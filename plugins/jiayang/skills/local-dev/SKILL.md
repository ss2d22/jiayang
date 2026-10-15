---
name: local-dev
description: Run an app locally with Jiayang Cloud's sign-in in front of it, so identity works the same as in production, as an owner, editor, viewer, agent, bypass token, scheduled job, webhook or someone the app isn't shared with. Use when developing or testing an app that verifies its caller, checking what each role sees, or when something works locally but not deployed.
---

# Run an app locally

The SDKs never skip a signature. Started on its own, an app that verifies its caller gets no token
and refuses every request.

`jiayang dev` runs Jiayang Cloud's sign-in edge on your machine. Ask the user to run this in the
project directory:

```sh
jiayang dev                      # works out how to start the app itself
jiayang dev -- npm run dev       # or give the command yourself
jiayang dev --docker             # a container app, in the image a deploy would build
```

It creates a signing key for that session and serves the matching JWKS. It strips any identity headers
the client sent, then adds a real 60-second identity token to every request it passes on, as
production does. It sets `JIAYANG_APP_ID`, `JIAYANG_IDENTITY_ISSUER`, `JIAYANG_JWKS_URL` and
`JIAYANG_DEV=1` for the app. A Workers app gets them as bindings. The SDKs (0.3.0 and newer) take its
http issuer only with `JIAYANG_DEV=1`, which the platform never sets, so never set it in deployed
config or tell the user to.

- Open the app at http://127.0.0.1:8787, not at the port it listens on.
- `--as` picks who requests come from, and http://127.0.0.1:8787/.jiayang switches while it runs:

  | `--as` | The app sees |
  |---|---|
  | `owner`, `editor`, `viewer` | you@example.com, editor@example.com, viewer@example.com with that role |
  | `agent` | the agent `dev-agent`: `kind` service, `sub` `agent:ag_dev`, role editor (`--role viewer`) |
  | `token` | a bypass token: `kind` service, `sub` `service:bt_dev`, role viewer (`--role editor`) |
  | `scheduler` | a scheduled job: `kind` service, `sub` `scheduler:dev`, role viewer |
  | `webhook` | a delivery from `--provider` (stripe by default) to `--pattern` (`/hooks/*` by default), for routes that call `requireWebhook`. Other paths get 401 before the app |
  | `outsider` | nothing: our 404, as for someone the app isn't shared with |
  | `nobody` | no token, as on a public path |
  | an email | that person, with `--role` (owner by default) |

- To test each role yourself, switch with a POST and then call the app:

  ```sh
  curl -H 'Origin: http://127.0.0.1:8787' -d persona=viewer http://127.0.0.1:8787/.jiayang/as
  curl http://127.0.0.1:8787/
  ```

  Check that what a viewer must not do is refused (403), and that `outsider` and `nobody` get nothing.
- Streamed responses, server-sent events and WebSockets pass through, so HMR works.

`--as someone@example.com --role viewer` starts as a person of your choosing.

When something works locally but not deployed, the cause is usually one of these:

- a variable set in a shell but never set with `set_env`
- a credential in a `.env` file that the deploy refused, which belongs in `set_secret`
- an app reading `X-Jiayang-Email` instead of verifying the token. Both `jiayang dev` and
  production send that header, but it proves nothing in either.
- 401 with `must use https, except under jiayang dev` locally: the app didn't get `JIAYANG_DEV=1`.
  The user's CLI is older than 0.1.11, or something between drops the environment.

The signing key only exists for that session, and nothing else trusts what it signs.
