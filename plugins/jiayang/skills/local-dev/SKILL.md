---
name: local-dev
description: Run an app locally with the platform's sign-in in front of it, so identity works the same as in production. Use when developing an app that verifies its caller, or when something works locally but not deployed.
---

# Run an app locally

The SDKs have no development mode and never skip a signature. Started on its own, an app that
verifies its caller gets no token and refuses every request.

`jiayang dev` runs the platform's front door on your machine. Ask the user to run this in the
project directory:

```sh
jiayang dev                      # works out how to start the app itself
jiayang dev -- npm run dev       # or say it yourself
```

It makes a signing key for that run and serves the matching JWKS. It strips any identity headers
the client sent, then adds a real 60-second identity token to every request it passes on, as
production does. It sets `JIAYANG_APP_ID`, `JIAYANG_IDENTITY_ISSUER` and `JIAYANG_JWKS_URL` for
the app; a Workers app gets them as bindings.

- Open the app at http://127.0.0.1:8787, not at the port it listens on.
- http://127.0.0.1:8787/.jiayang switches who you are: any email, any role, or nobody. Choose
  nobody to see what a stranger sees.
- Streamed responses, server-sent events and WebSockets pass through, so HMR works.

`--as you@example.com --role viewer` picks who you start as.

When something works locally but not deployed, the cause is usually one of these:

- a variable set in a shell but never set with `set_env`;
- a credential in a `.env` file that the deploy refused, which should be set with `set_secret`;
- an app reading `X-Jiayang-Email` instead of verifying the token. Both `jiayang dev` and
  production send that header, but it proves nothing in either.

The signing key exists only for that run, and nothing else trusts what it signs.
