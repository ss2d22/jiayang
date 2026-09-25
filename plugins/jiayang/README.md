# The Jiayang Cloud plugin

One plugin, one MCP server, four clients. Everything here launches the same thing:

```
jiayang mcp
```

The server is the CLI itself, so a customer installs one binary and every client runs the same
command. No Node, no bundled server file, no plugin-root path to interpolate, and the server's
version is the CLI's version by construction.

## Why there are four manifests

Each client looks for its own file, and they disagree about almost everything except the command.

| File | Read by | Server definition it uses |
|---|---|---|
| `plugin.json` | Agent Plugins 1.0 clients | `mcp.json` (fixed location, by the spec) |
| `.claude-plugin/plugin.json` | Claude Code | `.mcp.json` (read automatically from the plugin root) |
| `.cursor-plugin/plugin.json` | Cursor | `mcp.json`, named by `"mcpServers"` |
| `.codex-plugin/plugin.json` | Codex | `.mcp.json`, named by `"mcpServers"` |

`skills/` is shared by all four. `rules/` is Cursor's alone.

Codex reads the root `plugin.json` and `mcp.json` whenever they're there, and reads
`.codex-plugin/plugin.json` only for the variables its server file (`.mcp.json`) lists in
`env_vars`. It takes nothing else from that file: not the timeouts, and not the working
directory. (`agent_plugin_mcp_overlay.rs` and `agent_plugin_config.rs` in openai/codex, read
25 Sep 2026.) So under Codex, as under any Agent Plugins client, the server starts in the plugin's
own directory, and a tool call gets Codex's five minutes. The two sections below are how it works
anyway.

## Where a deploy is allowed to read from

`jiayang mcp` takes its roots from `JIAYANG_MCP_ROOTS`, else the roots the client offers, else the
directory it was started in, and confines every deploy to one of them, by real path.

A plugin client starts it in the plugin's own directory, which is never the project. The server
knows that directory by `PLUGIN_ROOT` and `PLUGIN_DATA`, which the Agent Plugins spec has every
client set, or by the manifests in it. There it goes by `PWD` instead: the directory the client
itself was started from. With no `PWD` it deploys nothing, and says to set `JIAYANG_MCP_ROOTS`.
Every other rule still holds for either: real paths only, never your home directory or anything
above it, never a hidden directory.

That fallback chain exists because the clients can't agree here either:

- **Claude Code** expands `${CLAUDE_PROJECT_DIR}`, so `.mcp.json` sets `JIAYANG_MCP_ROOTS` outright.
- **Codex** expands nothing that points at the project and offers no roots, so `.mcp.json` lists
  `JIAYANG_MCP_ROOTS` and `PWD` in `env_vars`, which forwards them from Codex's own environment.
  `PWD` is where Codex was started, which is the session's directory unless it was started with
  `--cd`. It passes `${CLAUDE_PROJECT_DIR}` through literally, which the server refuses, because a
  root containing `${` is a placeholder a launcher failed to expand, not a directory.
- **Cursor** has no project-root variable available to a plugin-shipped `mcp.json` at all: a bare
  `${FOO}` there means a plugin variable filled from its dashboard. So `mcp.json` sets no
  environment, and the server uses the roots Cursor offers. Someone who wants it pinned can put
  `JIAYANG_MCP_ROOTS` in their own `.cursor/mcp.json`, where `${workspaceFolder}` does expand.
- **Other Agent Plugins clients** read the same `mcp.json`, which can hold nothing but the
  command: the spec refuses any field it doesn't define. They get their roots, or `PWD`.

## A deploy takes as long as it takes

A container's build can run past any client's limit on one call, and a plugin can't raise Codex's.
So `deploy_app` never holds a call for longer than `wait_seconds`: 45 by default, 240 at most. A
deploy still going then answers `"state": "deploying"` and carries on inside the server. The agent
waits for it with `deploy_status`, which answers as `deploy_app` would have once it's done. The
deploy skill says to. The timeouts left in `.mcp.json` are for a Codex that reads that file whole.

## Installing it

The plugin is Apache-2.0 and published with the SDKs in `ss2d22/jiayang`. Each client reads its
own marketplace file at that repository's root, and all three list the plugin as `jiayang-cloud`
in a marketplace also called `jiayang-cloud`.

- **Claude Code**: `/plugin marketplace add ss2d22/jiayang`, then
  `/plugin install jiayang-cloud@jiayang-cloud`. Reads `.claude-plugin/marketplace.json`.
- **Codex**: `codex plugin marketplace add ss2d22/jiayang`, then
  `codex plugin add jiayang-cloud@jiayang-cloud`. Reads `.agents/plugins/marketplace.json`.
- **Cursor**: in **Customize**, add `https://github.com/ss2d22/jiayang` with **From GitHub
  Repository** and install Jiayang Cloud. Reads `.cursor-plugin/marketplace.json`.

Every name, the entry's and each manifest's, has to be the same: Codex refuses an install whose
manifest name differs from the entry's, and `scripts/mirror.test.mjs` checks it.

A client that takes no plugins can run the server on its own. The skills are the only thing it
misses:

```json
{ "mcpServers": { "jiayang-cloud": { "command": "jiayang", "args": ["mcp"] } } }
```

No client needs a longer timeout for it. A deploy that outlasts one call is followed with
`deploy_status`.

Every tool acts as whoever is signed in to the CLI. Run `jiayang login` first.

It needs `jiayang` 0.1.1 or later, the first with `deploy_status`.

To publish a change, bump `version` in all four manifests and push a `plugin-v*` tag here, as
RELEASING.md says. Clients install from the public repository's default branch, and Claude Code
only offers an update when the version changes.
