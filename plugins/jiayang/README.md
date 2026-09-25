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

Codex's own docs call `.codex-plugin/` a compatibility fallback and prefer a portable layout. We
meant to use the fallback: the portable format pins the server's working directory to the
plugin's own install path and refuses unknown fields, so it can't start a server that reads the
user's project. But Codex 0.157 takes the root `plugin.json` whenever there is one, and reads
`.codex-plugin/plugin.json` only for the environment it adds. So a Codex install today starts the
server in the plugin's cache, gives a tool call Codex's default five minutes rather than fifteen,
and deploys only with `JIAYANG_MCP_ROOTS` exported in the shell Codex started from.

## Where a deploy is allowed to read from

`jiayang mcp` takes its roots from `JIAYANG_MCP_ROOTS`, else the roots the client offers, else the
directory it was started in, and confines every deploy to one of them, by real path.

That fallback chain exists because the clients can't agree here either:

- **Claude Code** expands `${CLAUDE_PROJECT_DIR}`, so `.mcp.json` sets `JIAYANG_MCP_ROOTS` outright.
- **Codex** expands nothing that points at the project, so `.mcp.json` lists `JIAYANG_MCP_ROOTS`
  in `env_vars` to forward a real value from the shell if there is one. With none, Codex starts
  the server in the session's own directory and the `cwd` fallback is correct. It passes
  `${CLAUDE_PROJECT_DIR}` through literally, which the server refuses, because a root containing
  `${` is a placeholder a launcher failed to expand, not a directory.
- **Cursor** has no project-root variable available to a plugin-shipped `mcp.json` at all: a bare
  `${FOO}` there means a plugin variable filled from its dashboard. So `mcp.json` sets no
  environment, and the server uses the roots Cursor offers. Someone who wants it pinned can put
  `JIAYANG_MCP_ROOTS` in their own `.cursor/mcp.json`, where `${workspaceFolder}` does expand.

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

Codex needs `tool_timeout_sec = 900` beside that, as `.mcp.json` has it: a deploy is one call.

Every tool acts as whoever is signed in to the CLI. Run `jiayang login` first.

To publish a change, bump `version` in all four manifests and push a `plugin-v*` tag here, as
RELEASING.md says. Clients install from the public repository's default branch, and Claude Code
only offers an update when the version changes.
