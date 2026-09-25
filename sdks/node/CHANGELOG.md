# Changelog

## 0.1.0 - 2026-09-25

First release, so there is nothing to upgrade from.

- `requireUser` and `verifyIdentity` check the identity token the platform sends with a person's or
  a bypass token's request, with Express, Hono, Next and `node:http` adapters.
- `requireWebhook` and `verifyWebhook` check the token it sends with a webhook delivery whose
  signature it verified, and name the provider. The adapters are `requireWebhook` for Express and
  Next, `webhook` and `getWebhook` for Hono, and `requireWebhookFrom` for Node's own headers. Each
  kind of token is refused where the other is expected.
