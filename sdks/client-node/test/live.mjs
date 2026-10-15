// The built client against a running platform: the local stack in tests/e2e (clients.rs), or any
// other one it's pointed at. Everything it makes is in a new workspace, LIVE_WS.
//
//   JIAYANG_API=... JIAYANG_TOKEN=jyu_... LIVE_WS=<new slug> LIVE_FRIEND=<email> node test/live.mjs
//
// It checks what it can see for itself, then prints one line of JSON for the caller to check from
// the outside, with the CLI.

import http from "node:http";
import { AuthenticationError, Jiayang, NotFoundError } from "../dist/index.mjs";

const need = (name) => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
};
const ws = need("LIVE_WS");
const friend = need("LIVE_FRIEND");
const jy = new Jiayang();

function check(what, ok, detail = "") {
	if (!ok) throw new Error(`${what}${detail ? `: ${detail}` : ""}`);
	console.error(`ok ${what}`);
}

/** GET through the apps domain with a bypass token. .localhost goes to loopback, as the client does. */
function callApp(url, secret) {
	const u = new URL(url.endsWith("/") ? url : `${url}/`);
	const local = u.hostname.endsWith(".localhost");
	return new Promise((resolve, reject) => {
		const req = http.request(
			u,
			{
				headers: { authorization: `Bearer ${secret}` },
				...(local ? { lookup: (_h, o, cb) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) } : {}),
			},
			(res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve({ status: res.statusCode, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

const me = await jy.me();
check("knows who it is", me.email.length > 0);

await jy.workspaces.create({ slug: ws, name: "Client test" });
check("made a workspace", (await jy.workspaces.list()).some((w) => w.slug === ws));

// A site, twice: the second deploy sends only the file that changed.
await jy.apps.create(ws, { slug: "site", name: "Site", driver: "workers" });
const logo = new Uint8Array(2048).map((_, i) => i % 251);
const site = await jy.deploy.site(ws, "site", {
	files: [
		{ path: "/index.html", content: "<h1>from node</h1>" },
		{ path: "/logo.bin", content: logo },
	],
});
check("deployed a site", site.status === "deployed" && site.active, JSON.stringify(site));
const said = [];
const again = await jy.deploy.site(
	ws,
	"site",
	{
		files: [
			{ path: "/index.html", content: "<h1>from node</h1>" },
			{ path: "/logo.bin", content: logo },
			{ path: "/new.txt", content: "new" },
		],
	},
	{ onProgress: (line) => said.push(line) },
);
check("sent only the new file", said.includes("Uploading 1 of 3 files ..."), said.join(" | "));
check("put the second version live", again.number === site.number + 1 && again.active);

// A Worker, two versions, then back to the first.
await jy.apps.create(ws, { slug: "worker", name: "Worker", driver: "workers" });
const worker = (text) => ({
	main_module: "index.js",
	compatibility_date: "2026-09-01",
	modules: { "index.js": { content: `export default { fetch() { return new Response(${JSON.stringify(text)}) } }` } },
});
const one = await jy.deploy.worker(ws, "worker", worker("one from node"));
const two = await jy.deploy.worker(ws, "worker", worker("two from node"));
check("deployed a Worker twice", one.number === 1 && two.number === 2 && two.active);
const back = await jy.versions.rollback(ws, "worker", 1);
check("rolled back", back.number === 1 && back.active, JSON.stringify(back));
const versions = await jy.versions.list(ws, "worker");
check("lists versions", versions.find((v) => v.active)?.number === 1);

// A bypass token opens the app, and stops at once when revoked.
const made = await jy.tokens.create(ws, "worker", { name: "live", role: "viewer", expires_in_days: 1 });
const opened = await callApp(made.url, made.secret);
check("a token opens the app", opened.status === 200 && opened.body === "one from node", JSON.stringify(opened));
check("lists the token", (await jy.tokens.list(ws, "worker")).some((t) => t.id === made.token.id && !t.revoked_at));
await jy.tokens.revoke(ws, "worker", made.token.id);
const shut = await callApp(made.url, made.secret);
check("a revoked token opens nothing", shut.status === 401, JSON.stringify(shut));

// Sharing.
const grant = await jy.access.share(ws, "worker", friend, { role: "viewer" });
check("shared the app", grant.email === friend && grant.role === "viewer");
check("lists who it's shared with", (await jy.access.list(ws, "worker")).grants.some((g) => g.email === friend));
const unshared = await jy.access.unshare(ws, "worker", friend);
check("unshared it", Array.isArray(unshared.still_shared_by));

// Secrets and config.
await jy.secrets.set(ws, "worker", "THIRD_PARTY", { value: "s3cret-value", inject_host: "api.example.com", inject_header: "Authorization", inject_format: "Bearer {value}" });
const secrets = await jy.secrets.list(ws, "worker");
check("stored a secret without ever showing it", secrets.length === 1 && !JSON.stringify(secrets).includes("s3cret-value"));
await jy.secrets.delete(ws, "worker", "THIRD_PARTY");
const env = await jy.env.update(ws, "worker", { set: { GREETING: "hello" } });
check("set a config value", env.vars.some((v) => v.name === "GREETING" && v.value === "hello"));

// Errors are typed.
const missing = await jy.apps.get(ws, "nope").catch((e) => e);
check("a missing app is NotFoundError", missing instanceof NotFoundError && missing.code === "not_found", String(missing));
const stranger = await new Jiayang({ token: "jyu_notarealtoken" }).me().catch((e) => e);
check("a bad token is AuthenticationError", stranger instanceof AuthenticationError, String(stranger));

// The audit log, a page at a time and all at once, agree.
const deadline = Date.now() + 30_000;
let all = [];
for (;;) {
	all = (await jy.audit.list(ws, { limit: 500 })).entries;
	if (all.some((e) => e.action === "token.revoke") || Date.now() > deadline) break;
	await new Promise((r) => setTimeout(r, 1000));
}
// The log can grow while it's read (the edge's lines arrive a moment later), so the pages hold
// everything the one read did, each entry once, newest first.
const paged = [];
for await (const entry of jy.audit.iterate(ws, { page_size: 3 })) paged.push(entry);
const ids = paged.map((e) => e.id);
check(
	"pages through the audit log",
	new Set(ids).size === ids.length && all.every((e) => ids.includes(e.id)) && paged.every((e, i) => i === 0 || Date.parse(paged[i - 1].at) >= Date.parse(e.at)),
	`${ids.length} paged, ${new Set(ids).size} distinct, ${all.length} at once`,
);
for (const action of ["app.deploy", "app.rollback", "token.create", "token.revoke", "grant.put", "grant.remove"]) {
	check(`the audit log has ${action}`, all.some((e) => e.action === action));
}

console.log(JSON.stringify({ ws, token_id: made.token.id, live: back.number, audit: all.length }));
