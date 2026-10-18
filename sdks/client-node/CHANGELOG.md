# Changelog

## Unreleased

- A share or a new member's reply says which day's budget stopped the invitation email, when one
  did: `budget_spent` is `workspace`, `sender` or `platform`, beside `invited: "over_budget"`.
- A share in the role the person already had says `unchanged: true`. Nothing changed and nothing
  was logged.

## 0.1.0 - 2026-10-07

- First release. A client for the Jiayang Cloud API: workspaces, members, apps, versions, deploys of
  Workers and static sites, sharing, bypass tokens, the audit log, secrets and config values.
- Signs in with a CLI session: `token`, `JIAYANG_TOKEN`, or the one `jiayang login` saved.
- Tries reads again after a failure on our side or a 429, and never sends a change or a deploy twice.
- Sends a deploy's lock files and `.jiayang-allow` for its scan, when given them as `scan`.
- Sends a saved CLI session only to the API it was made by.
- Asks for the app's key-value storage and queue with a Worker deploy, as jiayang.json does:
  `kv` and `queue`.
