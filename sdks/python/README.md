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

Headers in any shape: a mapping, Django's `request.META`, anything with `.get`.

The platform sets `JIAYANG_APP_ID`, `JIAYANG_IDENTITY_ISSUER` and `JIAYANG_JWKS_URL`. If any is
missing, or the keys can't be fetched, every request is refused.

`user.kind` is `"user"` (with `email`) or `"service"` for a bypass token (`email` is `None`).
`user.role` is the caller's access to this app: `viewer`, `editor` or `owner`, in that order.
`require_role(user, "editor")` raises `Forbidden`; `has_role` asks without raising.

## Your framework

Each of these only needs its own framework. Install `jiayang[flask]`, `jiayang[fastapi]`,
`jiayang[django]`, `jiayang[streamlit]` or `jiayang[gradio]` to say so.

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

No identity is 401, too little role is 403, and neither reaches the view. `get_user()` returns the
caller or `None`, for a page that would rather render than refuse.

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

`optional_user` is the dependency that answers `None` instead of refusing. These verify
asynchronously, as `jiayang.aio` below does.

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

The middleware sets `request.jiayang_user` to the caller or `None`, and refuses nothing by itself,
so an app can have a public page and a private one. `login_required` and `role_required` are what
refuse: 401 without an identity, 403 with too little role. Import them from `jiayang.django`:
Django's own `login_required` checks Django's sessions and redirects to `LOGIN_URL`.

### Streamlit

```python
from jiayang.streamlit import get_user

user = get_user()
if user is None:
    st.error("sign in to use this")
    st.stop()
```

Verified once per session and remembered. Streamlit only sees the headers of the request that
opened the session, and an identity token is good for sixty seconds, so checking again on the next
rerun would refuse a caller who never left. Nothing is lost by remembering: the edge closes the
connection within a minute of someone's access being taken away.

### Gradio

```python
from jiayang.gradio import require_user

def answer(question, request: gr.Request):
    user = require_user(request)
    ...
```

Gradio passes `None` for a handler reached through the API or a cached example. That's a caller the
app knows nothing about, so it's refused.

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

The body arrives as the provider sent it, and nothing needs its raw bytes any more, so read it
however the framework does.

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

With Flask-WTF's `CSRFProtect`, exempt the route: a provider has no CSRF token to send, and the
platform's token is what lets the delivery in.

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
`webhook_required` exempts its view from Django's CSRF check for the same reason as above.

What the token doesn't cover:

- Signed deliveries reach your app with a webhook token, and `require_webhook` refuses everything
  else. A route that skips it is open to anyone: for up to a minute after a verifier is added, for
  good once one is removed, if the platform ever rolls its edge back, and on any path that a more
  specific pattern with no verifier decides. A path in another case (`/Hooks/Stripe`) goes to whatever pattern
  matches it and arrives with no token.
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
from fastapi import Request
from jiayang.aio import require_user

@app.get("/")
async def index(request: Request):
    user = await require_user(request.headers)
```

Tests: `uv run --frozen python -m unittest discover -s tests`
