---
name: add-auth
description: Make an app on Jiayang Cloud identify its caller properly, by verifying the identity token with the SDK. Use when an app needs to know who is using it, show a name, or allow some people more than others.
---

# Know who is calling

Every request that reaches an app on this platform has already been through the platform's
sign-in. The edge signs a 60-second token naming the caller and sends it as `X-Jiayang-Identity`.
The app's job is to verify it.

**The header alone proves nothing.** `X-Jiayang-Email` is for display. An app that trusts it
trusts whoever can reach it. Verify the token; the SDK does the rest. The platform sends no role
header: the role is in the verified token. (`jiayang dev` also sends `X-Jiayang-Role`, for display
there only, so never read it.)

Install the SDK for the language. These are the only names it's published under, so don't guess
another:

| Language | Install | Import |
|---|---|---|
| JS/TS: Workers, Node, Next.js, Express, Deno, Bun | `npm install @jiayang-cloud/sdk` | `@jiayang-cloud/sdk`, `@jiayang-cloud/sdk/next`, `@jiayang-cloud/sdk/express` |
| Python | `pip install jiayang`, or `jiayang[flask]`, `[fastapi]`, `[django]`, `[streamlit]`, `[gradio]` | `jiayang`, `jiayang.flask`, `jiayang.fastapi`, ... |
| Go (1.25 or newer) | `go get jiayang.cloud/sdk` | `import jiayang "jiayang.cloud/sdk"` |
| Rust | `cargo add jiayang`, with `--features axum` for the extractor and layer | `jiayang` |

The Go module is `jiayang.cloud/sdk`, not a GitHub path: fetching it by where its source lives
fails with a module path mismatch.

Then:

```js
// Workers, or anything with fetch
import { requireUser, requireRole, Unauthorized, Forbidden } from "@jiayang-cloud/sdk";
const user = await requireUser(request, env);       // throws Unauthorized
requireRole(user, "editor");                        // throws Forbidden
```

```js
// Next.js
import { getUser } from "@jiayang-cloud/sdk/next";
const user = await getUser();                       // null rather than throwing
```

```js
// Express
import { requireUser } from "@jiayang-cloud/sdk/express";
app.use(requireUser());                             // 401 before the handler
```

Python has a module per framework, and each one works the way its framework does:

```python
# Flask: a refused request never reaches the view
from jiayang.flask import current_user, login_required

@app.get("/")
@login_required                                            # @login_required(role="editor") to need more
def index():
    return f"hello {current_user.email}"
```

```python
# FastAPI: dependencies that answer 401 or 403 before the handler runs
from typing import Annotated
from fastapi import Depends
from jiayang import User
from jiayang.fastapi import CurrentUser, requires

@app.get("/")
async def index(user: CurrentUser): ...

@app.post("/orders")
async def place_order(user: Annotated[User, Depends(requires("editor"))]): ...
```

```python
# Django: the middleware verifies, and a view says what it needs
MIDDLEWARE = ["jiayang.django.JiayangMiddleware", ...]

from jiayang.django import login_required, role_required

@login_required                                            # request.jiayang_user is the caller
def account(request): ...

@role_required("editor")
def place_order(request): ...
```

```python
# Streamlit: verified once per session
from jiayang.streamlit import get_user                    # or require_user(), which raises

user = get_user()
if user is None:
    st.error("sign in to use this")
    st.stop()
```

```python
# Gradio: a handler asks for the request by type
from jiayang.gradio import require_user

def answer(question, request: gr.Request):
    user = require_user(request)
    return f"{user.email} asked: {question}"
```

```go
http.Handle("/", jiayang.Middleware(handler))              // jiayang.Requires(jiayang.RoleEditor) to gate one route
user, _ := jiayang.UserFrom(r.Context())                   // in the handler
```

```rust
let verifier = jiayang::Verifier::from_env()?;             // once, at startup
let user = verifier.require_user(&headers).await?;         // or the `axum` feature's layer
```

What the SDK gives back: the caller's email (absent for a machine), their kind (`user` or
`service`), their role (`viewer`, `editor` or `owner`) and their workspace's id. Each language
spells them its own way:

| | Email | Kind | Role | Workspace |
|---|---|---|---|---|
| JS/TS | `email` | `kind` | `role` | `workspaceId` |
| Python | `email` | `kind` | `role` | `workspace_id` |
| Go | `Email` | `Kind` | `Role` | `WorkspaceID` |
| Rust | `email` | `kind` | `role` | `workspace_id` |

A webhook's delivery carries a token too, of kind `webhook`, and `requireUser` refuses it. Its route
checks it with `requireWebhook()` from the same SDK and has to be mounted where an app-wide user
check never sees it: in Express, before `app.use(requireUser())`. The webhooks skill has the rest.

Two different refusals, and they mean different things: **401** is "I don't know who you are",
**403** is "I know, and you may not do this". Answer with the right one.

The platform sets `JIAYANG_APP_ID`, `JIAYANG_IDENTITY_ISSUER` and `JIAYANG_JWKS_URL` for the app.
If any is missing, or the keys can't be fetched, every request is refused. That is deliberate.

Locally, `jiayang dev -- <your start command>` puts the same front door in front of the app on
your machine, signing real tokens with a key made for that run, so the same code path runs. There
is no development mode in the SDKs and no way to skip a signature.

Afterwards, `call_app` as yourself and check the app says who you are.
