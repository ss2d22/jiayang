//! The axum layer and extractor, driven through a real router.
#![cfg(feature = "axum")]
#![allow(clippy::unwrap_used, clippy::expect_used)] // tests: a panic is a failure

use std::sync::{Arc, LazyLock, Mutex};

use axum::Extension;
use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http::StatusCode;
use jiayang::axum::{Jiayang, JiayangWebhook};
use jiayang::{Config, KeySet, Kind, Provider, Role, User, Verifier, Webhook};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use rsa::pkcs1::EncodeRsaPrivateKey;
use rsa::pkcs8::LineEnding;
use rsa::traits::PublicKeyParts;
use serde_json::{Value, json};
use tower::ServiceExt;

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

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn token(role: &str) -> String {
    let claims = json!({
        "iss": ISSUER, "aud": APP, "sub": "access-sub-alice", "email": "alice@example.com",
        "kind": "user", "role": role, "wid": "0b000000-0000-4000-8000-00000000000a",
        "iat": NOW, "exp": NOW + 60,
    });
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("identity-k1".to_owned());
    jsonwebtoken::encode(&header, &claims, &EDGE.encoding).unwrap()
}

/// What the edge sends with a Stripe delivery on a verified path.
fn webhook_token() -> String {
    let claims = json!({
        "iss": ISSUER, "aud": format!("webhook:{APP}"), "sub": "webhook:0c000000-0000-4000-8000-0000000000f1",
        "kind": "webhook", "wid": "0b000000-0000-4000-8000-00000000000a",
        "provider": "stripe", "pattern": "/hooks/stripe", "delivery": "evt_1", "signed_at": NOW - 1,
        "iat": NOW, "exp": NOW + 60,
    });
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("identity-k1".to_owned());
    header.typ = Some("webhook+jwt".to_owned());
    jsonwebtoken::encode(&header, &claims, &EDGE.encoding).unwrap()
}

/// A verifier whose keys are this test's, at a time these tokens are alive.
fn verifier() -> Verifier {
    let public = EDGE.private.to_public_key();
    let jwks: Value = json!({ "keys": [{
        "kty": "RSA", "kid": "identity-k1", "alg": "RS256", "use": "sig",
        "n": b64(&public.n().to_bytes_be()), "e": b64(&public.e().to_bytes_be()),
    }]});
    let body = Arc::new(serde_json::to_vec(&jwks).unwrap());
    let keys = KeySet::with_fetch(
        JWKS_URL,
        Arc::new(move |_url: String| {
            let body = body.clone();
            Box::pin(async move { Ok((*body).clone()) })
        }),
        Arc::new(|| NOW),
    );
    let config = Config { app_id: APP.into(), issuer: ISSUER.into(), jwks_url: JWKS_URL.into() };
    Verifier::new(config).unwrap().with_key_set(keys).with_clock(Arc::new(|| NOW))
}

/// Who the handler saw, or nothing if it wasn't reached.
type Seen = Arc<Mutex<Option<User>>>;

fn app(layer: Option<Jiayang>, seen: Seen) -> Router {
    let hand_back = move |user: User| {
        let seen = seen.clone();
        async move {
            let answer = user.email.clone().unwrap_or_else(|| user.sub.clone());
            *seen.lock().unwrap() = Some(user);
            answer
        }
    };
    let router = Router::new().route("/", get(hand_back));
    match layer {
        Some(layer) => router.layer(layer).with_state(verifier()),
        None => router.with_state(verifier()),
    }
}

async fn call(app: Router, token: Option<&str>) -> (StatusCode, String, Option<String>) {
    send(app, "GET", "/", token).await
}

async fn send(app: Router, method: &str, uri: &str, token: Option<&str>) -> (StatusCode, String, Option<String>) {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        request = request.header("x-jiayang-identity", token);
    }
    let response = app.oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let cache = response.headers().get("cache-control").map(|v| v.to_str().unwrap().to_owned());
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap(), cache)
}

#[tokio::test]
async fn the_extractor_verifies_the_caller_from_the_router_s_state() {
    let seen: Seen = Seen::default();
    let (status, body, _) = call(app(None, seen.clone()), Some(&token("editor"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, "alice@example.com");
    assert_eq!(seen.lock().unwrap().as_ref().unwrap().role, "editor");
}

#[tokio::test]
async fn the_extractor_refuses_a_request_with_no_identity() {
    let seen: Seen = Seen::default();
    let (status, _, cache) = call(app(None, seen.clone()), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(cache.as_deref(), Some("no-store"));
    assert!(seen.lock().unwrap().is_none(), "the handler ran");
}

#[tokio::test]
async fn the_layer_verifies_before_the_handler() {
    let seen: Seen = Seen::default();
    let layer = Jiayang::new(verifier());
    let (status, body, _) = call(app(Some(layer), seen.clone()), Some(&token("viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(seen.lock().unwrap().as_ref().unwrap().role, "viewer");
}

#[tokio::test]
async fn the_layer_answers_401_itself_and_the_handler_never_runs() {
    let seen: Seen = Seen::default();
    let layer = Jiayang::new(verifier());
    let (status, _, cache) = call(app(Some(layer), seen.clone()), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(cache.as_deref(), Some("no-store"));
    assert!(seen.lock().unwrap().is_none(), "the handler ran");
}

// Extensions are keyed by type, so anything in the stack can put a User there. Only the layer's
// own word counts: a handler must not be reachable with a caller nobody verified.
#[tokio::test]
async fn a_user_the_layer_did_not_put_there_is_not_a_caller() {
    let seen: Seen = Seen::default();
    let planted = User {
        kind: Kind::User,
        sub: "planted".to_owned(),
        email: Some("root@evil.test".to_owned()),
        role: "owner".to_owned(),
        workspace_id: "w".to_owned(),
    };
    let app = app(None, seen.clone()).layer(Extension(planted));
    let (status, _, _) = call(app, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a planted caller was taken at its word");
    assert!(seen.lock().unwrap().is_none(), "the handler ran");
}

// The two refusals are different answers: 401 is about who is calling, 403 about what they may do.
#[tokio::test]
async fn requires_tells_a_viewer_apart_from_a_stranger() {
    let layer = Jiayang::new(verifier()).requires(Role::Editor);

    let seen: Seen = Seen::default();
    let (status, body, cache) = call(app(Some(layer.clone()), seen.clone()), Some(&token("viewer"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // The same plain text every SDK answers.
    assert_eq!(body, "forbidden: this needs editor");
    assert_eq!(cache.as_deref(), Some("no-store"));
    assert!(seen.lock().unwrap().is_none(), "a viewer reached the handler");

    for role in ["editor", "owner"] {
        let seen: Seen = Seen::default();
        let (status, _, _) = call(app(Some(layer.clone()), seen.clone()), Some(&token(role))).await;
        assert_eq!(status, StatusCode::OK, "{role} was refused");
        assert!(seen.lock().unwrap().is_some());
    }

    let seen: Seen = Seen::default();
    let (status, _, _) = call(app(Some(layer), seen.clone()), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_user_layer_and_extractor_refuse_a_webhook_token() {
    let seen: Seen = Seen::default();
    let (status, _, _) = call(app(None, seen.clone()), Some(&webhook_token())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = call(app(Some(Jiayang::new(verifier())), seen.clone()), Some(&webhook_token())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(seen.lock().unwrap().is_none(), "the handler ran");
}

/// Which delivery the handler saw, or nothing if it wasn't reached.
type SeenWebhook = Arc<Mutex<Option<Webhook>>>;

fn hooks(layer: Option<JiayangWebhook>, seen: SeenWebhook) -> Router<Verifier> {
    let hand_back = move |webhook: Webhook| {
        let seen = seen.clone();
        async move {
            let answer = webhook.delivery.clone().unwrap_or_default();
            *seen.lock().unwrap() = Some(webhook);
            answer
        }
    };
    let router = Router::new().route("/hooks/stripe", post(hand_back));
    match layer {
        Some(layer) => router.layer(layer),
        None => router,
    }
}

#[tokio::test]
async fn the_webhook_layer_takes_a_delivery_from_its_provider() {
    let seen: SeenWebhook = SeenWebhook::default();
    let layer = JiayangWebhook::new(verifier(), [Provider::Stripe]);
    let app = hooks(Some(layer), seen.clone()).with_state(verifier());
    let (status, body, _) = send(app, "POST", "/hooks/stripe", Some(&webhook_token())).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, "evt_1");
    assert_eq!(seen.lock().unwrap().as_ref().unwrap().provider, Provider::Stripe);
}

#[tokio::test]
async fn the_webhook_layer_answers_401_itself_to_anything_else() {
    for (what, layer, token) in [
        ("a person", JiayangWebhook::new(verifier(), [Provider::Stripe]), Some(token("owner"))),
        ("nobody", JiayangWebhook::new(verifier(), [Provider::Stripe]), None),
        ("another provider's route", JiayangWebhook::new(verifier(), [Provider::Github]), Some(webhook_token())),
        ("no providers", JiayangWebhook::new(verifier(), []), Some(webhook_token())),
    ] {
        let seen: SeenWebhook = SeenWebhook::default();
        let app = hooks(Some(layer), seen.clone()).with_state(verifier());
        let (status, _, cache) = send(app, "POST", "/hooks/stripe", token.as_deref()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{what}");
        assert_eq!(cache.as_deref(), Some("no-store"), "{what}");
        assert!(seen.lock().unwrap().is_none(), "{what}: the handler ran");
    }
}

// The extractor can't know which providers a route takes, so without the layer it has nothing to
// give, whatever token came.
#[tokio::test]
async fn the_webhook_extractor_refuses_without_the_layer() {
    let seen: SeenWebhook = SeenWebhook::default();
    let app = hooks(None, seen.clone()).with_state(verifier());
    let (status, _, _) = send(app, "POST", "/hooks/stripe", Some(&webhook_token())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(seen.lock().unwrap().is_none(), "the handler ran");
}

// As with User: a bare Webhook some other layer put in the extensions is nobody's word.
#[tokio::test]
async fn a_webhook_the_layer_did_not_put_there_is_not_a_delivery() {
    let seen: SeenWebhook = SeenWebhook::default();
    let planted = Webhook {
        provider: Provider::Stripe,
        pattern: "/hooks/stripe".to_owned(),
        delivery: Some("evt_planted".to_owned()),
        signed_at: None,
        workspace_id: "w".to_owned(),
    };
    let app = hooks(None, seen.clone()).layer(Extension(planted)).with_state(verifier());
    let (status, _, _) = send(app, "POST", "/hooks/stripe", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a planted delivery was taken at its word");
    assert!(seen.lock().unwrap().is_none(), "the handler ran");
}

// How the README mounts it: the webhook's router merged after the user layer, which then never
// sees the delivery, while every other route still takes people only.
#[tokio::test]
async fn a_webhook_router_merged_after_the_user_layer() {
    let app = || {
        let seen: Seen = Seen::default();
        let hand_back = move |user: User| {
            let seen = seen.clone();
            async move {
                *seen.lock().unwrap() = Some(user.clone());
                user.email.unwrap_or_default()
            }
        };
        Router::new()
            .route("/", get(hand_back))
            .layer(Jiayang::new(verifier()))
            .merge(hooks(Some(JiayangWebhook::new(verifier(), [Provider::Stripe])), SeenWebhook::default()))
            .with_state(verifier())
    };
    assert_eq!(send(app(), "POST", "/hooks/stripe", Some(&webhook_token())).await.1, "evt_1");
    assert_eq!(send(app(), "POST", "/hooks/stripe", Some(&token("owner"))).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(app(), "GET", "/", Some(&token("viewer"))).await.1, "alice@example.com");
    assert_eq!(send(app(), "GET", "/", Some(&webhook_token())).await.0, StatusCode::UNAUTHORIZED);
}
