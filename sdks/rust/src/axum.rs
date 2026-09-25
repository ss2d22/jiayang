//! axum, behind the `axum` feature.
//!
//! ```no_run
//! use axum::{Router, routing::{get, post}};
//! use jiayang::{Role, User, Verifier, axum::Jiayang};
//!
//! # fn build() -> Result<Router, jiayang::Unauthorized> {
//! let verifier = Verifier::from_env()?;
//! Ok(Router::new()
//!     .route("/", get(index))
//!     .route("/orders", post(place_order).layer(Jiayang::new(verifier.clone()).requires(Role::Editor)))
//!     .layer(Jiayang::new(verifier.clone()))
//!     .with_state(verifier))
//! # }
//!
//! async fn index(user: User) -> String {
//!     format!("hello {}", user.email.as_deref().unwrap_or(&user.sub))
//! }
//! # async fn place_order(user: User) {}
//! ```
//!
//! [`User`] is an extractor as well, for a route that isn't behind the layer. It needs the
//! [`Verifier`] to be reachable from the router's state, which is what `with_state` above does.
//!
//! A webhook's route goes in a router of its own, merged after the user layer so that layer never
//! sees the delivery:
//!
//! ```no_run
//! use axum::{Router, routing::{get, post}};
//! use jiayang::{Provider, User, Verifier, Webhook, axum::{Jiayang, JiayangWebhook}};
//!
//! # fn build() -> Result<Router, jiayang::Unauthorized> {
//! let verifier = Verifier::from_env()?;
//! let hooks = Router::new()
//!     .route("/hooks/stripe", post(stripe))
//!     .layer(JiayangWebhook::new(verifier.clone(), [Provider::Stripe]));
//! Ok(Router::new()
//!     .route("/", get(index))
//!     .layer(Jiayang::new(verifier.clone()))
//!     .merge(hooks)
//!     .with_state(verifier))
//! # }
//! # async fn index(user: User) {}
//!
//! async fn stripe(hook: Webhook, body: String) {
//!     // hook.delivery is Stripe's event id.
//! }
//! ```

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use ::axum::extract::{FromRef, FromRequestParts};
use ::axum::http::request::Parts;
use ::axum::http::{HeaderMap, Request, StatusCode};
use ::axum::response::{IntoResponse, Response};
use tower::{Layer, Service};

use crate::{Forbidden, Provider, Role, Unauthorized, User, Verifier, Webhook};

/// Why a handler didn't run: 401 about who is calling, 403 about what they may do.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Rejection {
    #[error(transparent)]
    Unauthorized(#[from] Unauthorized),
    #[error(transparent)]
    Forbidden(#[from] Forbidden),
}

impl IntoResponse for Rejection {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            Self::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "unauthorized".to_owned()),
            Self::Forbidden(Forbidden(least)) => (StatusCode::FORBIDDEN, format!("forbidden: this needs {least}")),
        };
        // A refusal is about this caller at this moment. Nothing may keep it.
        (status, [("cache-control", "no-store")], body).into_response()
    }
}

impl<S> FromRequestParts<S> for User
where
    S: Send + Sync,
    Verifier: FromRef<S>,
{
    type Rejection = Rejection;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // Whatever the layer already verified, if it ran. Verifying twice would be two fetches
        // and two answers to the same question.
        if let Some(Vouched(user)) = parts.extensions.get::<Vouched>() {
            return Ok(user.clone());
        }
        Ok(Verifier::from_ref(state).require_user(&parts.headers).await?)
    }
}

/// A caller [`Jiayang`] vouched for.
///
/// Extensions are keyed by type, so a bare `User` in there could have been put there by anything:
/// a test harness, another layer. Only this module can make one of these, so the extractor reading
/// it is reading its own work.
#[derive(Clone)]
struct Vouched(User);

/// Verifies every request that reaches it, and answers the ones it refuses itself.
///
/// The caller goes in the request's extensions as well, so a handler that already has the state
/// can take [`User`] without it being verified a second time.
#[derive(Clone)]
pub struct Jiayang {
    verifier: Verifier,
    least: Option<Role>,
}

impl Jiayang {
    /// A layer that lets through any caller `verifier` accepts.
    pub fn new(verifier: Verifier) -> Self {
        Self { verifier, least: None }
    }

    /// Also refuses a caller who may not do this.
    #[must_use]
    pub fn requires(mut self, least: Role) -> Self {
        self.least = Some(least);
        self
    }

    async fn check(&self, headers: &HeaderMap) -> Result<User, Rejection> {
        let user = self.verifier.require_user(headers).await?;
        if let Some(least) = self.least {
            user.require_role(least)?;
        }
        Ok(user)
    }
}

impl<S> Layer<S> for Jiayang {
    type Service = Verified<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Verified { inner, jiayang: self.clone() }
    }
}

/// What [`Jiayang`] wraps a service in.
#[derive(Clone)]
pub struct Verified<S> {
    inner: S,
    jiayang: Jiayang,
}

impl<S, B> Service<Request<B>> for Verified<S>
where
    S: Service<Request<B>, Response = Response> + Clone + Send + 'static,
    S::Future: Send + 'static,
    B: Send + 'static,
{
    type Response = Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut request: Request<B>) -> Self::Future {
        // The clone that was polled ready is the one that has to be called; the fresh one stays
        // behind for the next request. Calling `self.inner` directly would call a service nobody
        // polled.
        let spare = self.inner.clone();
        let mut ready = std::mem::replace(&mut self.inner, spare);
        let jiayang = self.jiayang.clone();
        Box::pin(async move {
            match jiayang.check(request.headers()).await {
                Ok(user) => {
                    request.extensions_mut().insert(Vouched(user));
                    ready.call(request).await
                }
                Err(refusal) => Ok(refusal.into_response()),
            }
        })
    }
}

impl<S> FromRequestParts<S> for Webhook
where
    S: Send + Sync,
{
    type Rejection = Rejection;

    /// Only what [`JiayangWebhook`] verified. The extractor can't check a token itself: which
    /// providers a route takes is the layer's to say.
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        match parts.extensions.get::<VouchedWebhook>() {
            Some(VouchedWebhook(webhook)) => Ok(webhook.clone()),
            None => Err(Unauthorized("no verified webhook").into()),
        }
    }
}

/// A delivery [`JiayangWebhook`] vouched for. Private for the reason [`Vouched`] is.
#[derive(Clone)]
struct VouchedWebhook(Webhook);

/// Verifies that every request reaching it is a delivery the platform checked from one of its
/// providers, and answers 401 to anything else itself. The delivery goes in the request's
/// extensions, where the [`Webhook`] extractor finds it.
#[derive(Clone)]
pub struct JiayangWebhook {
    verifier: Verifier,
    providers: Arc<[Provider]>,
}

impl JiayangWebhook {
    /// A layer taking deliveries from these providers. With none, it refuses everything.
    pub fn new(verifier: Verifier, providers: impl IntoIterator<Item = Provider>) -> Self {
        Self { verifier, providers: providers.into_iter().collect() }
    }
}

impl<S> Layer<S> for JiayangWebhook {
    type Service = VerifiedWebhook<S>;

    fn layer(&self, inner: S) -> Self::Service {
        VerifiedWebhook { inner, layer: self.clone() }
    }
}

/// What [`JiayangWebhook`] wraps a service in.
#[derive(Clone)]
pub struct VerifiedWebhook<S> {
    inner: S,
    layer: JiayangWebhook,
}

impl<S, B> Service<Request<B>> for VerifiedWebhook<S>
where
    S: Service<Request<B>, Response = Response> + Clone + Send + 'static,
    S::Future: Send + 'static,
    B: Send + 'static,
{
    type Response = Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut request: Request<B>) -> Self::Future {
        // As in Verified::call: the clone that was polled ready is the one to call.
        let spare = self.inner.clone();
        let mut ready = std::mem::replace(&mut self.inner, spare);
        let layer = self.layer.clone();
        Box::pin(async move {
            match layer.verifier.require_webhook(request.headers(), &layer.providers).await {
                Ok(webhook) => {
                    request.extensions_mut().insert(VouchedWebhook(webhook));
                    ready.call(request).await
                }
                Err(refusal) => Ok(Rejection::from(refusal).into_response()),
            }
        })
    }
}
