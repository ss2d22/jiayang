# Containers

Anything that isn't a static site or a Worker runs as a container: Node servers, Python, Go, Rust,
and anything with a Dockerfile of its own.

A container has no public ingress. It is reachable only through the platform's front door, the
same as everything else, and it never gets a public hostname of its own.

## With a Dockerfile

Yours is used as it stands. Nothing is generated and nothing is rewritten. Listen on `$PORT`.

## Without one

The CLI writes one for you from a template, renders it into a temporary directory, and builds with
`-f`, so your project never gains a file it didn't have. `jiayang dockerfile --write` ejects it into
the project if you'd rather own it.

Every template pins its base images by digest and runs as a non-root user with `PORT=8080`. Node,
Go and Rust build in one stage and run in another, so the compiler and what the build leaves
behind stay out of the image; Python is a single stage. None of them take a build argument or
mount a secret.

| Runtime | Built with | Starts |
|---|---|---|
| Node | npm ci, pnpm via corepack, yarn immutable or bun frozen, from whichever lockfile you have (with none, `npm install`); then `npm run build` if you have one, then dev dependencies pruned | `npm start` |
| Python | `uv sync --frozen` with a `uv.lock`, `poetry install` with a `poetry.lock`, otherwise pip: `requirements.txt`, or the project itself from `pyproject.toml` | see below |
| Go | a static binary, on distroless | the binary |
| Rust | `--locked` release build, on bookworm-slim | the binary |

Python picks its server from what the project depends on:

| | |
|---|---|
| FastAPI | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Flask | `gunicorn app:app --bind 0.0.0.0:$PORT` |
| Django | `gunicorn <project>.wsgi:application --bind 0.0.0.0:$PORT`, with `collectstatic` at build |
| Streamlit | `streamlit run app.py --server.port $PORT --server.address 0.0.0.0 --server.headless true` |
| Gradio | the app, with `GRADIO_SERVER_*` set |

The module is whichever of `main.py`, `app.py` or `server.py` exists. Anything it can't work out
asks you for `container.start`:

```json
{ "version": 1, "container": { "runtime": "python", "start": "uvicorn api.main:app --host 0.0.0.0 --port $PORT" } }
```

A start command you give is run as `sh -c`, so `$PORT` and pipes work. Go is the exception: it
builds on distroless and has no shell at all.

## What never reaches the image

Your `.dockerignore` is used as you wrote it, and these are appended to it:

```
.git  node_modules  .venv  venv  __pycache__  target
.env  .env.*  *.pem  *.key  .dev.vars
Dockerfile  .dockerignore
```

Beyond that, the build refuses to start if it would copy something that looks like a live
credential, and says which file. What those patterns leave out isn't counted, so a `.venv` or a
local `.env` is no reason to refuse; a pattern with no slash in it only matches at the top level,
though, so `config/tls.key` still is:

```
these look like credentials and the build would copy them into the image: config/tls.key, id_rsa.
Tenant code holds no secrets: store them with `jiayang secret set`, then delete the files or list
them in .dockerignore.
```

The appended patterns go in an ignore file beside the generated Dockerfile, and only BuildKit reads
that, so the build always runs with `DOCKER_BUILDKIT=1`. When `docker buildx version` doesn't answer
(podman, an old docker, or a `JIAYANG_DOCKER` without buildx), the check can't count on BuildKit and
goes by your own ignore files alone: add `.env` and `.venv` to `.dockerignore` (and to
`.containerignore`, if you have one), or build with a docker that has buildx.

That check is a speed bump, not a guarantee. Secrets belong in `jiayang secret set`, where they are
held by the platform and injected per request rather than baked into a layer that lives forever.

## Knowing who is calling

A container gets the same 60-second signed identity token as everything else, in
`X-Jiayang-Identity`. Verify it:

```python
from jiayang.fastapi import CurrentUser

@app.get("/")
def home(user: CurrentUser):
    return {"hello": user.email}
```

```go
http.Handle("/", jiayang.Middleware(handler))
```

See the SDK for your language under [`sdks/`](../sdks). The headers beside the token,
`X-Jiayang-Email` and `X-Jiayang-Role`, are for display. The presence of a header proves nothing.

## Picking the driver yourself

Detection can be overridden, but an app does not change driver after it exists, because that would
lose its data. Say so at creation:

```sh
jiayang deploy acme/api ./api --create --kind=container
```
