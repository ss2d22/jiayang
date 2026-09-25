# Jiayang Cloud

Deploy the app you just built in one step, share it like a document, and see who used it.

```sh
curl -fsSL https://jiayang.cloud/install.sh | sh
jiayang login
jiayang workspace create acme
jiayang deploy acme/hello ./my-app --create
jiayang share acme/hello someone@example.com
```

Your app is live at its own address, reachable only by the people you shared it with. They sign in
with their browser; a script sends a bearer token instead and gets the same checks.

The docs are at https://jiayang.cloud/docs/.

This repository holds the open-source SDKs your app verifies its callers with, the agent plugin,
and the CLI's releases. The `jiayang` CLI is installed as a binary: by the script above, `irm
https://jiayang.cloud/install.ps1 | iex` in PowerShell, `brew install ss2d22/tap/jiayang`, or
`npm install -g jiayang`. Like the platform, it is closed source.

### Updating

`jiayang --version` says which you have, and this repository's releases page lists every version.
Update the same way you installed:

```sh
curl -fsSL https://jiayang.cloud/install.sh | sh      # the script, run again
brew upgrade ss2d22/tap/jiayang                      # Homebrew
npm install -g jiayang@latest                        # npm
```

On Windows, run the PowerShell line above again.

The CLI trusts what your operating system trusts, so behind a proxy that inspects TLS (Zscaler,
Netskope and the like) it works wherever your browser does. If the proxy's CA isn't in the system's
store, point `JIAYANG_CA_FILE` at it, in PEM. The CLI uses `SSL_CERT_FILE` when that isn't set, and
trusts either on top of the system's.

The CLI takes its environment as your own settings, the way git, gh and the AWS CLI do.
`JIAYANG_API`, `JIAYANG_APPS_URL`, `JIAYANG_CONFIG_DIR`, `XDG_CONFIG_HOME`, `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `JIAYANG_CA_FILE` and `SSL_CERT_FILE` decide where it
connects, what it trusts and where your session is kept, so set them only to values you chose. That
includes what a tool like direnv loads from a project's `.envrc`. The CLI never reads a `.env` file
itself, never sends a token to another machine over plain http, never sends traffic for this
machine (localhost and loopback addresses) through a proxy, and `jiayang login` says which API it's
signing in through whenever that isn't `https://api.jiayang.cloud`.

## Knowing who is calling

Every request that reaches your app has already been through the platform's sign-in, and arrives
with a 60-second signed token saying who the caller is. Your app verifies it:

```js
import { requireUser } from "@jiayang-cloud/sdk";
const user = await requireUser(request, env);   // throws Unauthorized
```

```python
from jiayang.flask import current_user, login_required
```

```go
http.Handle("/", jiayang.Middleware(handler))
```

```rust
let user = verifier.require_user(&headers).await?;
```

A webhook can't sign in, so its path is opened in the dashboard with the provider that signs it.
The platform checks each delivery's signature and sends it with a token of kind `webhook`, which
`requireWebhook()` checks: see [docs/webhooks.md](docs/webhooks.md).

`X-Jiayang-Email` and `X-Jiayang-Role` are for display. The presence of a header proves nothing:
verify the token, which is all any of these do for you.

| SDK | Install | Docs | Source |
|---|---|---|---|
| Node, Workers, Deno, Bun | `npm install @jiayang-cloud/sdk` | [Node](https://jiayang.cloud/docs/sdks/node/) | [sdks/node](sdks/node) |
| Python | `pip install jiayang` | [Python](https://jiayang.cloud/docs/sdks/python/) | [sdks/python](sdks/python) |
| Go | `go get jiayang.cloud/sdk` | [Go](https://jiayang.cloud/docs/sdks/go/) | [sdks/go](sdks/go) |
| Rust | `cargo add jiayang` | [Rust](https://jiayang.cloud/docs/sdks/rust/) | [sdks/rust](sdks/rust) |

## Running it locally

`jiayang dev` puts the platform's front door in front of your app on your machine, signing real
tokens with a key made for that run. The SDKs have no development mode and never skip a signature,
so this is how you test the code that matters.

```sh
jiayang dev                      # works out how to start your app
jiayang dev -- npm run dev       # or say it yourself
```

A Worker or a site runs under `wrangler dev`; a site is served as its last build left it. A server
starts the way its image would, here: `npm start`, uvicorn, `flask run`, `manage.py runserver`,
`go run` or `cargo run`. A Dockerfile says how to build an app rather than how to run it on your
machine, so for one of those, say it yourself.

Your app is at http://127.0.0.1:8787, and http://127.0.0.1:8787/.jiayang switches who you are:
any email, any role, or nobody at all.

## From an agent

The CLI is also an MCP server, so the agent that wrote your app can deploy it. The plugin in
[plugins/jiayang](plugins/jiayang) adds it to Claude Code, Codex or Cursor with skills for
deploying, sharing and checking who is calling:

```text
/plugin marketplace add ss2d22/jiayang                  # Claude Code, in a session
/plugin install jiayang-cloud@jiayang-cloud

codex plugin marketplace add ss2d22/jiayang             # Codex
codex plugin add jiayang-cloud@jiayang-cloud
```

Codex starts a plugin's server in the plugin's own folder, so run `export JIAYANG_MCP_ROOTS="$PWD"`
in the project before starting it. In Cursor, add this repository in **Customize** with **From GitHub Repository** and install
Jiayang Cloud.

Any other MCP client can run the server on its own:

```json
{ "mcpServers": { "jiayang-cloud": { "command": "jiayang", "args": ["mcp"] } } }
```

A deploy is one tool call, and it runs your project's build first; a container's or a framework's
can take several minutes. A client that limits how long a tool call may take needs room for that.
In Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.jiayang-cloud]
command = "jiayang"
args = ["mcp"]
tool_timeout_sec = 900
```

Every tool acts as whoever the CLI is signed in as, with your permissions and under your name in
the audit log. Nothing it can do will open an app to the internet. That takes a person in the
dashboard.

## What deploys

`jiayang deploy` works out what your directory is and builds it the way you would:

- static sites and SPA builds
- JS/TS on Workers, and framework apps with Cloudflare adapters: Hono, Next.js, Astro, SvelteKit,
  React Router, Nuxt, the Vite plugin
- servers with no Dockerfile: Node, Python (FastAPI, Flask, Django, Streamlit, Gradio), Go, Rust
- anything with a Dockerfile

`jiayang detect` says what it would do, without doing it.

- [docs/deploying.md](docs/deploying.md): how it decides, `jiayang.json`, environment, limits
- [docs/frameworks.md](docs/frameworks.md): per framework, including Astro's `checkOrigin`
- [docs/containers.md](docs/containers.md): servers, with or without a Dockerfile
- [docs/webhooks.md](docs/webhooks.md): receiving webhooks, with the platform checking each signature

These cover the basics. The full docs are at https://jiayang.cloud/docs/.

## Licence

Everything in this repository is Apache-2.0. See [LICENSE](LICENSE), and the `LICENSE` and `NOTICE`
beside each SDK and the plugin. The CLI binaries published on its releases are proprietary, under the terms at
https://jiayang.cloud/terms.
