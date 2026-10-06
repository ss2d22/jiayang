# jiayang (Python)

Verifies who is calling your Jiayang Cloud app. Full docs: https://jiayang.cloud/docs/sdks/python/

The edge sends a 60-second identity token in `X-Jiayang-Identity` on every request it lets through.
`require_user` checks the RS256 signature against the platform's keys, plus issuer, audience (your
app) and expiry, and returns the caller. A missing or bad token raises `Unauthorized`, and so does
a request that only carries `X-Jiayang-Email`.

```sh
pip install jiayang
```

```python
from jiayang import require_user, Unauthorized

@app.get("/")
def index():
    try:
        user = require_user(request.headers)
    except Unauthorized:
        return "unauthorized", 401
    return f"hello {user.email}"
```

It accepts headers in any shape: a mapping, Django's `request.META`, or anything with `.get`.

The platform sets `JIAYANG_APP_ID`, `JIAYANG_IDENTITY_ISSUER` and `JIAYANG_JWKS_URL`. If any is
missing, or the keys can't be fetched, every request is refused.

`user.kind` is `"user"` (with `email`) or `"service"` for a bypass token (`email` is `None`).
A scheduled job is `"service"` too, with a `user.sub` that starts with `"scheduler:"`. Check both
before doing the job: anyone the app is shared with can call the same path.
One of the workspace's agents is `"service"` as well, with a `user.sub` of `"agent:<agent id>"` and
its name in `user.agent_name` (`None` for everyone else). `user.is_agent` says whether an agent
called. Show the name; decide what an agent may do by `sub`, since a name can change.
`user.role` is the caller's access to this app: `viewer`, `editor` or `owner`, in that order.
`require_role(user, "editor")` raises `Forbidden`; `has_role` checks without raising.

## Your framework

Each integration depends only on its own framework. Install it with `jiayang[flask]`,
`jiayang[fastapi]`, `jiayang[django]`, `jiayang[streamlit]` or `jiayang[gradio]`.

### Flask

```python
from jiayang.flask import current_user, get_user, login_required

@app.get("/")
@login_required
def index():
    return f"hello {current_user.email}"

@app.post("/orders")
@login_required(role="editor")
def place_order():
    ...
```

A request with no identity gets 401 and one with too low a role gets 403, before the view runs.
`get_user()` returns the caller or `None`, for a page that should render for anyone.

### FastAPI

```python
from typing import Annotated

from fastapi import Depends
from jiayang import User
from jiayang.fastapi import CurrentUser, requires

@app.get("/")
async def index(user: CurrentUser):
    return {"hello": user.email}

@app.post("/orders")
async def place_order(user: Annotated[User, Depends(requires("editor"))]):
    ...
```

`optional_user` is a dependency that gives `None` instead of refusing. These dependencies verify
asynchronously, like `jiayang.aio` below.

### Django

```python
MIDDLEWARE = ["jiayang.django.JiayangMiddleware", ...]
```

```python
from django.http import HttpResponse
from jiayang.django import login_required, role_required

@login_required
def account(request):
    return HttpResponse(f"hello {request.jiayang_user.email}")

@role_required("editor")
def place_order(request):
    ...
```

The middleware sets `request.jiayang_user` to the caller or `None` and refuses nothing itself, so
an app can have both public and private pages. `login_required` and `role_required` do the
refusing: 401 without an identity, 403 with too low a role. Import them from `jiayang.django`;
Django's own `login_required` checks Django's sessions and redirects to `LOGIN_URL`.

### Streamlit

```python
from jiayang.streamlit import get_user

user = get_user()
if user is None:
    st.error("sign in to use this")
    st.stop()
```

The caller is verified once per session and remembered. Streamlit only sees the headers of the
request that opened the session, and an identity token lasts sixty seconds, so checking again on a
later rerun would refuse a caller who is still there. Remembering is safe because the edge closes
the connection within a minute of someone's access being removed.

### Gradio

```python
import os

import gradio as gr
from jiayang.gradio import require_user

def answer(question, request: gr.Request):
    user = require_user(request)
    return f"{user.email} asked: {question}"

gr.Interface(answer, "textbox", "textbox").launch(
    server_name="0.0.0.0", server_port=int(os.environ.get("PORT", "7860"))
)
```

On the platform the app has to listen on `0.0.0.0` at the port in `PORT`. Gradio's defaults,
`127.0.0.1` and 7860, can't be reached there.

Gradio passes `None` as the request for a handler reached through the API or a cached example.
`require_user` refuses it, since there's no caller to verify.

## Webhooks

A webhook provider can't sign in, so its route is a public path, opened in the dashboard (Sharing,
Public paths) along with the provider that signs it and that provider's signing secret. The platform
checks each delivery's signature before your app sees it and sends it on with a token of kind
`webhook`. `require_webhook` checks that token and tells you which provider it came from. Your app
never holds the signing secret.

```python
from jiayang import Unauthorized, require_webhook

@app.post("/hooks/stripe")
def stripe_hook():
    try:
        hook = require_webhook(request.headers, provider="stripe")
    except Unauthorized:
        return "unauthorized", 401
    event = request.get_json()
    # hook.delivery is Stripe's event id. Skip one you've handled.
    return "", 204
```

`provider` is required: one of `stripe`, `github`, `slack`, `shopify`, `standard_webhooks` and
`hmac_sha256`, or a list of them. A delivery from any other provider is refused, so a Stripe route
can't be handed a GitHub delivery after a pattern is widened. `require_user` refuses a webhook's
token and `require_webhook` refuses a person's.

It returns a `Webhook(provider, pattern, delivery, signed_at, workspace_id)`. `pattern` is the
public path it came in on, such as `/hooks/stripe` or `/hooks/*`. `delivery` is the provider's
signed id for it and `signed_at` the signed time in unix seconds, each where the provider signs one
(Stripe, Slack events, Standard Webhooks) and `None` otherwise. `jiayang.aio` has both as
coroutines.

The body arrives as the provider sent it, and your app doesn't need the raw bytes, so read it the
way the framework usually does.

Each framework checks per route, so a webhook's route and a person's can sit side by side:

```python
# Flask
from jiayang.flask import get_webhook, webhook_required

@app.post("/hooks/stripe")
@webhook_required(provider="stripe")
def stripe_hook():
    hook = get_webhook()
    ...
```

With Flask-WTF's `CSRFProtect`, exempt the route. A provider has no CSRF token to send, and the
platform's token is what authenticates the delivery.

```python
@app.post("/hooks/stripe")
@csrf.exempt
@webhook_required(provider="stripe")
def stripe_hook(): ...
```

```python
# FastAPI
from typing import Annotated

from fastapi import Depends, Request
from jiayang import Webhook
from jiayang.fastapi import webhook

@app.post("/hooks/stripe")
async def stripe_hook(hook: Annotated[Webhook, Depends(webhook("stripe"))], request: Request):
    event = await request.json()
```

```python
# Django
from jiayang.django import webhook_required

@webhook_required(provider="stripe")
def stripe_hook(request):
    hook = request.jiayang_webhook
    event = json.loads(request.body)
    ...
```

`JiayangMiddleware` refuses nothing by itself, so it can stay installed for the whole project.
`webhook_required` exempts its view from Django's CSRF check, for the same reason.

Keep these limits in mind:

- Signed deliveries reach your app with a webhook token, and `require_webhook` refuses everything
  else. A route that skips it accepts anyone's request for up to a minute after a verifier is
  added, permanently once one is removed, if the platform ever rolls its edge back, and on any
  path that a more specific pattern with no verifier matches. A path in another case
  (`/Hooks/Stripe`) goes to whatever pattern matches it and arrives with no token.
- GitHub, Shopify and plain HMAC senders sign no time, so a captured delivery can be sent again at
  any time, with a different query string and any header but the signature changed. Act on what the
  signed body says, never on `X-GitHub-Event`, `X-Shopify-Topic` or another header, and make that
  safe to repeat.
- On Stripe, Slack and Standard Webhooks the platform refuses a copy of a delivery your app answered
  with a 2xx. Answer with anything else and a copy can get through within the provider's tolerance,
  so dedupe on `delivery` there as well.

## async

`require_user` blocks for up to three seconds when it fetches keys, about once every five minutes.
`jiayang.aio` does the same work without stopping the event loop. The fetch goes to a thread, one
at a time, and everything else stays on the loop.

```python
from fastapi import HTTPException, Request
from jiayang import Unauthorized
from jiayang.aio import require_user

@app.get("/")
async def index(request: Request):
    try:
        user = await require_user(request.headers)
    except Unauthorized as err:
        raise HTTPException(401, str(err))
    return {"hello": user.email}
```

Left uncaught, `Unauthorized` becomes a 500. In FastAPI the `CurrentUser` dependency above handles
this for you.

Tests: `uv run --frozen python -m unittest discover -s tests`
