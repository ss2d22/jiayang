# Changelog

## 0.2.0 - 2026-10-06

- `User` has `AgentName`: the name of the workspace's agent that made the request, or empty for a
  person, a bypass token or a scheduled job. `user.IsAgent()` says whether an agent called. Decide
  what an agent may do by `Sub`, which is `agent:<agent id>`; the name can change.
- `User` marshals `agent_name` too, `null` when empty, as the other SDKs write it.
- An agent's identity token with no name, an empty one, or an empty agent id is refused, as a
  person's with no email is. The platform always sends one.
- A `User` written as an unkeyed literal (`User{"user", ...}`) no longer compiles. Name the fields.

## 0.1.2 - 2026-10-01

- The README is rewritten in plain words. Nothing in the SDK's behaviour changed.

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
