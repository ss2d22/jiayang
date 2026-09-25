# Changelog

## 0.1.1 - 2026-09-25

- `Requires` answers its 403, `forbidden: this needs editor`, with no newline after it, the same
  body every SDK answers.

## 0.1.0 - 2026-09-25

First release, so there is nothing to upgrade from.

- `RequireUser`, `Verify`, `Middleware` and `Requires` check the identity token the platform sends
  with a person's or a bypass token's request.
- `RequireWebhook`, `VerifyWebhook` and `WebhookMiddleware` (with `WebhookFrom`) check the token it
  sends with a webhook delivery whose signature it verified, and name the provider. Each kind of
  token is refused where the other is expected.
- `User` and `Webhook` marshal to JSON with the names the Python and Rust SDKs use: `kind`, `sub`,
  `email`, `role` and `workspace_id`, and `provider`, `pattern`, `delivery`, `signed_at` and
  `workspace_id`. An empty email or delivery id is `null`, and `signed_at` is unix seconds or
  `null`.
