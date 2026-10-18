# Installing the Jiayang Cloud MCP server

The server is the `jiayang` CLI, run as `jiayang mcp`. It deploys apps to Jiayang Cloud, shares
them by email and reads their logs and audit log, acting as the person signed in to the CLI. Every
app it deploys stays private behind sign-in.

## 1. Install the CLI

On macOS or Linux:

```sh
curl -fsSL https://jiayang.cloud/install.sh | sh
```

Or `brew install ss2d22/tap/jiayang`, or `npm install -g jiayang`. On Windows, in PowerShell:
`irm https://jiayang.cloud/install.ps1 | iex`.

## 2. Sign in

The person has to do this in a terminal. It opens a browser to approve the sign-in. Don't run it
for them, and don't ask for a password: there isn't one to give.

```sh
jiayang login
```

## 3. Add the server

In the MCP settings (`cline_mcp_settings.json` for Cline):

```json
{
  "mcpServers": {
    "jiayang-cloud": {
      "command": "jiayang",
      "args": ["mcp"],
      "env": { "JIAYANG_MCP_ROOTS": "/absolute/path/to/the/project" }
    }
  }
}
```

`JIAYANG_MCP_ROOTS` is the one directory deploys may read from. Set it to the project's folder. The
server refuses to deploy from a home directory, a hidden directory or anywhere outside it. If the
client can't find `jiayang`, put the full path from `which jiayang` (`where jiayang` on Windows) in
`command`.

## 4. Check it

Call `whoami`. It answers with the signed-in person and their workspaces. If it says to run
`jiayang login`, ask the person to run it, then try again.

To deploy, call `deploy_app` with the directory and an app name like `acme/hello`, and
`create_if_missing` if the app is new. If it answers that the deploy is still going, call
`deploy_status` until it's live. Then `call_app` checks it answers, and `set_access` shares it.

The docs, with every tool: https://jiayang.cloud/docs/agents/
