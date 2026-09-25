//! The token cases in sdks/testdata/vectors.json, shared by every SDK.
#![allow(clippy::unwrap_used, clippy::expect_used)] // tests: a panic is a failure

use std::sync::Arc;

use jiayang::{Config, Fetch, KeySet, Kind, Provider, User, Verifier, Webhook};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn verifier(v: &Value, case: &Value) -> Verifier {
    let config = Config {
        app_id: v["config"]["app_id"].as_str().unwrap().to_owned(),
        issuer: v["config"]["issuer"].as_str().unwrap().to_owned(),
        jwks_url: v["config"]["jwks_url"].as_str().unwrap().to_owned(),
    };
    let body = serde_json::to_vec(case.get("jwks").unwrap_or(&v["jwks"])).unwrap();
    let now = case.get("now").unwrap_or(&v["now"]).as_u64().unwrap();
    let fetch: Fetch = Arc::new(move |_url| {
        let body = body.clone();
        Box::pin(async move { Ok(body) })
    });
    let keys = KeySet::with_fetch(&config.jwks_url, fetch, Arc::new(move || now));
    Verifier::new(config).unwrap().with_clock(Arc::new(move || now)).with_key_set(keys)
}

async fn verify(v: &Value, case: &Value) -> Result<User, jiayang::Unauthorized> {
    verifier(v, case).verify(case["token"].as_str().unwrap()).await
}

/// A name this version doesn't know can't be a `Provider`, so it drops out of the list, which is
/// how the other SDKs treat one: it matches nothing.
async fn verify_webhook(v: &Value, case: &Value) -> Result<Webhook, jiayang::Unauthorized> {
    let providers: Vec<Provider> = case["providers"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|name| Provider::from_name(name.as_str().unwrap()))
        .collect();
    verifier(v, case).verify_webhook(case["token"].as_str().unwrap(), &providers).await
}

#[tokio::test]
async fn accepts_the_valid_cases() {
    let v = vectors();
    for case in v["valid"].as_array().unwrap() {
        let user = verify(&v, case).await.unwrap_or_else(|e| panic!("{}: {e:?}", case["name"]));
        let want = &case["user"];
        let kind = if want["kind"] == "user" { Kind::User } else { Kind::Service };
        assert_eq!(
            user,
            User {
                kind,
                sub: want["sub"].as_str().unwrap().to_owned(),
                email: want["email"].as_str().map(str::to_owned),
                role: want["role"].as_str().unwrap().to_owned(),
                workspace_id: want["workspace_id"].as_str().unwrap().to_owned(),
            },
            "{}",
            case["name"]
        );
    }
}

#[tokio::test]
async fn refuses_the_invalid_cases() {
    let v = vectors();
    for case in v["invalid"].as_array().unwrap() {
        let result = verify(&v, case).await;
        assert!(result.is_err(), "accepted {}: {result:?}", case["name"]);
    }
}

#[tokio::test]
async fn accepts_the_valid_webhook_cases() {
    let v = vectors();
    for case in v["webhook_valid"].as_array().unwrap() {
        let webhook = verify_webhook(&v, case).await.unwrap_or_else(|e| panic!("{}: {e:?}", case["name"]));
        let want = &case["webhook"];
        assert_eq!(
            webhook,
            Webhook {
                provider: Provider::from_name(want["provider"].as_str().unwrap()).unwrap(),
                pattern: want["pattern"].as_str().unwrap().to_owned(),
                delivery: want["delivery"].as_str().map(str::to_owned),
                signed_at: want["signed_at"].as_u64(),
                workspace_id: want["workspace_id"].as_str().unwrap().to_owned(),
            },
            "{}",
            case["name"]
        );
    }
}

#[tokio::test]
async fn refuses_the_invalid_webhook_cases() {
    let v = vectors();
    for case in v["webhook_invalid"].as_array().unwrap() {
        let result = verify_webhook(&v, case).await;
        assert!(result.is_err(), "accepted {}: {result:?}", case["name"]);
    }
}

// An app in a language we ship no SDK for checks the token with whatever JWT library it has:
// signature, issuer, audience, expiry. Addressed to the app, that check must not pass a webhook.
#[test]
fn a_generic_check_that_the_audience_is_the_app_refuses_webhooks() {
    let v = vectors();
    let jwk = &v["jwks"]["keys"][0];
    let key = DecodingKey::from_rsa_components(jwk["n"].as_str().unwrap(), jwk["e"].as_str().unwrap()).unwrap();
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[v["config"]["app_id"].as_str().unwrap()]);
    validation.set_issuer(&[v["config"]["issuer"].as_str().unwrap()]);
    validation.validate_exp = false;
    for case in v["webhook_valid"].as_array().unwrap() {
        let refused = jsonwebtoken::decode::<Value>(case["token"].as_str().unwrap(), &key, &validation)
            .expect_err(case["name"].as_str().unwrap());
        assert_eq!(refused.kind(), &jsonwebtoken::errors::ErrorKind::InvalidAudience, "{}", case["name"]);
    }
}
