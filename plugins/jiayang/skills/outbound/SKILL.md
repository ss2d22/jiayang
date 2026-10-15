---
name: outbound
description: Control which hosts an app on Jiayang Cloud may send requests to, and let it use the workspace's Anthropic or OpenAI key within a monthly budget. Use when the user wants to lock an app down to the services it needs, an outbound request is refused, or an app needs an AI provider.
---

# Outbound requests and AI keys

## Where an app may send requests

Every request an app sends goes through Jiayang Cloud. By default it can reach any host.

1. `outbound_usage` shows where the app actually sent requests over the last 30 days, and what was
   refused. Start there.
2. `allow_outbound_host` adds each host it needs, like `api.stripe.com`, or `*.stripe.com` for
   every host under one.
3. `set_outbound_list` with `on: true` holds the app to its list. Requests to anything else are
   refused within 10 seconds. Check the app still works with `call_app` and `app_logs`.

`list_outbound_hosts` shows the list and whether it's on. `remove_outbound_host` takes a host off.
Turning the list off lets the app reach anywhere again, so only do that when the person asks,
passing the app again as `confirm`.

## AI keys

A workspace can share its Anthropic or OpenAI key with apps. The app never sees the key: its
requests to the provider carry it.

- `list_ai_keys` shows the workspace's keys (only their last four characters) and the apps using
  each. Storing a key is for an owner, with `jiayang ai key set`, never through you.
- `set_ai_budget` lets an app use a key up to a monthly budget in dollars, or stops it with
  `none`. It spends the workspace's money, so only set the budget the person names.
- `list_ai_budgets` shows an app's budgets and this month's spend.

If the app's outbound list is on, it also needs the provider's host on it: `api.anthropic.com` or
`api.openai.com`. The answer says so when it's missing.
