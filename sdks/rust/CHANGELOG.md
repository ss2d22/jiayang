# Changelog

## 0.3.0 - 2026-10-16

- An issuer or key set on http is refused unless `JIAYANG_DEV` is `1`, and even then only on this
  machine (`127.0.0.1`, `localhost` or `[::1]`, and for the keys `host.docker.internal` too).
  `jiayang dev` sets it for the app it runs, from CLI 0.1.11. The platform's issuer and keys are
  https and it never sets `JIAYANG_DEV`, so a deployed app that still points at `jiayang dev`
  refuses everyone, and asks nobody for keys.
- `Config` has a new public field, `dev`, which `Config::from_env` reads from `JIAYANG_DEV`.
  `Verifier::new` refuses an http issuer or key set unless it's true. A `Config { .. }` literal
  needs `dev: false`; `Config` is `Default` now, so `..Default::default()` works too. That is why
  this is 0.3.0.

## 0.2.0 - 2026-10-06

- `User` has `agent_name`: the name of the workspace's agent that made the request, or `None` for a
  person, a bypass token or a scheduled job. `user.is_agent()` says whether an agent called. Decide
  what an agent may do by `sub`, which is `agent:<agent id>`; the name can change.
- An agent's identity token with no name, an empty one, or an empty agent id is refused, as a
  person's with no email is. The platform always sends one.
- `User` has a new public field, so a `User { .. }` literal needs `agent_name: None`. That is why
  this is 0.2.0.

## 0.1.1 - 2026-10-01

- The README is rewritten in plain words. Nothing in the SDK's behaviour changed.

## 0.1.0 - 2026-09-25

First release, so there is nothing to upgrade from.

- `Verifier::require_user` and `Verifier::verify` check the identity token the platform sends with a
  person's or a bypass token's request. The `axum` feature adds the `Jiayang` layer and the `User`
  extractor.
- `Verifier::require_webhook` and `Verifier::verify_webhook` check the token it sends with a webhook
  delivery whose signature it verified, and name the `Provider`. The `axum` feature adds the
  `JiayangWebhook` layer and the `Webhook` extractor. Each kind of token is refused where the other
  is expected.
