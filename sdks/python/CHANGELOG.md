# Changelog

## 0.1.0 - 2026-09-25

First release, so there is nothing to upgrade from.

- `require_user` and `verify_identity` check the identity token the platform sends with a person's
  or a bypass token's request, with Flask, FastAPI, Django, Streamlit and Gradio integrations.
- `require_webhook` and `verify_webhook` check the token it sends with a webhook delivery whose
  signature it verified, and name the provider. The integrations are `webhook_required` and
  `get_webhook` for Flask, the `webhook` dependency for FastAPI, and `webhook_required` for Django,
  which exempts its view from the CSRF check. `jiayang.aio` has both calls. Each kind of token is
  refused where the other is expected.
