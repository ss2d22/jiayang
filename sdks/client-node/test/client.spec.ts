import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AuthenticationError,
	BadRequestError,
	ConfigError,
	ConflictError,
	ConnectionFailedError,
	Jiayang,
	JiayangError,
	NotFoundError,
	PermissionDeniedError,
	PlanLimitError,
	RateLimitError,
	ServerError,
} from "../src/index.js";
import { segment } from "../src/paths.js";
import { TOKEN, fake, json, refusal } from "./fake.js";

const ROUTES = JSON.parse(readFileSync(new URL("../../testdata/client-routes.json", import.meta.url), "utf8")) as {
	routes: { method: string; path: string }[];
};

describe("the requests it makes", () => {
	it("are the ones in client-routes.json, every one of them", async () => {
		const asked = new Set<string>();
		const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			const match = ROUTES.routes.find(
				(r) => r.method === method && new RegExp(`^${r.path.replace(/\{[a-z0-9]+\}/g, "[^/]+")}$`).test(url.pathname),
			);
			asked.add(match ? `${match.method} ${match.path}` : `UNLISTED ${method} ${url.pathname}`);
			if (url.pathname.endsWith("/blobs/missing")) return json(200, { missing: JSON.parse(String(init?.body)).sha256 });
			if (method === "POST" && /\/(versions|site)$/.test(url.pathname)) return json(201, { number: 2, status: "deployed", active: true });
			if (url.pathname.endsWith("/versions")) return json(200, [{ number: 1, status: "deployed", active: true }]);
			if (url.pathname === "/v1/me") return json(200, { workspaces: [] });
			if (url.pathname.endsWith("/audit")) return json(200, []);
			if (method === "DELETE") return new Response(null, { status: 204 });
			if (method === "GET" && /\/(grants|domain-grants|group-grants|tokens|secrets|env|members|apps)$/.test(url.pathname)) return json(200, []);
			return json(200, { visibility: "private" });
		}) as typeof globalThis.fetch;
		const jy = new Jiayang({ token: TOKEN, baseUrl: "https://api.example.com", fetch });
		const ws = "acme";
		const app = "hello";
		await jy.me();
		await jy.workspaces.list();
		await jy.workspaces.get(ws);
		await jy.workspaces.create({ slug: ws, name: "Acme" });
		await jy.members.list(ws);
		await jy.members.set(ws, "ada@example.com", { role: "member" });
		await jy.members.remove(ws, "ada@example.com");
		await jy.apps.list(ws);
		await jy.apps.get(ws, app);
		await jy.apps.create(ws, { slug: app, name: "Hello", driver: "workers" });
		await jy.apps.update(ws, app, { name: "Hi" });
		await jy.apps.delete(ws, app);
		await jy.versions.list(ws, app);
		await jy.versions.rollback(ws, app, 1);
		await jy.versions.promote(ws, app, 1);
		await jy.deploy.worker(ws, app, {
			main_module: "index.js",
			compatibility_date: "2026-09-01",
			modules: { "index.js": { content: "export default {}" } },
		});
		// One small file goes in a batch and one big one on its own.
		const big = new Uint8Array(4 * 1024 * 1024);
		await jy.deploy.site(ws, app, {
			files: [
				{ path: "/a.html", content: "a" },
				{ path: "/b.bin", content: big },
			],
		});
		await jy.access.list(ws, app);
		await jy.access.share(ws, app, "ada@example.com");
		await jy.access.unshare(ws, app, "ada@example.com");
		await jy.access.shareDomain(ws, app, "@example.com");
		await jy.access.unshareDomain(ws, app, "example.com");
		await jy.access.shareGroup(ws, app, "finance");
		await jy.access.unshareGroup(ws, app, "finance");
		await jy.tokens.list(ws, app);
		await jy.tokens.create(ws, app, { name: "ci", role: "viewer" });
		await jy.tokens.revoke(ws, app, "tok1");
		await jy.audit.list(ws);
		for await (const _ of jy.audit.iterate(ws)) void _;
		await jy.secrets.list(ws, app);
		await jy.secrets.set(ws, app, "STRIPE", { value: "x", inject_host: "api.stripe.com", inject_header: "Authorization" });
		await jy.secrets.delete(ws, app, "STRIPE");
		await jy.env.list(ws, app);
		await jy.env.update(ws, app, { set: { A: "1" } });

		const listed = ROUTES.routes.map((r) => `${r.method} ${r.path}`);
		expect([...asked].filter((a) => a.startsWith("UNLISTED"))).toEqual([]);
		expect(listed.filter((r) => !asked.has(r))).toEqual([]);
	});

	it("uploads small files many to a request and a big one on its own", async () => {
		const big = new Uint8Array(4 * 1024 * 1024).fill(7);
		const bigSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", big)), (b) => b.toString(16).padStart(2, "0")).join("");
		const base = "/v1/workspaces/acme/apps/hello";
		const { client, seen } = fake({
			[`GET ${base}/versions`]: () => json(200, []),
			[`POST ${base}/blobs/missing`]: (req) => json(200, { missing: (JSON.parse(req.body as string) as { sha256: string[] }).sha256 }),
			[`POST ${base}/blobs`]: () => new Response(null, { status: 204 }),
			[`PUT ${base}/blobs/${bigSha}`]: () => new Response(null, { status: 204 }),
			[`POST ${base}/site`]: () => json(201, { number: 1, status: "deployed", active: true }),
		});
		const files = [
			{ path: "index.html", content: "<h1>hi</h1>" },
			{ path: "/app.css", content: "h1{}" },
			{ path: "/copy.css", content: "h1{}" },
			{ path: "/big.bin", content: big },
		];
		await client.deploy.site("acme", "hello", { files });
		const batch = seen.find((r) => r.method === "POST" && r.url.pathname === `${base}/blobs`);
		const parts = [...(batch?.body as FormData).entries()];
		// The same bytes at two paths go up once.
		expect(parts).toHaveLength(2);
		for (const [name, value] of parts) {
			expect(name).toMatch(/^[0-9a-f]{64}$/);
			expect((value as File).name).toBe(name);
		}
		expect((parts[0]?.[1] as File).type).toBe("text/html; charset=utf-8");
		const alone = seen.find((r) => r.method === "PUT");
		expect(alone?.headers.get("content-type")).toBe("application/octet-stream");
		const site = seen.find((r) => r.url.pathname === `${base}/site`);
		const manifest = JSON.parse(site?.body as string) as { files: { path: string; size: number }[] };
		expect(manifest.files.map((f) => f.path)).toEqual(["/index.html", "/app.css", "/copy.css", "/big.bin"]);
		expect(site?.headers.get("prefer")).toBe("respond-async");
		expect(site?.headers.has("jiayang-site-entry")).toBe(false);
	});
});

describe("signing in", () => {
	let dir: string;
	const saved = { ...process.env };
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jiayang-client-"));
		delete process.env.JIAYANG_TOKEN;
		delete process.env.JIAYANG_API;
		process.env.JIAYANG_CONFIG_DIR = dir;
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		process.env = { ...saved };
	});

	const recording = () => {
		const seen: { url: string; auth: string | null }[] = [];
		const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
			return json(200, { email: "ada@example.com", workspaces: [] });
		}) as typeof globalThis.fetch;
		return { seen, fetch };
	};

	it("sends the token as a bearer, to the address it's given", async () => {
		const { seen, fetch } = recording();
		await new Jiayang({ token: TOKEN, baseUrl: "https://api.example.com/", fetch }).me();
		expect(seen).toEqual([{ url: "https://api.example.com/v1/me", auth: `Bearer ${TOKEN}` }]);
	});

	it("takes JIAYANG_TOKEN and JIAYANG_API from the environment", async () => {
		process.env.JIAYANG_TOKEN = "jyu_fromenv";
		process.env.JIAYANG_API = "https://api.staging.example.com";
		const { seen, fetch } = recording();
		await new Jiayang({ fetch }).me();
		expect(seen).toEqual([{ url: "https://api.staging.example.com/v1/me", auth: "Bearer jyu_fromenv" }]);
	});

	it("uses the session `jiayang login` saved, with the API it's for", async () => {
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({ api_url: "http://api.jiayang.localhost:8000", api_token: "jyu_saved", session_expires_at: "2999-01-01T00:00:00Z" }),
		);
		const { seen, fetch } = recording();
		const jy = new Jiayang({ fetch });
		await jy.me();
		expect(seen).toEqual([{ url: "http://api.jiayang.localhost:8000/v1/me", auth: "Bearer jyu_saved" }]);
		expect(await jy.baseUrl()).toBe("http://api.jiayang.localhost:8000");
	});

	it("sends the saved session only to the API it's for", async () => {
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({ api_url: "https://api.jiayang.cloud", api_token: "jyu_saved", session_expires_at: "2999-01-01T00:00:00Z" }),
		);
		const { seen, fetch } = recording();
		process.env.JIAYANG_API = "https://api.attacker.example";
		await expect(new Jiayang({ fetch }).me()).rejects.toThrow(ConfigError);
		await expect(new Jiayang({ fetch }).me()).rejects.toThrow(/only send your session there/);
		delete process.env.JIAYANG_API;
		await expect(new Jiayang({ baseUrl: "https://api.attacker.example", fetch }).me()).rejects.toThrow(ConfigError);
		expect(seen).toEqual([]);
		// The same API, written another way, is fine.
		process.env.JIAYANG_API = "https://API.jiayang.cloud/";
		await new Jiayang({ fetch }).me();
		expect(seen).toEqual([{ url: "https://api.jiayang.cloud/v1/me", auth: "Bearer jyu_saved" }]);
		// A token passed in goes where it's told.
		process.env.JIAYANG_API = "https://api.staging.example.com";
		await new Jiayang({ token: TOKEN, fetch }).me();
		expect(seen.at(-1)).toEqual({ url: "https://api.staging.example.com/v1/me", auth: `Bearer ${TOKEN}` });
	});

	it("won't guess the API a saved session is for", async () => {
		writeFileSync(join(dir, "config.json"), JSON.stringify({ api_token: "jyu_saved", session_expires_at: "2999-01-01T00:00:00Z" }));
		const { seen, fetch } = recording();
		await expect(new Jiayang({ fetch }).me()).rejects.toThrow(/jiayang login/);
		expect(seen).toEqual([]);
	});

	it("says so when the saved session has ended, or there is none", async () => {
		const { fetch } = recording();
		await expect(new Jiayang({ fetch }).me()).rejects.toThrow(/No token/);
		writeFileSync(join(dir, "config.json"), JSON.stringify({ api_token: "jyu_saved", session_expires_at: "2020-01-01T00:00:00Z" }));
		await expect(new Jiayang({ fetch }).me()).rejects.toThrow(/has ended/);
	});

	it("refuses a token that isn't for the API before sending it anywhere", () => {
		expect(() => new Jiayang({ token: "jyb_abc" })).toThrow(/bypass token/);
		expect(() => new Jiayang({ token: "jya_abc" })).toThrow(ConfigError);
		expect(() => new Jiayang({ token: "jyu_a\r\nx: y" })).toThrow(ConfigError);
		expect(() => new Jiayang({ token: "" })).toThrow(ConfigError);
	});

	it("never sends a token over plain http to another machine", () => {
		expect(() => new Jiayang({ token: TOKEN, baseUrl: "http://api.example.com" })).toThrow(/isn't https/);
		expect(() => new Jiayang({ token: TOKEN, baseUrl: "http://localhost:8000" })).not.toThrow();
		expect(() => new Jiayang({ token: TOKEN, baseUrl: "http://127.0.0.1:8000" })).not.toThrow();
		expect(() => new Jiayang({ token: TOKEN, baseUrl: "http://[::1]:8000" })).not.toThrow();
		expect(() => new Jiayang({ token: TOKEN, baseUrl: "http://localhost.example.com" })).toThrow(/isn't https/);
		expect(() => new Jiayang({ token: TOKEN, baseUrl: "https://user:pw@api.example.com" })).toThrow(ConfigError);
	});

	it("follows no redirect, which would carry the token somewhere else", async () => {
		let redirect: RequestRedirect | undefined;
		const fetch = (async (_: RequestInfo | URL, init?: RequestInit) => {
			redirect = init?.redirect;
			return new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } });
		}) as typeof globalThis.fetch;
		await expect(new Jiayang({ token: TOKEN, baseUrl: "https://api.example.com", fetch }).me()).rejects.toThrow(JiayangError);
		expect(redirect).toBe("manual");
	});
});

describe("errors", () => {
	it("are typed by status, with the platform's code and message", async () => {
		const { client } = fake({
			"GET /v1/workspaces/acme": () => refusal(404, "not_found", "Not found."),
			"POST /v1/workspaces": () => refusal(400, "bad_request", "Use lower-case letters."),
			"GET /v1/me": () => refusal(401, "unauthenticated", "Sign in."),
			"POST /v1/workspaces/acme/apps": () =>
				refusal(403, "plan_limit", "Free has 3 apps.", {}, { limit: { what: "apps", max: 3, plan: "free" } }),
			"DELETE /v1/workspaces/acme/apps/hello": () => refusal(403, "forbidden", "No."),
			"PATCH /v1/workspaces/acme/apps/hello": () => refusal(409, "conflict", "Taken."),
		});
		const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
		const missing = await caught(client.workspaces.get("acme"));
		expect(missing).toBeInstanceOf(NotFoundError);
		expect(missing).toMatchObject({ status: 404, code: "not_found", message: "Not found." });
		expect(await caught(client.workspaces.create({ slug: "Acme", name: "x" }))).toBeInstanceOf(BadRequestError);
		expect(await caught(client.me())).toBeInstanceOf(AuthenticationError);
		const limit = await caught(client.apps.create("acme", { slug: "a", name: "a", driver: "workers" }));
		expect(limit).toBeInstanceOf(PlanLimitError);
		expect(limit).toBeInstanceOf(PermissionDeniedError);
		expect((limit as PlanLimitError).limit).toEqual({ what: "apps", max: 3, plan: "free" });
		expect(await caught(client.apps.delete("acme", "hello"))).toBeInstanceOf(PermissionDeniedError);
		expect(await caught(client.apps.update("acme", "hello", {}))).toBeInstanceOf(ConflictError);
	});

	it("say so when the answer isn't the platform's own", async () => {
		const { client } = fake({
			"GET /v1/me": () => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway", headers: { "cf-ray": "8abc-LHR" } }),
		}, { maxRetries: 0 });
		const err = await client.me().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ServerError);
		expect(err).toMatchObject({ status: 502, code: "", requestId: "8abc-LHR", message: "The API answered 502 Bad Gateway." });
	});
});

describe("retries", () => {
	it("try a read again after a failure on our side, and then give up", async () => {
		const { client, seen } = fake({
			"GET /v1/me": [() => refusal(503, "busy", "Busy."), () => json(200, { email: "a@example.com", workspaces: [] })],
			"GET /v1/workspaces/acme": () => refusal(500, "internal", "Oops."),
		});
		expect((await client.me()).email).toBe("a@example.com");
		await expect(client.workspaces.get("acme")).rejects.toBeInstanceOf(ServerError);
		expect(seen.filter((r) => r.url.pathname === "/v1/workspaces/acme")).toHaveLength(3);
	});

	it("never send a change twice that may have been made", async () => {
		const { client, seen } = fake({ "POST /v1/workspaces": () => refusal(502, "unavailable", "Try again.") });
		await expect(client.workspaces.create({ slug: "acme", name: "Acme" })).rejects.toBeInstanceOf(ServerError);
		expect(seen).toHaveLength(1);
	});

	it("wait out a 429 for as long as it says", async () => {
		const waits: number[] = [];
		const realTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms?: number) => {
			waits.push(ms ?? 0);
			return realTimeout(fn, 0);
		}) as typeof setTimeout;
		try {
			const { client, seen } = fake({
				"GET /v1/me": [() => refusal(429, "rate_limited", "Slow down.", { "retry-after": "3" }), () => json(200, { workspaces: [] })],
			});
			expect((await client.me()).workspaces).toEqual([]);
			expect(seen).toHaveLength(2);
			expect(waits).toContain(3000);
		} finally {
			globalThis.setTimeout = realTimeout;
		}
	});

	it("never send a change twice after a 429, since it may have been made", async () => {
		const { client, seen } = fake({
			"POST /v1/workspaces": [() => refusal(429, "rate_limited", "Slow down.", { "retry-after": "3" }), () => json(201, { slug: "acme" })],
		});
		const err = await client.workspaces.create({ slug: "acme", name: "Acme" }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RateLimitError);
		expect((err as RateLimitError).retryAfter).toBe(3);
		expect(seen).toHaveLength(1);
	});

	it("give up on a 429 whose wait is too long, saying how long", async () => {
		const { client } = fake({ "GET /v1/me": () => refusal(429, "rate_limited", "Slow down.", { "retry-after": "600" }) });
		const err = await client.me().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RateLimitError);
		expect((err as RateLimitError).retryAfter).toBe(600);
	});

	it("don't ask again for what asking again won't fix", async () => {
		const { client, seen } = fake({ "GET /v1/me": () => refusal(500, "storage_refused", "No.") });
		await expect(client.me()).rejects.toBeInstanceOf(ServerError);
		expect(seen).toHaveLength(1);
	});

	it("try a read again when the connection fails", async () => {
		let calls = 0;
		const fetch = (async () => {
			calls += 1;
			if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
			return json(200, { email: "a@example.com", workspaces: [] });
		}) as typeof globalThis.fetch;
		const jy = new Jiayang({ token: TOKEN, baseUrl: "https://api.example.com", fetch });
		jy.backoff = () => 0;
		expect((await jy.me()).email).toBe("a@example.com");
		const failing = new Jiayang({ token: TOKEN, baseUrl: "https://api.example.com", maxRetries: 0, fetch: (async () => {
			throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
		}) as typeof globalThis.fetch });
		await expect(failing.me()).rejects.toThrow(ConnectionFailedError);
		await expect(failing.me()).rejects.toThrow(/ECONNREFUSED/);
	});
});

describe("paths", () => {
	it("encode each name as one segment, as the CLI does", () => {
		expect(segment("ada@example.com")).toBe("ada@example.com");
		expect(segment("a b/c?d#e")).toBe("a%20b%2Fc%3Fd%23e");
		expect(segment("é")).toBe("%C3%A9");
		expect(() => segment("..")).toThrow(JiayangError);
		expect(() => segment("")).toThrow(JiayangError);
	});
});
