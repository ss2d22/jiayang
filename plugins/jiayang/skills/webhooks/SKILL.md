---
name: webhooks
description: Let a third party (Stripe, GitHub, Slack, Shopify, a Standard Webhooks sender such as Resend, or anything that signs with HMAC-SHA256) deliver webhooks to one path of an app on Jiayang Cloud, with the platform checking each signature. Use when an app needs to receive a webhook or callback.
---

# Webhooks

Apps are unreachable except through the platform's sign-in. A webhook sender can't sign in, so one
path has to be opened to the internet, and only that path. The platform checks the sender's
signature on that path before the app sees anything, so the app never holds the provider's signing
secret.

**You can't open the path or set up its verifier.** Both take a person signed in to the dashboard.
That is on purpose: an agent that can open an app, or change what a stranger's request needs to get
in, is an agent that can be talked into it. Your job is to get the app right and tell the person
exactly what to do.

1. **Build the endpoint.** One path doing one thing: `/hooks/stripe`, not `/api/*`. Deliveries
   arrive as POST.

2. **Check the platform's token, not the provider's signature.** Once the person has added a
   verifier, the platform checks each delivery's signature and sends it on unchanged, with an
   `X-Jiayang-Identity` token of kind `webhook`. In the handler:

   ```js
   import { requireWebhook, Unauthorized } from "@jiayang-cloud/sdk";
   const hook = await requireWebhook(request, env, { provider: "stripe" }); // throws Unauthorized
   ```

   Python `require_webhook(request.headers, provider="stripe")`, Go
   `jiayang.RequireWebhook(r, jiayang.ProviderStripe)`, Rust
   `verifier.require_webhook(&headers, &[Provider::Stripe]).await?`. Answer 401 when it refuses. The
   providers are `stripe`, `github`, `slack`, `shopify`, `standard_webhooks` and `hmac_sha256`; name
   only the one that sends to this route.

   Mount the route where app-wide user checks never see it, since `requireUser` refuses a webhook's
   token: in Express or Hono, register it before `app.use(requireUser())` or
   `app.use("*", jiayang())`; in Go, outside `jiayang.Middleware`, with
   `jiayang.WebhookMiddleware(jiayang.ProviderStripe)` on the route itself; in axum, a router of its
   own behind `JiayangWebhook`, merged after the user layer. FastAPI, Flask and Django check per
   route already (`jiayang.django.webhook_required` also exempts the view from CSRF). The body
   arrives byte for byte as the provider sent it, so parse it the normal way.

   Keep the check even though the platform verifies: a route without it takes unchecked requests
   for up to a minute after a verifier is added, for good once one is removed, and on any path that
   a more specific unverified pattern decides.

3. **Make a repeat harmless.** `hook.delivery` is the provider's signed id where it signs one
   (Stripe's event id, Slack's `event_id`, the Standard Webhooks message id): skip one you've
   handled. GitHub, Shopify and plain HMAC senders sign no time, so anyone holding a copy of a
   delivery can send it again at any time, with the query string and any header but the signature
   changed. Act on what the signed body says, never on `X-GitHub-Event`, `X-Shopify-Topic` or
   another header, and make handling a delivery twice safe.

4. **The app holds no signing secret.** Don't read one from the environment, don't put one in
   `set_env` or `set_secret`, and never ask the person to paste one to you. `set_env` refuses a
   `whsec_` value or a name like `STRIPE_WEBHOOK_SECRET`, and its refusal says where it goes.

5. **Deploy, then ask the person to open and verify the path in one step.** Tell them: in the
   dashboard, the app's Sharing tab, Public paths, enter `/hooks/stripe`, choose Stripe under
   "Who sends to it?", press Open it, and paste the signing secret from Stripe (Workbench, Webhooks,
   your endpoint, Reveal secret). The dialog shows the address to give Stripe, which is
   `<apps domain>/<workspace>/<app>/hooks/stripe`, never the app's own address. For GitHub and
   generic senders the person chooses the secret, and the dialog can generate one to paste in both
   places. `list_public_paths` shows what's open, and which provider verifies each path.

6. **Check it.** A test delivery from the provider reaches the app (the path's row in the dashboard
   says it was let through), a request with no signature gets 401 from the platform, and every
   other path still needs a sign-in.

If the provider isn't one of these and doesn't sign the raw body with plain HMAC-SHA256, tell the
person the platform can't check it. The path would be opened with "Nobody I can verify", nothing
arrives with a token, and the endpoint must do nothing a stranger could abuse.

An open path and every change to its verifier are in the audit log, and the person can remove the
verifier or close the path in the same place.
