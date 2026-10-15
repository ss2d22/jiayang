---
name: agents
description: Give a bot, script or other agent its own identity on Jiayang Cloud, grant it apps, and take them away. Use when the user wants an automated caller named in the audit log, or asks to revoke one.
---

# Agents

An agent is a named caller of a workspace's own, with credentials of its own, and named as itself
in the audit log. It reaches nothing until an app is granted to it. Use one for anything that runs
without a person. A bypass token is for one app only and isn't named in the log as anyone.

1. `create_agent` with the workspace and a name, like `release-bot`.
2. `set_agent_access` with the app, the agent and `viewer` or `editor`. Repeat for each app.
3. Ask the person to mint its credential: `jiayang agent token <workspace> <agent>`. The secret is
   shown to them once and never passes through you. Tell them to store it where the agent runs.

Inside the app, a request from an agent has an identity token whose `sub` starts with `agent:`.
`requireUser()` accepts it, so check the role or the `sub` if only agents should do something.

- `list_agents` shows each agent, its apps and its credentials, never the secrets.
- `revoke_agent_credential` ends one credential on its next request. The agent stays.
- `set_agent_access` with `none` takes an app away. `end_agent` ends the agent for good. Pass it
  again as `confirm`.
