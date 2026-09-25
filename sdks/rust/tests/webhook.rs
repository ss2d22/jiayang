//! `require_webhook` from the tenant side: what it takes, and that it fails closed like
//! `require_user`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // tests: a panic is a failure

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jiayang::{Config, KeySet, Provider, Verifier, Webhook};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use reqwest::header::{HeaderMap, HeaderValue};
use rsa::pkcs1::EncodeRsaPrivateKey;
use rsa::pkcs8::LineEnding;
use rsa::traits::PublicKeyParts;
use serde_json::{Value, json};

const APP: &str = "0a000000-0000-4000-8000-000000000001";
const ISSUER: &str = "https://edge.example.com";
const JWKS_URL: &str = "https://edge.example.com/.well-known/jwks.json";
const NOW: u64 = 1_789_819_200; // 2026-09-19T12:00:00Z

struct Key {
    private: rsa::RsaPrivateKey,
    encoding: EncodingKey,
}

static EDGE: LazyLock<Key> = LazyLock::new(|| {
    let private = rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048).unwrap();
    let pem = private.to_pkcs1_pem(LineEnding::LF).unwrap();
    Key { encoding: EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(), private }
});

fn sign(claims: &Value, typ: &str) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("identity-k1".to_owned());
    header.typ = Some(typ.to_owned());
    jsonwebtoken::encode(&header, claims, &EDGE.encoding).unwrap()
}

/// What the edge sends with a Stripe delivery on a verified path.
fn webhook_token() -> String {
    sign(
        &json!({
            "iss": ISSUER, "aud": format!("webhook:{APP}"), "sub": "webhook:0c000000-0000-4000-8000-0000000000f1",
            "kind": "webhook", "wid": "0b000000-0000-4000-8000-00000000000a",
            "provider": "stripe", "pattern": "/hooks/stripe", "delivery": "evt_1", "signed_at": NOW - 1,
            "iat": NOW, "exp": NOW + 60,
        }),
        "webhook+jwt",
    )
}

fn user_token() -> String {
    sign(
        &json!({
            "iss": ISSUER, "aud": APP, "sub": "access-sub-alice", "email": "alice@example.com",
            "kind": "user", "role": "editor", "wid": "0b000000-0000-4000-8000-00000000000a",
            "iat": NOW, "exp": NOW + 60,
        }),
        "JWT",
    )
}

struct Edge {
    fetches: Arc<AtomicUsize>,
    down: Arc<AtomicBool>,
    verifier: Verifier,
}

fn edge() -> Edge {
    let public = EDGE.private.to_public_key();
    let b64 = |bytes: &[u8]| URL_SAFE_NO_PAD.encode(bytes);
    let jwks = json!({ "keys": [{
        "kty": "RSA", "kid": "identity-k1", "alg": "RS256", "use": "sig",
        "n": b64(&public.n().to_bytes_be()), "e": b64(&public.e().to_bytes_be()),
    }]});
    let body = serde_json::to_vec(&jwks).unwrap();
    let (fetches, down) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
    let (counted, failing) = (fetches.clone(), down.clone());
    let keys = KeySet::with_fetch(
        JWKS_URL,
        Arc::new(move |_url: String| {
            counted.fetch_add(1, Ordering::SeqCst);
            let answer = if failing.load(Ordering::SeqCst) { Err("network down".to_owned()) } else { Ok(body.clone()) };
            Box::pin(async move { answer })
        }),
        Arc::new(|| NOW),
    );
    let config = Config { app_id: APP.into(), issuer: ISSUER.into(), jwks_url: JWKS_URL.into() };
    let verifier = Verifier::new(config).unwrap().with_key_set(keys).with_clock(Arc::new(|| NOW));
    Edge { fetches, down, verifier }
}

fn headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("x-jiayang-identity", HeaderValue::from_str(token).unwrap());
    headers
}

#[tokio::test]
async fn it_reads_the_header_and_names_the_delivery() {
    let got = edge().verifier.require_webhook(&headers(&webhook_token()), &[Provider::Stripe]).await.unwrap();
    assert_eq!(
        got,
        Webhook {
            provider: Provider::Stripe,
            pattern: "/hooks/stripe".to_owned(),
            delivery: Some("evt_1".to_owned()),
            signed_at: Some(NOW - 1),
            workspace_id: "0b000000-0000-4000-8000-00000000000a".to_owned(),
        }
    );
}

#[tokio::test]
async fn it_refuses_a_request_with_no_token_whatever_else_it_carries() {
    let mut bare = HeaderMap::new();
    bare.insert("x-jiayang-email", HeaderValue::from_static("alice@example.com"));
    bare.insert("stripe-signature", HeaderValue::from_static("t=1,v1=00"));
    assert!(edge().verifier.require_webhook(&bare, &[Provider::Stripe]).await.is_err());
}

#[tokio::test]
async fn no_provider_refuses_everything_without_fetching_a_key() {
    let edge = edge();
    assert!(edge.verifier.verify_webhook(&webhook_token(), &[]).await.is_err());
    assert_eq!(edge.fetches.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_provider_not_listed_is_refused_and_a_list_of_several_works() {
    let edge = edge();
    assert!(edge.verifier.verify_webhook(&webhook_token(), &[Provider::Github, Provider::Slack]).await.is_err());
    let got = edge.verifier.verify_webhook(&webhook_token(), &[Provider::Github, Provider::Stripe]).await.unwrap();
    assert_eq!(got.provider, Provider::Stripe);
}

// The same token is a user's no more than a user's token is a webhook.
#[tokio::test]
async fn each_refuses_the_other_s_token() {
    let edge = edge();
    assert!(edge.verifier.require_user(&headers(&webhook_token())).await.is_err());
    assert!(edge.verifier.require_webhook(&headers(&user_token()), &Provider::ALL).await.is_err());
}

#[tokio::test]
async fn it_refuses_when_the_keys_can_t_be_fetched() {
    let edge = edge();
    edge.down.store(true, Ordering::SeqCst);
    assert!(edge.verifier.verify_webhook(&webhook_token(), &[Provider::Stripe]).await.is_err());
}

#[test]
fn a_provider_is_known_by_the_name_the_platform_writes() {
    for provider in Provider::ALL {
        assert_eq!(Provider::from_name(provider.name()), Some(provider));
        assert_eq!(provider.to_string(), provider.name());
    }
    assert_eq!(Provider::from_name("standard_webhooks"), Some(Provider::StandardWebhooks));
    for unknown in ["", "Stripe", "paddle", "stripe "] {
        assert_eq!(Provider::from_name(unknown), None, "{unknown:?}");
    }
}
