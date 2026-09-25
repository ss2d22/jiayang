# jiayang (Rust)

Verifies who is calling your Jiayang Cloud app. Full docs: https://jiayang.cloud/docs/sdks/rust/

The edge signs a 60-second identity token for each request it lets through and sends it in
`X-Jiayang-Identity`. `Verifier::require_user` checks it against the platform's published keys
(signature, RS256 only, issuer, your app as the audience, expiry) and returns the caller.
Anything else, including a missing token or a request that only carries `X-Jiayang-Email`, is
`Unauthorized`.

```sh
cargo add jiayang
```

```rust
// Once, at startup: reads JIAYANG_APP_ID, JIAYANG_IDENTITY_ISSUER and JIAYANG_JWKS_URL.
let verifier = jiayang::Verifier::from_env()?;

// Per request, from any `http::HeaderMap`: axum's, hyper's, your own.
let user = verifier.require_user(&headers).await?;
```

`user.require_role(Role::Editor)` returns `Forbidden`, which is a different answer from
`Unauthorized`: one is about who is calling, the other about what they may do. `has_role` asks
without returning an error.

## axum

```toml
jiayang = { version = "0.1", features = ["axum"] }
```

```rust
use axum::{Router, routing::{get, post}};
use jiayang::{Role, User, Verifier, axum::Jiayang};

let verifier = Verifier::from_env()?;
let app = Router::new()
    .route("/", get(index))
    .route("/orders", post(place_order).layer(Jiayang::new(verifier.clone()).requires(Role::Editor)))
    .layer(Jiayang::new(verifier.clone()))
    .with_state(verifier);

async fn index(user: User) -> String {
    format!("hello {}", user.email.as_deref().unwrap_or(&user.sub))
}
```

The layer verifies before the handler and answers 401 or 403 itself, putting the caller in the
request's extensions. `User` is also an extractor for routes that aren't behind it, which is what
the `with_state(verifier)` is for. Behind the layer it reads what the layer already found rather
than verifying twice.

## Webhooks

A webhook provider can't sign in, so its route is a public path, opened in the dashboard (Sharing,
Public paths) along with the provider that signs it and that provider's signing secret. The platform
checks each delivery's signature before your app sees it and sends it on with a token of kind
`webhook`. `Verifier::require_webhook` checks that token and tells you which provider it came from.
Your app never holds the signing secret.

```rust
use jiayang::Provider;

let hook = verifier.require_webhook(&headers, &[Provider::Stripe]).await?;
// hook.delivery is Stripe's event id. Skip one you've handled.
```

With axum, the webhook's routes get a router of their own behind `JiayangWebhook`, merged after
the user layer so that layer never sees the delivery. The `Webhook` extractor reads only what
`JiayangWebhook` verified.

```rust
use jiayang::{Provider, Webhook, axum::{Jiayang, JiayangWebhook}};

let hooks = Router::new()
    .route("/hooks/stripe", post(stripe))
    .layer(JiayangWebhook::new(verifier.clone(), [Provider::Stripe]));
let app = Router::new()
    .route("/", get(index))
    .layer(Jiayang::new(verifier.clone()))
    .merge(hooks)
    .with_state(verifier);

async fn stripe(hook: Webhook, body: String) -> StatusCode {
    // The body arrives as Stripe sent it; parse it however you like.
    StatusCode::NO_CONTENT
}
```

Name the provider or providers a route takes. A delivery from any other is refused, and so is
every delivery when the list is empty, so a Stripe route can't be handed a GitHub delivery after a
pattern is widened. `require_user` refuses a webhook's token and `require_webhook` refuses a
person's. `Provider::from_name("stripe")` reads a name from your own config.

`hook.pattern` is the public path it came in on, such as `/hooks/stripe` or `/hooks/*`.
`hook.delivery` is the provider's signed id for it and `hook.signed_at` the signed time in unix
seconds, each where the provider signs one (Stripe, Slack events, Standard Webhooks) and `None`
otherwise.

What the token doesn't cover:

- Signed deliveries reach your app with a webhook token, and `require_webhook` refuses everything
  else. A route that skips it is open to anyone: for up to a minute after a verifier is added, for
  good once one is removed, if the platform ever rolls its edge back, and on any path that a more
  specific pattern with no verifier decides. A path in another case (`/Hooks/Stripe`) goes to whatever pattern
  matches it and arrives with no token.
- GitHub, Shopify and plain HMAC senders sign no time, so a captured delivery can be sent again at
  any time, with a different query string and any header but the signature changed. Act on what the
  signed body says, never on `X-GitHub-Event`, `X-Shopify-Topic` or another header, and make that
  safe to repeat.
- On Stripe, Slack and Standard Webhooks the platform refuses a copy of a delivery your app answered
  with a 2xx. Answer with anything else and a copy can get through within the provider's tolerance,
  so dedupe on `delivery` there as well.

## Configuration

The platform sets all three variables for your app. Without them, `from_env` fails and nothing
verifies. Every request is refused while the keys can't be fetched.

The keys are fetched over TLS, trusting the public roots and, on top of them, the certificates in
the file `SSL_CERT_FILE` names. A container's outbound TLS on the platform goes through a proxy
whose CA is in that file, and the platform sets the variable for you.

Tests: `cargo test -p jiayang --all-features`
