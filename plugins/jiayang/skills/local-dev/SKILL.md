---
name: local-dev
description: Run an app locally with the platform's sign-in in front of it, so identity works the same as in production. Use when developing an app that verifies its caller, or when something works locally but not deployed.
---

# Run it locally, properly

The SDKs have no development mode and never skip a signature. An app that verifies its caller
therefore can't be tested by "just running it": there'd be no token to verify.

`jiayang dev` puts the platform's front door on your machine. Ask the user to run, in the project
directory:

```sh
jiayang dev                      # works out how to start the app itself
jiayang dev -- npm run dev       # or say it yourself
```

It makes a signing key for that run, serves the matching JWKS, and stamps a real 60-second
identity token on every request it passes through, after stripping any the client sent, so a
forged header is as useless there as in production. It sets `JIAYANG_APP_ID`,
`JIAYANG_IDENTITY_ISSUER` and `JIAYANG_JWKS_URL` for the app; a Workers app gets them as bindings.

- The app is at **http://127.0.0.1:8787**, not at the port it's listening on.
- **http://127.0.0.1:8787/.jiayang** switches who you are: any email, any role, or nobody at all.
  Use "nobody" to see what a stranger sees.
- Streamed responses, server-sent events and WebSockets pass through, so HMR works.

`--as you@example.com --role viewer` picks who you start as.

**Something that works locally but not deployed** is usually one of: a variable set in a shell but
never `set_env`'d; a credential in a `.env` file that the deploy refused and that should be a
`set_secret`; or an app reading `X-Jiayang-Email` instead of verifying the token, which the dev
front door happily sends and production also sends, but which proves nothing either way.

The key exists only for that run. Nothing it signs is trusted anywhere else.
