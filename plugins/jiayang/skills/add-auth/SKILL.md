---
name: add-auth
description: Make an app on Jiayang Cloud identify its caller properly, by verifying the identity token with the SDK. Use when an app needs to know who is using it, show a name, or allow some people more than others.
---

# Identify the caller

Every request that reaches an app on this platform has already passed the platform's sign-in. The
edge signs a 60-second token naming the caller and sends it as `X-Jiayang-Identity`. The app
verifies that token with the SDK.

Don't trust a header on its own. `X-Jiayang-Email` is for display, and an app that trusts it
trusts anyone who can reach it. The platform sends no role header; the role is in the verified
token. (`jiayang dev` also sends `X-Jiayang-Role`, for display there only. Never read it.)

Install the SDK for the language. It is published only under these names:

| Language | Install | Import |
|---|---|---|
| JS/TS: Workers, Node, Next.js, Express, Deno, Bun | `npm install @jiayang-cloud/sdk` | `@jiayang-cloud/sdk`, `@jiayang-cloud/sdk/next`, `@jiayang-cloud/sdk/express` |
| Python | `pip install jiayang`, or `jiayang[flask]`, `[fastapi]`, `[django]`, `[streamlit]`, `[gradio]` | `jiayang`, `jiayang.flask`, `jiayang.fastapi`, ... |
| Go (1.25 or newer) | `go get jiayang.cloud/sdk` | `import jiayang "jiayang.cloud/sdk"` |
| Rust | `cargo add jiayang`, with `--features axum` for the extractor and layer | `jiayang` |

The Go module is `jiayang.cloud/sdk`. Fetching it by its GitHub path fails with a module path
mismatch.

Then verify the caller:

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

Python has a module per framework, each following that framework's conventions:

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

The SDK returns the caller's email (absent for a machine), their kind (`user` or `service`), their
role (`viewer`, `editor` or `owner`) and their workspace's id. The field names in each language:

| | Email | Kind | Role | Workspace |
|---|---|---|---|---|
| JS/TS | `email` | `kind` | `role` | `workspaceId` |
| Python | `email` | `kind` | `role` | `workspace_id` |
| Go | `Email` | `Kind` | `Role` | `WorkspaceID` |
| Rust | `email` | `kind` | `role` | `workspace_id` |

A webhook's delivery carries a token too, of kind `webhook`, and `requireUser` refuses it. Its route
checks it with `requireWebhook()` from the same SDK and has to be mounted where an app-wide user
check never sees it: in Express, before `app.use(requireUser())`. The webhooks skill covers the
rest.

Answer 401 when the caller isn't identified, and 403 when they are identified but not allowed.

The platform sets `JIAYANG_APP_ID`, `JIAYANG_IDENTITY_ISSUER` and `JIAYANG_JWKS_URL` for the app.
If any is missing, or the keys can't be fetched, the SDK refuses every request.

Locally, `jiayang dev -- <your start command>` runs the same front door on your machine and signs
real tokens with a key made for that run, so the app runs the same code as in production. The
SDKs have no development mode and can't skip a signature.

When you're done, `call_app` as yourself and check the app says who you are.
