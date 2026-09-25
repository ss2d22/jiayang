# Changelog

## 0.1.0 - 2026-09-25

First release, so there is nothing to upgrade from.

- `Verifier::require_user` and `Verifier::verify` check the identity token the platform sends with a
  person's or a bypass token's request. The `axum` feature adds the `Jiayang` layer and the `User`
  extractor.
- `Verifier::require_webhook` and `Verifier::verify_webhook` check the token it sends with a webhook
  delivery whose signature it verified, and name the `Provider`. The `axum` feature adds the
  `JiayangWebhook` layer and the `Webhook` extractor. Each kind of token is refused where the other
  is expected.
