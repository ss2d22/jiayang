//! Verifies the identity token the edge sends your Jiayang Cloud app in `X-Jiayang-Identity`.
//! `X-Jiayang-Email` and `X-Jiayang-Role` are for display only.
//!
//! ```no_run
//! # async fn handler(headers: reqwest::header::HeaderMap) -> Result<String, jiayang::Unauthorized> {
//! // Once, at startup: reads JIAYANG_APP_ID, JIAYANG_IDENTITY_ISSUER and JIAYANG_JWKS_URL.
//! let verifier = jiayang::Verifier::from_env()?;
//! // Per request (axum's `HeaderMap` is the same type):
//! let user = verifier.require_user(&headers).await?;
//! Ok(format!("hello {}", user.email.as_deref().unwrap_or(&user.sub)))
//! # }
//! ```
//!
//! The platform sets all three variables. Without them `from_env` returns an error and nothing
//! verifies.
//!
//! A webhook delivery on a verified public path carries a token too, of its own kind:
//! [`Verifier::require_webhook`] checks it, and [`Verifier::require_user`] refuses it.
//!
//! Docs: <https://jiayang.cloud/docs/sdks/rust/>

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http::HeaderMap;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::{Map, Value};
use tokio::sync::Mutex;

#[cfg(feature = "axum")]
pub mod axum;

/// The header the edge sends the identity token in.
pub const IDENTITY_HEADER: &str = "x-jiayang-identity";

const MAX_AGE_SECONDS: u64 = 300;
const COOLDOWN_SECONDS: u64 = 10;
const RETRY_SECONDS: u64 = 1;
const FETCH_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_JWKS_BYTES: usize = 1 << 20;
const MIN_RSA_BITS: usize = 2048;

/// No valid identity for this app, so respond with 401.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unauthorized: {0}")]
pub struct Unauthorized(pub &'static str);

/// Who is calling: a person, or a script with a bypass token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A person.
    User,
    /// A bypass token.
    Service,
}

/// A verified caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub kind: Kind,
    /// Stable id, either the person's platform id (`usr_…`) or `service:<token id>`.
    pub sub: String,
    /// `None` for service tokens.
    pub email: Option<String>,
    /// The caller's access to this app.
    pub role: String,
    pub workspace_id: String,
}

/// The caller is who they say they are, but not allowed to do this. Respond with 403.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("forbidden: this needs {0}")]
pub struct Forbidden(pub Role);

/// What a caller may do with this app. Ordered: an owner can do what an editor can.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Viewer,
    Editor,
    Owner,
}

impl Role {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "viewer" => Some(Self::Viewer),
            "editor" => Some(Self::Editor),
            "owner" => Some(Self::Owner),
            _ => None,
        }
    }
}

impl std::fmt::Display for Role {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Viewer => "viewer",
            Self::Editor => "editor",
            Self::Owner => "owner",
        })
    }
}

impl User {
    /// Whether the caller has at least `least`.
    ///
    /// A role this version doesn't know counts for nothing: if the platform ever adds one, an app
    /// built against an older SDK refuses rather than guessing what it allows.
    pub fn has_role(&self, least: Role) -> bool {
        Role::parse(&self.role).is_some_and(|has| has >= least)
    }

    /// Like [`User::has_role`], but returns [`Forbidden`] so a handler can answer with it.
    pub fn require_role(&self, least: Role) -> Result<(), Forbidden> {
        if self.has_role(least) { Ok(()) } else { Err(Forbidden(least)) }
    }
}

/// Who signs a webhook the platform can check for you.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Stripe,
    Github,
    Slack,
    Shopify,
    StandardWebhooks,
    HmacSha256,
}

impl Provider {
    /// Every provider this version knows.
    pub const ALL: [Self; 6] =
        [Self::Stripe, Self::Github, Self::Slack, Self::Shopify, Self::StandardWebhooks, Self::HmacSha256];

    /// The name the platform writes, such as `"standard_webhooks"`.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Stripe => "stripe",
            Self::Github => "github",
            Self::Slack => "slack",
            Self::Shopify => "shopify",
            Self::StandardWebhooks => "standard_webhooks",
            Self::HmacSha256 => "hmac_sha256",
        }
    }

    /// The provider with this name, or `None` for one this version doesn't know.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|provider| provider.name() == name)
    }
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

/// A delivery whose signature the platform checked before it reached your app, on a public path
/// with a verifier. Not a person: it has no email and no role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Webhook {
    pub provider: Provider,
    /// The public path pattern it arrived on, such as `/hooks/stripe`.
    pub pattern: String,
    /// The provider's signed id for this delivery, where it signs one. Dedupe on it.
    pub delivery: Option<String>,
    /// When the provider signed it, in unix seconds, where it signs a time.
    pub signed_at: Option<u64>,
    pub workspace_id: String,
}

/// What a token is checked against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub app_id: String,
    pub issuer: String,
    pub jwks_url: String,
}

impl Config {
    /// Reads `JIAYANG_APP_ID`, `JIAYANG_IDENTITY_ISSUER` and `JIAYANG_JWKS_URL`.
    pub fn from_env() -> Result<Self, Unauthorized> {
        let var = |name| std::env::var(name).unwrap_or_default();
        Self {
            app_id: var("JIAYANG_APP_ID"),
            issuer: var("JIAYANG_IDENTITY_ISSUER"),
            jwks_url: var("JIAYANG_JWKS_URL"),
        }
        .checked()
    }

    fn checked(self) -> Result<Self, Unauthorized> {
        if self.app_id.is_empty() || self.issuer.is_empty() || self.jwks_url.is_empty() {
            // Without all three there's nothing to verify against, so refuse.
            return Err(Unauthorized("JIAYANG_APP_ID, JIAYANG_IDENTITY_ISSUER and JIAYANG_JWKS_URL must be set"));
        }
        Ok(self)
    }
}

/// Seconds since the epoch.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type FetchFuture = Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send>>;
/// Fetches the JWKS at a URL.
pub type Fetch = Arc<dyn Fn(String) -> FetchFuture + Send + Sync>;

fn system_clock() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Build once and share, since it caches the signing keys.
#[derive(Clone)]
pub struct Verifier {
    config: Config,
    keys: Arc<KeySet>,
    now: Clock,
}

impl Verifier {
    /// A verifier for `config`, or an error if any of its fields is empty.
    pub fn new(config: Config) -> Result<Self, Unauthorized> {
        let config = config.checked()?;
        let keys = Arc::new(KeySet::new(&config.jwks_url));
        Ok(Self { config, keys, now: Arc::new(system_clock) })
    }

    /// A verifier for the variables the platform sets. See [`Config::from_env`].
    pub fn from_env() -> Result<Self, Unauthorized> {
        Self::new(Config::from_env()?)
    }

    /// Overrides the time tokens are checked at, for tests.
    pub fn with_clock(mut self, now: Clock) -> Self {
        self.now = now;
        self
    }

    /// Overrides where keys come from, for tests or custom transports.
    pub fn with_key_set(mut self, keys: KeySet) -> Self {
        self.keys = Arc::new(keys);
        self
    }

    /// Verifies the `X-Jiayang-Identity` header and returns the caller.
    pub async fn require_user(&self, headers: &HeaderMap) -> Result<User, Unauthorized> {
        self.verify(token_in(headers)?).await
    }

    /// Checks signature, algorithm, issuer, audience, expiry and claims.
    pub async fn verify(&self, token: &str) -> Result<User, Unauthorized> {
        const INVALID: Unauthorized = Unauthorized("invalid identity token");
        let claims = self.claims(token, &self.config.app_id).await?;
        let text = |name: &str| claims.get(name).and_then(Value::as_str);
        let kind = match text("kind") {
            Some("user") => Kind::User,
            Some("service") => Kind::Service,
            _ => return Err(INVALID),
        };
        let sub = text("sub").filter(|s| !s.is_empty()).ok_or(INVALID)?;
        let email = match kind {
            Kind::User => Some(text("email").ok_or(INVALID)?.to_owned()),
            Kind::Service => None,
        };
        let role = text("role").ok_or(INVALID)?;
        let workspace_id = text("wid").ok_or(INVALID)?;
        Ok(User { kind, sub: sub.to_owned(), email, role: role.to_owned(), workspace_id: workspace_id.to_owned() })
    }

    /// Verifies the `X-Jiayang-Identity` header of a webhook delivery from one of `providers`.
    ///
    /// A delivery from any other provider is refused, and so is every delivery when `providers` is
    /// empty. A person's or a bypass token's identity is refused here, as a webhook's is by
    /// [`Verifier::require_user`].
    pub async fn require_webhook(&self, headers: &HeaderMap, providers: &[Provider]) -> Result<Webhook, Unauthorized> {
        self.verify_webhook(token_in(headers)?, providers).await
    }

    /// Like [`Verifier::require_webhook`], for a token you already have.
    pub async fn verify_webhook(&self, token: &str, providers: &[Provider]) -> Result<Webhook, Unauthorized> {
        const INVALID: Unauthorized = Unauthorized("invalid webhook token");
        // Named by the caller, so a Stripe route can't be handed a GitHub delivery because a pattern
        // was widened later.
        if providers.is_empty() {
            return Err(Unauthorized("no provider named"));
        }
        let claims = self.claims(token, &format!("{WEBHOOK_AUDIENCE}{}", self.config.app_id)).await?;
        let text = |name: &str| claims.get(name).and_then(Value::as_str);
        // jsonwebtoken takes a list holding our audience as well. The edge writes a single string.
        if text("aud").is_none() || text("kind") != Some("webhook") || text("sub").is_none_or(str::is_empty) {
            return Err(INVALID);
        }
        let workspace_id = text("wid").ok_or(INVALID)?;
        // A provider this version doesn't know matches nothing.
        let provider = text("provider")
            .and_then(Provider::from_name)
            .filter(|provider| providers.contains(provider))
            .ok_or(Unauthorized("not a webhook this route takes"))?;
        let pattern = text("pattern").filter(|p| !p.is_empty()).ok_or(INVALID)?;
        // Left out where the provider signs no id or no time. When there, each is what the edge writes.
        let delivery = match claims.get("delivery") {
            None => None,
            Some(Value::String(delivery)) if !delivery.is_empty() => Some(delivery.clone()),
            Some(_) => return Err(INVALID),
        };
        let signed_at = claims.get("signed_at").map(|value| whole_seconds(value).ok_or(INVALID)).transpose()?;
        Ok(Webhook {
            provider,
            pattern: pattern.to_owned(),
            delivery,
            signed_at,
            workspace_id: workspace_id.to_owned(),
        })
    }

    /// The checks every token gets, whoever it's for: signature, issuer, audience, times, claim
    /// names.
    async fn claims(&self, token: &str, audience: &str) -> Result<Map<String, Value>, Unauthorized> {
        const INVALID: Unauthorized = Unauthorized("invalid identity token");
        let header = jsonwebtoken::decode_header(token).map_err(|_| INVALID)?;
        // alg is pinned to RS256 regardless of what the header says.
        if header.alg != Algorithm::RS256 {
            return Err(INVALID);
        }
        let kid = header.kid.ok_or(INVALID)?;
        let key = self.keys.key(&kid).await?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[audience]);
        validation.set_issuer(&[&self.config.issuer]);
        validation.set_required_spec_claims(&["iss", "aud", "sub"]);
        // exp/nbf are checked below against our own clock, so tests can set it.
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.leeway = 0;
        let claims = jsonwebtoken::decode::<Map<String, Value>>(token, &key, &validation).map_err(|_| INVALID)?.claims;
        // Go's JSON decoder matches "EXP" to exp, so every SDK refuses names like it to stay in step.
        if claims
            .keys()
            .any(|name| name != &name.to_ascii_lowercase() && CLAIM_NAMES.contains(&name.to_ascii_lowercase().as_str()))
        {
            return Err(INVALID);
        }

        let now = (self.now)();
        let time = |name: &str| claims.get(name).map(|v| v.as_u64().ok_or(INVALID)).transpose();
        time("iat")?.ok_or(INVALID)?;
        let (exp, nbf) = (time("exp")?.ok_or(INVALID)?, time("nbf")?);
        if now >= exp || nbf.is_some_and(|nbf| now < nbf) {
            return Err(INVALID);
        }
        Ok(claims)
    }
}

fn token_in(headers: &HeaderMap) -> Result<&str, Unauthorized> {
    headers
        .get(IDENTITY_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|t| !t.is_empty())
        .ok_or(Unauthorized("no identity token"))
}

/// A webhook's token is addressed to `webhook:<app id>`, never to the app id alone, so a check
/// written for people can't take a delivery for someone signed in.
const WEBHOOK_AUDIENCE: &str = "webhook:";

/// The largest integer every language reading a JSON number is sure to get back as written.
const MAX_EXACT: u64 = (1 << 53) - 1;

/// A whole, non-negative number of seconds. JSON has one number type, so 5.0 is 5 here as it is in
/// the SDKs that can't tell them apart.
fn whole_seconds(value: &Value) -> Option<u64> {
    let seconds = match value.as_u64() {
        Some(seconds) => seconds,
        None => {
            let seconds = value.as_f64()?;
            if seconds < 0.0 || seconds.fract() != 0.0 || seconds > MAX_EXACT as f64 {
                return None;
            }
            seconds as u64
        }
    };
    (seconds <= MAX_EXACT).then_some(seconds)
}

/// The edge's claim names, in the case it writes them.
const CLAIM_NAMES: [&str; 15] = [
    "iss",
    "aud",
    "sub",
    "exp",
    "iat",
    "nbf",
    "jti",
    "kind",
    "email",
    "role",
    "wid",
    "provider",
    "pattern",
    "delivery",
    "signed_at",
];

/// The edge's public keys, cached for five minutes, with unknown-kid refetches limited to one
/// per ten seconds.
pub struct KeySet {
    url: String,
    fetch: Fetch,
    now: Clock,
    /// Single-flight fetch.
    fetching: Mutex<Option<u64>>,
    keys: std::sync::RwLock<Cached>,
}

#[derive(Default)]
struct Cached {
    keys: HashMap<String, DecodingKey>,
    fetched_at: Option<u64>,
}

impl Cached {
    fn lookup(&self, kid: &str, now: u64) -> (Option<DecodingKey>, bool) {
        let fresh = self.fetched_at.is_some_and(|at| now.saturating_sub(at) < MAX_AGE_SECONDS);
        (self.keys.get(kid).cloned(), fresh)
    }
}

impl KeySet {
    /// Fetches over HTTP(S) with a short timeout.
    pub fn new(url: &str) -> Self {
        Self::with_fetch(url, Arc::new(http_fetch), Arc::new(system_clock))
    }

    pub fn with_fetch(url: &str, fetch: Fetch, now: Clock) -> Self {
        Self {
            url: url.to_owned(),
            fetch,
            now,
            fetching: Mutex::new(None),
            keys: std::sync::RwLock::new(Cached::default()),
        }
    }

    fn lookup(&self, kid: &str, now: u64) -> (Option<DecodingKey>, bool) {
        // Poisoned lock means a panic mid-update. Treat it as no keys.
        self.keys.read().map(|c| c.lookup(kid, now)).unwrap_or((None, false))
    }

    pub async fn key(&self, kid: &str) -> Result<DecodingKey, Unauthorized> {
        if let (Some(key), true) = self.lookup(kid, (self.now)()) {
            return Ok(key);
        }
        let mut tried = self.fetching.lock().await;
        let now = (self.now)();
        let (mut key, mut fresh) = self.lookup(kid, now);
        // Retry stale keys after a second, unknown kids after ten.
        let wait = if fresh { COOLDOWN_SECONDS } else { RETRY_SECONDS };
        if (!fresh || key.is_none()) && tried.is_none_or(|at| now.saturating_sub(at) >= wait) {
            *tried = Some(now);
            let fetched = (self.fetch)(self.url.clone()).await.and_then(|body| parse_jwks(&body));
            if let Ok(mut cached) = self.keys.write() {
                match fetched {
                    Ok(keys) => *cached = Cached { keys, fetched_at: Some(now) },
                    Err(_) if !fresh => *cached = Cached::default(),
                    Err(_) => {}
                }
            }
            (key, fresh) = self.lookup(kid, now);
        }
        if !fresh {
            return Err(Unauthorized("couldn't fetch the identity keys"));
        }
        key.ok_or(Unauthorized("unknown signing key"))
    }
}

fn http_fetch(url: String) -> FetchFuture {
    Box::pin(async move {
        let client = client().map_err(|e| e.to_string())?;
        let mut res = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if res.status() != reqwest::StatusCode::OK {
            return Err(format!("JWKS answered {}", res.status()));
        }
        // Read in chunks so a body without Content-Length still hits the size cap.
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            body.extend_from_slice(&chunk);
            if body.len() > MAX_JWKS_BYTES {
                return Err("JWKS too large".into());
            }
        }
        Ok(body)
    })
}

/// The client for that one GET. It trusts the public roots built into it and, on top of them, the
/// certificates in the file `SSL_CERT_FILE` names.
///
/// A platform container's outbound TLS is intercepted, and the platform names the CA it's
/// intercepted with in `SSL_CERT_FILE`, the variable OpenSSL, Go and Python read by themselves.
/// rustls reads no environment, so without this every fetch from a container fails its handshake
/// and every caller is refused.
fn client() -> reqwest::Result<reqwest::Client> {
    let with = |roots: &[reqwest::Certificate]| {
        roots
            .iter()
            .fold(reqwest::Client::builder(), |builder, root| builder.add_root_certificate(root.clone()))
            .timeout(FETCH_TIMEOUT)
            // No redirects. Keys only come from the configured URL.
            .redirect(reqwest::redirect::Policy::none())
            .build()
    };
    let roots = roots_from_env();
    with(&roots).or_else(|_| {
        // One certificate rustls can't read fails the whole build, and a system bundle can carry
        // the odd ancient one. Keep the rest rather than dropping them all with it.
        let usable: Vec<_> = roots.iter().filter(|root| with(std::slice::from_ref(root)).is_ok()).cloned().collect();
        with(&usable)
    })
}

/// What `SSL_CERT_FILE` names, or nothing. A file that isn't there or isn't PEM adds no roots, as
/// it does for OpenSSL: the public ones still check the edge's certificate, so that can only
/// refuse more, never less.
fn roots_from_env() -> Vec<reqwest::Certificate> {
    let Some(path) = std::env::var_os("SSL_CERT_FILE") else { return Vec::new() };
    std::fs::read(path).ok().and_then(|pem| reqwest::Certificate::from_pem_bundle(&pem).ok()).unwrap_or_default()
}

fn parse_jwks(body: &[u8]) -> Result<HashMap<String, DecodingKey>, String> {
    let doc: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let mut keys = HashMap::new();
    for jwk in doc.get("keys").and_then(Value::as_array).into_iter().flatten() {
        let text = |name: &str| jwk.get(name).and_then(Value::as_str);
        let (Some("RSA"), Some(kid), Some(n), Some(e)) = (text("kty"), text("kid"), text("n"), text("e")) else {
            continue;
        };
        if text("use").is_some_and(|u| u != "sig") || text("alg").is_some_and(|a| a != "RS256") {
            continue;
        }
        let Ok(modulus) = URL_SAFE_NO_PAD.decode(n.trim_end_matches('=')) else { continue };
        let bits = modulus
            .iter()
            .position(|b| *b != 0)
            .map_or(0, |i| (modulus.len() - i) * 8 - modulus[i].leading_zeros() as usize);
        if bits < MIN_RSA_BITS {
            continue;
        }
        if let Ok(key) = DecodingKey::from_rsa_components(n, e) {
            keys.insert(kid.to_owned(), key);
        }
    }
    Ok(keys)
}

#[cfg(test)]
mod role_tests {
    use super::{Kind, Role, User};

    fn who(role: &str) -> User {
        User {
            kind: Kind::User,
            sub: "u1".into(),
            email: Some("a@example.com".into()),
            role: role.into(),
            workspace_id: "w1".into(),
        }
    }

    #[test]
    fn an_owner_can_do_what_an_editor_can() {
        let ladder: [(&str, &[Role], &[Role]); 3] = [
            ("viewer", &[Role::Viewer], &[Role::Editor, Role::Owner]),
            ("editor", &[Role::Viewer, Role::Editor], &[Role::Owner]),
            ("owner", &[Role::Viewer, Role::Editor, Role::Owner], &[]),
        ];
        for (role, allowed, refused) in ladder {
            for least in allowed {
                assert!(who(role).has_role(*least), "{role} should be at least {least}");
            }
            for least in refused {
                assert!(!who(role).has_role(*least), "{role} should not be {least}");
            }
        }
    }

    // If the platform ever adds a role, an app built against an older SDK must refuse rather than
    // guess what it allows.
    #[test]
    fn a_role_this_version_doesnt_know_allows_nothing() {
        for unknown in ["superuser", "", "OWNER", "admin"] {
            assert!(!who(unknown).has_role(Role::Viewer), "{unknown} allowed something");
        }
    }

    #[test]
    fn require_role_says_which_one() {
        assert!(who("owner").require_role(Role::Editor).is_ok());
        let refused = who("viewer").require_role(Role::Editor).expect_err("a viewer is not an editor");
        assert_eq!(refused.to_string(), "forbidden: this needs editor");
    }
}
