# Webhooks

Apps on Jiayang Cloud are reachable only through the platform's sign-in, and a webhook sender can't
sign in. So a webhook gets a **public path**: one exact path, like `/hooks/stripe`, or one prefix,
like `/hooks/*`, that anyone can reach. Give the path a **verifier** and the platform checks each
delivery's signature before your app sees it, with a secret your app never holds.

## Setting one up

Only a person signed in to the dashboard can open a path or change its verifier. A CLI token or an
agent can't, on purpose.

1. In the dashboard, open the app's **Sharing** tab and find **Public paths**.
2. Enter the path, choose who sends to it, and press **Open it**.
3. Paste the provider's signing secret. The field is write-only: nobody can read the secret back,
   and it never reaches the app.
4. Give the provider the address the dialog shows: `<apps domain>/<workspace>/<app>/hooks/stripe`.
   The app's own address asks for a sign-in, so a webhook sent there never arrives.
5. Send a test delivery from the provider. The path's row says whether it got through, and why not
   if it didn't.

A change takes effect within a minute. Choosing "Nobody I can verify" opens the path with no check
at all; the app then gets no token and has to treat every request as a stranger's.

## Providers

| Provider | Where the secret is | Signed id (`delivery`) | Signed time |
|---|---|---|---|
| Stripe | Workbench, Webhooks, your endpoint, Reveal secret (`whsec_...`) | the event id | yes |
| GitHub | the webhook's Secret field, which you choose | none | no |
| Slack | your app's settings, Basic Information, Signing Secret | `event_id`, for Events API deliveries | yes |
| Shopify | the app's client secret, or the key under Settings, Notifications, Webhooks | none | no |
| Standard Webhooks | the endpoint's secret at the sender (`whsec_...`) | the message id | yes |
| HMAC-SHA256 | whatever the sender signs with | none | no |

Standard Webhooks covers Svix and the senders built on it, Resend among them. Those send `svix-id`,
`svix-timestamp` and `svix-signature`; the spec's own names are `webhook-id` and the rest. The dialog
asks which. For a generic sender, say which header holds the signature, whether it's hex or base64,
and what comes before it, such as `sha256=`. It has to be HMAC-SHA256 over the raw body. Everyone
who can see the app can read the header name and the prefix, so neither may hold the secret or
anything shaped like a key.

For a provider that signs a time, a delivery signed more than 5 minutes before it arrives is refused,
and so is one whose signed time is more than 5 minutes ahead of the platform's clock. That can be
set from 1 to 10 minutes.

One endpoint per path. Two endpoints at the same provider sign with two secrets, and a verifier holds
one (two while you rotate).

## In your app

The delivery arrives as the provider sent it: method, path, query, headers and the body, byte for
byte. With it comes an `X-Jiayang-Identity` token of kind `webhook`. Check it with the SDK and
answer 401 when it refuses:

```js
import { requireWebhook, Unauthorized } from "@jiayang-cloud/sdk";

const hook = await requireWebhook(request, env, { provider: "stripe" }); // throws Unauthorized
```

```python
from jiayang import require_webhook

hook = require_webhook(request.headers, provider="stripe")  # raises Unauthorized
```

```go
hook, err := jiayang.RequireWebhook(r, jiayang.ProviderStripe)
```

```rust
let hook = verifier.require_webhook(&headers, &[Provider::Stripe]).await?;
```

Name only the providers that send to that route. A delivery from any other is refused, so a Stripe
route can't be handed a GitHub delivery after a pattern is widened. `requireUser` refuses a
webhook's token and `requireWebhook` refuses a person's, so mount the route where app-wide user
checks never see it: before `app.use(requireUser())` in Express, outside `jiayang.Middleware` in Go
(with `jiayang.WebhookMiddleware` on the route), and in a router of its own in axum. Each SDK's
README shows its frameworks.

The body can be parsed the normal way. Nothing needs its raw bytes any more.

The token holds:

| Claim | Value |
|---|---|
| `kind` | `webhook` |
| `aud` | `webhook:<app id>`, which no check for a person accepts |
| `provider` | `stripe`, `github`, `slack`, `shopify`, `standard_webhooks` or `hmac_sha256` |
| `pattern` | the public path it came in on, such as `/hooks/stripe` or `/hooks/*` |
| `delivery` | the provider's signed id, where there is one |
| `signed_at` | the signed time in unix seconds, where the provider signs one |
| `wid` | the workspace's id |

It has no email and no role. A webhook isn't a person.

## What the app still does

The platform refuses a delivery whose signature doesn't hold. Keep `requireWebhook()` in the route
all the same: without it the route takes unchecked requests for up to a minute after a verifier is
added, for good once one is removed, and on any path that a more specific unverified pattern
decides. A verified exact pattern also covers its trailing-slash spelling, `/hooks/stripe/`. An
exact pattern with no verifier opens that one path and not its trailing-slash spelling. Some
frameworks ignore case when they match a route, and Rails reads `/hooks/stripe.json` as the
`/hooks/stripe` route asked for JSON. So a path that gets in under one pattern but matches a
verified one with case ignored, or adds an extension to a verified exact one, like `/hooks/STRIPE`
or `/hooks/stripe.json` under an open `/hooks/*`, is checked by that verifier. Neither case nor an
extension opens a path nothing open covers as written.

Make a repeated delivery harmless:

- On Stripe, Slack and Standard Webhooks the platform refuses a copy of a delivery your app answered
  with a 2xx. One it answered with anything else can arrive again within the tolerance, so skip a
  `delivery` you've already handled.
- GitHub, Shopify and plain HMAC senders sign no time. Anyone holding a copy of a delivery can send
  it again at any time, with the query string and any header but the signature changed. Act on what
  the signed body says, never on `X-GitHub-Event`, `X-Shopify-Topic` or another header, and make
  handling a delivery twice safe.
- A Stripe-Signature header sent twice, where the second has no `t=`, reads as one header with two
  signatures. Every other provider's header sent twice is refused.

## What the platform answers the sender

| Case | Status |
|---|---|
| Anything but POST, or a method override | 401 |
| A signature header missing, over 4 KiB, or not what the provider sends | 401 |
| Signed further from now than the tolerance allows, either way | 401 |
| No signature matches | 401 |
| A copy of a delivery already let through | 401 |
| The verifier, its secret or the app's public paths changed while it was being checked | 401 |
| Body over 1 MiB | 413 |
| The workspace's verified deliveries are over their limit, or the path's are over its share | 429 |
| The workspace is over its plan's limits or suspended | 402 or 403 |
| The platform couldn't check it in time | 503 |

Every 401 reads the same, so a stranger learns nothing about which check failed. The audit log says
which: reason `webhook_refused`, or `webhook_too_large`, with the check in `detail.webhook.failure`
(`method`, `missing_header`, `malformed`, `stale`, `signature`, `replayed`, `unconfigured`,
`rate_limited`, `too_large`). A delivery that got through names the provider as its caller, as
`webhook:stripe` in `jiayang watch`, `jiayang top` and `jiayang audit`.

Verified deliveries don't count toward the workspace's requests, like all traffic to public paths.
A workspace can take bursts of 600 verified deliveries and 10 a second after that; past that the
platform answers 429. Like the 402 and 403, that goes only to a delivery whose signature holds. A
copy of a delivery that already got in doesn't count again, so nobody can use up the workspace's
share by replaying one.

No one path can use all of it. A delivery can verify and still not be yours: anyone can install
your GitHub App or Slack app and have the provider sign their own events to your path. So the
busiest verified path gets the top half of a burst, 300, and the other half is kept for paths that
have had fewer than half as many deliveries in the last minute or so. A flood at one path, however
it's signed, gets that path's deliveries answered 429 and leaves the others room.

Nothing sent to a verified path counts against the address it came from, whether it gets through
or not. Providers send for all their customers from a few shared addresses, and whatever one of
those customers can set up, someone else can too: an endpoint of their own at the same provider,
pointed at your path. Holding the address off would turn your real deliveries away with theirs, so
each delivery is judged on its own.

A flood of forged deliveries at a path can get that path's real deliveries answered 503 while it
lasts. Most providers retry them; GitHub doesn't, so redeliver those from the webhook's **Recent
Deliveries**. A delivery that finds every check it could use busy waits its turn for up to a second
and a half before that, so a short burst turns nothing away. Paths under a flood share half of the
checks between them, and the other half is kept for everyone else's. One workspace's paths under a
flood hold only one of those at a time between them, so a flood at one tenant's paths still leaves
checks for anyone else's path under a flood. Outside a flood, one workspace's paths hold only a few
checks at once between them, however many it has, so no one tenant's deliveries can take them all. A
path counts as under a flood once it has refused about 60 deliveries in a minute, and more than it
let through, so a forged delivery now and then doesn't put it there. A copy of a delivery it let
through in the last minute counts as one it refused. It still gets through, unless the path is under
a flood: then the copy is refused as soon as its signature header is read.

## Rotating a secret

**Rotate secret** on the path's row takes the new secret and keeps the old one accepted for none,
1 hour, 24 hours or 7 days. Stripe signs with both secrets while you roll one there. Shopify can take
up to an hour to switch, so the old secret is kept for at least that long. For the others, change the
secret at the sender within the time you chose. A new secret can take up to five seconds to be
accepted everywhere. **Stop accepting it** ends the old secret early.

**Replace verifier** changes the provider, its settings and the secret at once, and keeps no old
secret. **Remove verifier** leaves the path open with no check. Closing the path removes its verifier
and secret with it.

## From the CLI and agents

```sh
jiayang app public-paths acme/billing
```

prints each open path and, for a verified one, the provider and when its secret was set, never the
secret. `--json` gives the whole record. The MCP server's `list_public_paths` answers the same.
Neither can open a path or change a verifier, and `jiayang env set` refuses a `whsec_` value or a
name like `STRIPE_WEBHOOK_SECRET` until told otherwise: a verifier is where that secret goes.
