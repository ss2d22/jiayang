//! Hostile tests for the SDK. It should accept the edge's tokens for this app and nothing else.
#![allow(clippy::unwrap_used, clippy::expect_used)] // tests: a panic is a failure

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jiayang::{Config, KeySet, Kind, Unauthorized, User, Verifier};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use reqwest::header::{HeaderMap, HeaderValue};
use rsa::pkcs1::EncodeRsaPrivateKey;
use rsa::pkcs8::{EncodePublicKey, LineEnding};
use rsa::traits::PublicKeyParts;
use serde_json::{Value, json};

const APP: &str = "0a000000-0000-4000-8000-000000000001";
const OTHER_APP: &str = "0a000000-0000-4000-8000-000000000002";
const ISSUER: &str = "https://edge.example.com";
const JWKS_URL: &str = "https://edge.example.com/.well-known/jwks.json";
const NOW: u64 = 1_789_819_200; // 2026-09-19T12:00:00Z

struct Key {
    private: rsa::RsaPrivateKey,
    encoding: EncodingKey,
}

fn key(bits: usize) -> Key {
    let private = rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng, bits).unwrap();
    let pem = private.to_pkcs1_pem(LineEnding::LF).unwrap();
    Key { encoding: EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(), private }
}

/// 1024-bit key, which jsonwebtoken won't sign with.
fn small_key() -> rsa::RsaPrivateKey {
    rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 1024).unwrap()
}

/// RS256 by hand, for keys jsonwebtoken refuses to sign with.
fn sign_raw(c: &Value, private: &rsa::RsaPrivateKey, kid: &str) -> String {
    use rsa::signature::{SignatureEncoding, Signer};
    let head = b64(json!({ "alg": "RS256", "kid": kid, "typ": "JWT" }).to_string().as_bytes());
    let signing = format!("{head}.{}", b64(c.to_string().as_bytes()));
    let key = rsa::pkcs1v15::SigningKey::<rsa::sha2::Sha256>::new(private.clone());
    format!("{signing}.{}", b64(&key.sign(signing.as_bytes()).to_bytes()))
}

static EDGE: LazyLock<Key> = LazyLock::new(|| key(2048));
static ROTATED: LazyLock<Key> = LazyLock::new(|| key(2048));
static ATTACKER: LazyLock<Key> = LazyLock::new(|| key(2048));

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn jwk(kid: &str, key: &Key) -> Value {
    let public = key.private.to_public_key();
    json!({ "kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig",
            "n": b64(&public.n().to_bytes_be()), "e": b64(&public.e().to_bytes_be()) })
}

fn claims(changes: Value) -> Value {
    let mut c = json!({
        "iss": ISSUER, "aud": APP, "sub": "access-sub-alice", "email": "alice@example.com",
        "kind": "user", "role": "editor", "wid": "0b000000-0000-4000-8000-00000000000a",
        "iat": NOW, "exp": NOW + 60,
    });
    for (k, v) in changes.as_object().unwrap() {
        if v.is_null() {
            c.as_object_mut().unwrap().remove(k);
        } else {
            c[k] = v.clone();
        }
    }
    c
}

fn sign_with(c: &Value, key: &Key, kid: &str, alg: Algorithm) -> String {
    let mut header = Header::new(alg);
    header.kid = Some(kid.to_owned());
    jsonwebtoken::encode(&header, c, &key.encoding).unwrap()
}

fn good(changes: Value) -> String {
    sign_with(&claims(changes), &EDGE, "identity-k1", Algorithm::RS256)
}

/// Fake JWKS endpoint and clock.
struct Jwks {
    keys: Mutex<Vec<Value>>,
    down: AtomicBool,
    fetches: AtomicUsize,
    clock: AtomicU64,
}

struct Fixture {
    jwks: Arc<Jwks>,
    verifier: Verifier,
}

fn setup() -> Fixture {
    setup_at(NOW)
}

fn setup_at(now: u64) -> Fixture {
    let jwks = Arc::new(Jwks {
        keys: Mutex::new(vec![jwk("identity-k1", &EDGE)]),
        down: AtomicBool::new(false),
        fetches: AtomicUsize::new(0),
        clock: AtomicU64::new(NOW),
    });
    let fetcher = jwks.clone();
    let clock = jwks.clone();
    let keys = KeySet::with_fetch(
        JWKS_URL,
        Arc::new(move |url: String| {
            let j = fetcher.clone();
            Box::pin(async move {
                assert_eq!(url, JWKS_URL);
                j.fetches.fetch_add(1, Ordering::SeqCst);
                if j.down.load(Ordering::SeqCst) {
                    return Err("network down".to_owned());
                }
                Ok(serde_json::to_vec(&json!({ "keys": *j.keys.lock().unwrap() })).unwrap())
            })
        }),
        Arc::new(move || clock.clock.load(Ordering::SeqCst)),
    );
    let config = Config { app_id: APP.into(), issuer: ISSUER.into(), jwks_url: JWKS_URL.into() };
    let verifier = Verifier::new(config).unwrap().with_key_set(keys).with_clock(Arc::new(move || now));
    Fixture { jwks, verifier }
}

impl Fixture {
    async fn refused(&self, token: &str) {
        let result = self.verifier.verify(token).await;
        assert!(result.is_err(), "accepted {token}: {result:?}");
    }

    fn advance(&self, seconds: u64) {
        self.jwks.clock.fetch_add(seconds, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn returns_the_verified_caller() {
    let f = setup();
    let mut headers = HeaderMap::new();
    headers.insert("X-Jiayang-Identity", HeaderValue::from_str(&good(json!({}))).unwrap());
    assert_eq!(
        f.verifier.require_user(&headers).await.unwrap(),
        User {
            kind: Kind::User,
            sub: "access-sub-alice".into(),
            email: Some("alice@example.com".into()),
            role: "editor".into(),
            workspace_id: "0b000000-0000-4000-8000-00000000000a".into(),
        }
    );
}

#[tokio::test]
async fn a_service_caller_has_no_email() {
    let f = setup();
    let user = f.verifier.verify(&good(json!({ "kind": "service", "sub": "service:bt_ci" }))).await.unwrap();
    assert_eq!((user.kind, user.sub.as_str(), user.email), (Kind::Service, "service:bt_ci", None));
}

#[tokio::test]
async fn refuses_a_request_with_no_token_whatever_else_it_carries() {
    let f = setup();
    let mut headers = HeaderMap::new();
    headers.insert("X-Jiayang-Email", HeaderValue::from_static("alice@example.com"));
    headers.insert("X-Jiayang-Role", HeaderValue::from_static("owner"));
    assert_eq!(f.verifier.require_user(&headers).await, Err(Unauthorized("no identity token")));
    headers.insert("X-Jiayang-Identity", HeaderValue::from_static(""));
    assert!(f.verifier.require_user(&headers).await.is_err());
}

#[test]
fn refuses_when_the_app_isnt_configured() {
    let full = Config { app_id: APP.into(), issuer: ISSUER.into(), jwks_url: JWKS_URL.into() };
    for broken in [
        Config { app_id: String::new(), ..full.clone() },
        Config { issuer: String::new(), ..full.clone() },
        Config { jwks_url: String::new(), ..full.clone() },
    ] {
        assert!(Verifier::new(broken).is_err());
    }
}

#[tokio::test]
async fn hostile_tokens() {
    let f = setup();
    for token in ["", "abc", "a.b", "a.b.c", "a.b.c.d", "..."] {
        f.refused(token).await;
    }
    let body = b64(claims(json!({})).to_string().as_bytes());

    // alg: none.
    let none = b64(json!({ "alg": "none", "kid": "identity-k1" }).to_string().as_bytes());
    f.refused(&format!("{none}.{body}.")).await;

    // HS256 keyed with our public key.
    let pem = EDGE.private.to_public_key().to_public_key_pem(LineEnding::LF).unwrap();
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some("identity-k1".into());
    let confused =
        jsonwebtoken::encode(&header, &claims(json!({})), &EncodingKey::from_secret(pem.as_bytes())).unwrap();
    f.refused(&confused).await;

    // Other RSA algorithms, even with our key.
    for alg in [Algorithm::RS384, Algorithm::RS512, Algorithm::PS256] {
        f.refused(&sign_with(&claims(json!({})), &EDGE, "identity-k1", alg)).await;
    }

    // A valid signature from the wrong key, under our kid or its own.
    f.refused(&sign_with(&claims(json!({})), &ATTACKER, "identity-k1", Algorithm::RS256)).await;
    f.refused(&sign_with(&claims(json!({})), &ATTACKER, "attacker", Algorithm::RS256)).await;

    for (name, changes) in [
        ("another app's audience", json!({ "aud": OTHER_APP })),
        ("another app in a list", json!({ "aud": [OTHER_APP] })),
        ("the wrong issuer", json!({ "iss": "https://evil.example.com" })),
        ("not yet valid", json!({ "nbf": NOW + 30 })),
        ("no exp", json!({ "exp": null })),
        ("no iat", json!({ "iat": null })),
        ("no aud", json!({ "aud": null })),
        ("no iss", json!({ "iss": null })),
        ("exp as a string", json!({ "exp": (NOW + 60).to_string() })),
        ("iat as a string", json!({ "iat": NOW.to_string() })),
        ("nbf as a string", json!({ "nbf": (NOW - 5).to_string() })),
        ("exp as a bool", json!({ "exp": true })),
        ("no kind", json!({ "kind": null })),
        ("an unknown kind", json!({ "kind": "admin" })),
        ("a user with no email", json!({ "email": null })),
        ("no role", json!({ "role": null })),
        ("no workspace", json!({ "wid": null })),
        ("an empty sub", json!({ "sub": "" })),
        ("a numeric sub", json!({ "sub": 42 })),
    ] {
        let result = f.verifier.verify(&good(changes)).await;
        assert!(result.is_err(), "{name}: {result:?}");
    }
}

#[tokio::test]
async fn refuses_an_expired_token_and_the_same_token_replayed_after_expiry() {
    let token = good(json!({}));
    assert!(setup().verifier.verify(&token).await.is_ok());
    for later in [60, 3600] {
        setup_at(NOW + later).refused(&token).await;
    }
}

#[tokio::test]
async fn picks_up_a_rotated_key_on_first_sight_of_its_kid() {
    let f = setup();
    assert!(f.verifier.verify(&good(json!({}))).await.is_ok());
    *f.jwks.keys.lock().unwrap() = vec![jwk("identity-k2", &ROTATED), jwk("identity-k1", &EDGE)];
    f.advance(11);
    let rotated = sign_with(&claims(json!({})), &ROTATED, "identity-k2", Algorithm::RS256);
    assert!(f.verifier.verify(&rotated).await.is_ok());
}

#[tokio::test]
async fn made_up_kids_dont_become_a_stream_of_fetches() {
    let f = setup();
    assert!(f.verifier.verify(&good(json!({}))).await.is_ok());
    for i in 0..20 {
        f.refused(&sign_with(&claims(json!({})), &ATTACKER, &format!("made-up-{i}"), Algorithm::RS256)).await;
    }
    assert_eq!(f.jwks.fetches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn denies_when_the_keys_cant_be_fetched() {
    let f = setup();
    f.jwks.down.store(true, Ordering::SeqCst);
    f.refused(&good(json!({}))).await;
}

#[tokio::test]
async fn denies_once_cached_keys_expire_and_the_endpoint_is_down() {
    let f = setup();
    assert!(f.verifier.verify(&good(json!({}))).await.is_ok());
    f.jwks.down.store(true, Ordering::SeqCst);
    f.advance(301);
    f.refused(&good(json!({}))).await;
}

#[tokio::test]
async fn caches_keys_and_refetches_after_five_minutes() {
    let f = setup();
    let token = good(json!({}));
    for _ in 0..5 {
        assert!(f.verifier.verify(&token).await.is_ok());
    }
    assert_eq!(f.jwks.fetches.load(Ordering::SeqCst), 1);
    f.advance(301);
    assert!(f.verifier.verify(&token).await.is_ok());
    assert_eq!(f.jwks.fetches.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn ignores_keys_that_arent_rsa_signing_keys_or_are_too_small() {
    let f = setup();
    let small = small_key();
    let small_public = small.to_public_key();
    let small_jwk = json!({ "kty": "RSA", "kid": "small", "alg": "RS256", "use": "sig",
        "n": b64(&small_public.n().to_bytes_be()), "e": b64(&small_public.e().to_bytes_be()) });
    // Sanity check that sign_raw output verifies with the edge's key.
    assert!(f.verifier.verify(&sign_raw(&claims(json!({})), &EDGE.private, "identity-k1")).await.is_ok());

    let mut enc = jwk("identity-k1", &EDGE);
    enc["use"] = json!("enc");
    let mut rs512 = jwk("identity-k2", &ROTATED);
    rs512["alg"] = json!("RS512");
    *f.jwks.keys.lock().unwrap() =
        vec![enc, rs512, small_jwk, json!({ "kty": "oct", "kid": "hmac", "k": b64(b"secret") })];
    f.advance(301);
    f.refused(&good(json!({}))).await;
    f.refused(&sign_with(&claims(json!({})), &ROTATED, "identity-k2", Algorithm::RS256)).await;
    f.refused(&sign_raw(&claims(json!({})), &small, "small")).await;
}

#[tokio::test]
async fn a_down_endpoint_is_asked_at_most_once_per_cooldown_for_new_kids() {
    let f = setup();
    assert!(f.verifier.verify(&good(json!({}))).await.is_ok());
    f.advance(11);
    f.jwks.down.store(true, Ordering::SeqCst);
    for i in 0..50 {
        f.refused(&sign_with(&claims(json!({})), &ATTACKER, &format!("made-up-{i}"), Algorithm::RS256)).await;
    }
    assert_eq!(f.jwks.fetches.load(Ordering::SeqCst), 2);
    assert!(f.verifier.verify(&good(json!({}))).await.is_ok(), "the cached keys still serve");
}

/// Answers every request with the raw `response` bytes.
async fn serve(response: Vec<u8>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let response = response.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf).await;
                let _ = socket.write_all(&response).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    format!("http://{addr}")
}

fn verifier_at(url: String) -> Verifier {
    let config = Config { app_id: APP.into(), issuer: ISSUER.into(), jwks_url: url };
    Verifier::new(config).unwrap().with_clock(Arc::new(|| NOW))
}

#[tokio::test(flavor = "multi_thread")]
async fn never_follows_a_redirect() {
    let body = json!({ "keys": [jwk("identity-k1", &EDGE)] }).to_string();
    let keys = serve(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}", body.len()).into_bytes()).await;
    let redirect =
        serve(format!("HTTP/1.1 302 Found\r\nlocation: {keys}/\r\ncontent-length: 0\r\n\r\n").into_bytes()).await;
    assert!(verifier_at(format!("{keys}/")).verify(&good(json!({}))).await.is_ok(), "the keys themselves verify");
    assert!(verifier_at(format!("{redirect}/")).verify(&good(json!({}))).await.is_err(), "followed the redirect");
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_an_oversized_key_set_with_no_length() {
    let mut response = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n".to_vec();
    let chunk = vec![b' '; 64 * 1024];
    for _ in 0..40 {
        response.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
        response.extend_from_slice(&chunk);
        response.extend_from_slice(b"\r\n");
    }
    response.extend_from_slice(b"0\r\n\r\n");
    let url = serve(response).await;
    assert!(verifier_at(format!("{url}/")).verify(&good(json!({}))).await.is_err());
}
