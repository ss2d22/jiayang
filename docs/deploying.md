# Deploying

```sh
jiayang deploy acme/hello ./my-app --create
```

One command for every kind of app. It works out what the directory is, builds it the way you
would, and puts it behind the same front door as everything else.

`jiayang detect` does the working-out and stops, so you can see what it decided before it does
anything. It reads files; it runs nothing and reaches nothing.

```
$ jiayang detect
a Worker (Astro on Cloudflare)
  because package.json depends on @astrojs/cloudflare, builds with `npm run build`
  install: npm ci
  build: npm run build
```

## How it decides

The first rule that matches wins, and every answer carries the reason.

1. `--kind`, then `kind` in `jiayang.json`.
2. A **Dockerfile** and no wrangler config → a container, built as it stands. Both at once is a
   question, not a guess: it stops and asks for `--kind`.
3. A **wrangler config** (`wrangler.jsonc`, `wrangler.json`, `wrangler.toml`) → a Worker.
4. A **Cloudflare adapter** in `package.json` → a Worker, whatever else is there. A project with an
   adapter has already said where it is going.
5. A **static site builder** with no server of its own → the files it builds.
6. A **Node server** (a start script, Express, Fastify, Koa, NestJS, hapi, or a server-rendering
   framework with no Cloudflare adapter) → a container.
7. **Python, Go or Rust** markers → a container.
8. With no `package.json`: a root `index.html` → static; one of today's entry files → a Worker that
   goes up as it stands, no Node needed.
9. Otherwise it stops and lists every signal it looked for.

What "a Cloudflare adapter" means, exactly: `@opennextjs/cloudflare`, `@astrojs/cloudflare`,
`@sveltejs/adapter-cloudflare`, `@sveltejs/adapter-cloudflare-workers`, `@react-router/cloudflare`,
`@cloudflare/vite-plugin`, `nitro-cloudflare-dev`, `@remix-run/cloudflare`, `wrangler`, `hono`,
`@hono/vite-build`.

Same framework, different answer, depending on which adapter is installed. See
[frameworks.md](frameworks.md).

## Saying it yourself

`jiayang.json`, next to the app. Everything is optional; it only overrides what detection would
have decided. Unknown keys are an error rather than a typo that does nothing.

```json
{
  "version": 1,
  "kind": "worker",
  "build": {
    "install": "pnpm install --frozen-lockfile",
    "command": "pnpm build",
    "output": "dist"
  },
  "worker": {
    "main": "dist/index.js",
    "compatibility_date": "2026-09-01",
    "compatibility_flags": ["nodejs_compat"],
    "include": ["dist"],
    "wrangler_config": "wrangler.production.jsonc"
  },
  "container": {
    "runtime": "python",
    "start": "uvicorn app:app --host 0.0.0.0 --port $PORT",
    "port": 8080,
    "instance_type": "standard-1"
  }
}
```

| | |
|---|---|
| `version` | Always `1`. A file without it is the old flat format, and says so, with the rewrite printed. |
| `kind` | `static`, `worker` or `container`. |
| `build.install` | Defaults to your lockfile's install command, and runs only when dependencies are missing. |
| `build.command` | Defaults to the project's own `build` script. |
| `build.output` | Where the build leaves what should be deployed. Without it, a site deploys the first of `dist`, `build`, `out`, `_site`, `.output/public`, `.vitepress/dist` and `docs/.vitepress/dist` that the build wrote. If it wrote none of them, the deploy stops rather than publish your sources. |
| `worker.main` | The entry module. |
| `worker.include` | Directories to take modules from. Defaults to the whole app. |
| `worker.wrangler_config` | Which config to build with, when the project has more than one. |
| `container.runtime` | `node`, `python`, `go` or `rust`, when there's no Dockerfile. |
| `container.start` | The command the image runs, when the runtime's default is wrong. |
| `container.port` | The port the image listens on. `--port` overrides it. With neither, a deploy keeps the live version's, and an app's first listens on `8080`. |
| `container.instance_type` | The size it runs at: `lite`, `basic`, `standard-1`, `standard-2`, `standard-3` or `standard-4`. `--instance-type` overrides it. With neither, a deploy keeps the live version's, and an app's first runs at `basic`. |

Precedence, highest first: a flag, then `jiayang.json`, then your wrangler config, then detection.

## Building

- **Install** runs only when `node_modules` is missing, and always as a frozen-lockfile install:
  `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `bun install
  --frozen-lockfile` (from `bun.lock` or `bun.lockb`). With no lockfile nothing is installed:
  versions are never resolved at deploy time, and the build runs with whatever is there already.
- `--no-build` skips install and build and deploys what is already there.
- `--dry-run` says what the directory is and how it would be deployed (what `jiayang detect`
  says) and stops. It builds nothing, uploads nothing and doesn't create the app.
- What goes up is checked for credentials before anything is sent: a site's files and a Worker's
  modules once the build has written them, a container's build context before the image is built.

## Environment

Config that isn't secret goes in the app's environment, not in the bundle:

```sh
jiayang env set acme/hello API_BASE=https://api.example.com
jiayang env list acme/hello
```

Workers get them as bindings; containers get them as environment variables. Changing one
re-pushes the running version, so code that reads it at runtime sees the change at once.
Environment belongs to the app rather than a version, so a rollback keeps the current values.

A build reads them too, and bakes in what it reads: a static site's whole build, and the values a
front end exposes to the browser: `VITE_*`, `NEXT_PUBLIC_*`, `PUBLIC_*`, `REACT_APP_*`. Those
change on the next `jiayang deploy`, not before, and `env set` says so.

Secrets go somewhere else entirely, `jiayang secret set`, and are injected per request by the
egress proxy, never handed to your code. Anything that looks like a live credential is refused
from `env` with a pointer to `secret`.

`JIAYANG_*`, `CF_*`, `CLOUDFLARE_*`, `PORT`, `DB` and the proxy variables are reserved.

## What a Worker may ask for

The platform hands out one binding: a D1 database named `DB`. A wrangler config asking for
anything else is refused before the build, by name, with what to do instead:

```
wrangler.jsonc asks for things this platform doesn't hand out:
  vars (API_BASE): plain values belong in `jiayang env set`
    jiayang env set <app> API_BASE=<value>
  kv_namespaces (CACHE): the platform doesn't hand out KV
```

KV, R2, queues, service bindings, Durable Objects, dispatch namespaces, Workers AI, Vectorize,
Hyperdrive, browser rendering, mTLS certificates, email, Workflows, containers and `unsafe` are all
refused. So are `routes`, `triggers`, `crons` and anything else that would put your Worker
somewhere other than the platform's edge. That is the one property the whole product rests on.

Compatibility flags are an allowlist: `nodejs_compat`, `nodejs_compat_v2`, `nodejs_als` and
`global_fetch_strictly_public`. Anything else is refused before the build rather than at upload.

## Limits

| | |
|---|---|
| Worker bundle | 32 MiB |
| Static site | 20,000 files, 25 MiB each |

`_worker.js`, `_worker.js.map` and `_routes.json` are never served as files, including when a
build writes `_worker.js` as a *directory* of chunks, which is how a framework's whole server
source could otherwise end up downloadable. `_headers` and `_redirects` are read as configuration.
`.assetsignore` is honoured.

## Then

```sh
jiayang share acme/hello someone@example.com       # one person, by email
jiayang app visibility acme/hello workspace        # or everyone in the workspace
jiayang curl acme/hello /api/things                # as you, through the front door
jiayang watch acme/hello                           # its requests and changes, as they happen
jiayang audit acme --app hello                     # the same, newest first
jiayang versions acme/hello
jiayang rollback acme/hello <version>
```

`watch` and `audit`, for the workspace's owners and admins, show every request the platform let
through or turned away, and every change anyone made. What the app itself prints (its console,
its stdout) isn't kept anywhere you can read yet.
