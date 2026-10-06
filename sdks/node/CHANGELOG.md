# Changelog

## 0.2.0 - 2026-10-06

- A caller has `agentName`: the name of the workspace's agent that made the request, or `null` for
  a person, a bypass token or a scheduled job. `isAgent(user)` says whether an agent called. Decide
  what an agent may do by `sub`, which is `agent:<agent id>`; the name can change.
- An agent's identity token with no name, an empty one, or an empty agent id is refused, as a
  person's with no email is. The platform always sends one.
- `User` has a new required field, so code that builds a `User` by hand (in tests, say) needs
  `agentName: null`. That is why this is 0.2.0.

## 0.1.3 - 2026-10-01

- The README is rewritten in plain words. Nothing in the SDK's behaviour changed.

## 0.1.2 - 2026-09-25

- The Express adapter's 401 and 403 carry `Cache-Control: no-store`, as `toResponse()` already did.
- A 403 says `forbidden: this needs editor` as plain text, the same body every SDK answers, rather
  than `forbidden`.

## 0.1.1 - 2026-09-25

The first version on npm. 0.1.0 was tagged but its publish failed, so it was never released. The
code is the same as 0.1.0 below.

## 0.1.0 - 2026-09-25

First release, so there is nothing to upgrade from.

- `requireUser` and `verifyIdentity` check the identity token the platform sends with a person's or
  a bypass token's request, with Express, Hono, Next and `node:http` adapters.
- `requireWebhook` and `verifyWebhook` check the token it sends with a webhook delivery whose
  signature it verified, and name the provider. The adapters are `requireWebhook` for Express and
  Next, `webhook` and `getWebhook` for Hono, and `requireWebhookFrom` for Node's own headers. Each
  kind of token is refused where the other is expected.
