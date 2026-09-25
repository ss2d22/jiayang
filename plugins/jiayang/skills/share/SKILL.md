---
name: share
description: Give or take away someone's access to an app on Jiayang Cloud, or make an app visible to a whole workspace. Use when the user asks to share an app, add someone, change a role, or revoke access.
---

# Share it

An app is private by default: only people it has been shared with can reach it, and they sign in
as themselves.

**Roles**, each including the one before it:
- `viewer` uses the app.
- `editor` also deploys and manages its secrets and configuration.
- `owner` also shares it and deletes it.

**One person:** `set_access` with the app, their email and a role. `role: "none"` takes it away.
Both take effect within 60 seconds, open connections included: a revoked person's WebSocket
closes on its own.

**A whole workspace:** `set_visibility` with `workspace` makes every member a viewer without
naming them one by one; `private` puts it back.

**A machine**, such as a script, a cron job or another service, can't sign in. `create_bypass_token` makes
a credential for one app. Its secret is never shown to you: it's written to a private file whose
path comes back, for the person to put where it's needed. Give them the path, not the contents,
and tell them it's sent as `Authorization: Bearer <secret>` to the machine URL from `app_url`.
`revoke_bypass_token` ends it immediately.

Before telling the user it's done, `app_status` and read back who has access, so what you report is
what the platform thinks rather than what you just asked for.

Check the email is the one they meant. Sharing is not a guess.
