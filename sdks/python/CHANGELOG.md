# Changelog

## 0.2.0 - 2026-10-06

- `User` has `agent_name`: the name of the workspace's agent that made the request, or `None` for a
  person, a bypass token or a scheduled job. `user.is_agent` says whether an agent called. Decide
  what an agent may do by `sub`, which is `agent:<agent id>`; the name can change.
- An agent's identity token with no name, an empty one, or an empty agent id is refused, as a
  person's with no email is. The platform always sends one.
- `agent_name` defaults to `None`, so code that builds a `User` by hand keeps working.

## 0.1.2 - 2026-10-01

- The README is rewritten in plain words. Nothing in the SDK's behaviour changed.

## 0.1.1 - 2026-09-25

- A 403 says `forbidden: this needs editor` as plain text, the same body every SDK answers: Flask
  and Django said `forbidden: editor` as HTML. FastAPI's is that text as its JSON `detail`.

## 0.1.0 - 2026-09-25

First release, so there is nothing to upgrade from.

- `require_user` and `verify_identity` check the identity token the platform sends with a person's
  or a bypass token's request, with Flask, FastAPI, Django, Streamlit and Gradio integrations.
- `require_webhook` and `verify_webhook` check the token it sends with a webhook delivery whose
  signature it verified, and name the provider. The integrations are `webhook_required` and
  `get_webhook` for Flask, the `webhook` dependency for FastAPI, and `webhook_required` for Django,
  which exempts its view from the CSRF check. `jiayang.aio` has both calls. Each kind of token is
  refused where the other is expected.
