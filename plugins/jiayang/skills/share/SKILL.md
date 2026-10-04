---
name: share
description: Give or take away someone's access to an app on Jiayang Cloud, or make an app visible to a whole workspace. Use when the user asks to share an app, add someone, change a role, or revoke access.
---

# Share an app

An app is private by default. Only people it has been shared with can reach it, and they sign in
as themselves.

Roles, each including the one before it:
- `viewer` uses the app.
- `editor` also deploys and manages its secrets and configuration.
- `owner` also shares it and deletes it.

To share with one person, call `set_access` with the app, their email and a role.
`role: "none"` removes their access. Either change takes effect within 60 seconds, including on
open connections, so a revoked person's WebSocket is closed. If the app is still shared with them
another way (their domain, a group, or the whole workspace), the answer names it in
`still_shared_by`: tell the user they can still get in, and how to shut them out.

No tool here shares with everyone at a domain or with a group. For that, give the person the
command to run themselves: `jiayang share <workspace>/<app> @acme.com` for everyone whose address
is exactly at acme.com, or `jiayang share <workspace>/<app> --group <name>` for one of the
workspace's groups. Both let people in as viewers only.

To share with a whole workspace, call `set_visibility` with `workspace`. Every member becomes a
viewer. `private` undoes it.

A script, cron job or other service can't sign in. `create_bypass_token` makes a credential for one
app. You never see its secret. It's written to a private file and the tool returns the path, for
the person to put where it's needed. Give them the path, not the contents, and tell them the
secret is sent as `Authorization: Bearer <secret>` to the machine URL from `app_url`.
`revoke_bypass_token` ends it immediately.

Before telling the user it's done, call `app_status` and read back who has access. Report what
Jiayang Cloud has, not what you asked for.

Confirm the email is the one they meant. If you're unsure of an address, ask.
