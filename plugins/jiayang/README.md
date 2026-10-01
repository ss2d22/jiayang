# The Jiayang Cloud plugin

The plugin gives four agent clients one MCP server. Every client starts it with the same
command:

```
jiayang mcp
```

The server is the CLI, so a customer installs one binary and nothing else. The plugin ships no
server file and needs neither Node nor a plugin-root path, and the server's version is always the
CLI's version.

## Manifests

Each client reads its own manifest and expects a different layout. Only the command is the same in
all four.

| File | Read by | Server definition it uses |
|---|---|---|
| `plugin.json` | Agent Plugins 1.0 clients | `mcp.json` (fixed location, by the spec) |
| `.claude-plugin/plugin.json` | Claude Code | `.mcp.json` (read automatically from the plugin root) |
| `.cursor-plugin/plugin.json` | Cursor | `mcp.json`, named by `"mcpServers"` |
| `.codex-plugin/plugin.json` | Codex | `.mcp.json`, named by `"mcpServers"` |

`skills/` is shared by all four. `rules/` is Cursor's alone.

Codex reads the root `plugin.json` and `mcp.json` whenever they're there, and reads
`.codex-plugin/plugin.json` only for the variables its server file (`.mcp.json`) lists in
`env_vars`. It takes nothing else from that file, including the timeouts and the working
directory. (`agent_plugin_mcp_overlay.rs` and `agent_plugin_config.rs` in openai/codex, read
25 Sep 2026.) So under Codex, as under any Agent Plugins client, the server starts in the plugin's
own directory, and a tool call gets Codex's five minutes. The next two sections describe how the
server handles both.

## Where a deploy may read from

`jiayang mcp` takes its roots from `JIAYANG_MCP_ROOTS`, else the roots the client offers, else the
directory it was started in, and confines every deploy to one of them, compared by real path.

A plugin client starts it in the plugin's own directory, which is never the project. The server
recognises that directory by `PLUGIN_ROOT` and `PLUGIN_DATA`, which the Agent Plugins spec has
every client set, or by the manifests in it. When started there, it uses `PWD` instead, the
directory the client itself was started from. With no `PWD` it deploys nothing and says to set
`JIAYANG_MCP_ROOTS`. The other rules apply either way: paths are compared as real paths, and a
root can't be your home directory, anything above it, or a hidden directory.

Each client reaches a different step in that order:

- **Claude Code** expands `${CLAUDE_PROJECT_DIR}`, so `.mcp.json` sets `JIAYANG_MCP_ROOTS` outright.
- **Codex** expands nothing that points at the project and offers no roots, so `.mcp.json` lists
  `JIAYANG_MCP_ROOTS` and `PWD` in `env_vars`, which forwards them from Codex's own environment.
  `PWD` is where Codex was started, which is the session's directory unless it was started with
  `--cd`. Codex passes `${CLAUDE_PROJECT_DIR}` through unexpanded, and the server refuses any root
  containing `${`, since that is a placeholder a launcher failed to expand.
- **Cursor** gives a plugin-shipped `mcp.json` no project-root variable. A bare `${FOO}` there
  means a plugin variable filled in from Cursor's dashboard. So `mcp.json` sets no
  environment, and the server uses the roots Cursor offers. Someone who wants it pinned can put
  `JIAYANG_MCP_ROOTS` in their own `.cursor/mcp.json`, where `${workspaceFolder}` does expand.
- **Other Agent Plugins clients** read the same `mcp.json`, which holds only the command, because
  the spec refuses any field it doesn't define. They use the roots they offer, or `PWD`.

## Long deploys

A container's build can take longer than a client allows for one tool call, and a plugin can't
raise Codex's limit. So `deploy_app` holds a call for at most `wait_seconds`, which defaults to 45
and goes up to 240. If the deploy is still going, it answers `"state": "deploying"` and the deploy carries on
inside the server. The agent then waits with `deploy_status`, which answers as `deploy_app` would
have once the deploy is done. The deploy skill tells it to. The timeouts in `.mcp.json` are for a
Codex version that reads that whole file.

## Install

The plugin is Apache-2.0 and published with the SDKs in `ss2d22/jiayang`. Each client reads its
own marketplace file at that repository's root, and all three list the plugin as `jiayang-cloud`
in a marketplace also called `jiayang-cloud`.

- **Claude Code**: `/plugin marketplace add ss2d22/jiayang`, then
  `/plugin install jiayang-cloud@jiayang-cloud`. Reads `.claude-plugin/marketplace.json`.
- **Codex**: `codex plugin marketplace add ss2d22/jiayang`, then
  `codex plugin add jiayang-cloud@jiayang-cloud`. Reads `.agents/plugins/marketplace.json`.
- **Cursor**: in **Customize**, add `https://github.com/ss2d22/jiayang` with **From GitHub
  Repository** and install Jiayang Cloud. Reads `.cursor-plugin/marketplace.json`.

The marketplace entry and every manifest must use the same name. Codex refuses an install whose
manifest name differs from the entry's, and `scripts/mirror.test.mjs` checks this.

A client without plugin support can run the server directly. It gets every tool but no skills:

```json
{ "mcpServers": { "jiayang-cloud": { "command": "jiayang", "args": ["mcp"] } } }
```

No client needs a longer timeout. A deploy that outlasts one call is followed with
`deploy_status`.

Every tool acts as whoever is signed in to the CLI. Run `jiayang login` first.

It needs `jiayang` 0.1.1 or later, the first with `deploy_status`.

To publish a change, bump `version` in all four manifests and push a `plugin-v*` tag here, as
RELEASING.md says. Clients install from the public repository's default branch, and Claude Code
only offers an update when the version changes.
