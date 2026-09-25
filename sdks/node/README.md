# @jiayang-cloud/sdk

Verifies who is calling your Jiayang Cloud app. Full docs: https://jiayang.cloud/docs/sdks/node/

The edge sends a 60-second identity token in `X-Jiayang-Identity` on every request it lets through.
`requireUser` checks the RS256 signature against the platform's keys, plus issuer, audience (your
app) and expiry, and returns the caller. A missing or bad token throws `Unauthorized`, and so does a
request that only carries `X-Jiayang-Email`.

```sh
npm install @jiayang-cloud/sdk
```

```js
import { requireUser, Unauthorized } from "@jiayang-cloud/sdk";

export default {
	async fetch(request, env) {
		try {
			const user = await requireUser(request, env);
			return new Response(`hello ${user.email}`);
		} catch (err) {
			if (err instanceof Unauthorized) return err.toResponse();
			throw err;
		}
	},
};
```

It runs anywhere with WebCrypto and `fetch`: Workers, Node 20+, Deno and Bun.

`requireRole(user, "editor")` throws `Forbidden`, which is a different answer from `Unauthorized`:
one is about who is calling, the other about what they may do. `hasRole` asks without throwing.
Both refusals have `.toResponse()`.

## Your framework

Each of these is a subpath, so a Next app never loads the Express one.

### Next.js

```ts
import { getUser, requireUser } from "@jiayang-cloud/sdk/next";

export default async function Page() {
	const user = await getUser();
	return <p>hello {user?.email ?? "stranger"}</p>;
}
```

Reads the request's own headers through `next/headers`, in a server component or a route handler.
`requireUser()` throws `Unauthorized` where a route must refuse; `getUser()` answers `null` where a
page would rather render. Pass `headers` yourself to use it somewhere `next/headers` isn't.

### Express

```js
import { requireUser } from "@jiayang-cloud/sdk/express";

app.use(requireUser());
app.get("/", (req, res) => res.send(`hello ${req.user.email}`));
```

401 without an identity, 403 with `requireUser({ role: "editor" })` and a caller who isn't one.
Neither reaches the handler. `withUser()` lets everyone through and sets `req.user` when there is
one. The same shape works for Connect and Fastify's Express plugin.

### Hono

```js
import { getUser, jiayang } from "@jiayang-cloud/sdk/hono";

app.use("*", jiayang());
app.get("/", (c) => c.text(`hello ${getUser(c).email}`));
```

`getUser(c)` throws if the middleware didn't run on that route: a handler asking who is calling
should never be reached without an answer. The platform's variables come from Hono's bindings on
Workers and from `process.env` on Node, Bun and Deno, so the same line works in a container.

### node:http, Koa, anything else

```js
import { envFromProcess, requireUserFrom } from "@jiayang-cloud/sdk/node";

const user = await requireUserFrom(req, envFromProcess());
```

Takes Node-style headers. A token that arrived twice is refused rather than one of them being
picked: the edge sends exactly one, so two means something else put one there.

## Webhooks

A webhook provider can't sign in, so its route is a public path, opened in the dashboard (Sharing,
Public paths) along with the provider that signs it and that provider's signing secret. The platform
checks each delivery's signature before your app sees it and sends it on with a token of kind
`webhook`. `requireWebhook` checks that token and tells you which provider it came from. Your app
never holds the signing secret.

```js
import { requireWebhook, Unauthorized } from "@jiayang-cloud/sdk";

export default {
	async fetch(request, env) {
		if (new URL(request.url).pathname === "/hooks/stripe") {
			try {
				const hook = await requireWebhook(request, env, { provider: "stripe" });
				const event = await request.json();
				// hook.delivery is Stripe's event id. Skip one you've handled.
				return new Response(null, { status: 204 });
			} catch (err) {
				if (err instanceof Unauthorized) return err.toResponse();
				throw err;
			}
		}
		// ...requireUser for everything else
	},
};
```

`provider` is required: one of `stripe`, `github`, `slack`, `shopify`, `standard_webhooks` and
`hmac_sha256`, or a list of them. A delivery from any other provider is refused, so a Stripe route
can't be handed a GitHub delivery after a pattern is widened. `requireUser` refuses a webhook's
token and `requireWebhook` refuses a person's.

It returns `{ provider, pattern, delivery, signedAt, workspaceId }`. `pattern` is the public path it
came in on, such as `/hooks/stripe` or `/hooks/*`. `delivery` is the provider's signed id for it and
`signedAt` the signed time in unix seconds, each where the provider signs one (Stripe, Slack events,
Standard Webhooks) and `null` otherwise.

The body arrives as the provider sent it, and nothing needs its raw bytes any more:
`express.json()` or `await request.json()` is fine.

Mount a webhook's route so app-wide user checks never see it:

```js
// Express: the route first, since app.use(requireUser()) would refuse the delivery.
import { requireUser, requireWebhook } from "@jiayang-cloud/sdk/express";

app.post("/hooks/stripe", express.json(), requireWebhook({ provider: "stripe" }), (req, res) => {
	// req.webhook, req.body
	res.sendStatus(204);
});
app.use(requireUser());
```

```js
// Hono: the same order, before app.use("*", jiayang()).
import { getWebhook, jiayang, webhook } from "@jiayang-cloud/sdk/hono";

app.post("/hooks/stripe", webhook({ provider: "stripe" }), async (c) => {
	const hook = getWebhook(c);
	return c.body(null, 204);
});
app.use("*", jiayang());
```

```ts
// Next.js, app/hooks/stripe/route.ts
import { Unauthorized } from "@jiayang-cloud/sdk";
import { requireWebhook } from "@jiayang-cloud/sdk/next";

export async function POST(request: Request) {
	try {
		await requireWebhook({ provider: "stripe" });
	} catch (err) {
		if (err instanceof Unauthorized) return err.toResponse();
		throw err;
	}
	const event = await request.json();
	return new Response(null, { status: 204 });
}
```

With Node's own headers, `requireWebhookFrom(req, envFromProcess(), { provider: "github" })` from
`/node`, which refuses a token that arrived twice.

What the token doesn't cover:

- Signed deliveries reach your app with a webhook token, and `requireWebhook` refuses everything
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

The platform sets `JIAYANG_APP_ID`, `JIAYANG_IDENTITY_ISSUER` and `JIAYANG_JWKS_URL`. On Workers
they arrive as bindings, which is the `env` you pass; everywhere else they're in `process.env`,
which the `/express`, `/next` and `/hono` entries read for you, and `envFromProcess()` in `/node`
reads for anything else. If any is missing, or the keys can't be fetched, every request is refused.

`user.kind` is `"user"` (with `email`) or `"service"` for a bypass token (`email` is `null`).
`user.role` is the caller's access to this app.

Tests: `pnpm test`
