# jiayang (Go)

Verifies who is calling your Jiayang Cloud app. Full docs: https://jiayang.cloud/docs/sdks/go/

The edge sends a 60-second identity token in `X-Jiayang-Identity` on every request it lets through.
This package checks the RS256 signature against the platform's keys, plus issuer, audience (your
app) and expiry, and gives you the caller. A missing or bad token is refused, and so is a request
that only carries `X-Jiayang-Email`.

```sh
go get jiayang.cloud/sdk
```

Needs Go 1.25 or newer to fetch: the module lives in a subdirectory of its repository, and 1.25 is
where the go command learned to follow a `go-import` meta tag that says so ([Go 1.25 release
notes]).

```go
import jiayang "jiayang.cloud/sdk"

http.Handle("/", jiayang.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	user, _ := jiayang.UserFrom(r.Context())
	fmt.Fprintf(w, "hello %s\n", user.Email)
})))
```

Or call `user, err := jiayang.RequireUser(r)` in a handler. Every refusal matches
`errors.Is(err, jiayang.ErrUnauthorized)`.

`jiayang.Requires(jiayang.RoleEditor)` is the same middleware for a route only some callers may
reach: 401 without an identity, 403 with one that isn't enough. In a handler,
`jiayang.RequireRole(user, jiayang.RoleEditor)` returns an error matching
`errors.Is(err, jiayang.ErrForbidden)`, and `HasRole` asks without returning one.

## Your router

`Middleware` and `Requires` are plain `func(http.Handler) http.Handler`, which is what most Go
routers take.

```go
// chi
r.Use(jiayang.Middleware)
r.With(jiayang.Requires(jiayang.RoleEditor)).Post("/orders", placeOrder)

// echo
e.Use(echo.WrapMiddleware(jiayang.Middleware))

// gin, whose middleware has a shape of its own
r.Use(func(c *gin.Context) {
	user, err := jiayang.RequireUser(c.Request)
	if err != nil {
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	c.Set("user", user)
})
```

## Webhooks

A webhook provider can't sign in, so its route is a public path, opened in the dashboard (Sharing,
Public paths) along with the provider that signs it and that provider's signing secret. The platform
checks each delivery's signature before your app sees it and sends it on with a token of kind
`webhook`. `RequireWebhook` checks that token and tells you which provider it came from. Your app
never holds the signing secret.

```go
mux := http.NewServeMux()
// Outside Middleware, which would refuse the delivery before this handler saw it.
mux.Handle("POST /hooks/stripe", jiayang.WebhookMiddleware(jiayang.ProviderStripe)(http.HandlerFunc(stripeHook)))
mux.Handle("/", jiayang.Middleware(app))

func stripeHook(w http.ResponseWriter, r *http.Request) {
	hook, _ := jiayang.WebhookFrom(r.Context())
	if handled(hook.Delivery) { // Stripe's event id
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var event struct {
		Type string `json:"type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	// ...
	w.WriteHeader(http.StatusNoContent)
}
```

Or call `hook, err := jiayang.RequireWebhook(r, jiayang.ProviderStripe)` in a handler. With chi,
give the webhook's route its own middleware rather than the router's `Use`:

```go
r.Group(func(r chi.Router) {
	r.Use(jiayang.Middleware)
	r.Get("/", index)
})
r.With(jiayang.WebhookMiddleware(jiayang.ProviderStripe)).Post("/hooks/stripe", stripeHook)
```

Name the provider or providers the route takes: `ProviderStripe`, `ProviderGitHub`,
`ProviderSlack`, `ProviderShopify`, `ProviderStandardWebhooks` or `ProviderHMACSHA256`. A delivery
from any other is refused, and so is every delivery when none is named, so a Stripe route can't be
handed a GitHub delivery after a pattern is widened. `RequireUser` refuses a webhook's token and
`RequireWebhook` refuses a person's; each refusal matches `errors.Is(err, jiayang.ErrUnauthorized)`.

`hook.Pattern` is the public path it came in on, such as `/hooks/stripe` or `/hooks/*`.
`hook.Delivery` is the provider's signed id for it and `hook.SignedAt` the signed time, each where
the provider signs one (Stripe, Slack events, Standard Webhooks) and empty or zero otherwise. The
body arrives as the provider sent it, so decode it however you like.

What the token doesn't cover:

- Signed deliveries reach your app with a webhook token, and `RequireWebhook` refuses everything
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
  so dedupe on `Delivery` there as well.

## Configuration

The platform sets `JIAYANG_APP_ID`, `JIAYANG_IDENTITY_ISSUER` and `JIAYANG_JWKS_URL`. If any is
missing, or the keys can't be fetched, every request is refused.

`user.Kind` is `"user"` (with `Email`) or `"service"` for a bypass token (`Email` is empty).
`user.Role` is the caller's access to this app.

`User` and `Webhook` marshal to JSON with the names the Python and Rust SDKs use (`workspace_id`,
`signed_at`). An empty email or delivery id is `null`, and `signed_at` is unix seconds or `null`.

Tests: `go test ./...`

[Go 1.25 release notes]: https://go.dev/doc/go1.25#tools
