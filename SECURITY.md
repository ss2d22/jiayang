# Reporting a security problem

Email **security@jiayang.cloud**. Please don't open a public issue.

Tell us what you found, how to reproduce it, and what it lets someone do. We'll confirm we have it
within three working days and tell you what we're doing about it. If you'd like credit, say so and
we'll name you when it's fixed.

Please don't test against other people's apps or data. If you need somewhere to try something,
deploy an app of your own and attack that.

## What we care most about

The platform's job is that an app is unreachable except through our sign-in, and that an app can
only learn who is calling by verifying a token we signed. Anything that breaks either is the most
serious thing you can report:

- reaching an app without a session or a valid token, or as someone else
- getting an app to accept a caller it should refuse: a forged or replayed identity token, a
  header that is treated as identity, an expired or revoked session that still works
- reading another tenant's data, secrets, logs or storage
- getting a credential out of the platform: a stored third-party secret, a bypass token, a
  session, or a signing key

Denial of service and anything needing a person to be already signed in as the victim are
interesting but lower priority.

## This repository

What is here is the SDKs your app verifies its callers with. A problem in how an SDK verifies a
token is in scope and is exactly the kind of thing we want to hear about.

The CLI and the platform itself are not in this repository. Report anything about either to the
same address.
