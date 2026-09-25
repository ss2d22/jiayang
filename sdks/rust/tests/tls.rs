//! The key set's own fetch over TLS, the way a platform container makes it: through a proxy that
//! intercepts it, with a certificate from a CA no public root store holds. The platform names that
//! CA in `SSL_CERT_FILE`, and the SDK has to trust it or refuse everyone.
//!
//! The variable is read by the process doing the fetch, and safe code can't change a running test
//! binary's environment. So each case runs `fetches_with_its_environment` in a process of its own,
//! with the environment the case is about.
#![allow(clippy::unwrap_used, clippy::expect_used)] // tests: a panic is a failure

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, LazyLock};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use jiayang::{KeySet, Unauthorized};
use rsa::RsaPrivateKey;
use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey};
use rsa::signature::{SignatureEncoding, Signer};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::Value;

/// A CA made for this run and trusted nowhere else, and the certificate it signed for 127.0.0.1.
struct Pki {
    /// The CA's certificate, as `SSL_CERT_FILE` would hold it.
    ca: String,
    server: Vec<u8>,
    server_key: Vec<u8>,
}

static PKI: LazyLock<Pki> = LazyLock::new(|| {
    let key = || RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048).unwrap();
    let (ca_key, server_key) = (key(), key());
    let ca = certificate(
        1,
        (&ca_key, "jiayang sdk test CA"),
        (&ca_key, "jiayang sdk test CA"),
        &[
            // basicConstraints, critical: a CA.
            extension(&[0x55, 0x1d, 0x13], true, &der(SEQUENCE, &[&der(BOOLEAN, &[&[0xff]])])),
            // keyUsage, critical: keyCertSign and cRLSign.
            extension(&[0x55, 0x1d, 0x0f], true, &der(BIT_STRING, &[&[0x01, 0x06]])),
        ],
    );
    let server = certificate(
        2,
        (&server_key, "127.0.0.1"),
        (&ca_key, "jiayang sdk test CA"),
        &[
            // subjectAltName: the IP address 127.0.0.1.
            extension(&[0x55, 0x1d, 0x11], false, &der(SEQUENCE, &[&der(0x87, &[&[127, 0, 0, 1]])])),
            // extKeyUsage: serverAuth.
            extension(&[0x55, 0x1d, 0x25], false, &der(SEQUENCE, &[&der(OID, &[&[0x2b, 6, 1, 5, 5, 7, 3, 1]])])),
        ],
    );
    Pki { ca: pem(&ca), server, server_key: server_key.to_pkcs8_der().unwrap().as_bytes().to_vec() }
});

const BOOLEAN: u8 = 0x01;
const INTEGER: u8 = 0x02;
const BIT_STRING: u8 = 0x03;
const OCTET_STRING: u8 = 0x04;
const NULL: u8 = 0x05;
const OID: u8 = 0x06;
const UTF8_STRING: u8 = 0x0c;
const UTC_TIME: u8 = 0x17;
const GENERALIZED_TIME: u8 = 0x18;
const SEQUENCE: u8 = 0x30;
const SET: u8 = 0x31;

/// DER by hand, as the hostile suite signs RS256 by hand: a tag, a length, and what it holds.
fn der(tag: u8, content: &[&[u8]]) -> Vec<u8> {
    let content = content.concat();
    let mut out = vec![tag];
    match content.len() {
        len @ 0..0x80 => out.push(len as u8),
        len @ 0x80..0x100 => out.extend([0x81, len as u8]),
        len => out.extend([0x82, (len >> 8) as u8, len as u8]),
    }
    out.extend(content);
    out
}

fn extension(oid: &[u8], critical: bool, value: &[u8]) -> Vec<u8> {
    let critical = if critical { der(BOOLEAN, &[&[0xff]]) } else { Vec::new() };
    der(SEQUENCE, &[&der(OID, &[oid]), &critical, &der(OCTET_STRING, &[value])])
}

/// An X.509 v3 certificate for `subject`'s key, signed by `issuer`'s with RSA and SHA-256.
fn certificate(
    serial: u8,
    (subject, subject_name): (&RsaPrivateKey, &str),
    (issuer, issuer_name): (&RsaPrivateKey, &str),
    extensions: &[Vec<u8>],
) -> Vec<u8> {
    let name = |cn: &str| {
        let common_name = der(SEQUENCE, &[&der(OID, &[&[0x55, 0x04, 0x03]]), &der(UTF8_STRING, &[cn.as_bytes()])]);
        der(SEQUENCE, &[&der(SET, &[&common_name])])
    };
    let sha256_with_rsa =
        der(SEQUENCE, &[&der(OID, &[&[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]]), &der(NULL, &[])]);
    let validity = der(SEQUENCE, &[&der(UTC_TIME, &[b"200101000000Z"]), &der(GENERALIZED_TIME, &[b"21260101000000Z"])]);
    let extensions: Vec<&[u8]> = extensions.iter().map(Vec::as_slice).collect();
    let tbs = der(
        SEQUENCE,
        &[
            &der(0xa0, &[&der(INTEGER, &[&[2]])]),
            &der(INTEGER, &[&[serial]]),
            &sha256_with_rsa,
            &name(issuer_name),
            &validity,
            &name(subject_name),
            subject.to_public_key().to_public_key_der().unwrap().as_bytes(),
            &der(0xa3, &[&der(SEQUENCE, &extensions)]),
        ],
    );
    let signature = rsa::pkcs1v15::SigningKey::<rsa::sha2::Sha256>::new(issuer.clone()).sign(&tbs).to_bytes();
    der(SEQUENCE, &[&tbs, &sha256_with_rsa, &der(BIT_STRING, &[&[0], &signature])])
}

fn pem(certificate: &[u8]) -> String {
    let body = STANDARD.encode(certificate);
    let lines: Vec<&str> = body.as_bytes().chunks(64).map(|line| std::str::from_utf8(line).unwrap()).collect();
    format!("-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n", lines.join("\n"))
}

/// Well-formed PEM around bytes that are no certificate at all, which rustls refuses to trust.
const NOT_A_CERT: &str = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";

/// The shared test vectors' key set, and the kid of its key.
fn jwks() -> (String, String) {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/vectors.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let kid = vectors["jwks"]["keys"][0]["kid"].as_str().unwrap().to_owned();
    (vectors["jwks"].to_string(), kid)
}

/// Serves `body` over TLS as 127.0.0.1, with the test CA's certificate, and returns its URL.
fn serve(body: String) -> String {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(PKI.server.clone())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(PKI.server_key.clone())),
        )
        .unwrap();
    let config = Arc::new(config);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for socket in listener.incoming().flatten() {
            let (config, body) = (config.clone(), body.clone());
            std::thread::spawn(move || {
                let mut tls = rustls::StreamOwned::new(rustls::ServerConnection::new(config).unwrap(), socket);
                // A client that doesn't trust the certificate hangs up here, mid-handshake.
                let mut request = [0u8; 4096];
                if tls.read(&mut request).is_err() {
                    return;
                }
                let _ =
                    write!(tls, "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                tls.conn.send_close_notify();
                let _ = tls.flush();
            });
        }
    });
    format!("https://{addr}/.well-known/jwks.json")
}

/// Writes `pem` to a file of its own under the target directory.
fn file(name: &str, pem: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("jiayang-tls-{name}"));
    std::fs::write(&path, pem).unwrap();
    path
}

/// Runs `fetches_with_its_environment` in a process of its own, `SSL_CERT_FILE` set to `ca_file`
/// or unset, and asserts it saw what `expect` says.
fn fetch_in_its_own_process(ca_file: Option<&PathBuf>, expect: &str) {
    let (body, kid) = jwks();
    let mut child = Command::new(std::env::current_exe().unwrap());
    child
        .args(["fetches_with_its_environment", "--exact", "--nocapture"])
        .env("JIAYANG_TEST_JWKS_URL", serve(body))
        .env("JIAYANG_TEST_KID", kid)
        .env("JIAYANG_TEST_EXPECT", expect);
    match ca_file {
        Some(path) => child.env("SSL_CERT_FILE", path),
        None => child.env_remove("SSL_CERT_FILE"),
    };
    let out = child.output().unwrap();
    let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    // A filter that matched nothing passes too, having run nothing.
    assert!(out.status.success() && said.contains("1 passed"), "{said}");
}

#[test]
fn trusts_the_ca_ssl_cert_file_names() {
    fetch_in_its_own_process(Some(&file("ca.crt", &PKI.ca)), "keys");
}

// What a system bundle looks like: the CA among others, one of them something rustls won't read.
// That one alone is left out, rather than the whole file.
#[test]
fn trusts_the_ca_in_a_bundle_with_a_certificate_it_cant_read() {
    let bundle = format!("{NOT_A_CERT}{}{}", pem(&PKI.server), PKI.ca);
    fetch_in_its_own_process(Some(&file("bundle.crt", &bundle)), "keys");
}

// The public roots alone don't vouch for the server, so the cases above are about the variable,
// and the fetch still checks a certificate rather than taking whatever it's given.
#[test]
fn refuses_a_server_nothing_it_trusts_vouches_for() {
    fetch_in_its_own_process(None, "refused");
    fetch_in_its_own_process(
        Some(&PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("jiayang-tls-not-there")),
        "refused",
    );
    fetch_in_its_own_process(Some(&file("junk.crt", NOT_A_CERT)), "refused");
}

/// Not a case of its own: the ones above run it in a process with the environment they set. Run
/// alongside them it has no environment, and nothing to do.
#[tokio::test]
async fn fetches_with_its_environment() {
    let Ok(url) = std::env::var("JIAYANG_TEST_JWKS_URL") else { return };
    let var = |name| std::env::var(name).unwrap();
    let fetched = KeySet::new(&url).key(&var("JIAYANG_TEST_KID")).await;
    match var("JIAYANG_TEST_EXPECT").as_str() {
        "keys" => assert_eq!(fetched.err(), None),
        _ => assert_eq!(fetched.err(), Some(Unauthorized("couldn't fetch the identity keys"))),
    }
}
