"""The client against a running platform: the local stack in tests/e2e (clients.rs), or any other
one it's pointed at. Everything it makes is in a new workspace, LIVE_WS.

    JIAYANG_API=... JIAYANG_TOKEN=jyu_... LIVE_WS=<new slug> LIVE_FRIEND=<email> python tests/live.py

It checks what it can see for itself, then prints one line of JSON for the caller to check from the
outside, with the CLI.
"""

from __future__ import annotations

import http.client
import json
import os
import sys
import time
from datetime import datetime
from typing import List, Tuple
from urllib.parse import urlsplit

from jiayang_client import AuthenticationError, Client, NotFoundError


def need(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is not set")
    return value


def check(what: str, ok: bool, detail: str = "") -> None:
    if not ok:
        raise AssertionError(what + (f": {detail}" if detail else ""))
    print(f"ok {what}", file=sys.stderr)


def when(at: str) -> datetime:
    return datetime.fromisoformat(at.replace("Z", "+00:00"))


def call_app(url: str, secret: str) -> Tuple[int, str]:
    """GET through the apps domain with a bypass token. .localhost goes to loopback, as the client does."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    connect = "127.0.0.1" if host.endswith(".localhost") else host
    conn = (http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection)(connect, parts.port, timeout=30)
    path = parts.path if parts.path.endswith("/") else parts.path + "/"
    conn.request("GET", path, headers={"Host": parts.netloc, "Authorization": f"Bearer {secret}"})
    res = conn.getresponse()
    body = res.read().decode()
    conn.close()
    return res.status, body


ws = need("LIVE_WS")
friend = need("LIVE_FRIEND")
jy = Client()

me = jy.me()
check("knows who it is", bool(me["email"]))

jy.workspaces.create(ws, "Client test")
check("made a workspace", any(w["slug"] == ws for w in jy.workspaces.list()))

# A site, twice: the second deploy sends only the file that changed.
jy.apps.create(ws, "site", "Site", "workers")
logo = bytes(i % 251 for i in range(2048))
files = [{"path": "/index.html", "content": "<h1>from python</h1>"}, {"path": "/logo.bin", "content": logo}]
site = jy.deploy.site(ws, "site", files)
check("deployed a site", site["status"] == "deployed" and site["active"], json.dumps(site))
said: List[str] = []
again = jy.deploy.site(ws, "site", [*files, {"path": "/new.txt", "content": "new"}], on_progress=said.append)
check("sent only the new file", "Uploading 1 of 3 files ..." in said, " | ".join(said))
check("put the second version live", again["number"] == site["number"] + 1 and again["active"])

# A Worker, two versions, then back to the first.
jy.apps.create(ws, "worker", "Worker", "workers")


def worker(text: str) -> dict:
    source = "export default { fetch() { return new Response(%s) } }" % json.dumps(text)
    return {"main_module": "index.js", "compatibility_date": "2026-09-01", "modules": {"index.js": {"content": source}}}


one = jy.deploy.worker(ws, "worker", **worker("one from python"))
two = jy.deploy.worker(ws, "worker", **worker("two from python"))
check("deployed a Worker twice", one["number"] == 1 and two["number"] == 2 and two["active"])
back = jy.versions.rollback(ws, "worker", 1)
check("rolled back", back["number"] == 1 and back["active"], json.dumps(back))
check("lists versions", next(v for v in jy.versions.list(ws, "worker") if v["active"])["number"] == 1)

# A bypass token opens the app, and stops at once when revoked.
made = jy.tokens.create(ws, "worker", "live", "viewer", expires_in_days=1)
status, body = call_app(made["url"], made["secret"])
check("a token opens the app", status == 200 and body == "one from python", f"{status} {body}")
check("lists the token", any(t["id"] == made["token"]["id"] and not t["revoked_at"] for t in jy.tokens.list(ws, "worker")))
jy.tokens.revoke(ws, "worker", made["token"]["id"])
status, body = call_app(made["url"], made["secret"])
check("a revoked token opens nothing", status == 401, f"{status} {body}")

# Sharing.
grant = jy.access.share(ws, "worker", friend, role="viewer")
check("shared the app", grant["email"] == friend and grant["role"] == "viewer")
check("lists who it's shared with", any(g["email"] == friend for g in jy.access.list(ws, "worker")["grants"]))
check("unshared it", isinstance(jy.access.unshare(ws, "worker", friend)["still_shared_by"], list))

# Secrets and config.
jy.secrets.set(
    ws, "worker", "THIRD_PARTY", value="s3cret-value", inject_host="api.example.com", inject_header="Authorization", inject_format="Bearer {value}"
)
secrets = jy.secrets.list(ws, "worker")
check("stored a secret without ever showing it", len(secrets) == 1 and "s3cret-value" not in json.dumps(secrets))
jy.secrets.delete(ws, "worker", "THIRD_PARTY")
env = jy.env.update(ws, "worker", set={"GREETING": "hello"})
check("set a config value", any(v["name"] == "GREETING" and v["value"] == "hello" for v in env["vars"]))

# Errors are typed.
try:
    jy.apps.get(ws, "nope")
    check("a missing app is NotFoundError", False)
except NotFoundError as err:
    check("a missing app is NotFoundError", err.code == "not_found")
try:
    Client("jyu_notarealtoken").me()
    check("a bad token is AuthenticationError", False)
except AuthenticationError:
    check("a bad token is AuthenticationError", True)

# The audit log, a page at a time and all at once, agree.
deadline = time.monotonic() + 30
while True:
    everything = jy.audit.list(ws, limit=500)["entries"]
    if any(e["action"] == "token.revoke" for e in everything) or time.monotonic() > deadline:
        break
    time.sleep(1)
# The log can grow while it's read (the edge's lines arrive a moment later), so the pages hold
# everything the one read did, each entry once, newest first.
paged = list(jy.audit.iterate(ws, page_size=3))
ids = [e["id"] for e in paged]
check(
    "pages through the audit log",
    len(set(ids)) == len(ids)
    and {e["id"] for e in everything} <= set(ids)
    and all(when(paged[i]["at"]) >= when(paged[i + 1]["at"]) for i in range(len(paged) - 1)),
    f"{len(ids)} paged, {len(set(ids))} distinct, {len(everything)} at once",
)
for action in ("app.deploy", "app.rollback", "token.create", "token.revoke", "grant.put", "grant.remove"):
    check(f"the audit log has {action}", any(e["action"] == action for e in everything))

print(json.dumps({"ws": ws, "token_id": made["token"]["id"], "live": back["number"], "audit": len(everything)}))
