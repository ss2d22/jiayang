import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConflictError, DeployFailedError, JiayangError, RequestTimeoutError } from "../src/index.js";
import { CONTENT_TYPES, base64, bytesOf, contentType, moduleType, siteVersionHash, workerVersionHash } from "../src/deploy.js";
import { fake, json, refusal, version } from "./fake.js";

const BASE = "/v1/workspaces/acme/apps/hello";
const WORKER = {
	main_module: "index.js",
	compatibility_date: "2026-09-01",
	modules: { "index.js": { content: "export default { fetch() { return new Response('hi') } }" } },
};

describe("deploying a Worker", () => {
	it("sends its modules in base64, typed by name, and returns the live version", async () => {
		const { client, seen } = fake({
			[`GET ${BASE}/versions`]: () => json(200, [version(1)]),
			[`POST ${BASE}/versions`]: () => json(201, version(2)),
		});
		const wasm = new Uint8Array([0, 97, 115, 109]);
		const live = await client.deploy.worker("acme", "hello", {
			...WORKER,
			compatibility_flags: ["nodejs_compat"],
			modules: { ...WORKER.modules, "add.wasm": { content: wasm }, "page.html": { content: "<p>" }, "blob.bin": { content: wasm.buffer } },
		});
		expect(live.number).toBe(2);
		const sent = seen.find((r) => r.method === "POST");
		expect(sent?.headers.get("content-type")).toBe("application/json");
		const body = JSON.parse(sent?.body as string);
		expect(body).toEqual({
			main_module: "index.js",
			compatibility_date: "2026-09-01",
			compatibility_flags: ["nodejs_compat"],
			modules: {
				"index.js": { type: "esm", b64: btoa(WORKER.modules["index.js"].content) },
				"add.wasm": { type: "wasm", b64: "AGFzbQ==" },
				"page.html": { type: "text", b64: btoa("<p>") },
				"blob.bin": { type: "data", b64: "AGFzbQ==" },
			},
		});
	});

	// Review: a bundle couldn't ask for key-value storage or a queue, so a first deploy went up
	// with neither and env.KV was undefined.
	it("asks for key-value storage and a queue as jiayang.json would", async () => {
		const { client, seen } = fake({
			[`GET ${BASE}/versions`]: () => json(200, []),
			[`POST ${BASE}/versions`]: () => json(201, version(1)),
		});
		await client.deploy.worker("acme", "hello", { ...WORKER, kv: true, queue: { path: "/jobs/queue" } });
		const body = JSON.parse(seen.find((r) => r.method === "POST")?.body as string);
		expect(body.kv).toBe(true);
		expect(body.queue).toEqual({ path: "/jobs/queue" });
		const { client: plain, seen: plainSeen } = fake({
			[`GET ${BASE}/versions`]: () => json(200, []),
			[`POST ${BASE}/versions`]: () => json(201, version(1)),
		});
		await plain.deploy.worker("acme", "hello", WORKER);
		const sent = JSON.parse(plainSeen.find((r) => r.method === "POST")?.body as string);
		expect("kv" in sent || "queue" in sent).toBe(false);
	});

	it("refuses a main module that isn't among the modules", async () => {
		const { client, seen } = fake({});
		await expect(client.deploy.worker("acme", "hello", { ...WORKER, main_module: "main.js" })).rejects.toThrow(/main\.js/);
		expect(seen).toHaveLength(0);
	});

	it("puts a preview up with ?preview=true", async () => {
		const { client, seen } = fake({
			[`GET ${BASE}/versions`]: () => json(200, []),
			[`POST ${BASE}/versions`]: () => json(201, version(1, "deployed", { active: false, preview: { url: "https://p", until: "x", live: true } })),
		});
		const made = await client.deploy.worker("acme", "hello", WORKER, { preview: true });
		expect(made.preview?.live).toBe(true);
		expect(seen.find((r) => r.method === "POST")?.url.search).toBe("?preview=true");
	});
});

describe("following a version live", () => {
	it("waits for a version on its way, and returns it once it's live", async () => {
		const progress: string[] = [];
		const { client } = fake({
			[`GET ${BASE}/versions`]: [
				() => json(200, [version(1)]),
				() => json(200, [version(2, "uploaded"), version(1)]),
				() => json(200, [version(2), version(1, "deployed", { active: false })]),
			],
			[`POST ${BASE}/versions`]: () => json(202, version(2, "uploaded")),
		});
		const live = await client.deploy.worker("acme", "hello", WORKER, { onProgress: (line) => progress.push(line) });
		expect(live).toMatchObject({ number: 2, status: "deployed", active: true });
		expect(progress).toContain("Version 2 is going live ...");
	});

	it("returns at once with wait: false", async () => {
		const { client } = fake({
			[`GET ${BASE}/versions`]: () => json(200, []),
			[`POST ${BASE}/versions`]: () => json(202, version(1, "uploaded")),
		});
		expect((await client.deploy.worker("acme", "hello", WORKER, { wait: false })).status).toBe("uploaded");
	});

	it("throws DeployFailedError with the platform's reason when it fails", async () => {
		const { client } = fake({
			[`GET ${BASE}/versions`]: [() => json(200, []), () => json(200, [version(1, "failed", { failure: "Cloudflare refused the app's code: boom" })])],
			[`POST ${BASE}/versions`]: () => json(202, version(1, "uploaded")),
		});
		const err = await client.deploy.worker("acme", "hello", WORKER).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DeployFailedError);
		expect((err as DeployFailedError).message).toBe("Cloudflare refused the app's code: boom");
		expect((err as DeployFailedError).version.number).toBe(1);
	});

	it("waits its turn behind another version going live, then deploys", async () => {
		const { client, seen } = fake({
			[`GET ${BASE}/versions`]: [
				() => json(200, [version(2, "uploaded"), version(1)]),
				() => json(200, [version(2, "uploaded"), version(1)]),
				() => json(200, [version(2), version(1)]),
				() => json(200, [version(2)]),
			],
			[`POST ${BASE}/versions`]: [() => refusal(409, "version_going_live", "Version 2 is still going live."), () => json(201, version(3))],
		});
		expect((await client.deploy.worker("acme", "hello", WORKER)).number).toBe(3);
		expect(seen.filter((r) => r.method === "POST")).toHaveLength(2);
	});

	it("gives up waiting its turn after waitTimeoutMs", async () => {
		const { client } = fake({
			[`GET ${BASE}/versions`]: () => json(200, [version(2, "uploaded")]),
			[`POST ${BASE}/versions`]: () => refusal(409, "version_going_live", "Version 2 is still going live."),
		});
		await expect(client.deploy.worker("acme", "hello", WORKER, { waitTimeoutMs: 20 })).rejects.toBeInstanceOf(ConflictError);
	});

	it("looks for the version when the deploy's answer never came, rather than deploying twice", async () => {
		let posts = 0;
		const ours = { sha256: await workerHash(WORKER) };
		const { client } = fake({
			[`GET ${BASE}/versions`]: [() => json(200, [version(1)]), () => json(200, [version(1)]), () => json(200, [version(2, "deployed", ours), version(1)])],
			[`POST ${BASE}/versions`]: () => {
				posts += 1;
				return new Response("gateway timeout", { status: 504 });
			},
		});
		expect((await client.deploy.worker("acme", "hello", WORKER)).number).toBe(2);
		expect(posts).toBe(1);
	});

	it("doesn't take a teammate's version for its own", async () => {
		const ours = { sha256: await workerHash(WORKER) };
		const theirs = { sha256: "f".repeat(64), created_by: "bob@example.com" };
		const { client } = fake({
			[`GET ${BASE}/versions`]: [
				() => json(200, [version(1)]),
				() => json(200, [version(2, "deployed", theirs), version(1)]),
				() => json(200, [version(3, "deployed", ours), version(2, "deployed", theirs), version(1)]),
			],
			[`POST ${BASE}/versions`]: () => new Response("gateway timeout", { status: 504 }),
		});
		expect((await client.deploy.worker("acme", "hello", WORKER)).number).toBe(3);
		const alone = fake({
			[`GET ${BASE}/versions`]: [() => json(200, [version(1)]), () => json(200, [version(2, "deployed", theirs), version(1)])],
			[`POST ${BASE}/versions`]: () => new Response("gateway timeout", { status: 504 }),
		});
		await expect(alone.client.deploy.worker("acme", "hello", WORKER)).rejects.toBeInstanceOf(JiayangError);
	});

	it("waits out a 429, and sends the deploy again only if it wasn't made", async () => {
		const ours = { sha256: await workerHash(WORKER) };
		const slow = () => refusal(429, "rate_limited", "Slow down.", { "retry-after": "0" });
		const again = fake({
			[`GET ${BASE}/versions`]: () => json(200, [version(1)]),
			[`POST ${BASE}/versions`]: [slow, () => json(201, version(2, "deployed", ours))],
		});
		expect((await again.client.deploy.worker("acme", "hello", WORKER)).number).toBe(2);
		expect(again.seen.filter((r) => r.method === "POST")).toHaveLength(2);
		const made = fake({
			[`GET ${BASE}/versions`]: [() => json(200, [version(1)]), () => json(200, [version(2, "deployed", ours), version(1)])],
			[`POST ${BASE}/versions`]: slow,
		});
		expect((await made.client.deploy.worker("acme", "hello", WORKER)).number).toBe(2);
		expect(made.seen.filter((r) => r.method === "POST")).toHaveLength(1);
	});

	it("throws the original failure when no version turns up", async () => {
		const { client } = fake({
			[`GET ${BASE}/versions`]: () => json(200, [version(1)]),
			[`POST ${BASE}/versions`]: () => {
				const err = new DOMException("timed out", "TimeoutError");
				throw err;
			},
		});
		await expect(client.deploy.worker("acme", "hello", WORKER)).rejects.toBeInstanceOf(RequestTimeoutError);
	});
});

describe("deploying a site", () => {
	it("sends nothing the platform already has", async () => {
		const { client, seen } = fake({
			[`GET ${BASE}/versions`]: () => json(200, []),
			[`POST ${BASE}/blobs/missing`]: () => json(200, { missing: [] }),
			[`POST ${BASE}/site`]: () => json(201, version(1)),
		});
		await client.deploy.site("acme", "hello", { files: [{ path: "/index.html", content: "hi" }], not_found_handling: "404-page" });
		expect(seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
			`POST ${BASE}/blobs/missing`,
			`GET ${BASE}/versions`,
			`POST ${BASE}/site`,
		]);
		const manifest = JSON.parse(seen.at(-1)?.body as string);
		expect(manifest).toEqual({
			files: [{ path: "/index.html", sha256: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4", size: 2, content_type: "text/html; charset=utf-8" }],
			not_found_handling: "404-page",
			run_worker_first: null,
		});
	});

	it("sends the lock files and allow file for the deploy's scan", async () => {
		const { client, seen } = fake({
			[`GET ${BASE}/versions`]: () => json(200, []),
			[`POST ${BASE}/blobs/missing`]: () => json(200, { missing: [] }),
			[`POST ${BASE}/site`]: () => json(201, version(1)),
			[`POST ${BASE}/versions`]: () => json(201, version(2)),
		});
		const scan = { lockfiles: [{ path: "package-lock.json", text: "{}" }], allow: "AKIA* in /index.html\n" };
		await client.deploy.site("acme", "hello", { files: [{ path: "/index.html", content: "hi" }] }, { scan });
		expect(JSON.parse(seen.at(-1)?.body as string).scan).toEqual(scan);
		await client.deploy.worker("acme", "hello", WORKER, { scan: { allow: "" } });
		expect(JSON.parse(seen.at(-1)?.body as string).scan).toEqual({ allow: "" });
		await client.deploy.site("acme", "hello", { files: [{ path: "/index.html", content: "hi" }] }, { scan: { lockfiles: [] } });
		expect(JSON.parse(seen.at(-1)?.body as string)).not.toHaveProperty("scan");
	});

	it("refuses a file twice, an empty site and run_worker_first", async () => {
		const { client } = fake({});
		const file = { path: "/a.txt", content: "a" };
		await expect(client.deploy.site("acme", "hello", { files: [file, { ...file, path: "a.txt" }] })).rejects.toThrow(/twice/);
		await expect(client.deploy.site("acme", "hello", { files: [] })).rejects.toThrow(JiayangError);
		await expect(client.deploy.site("acme", "hello", { files: [file], run_worker_first: true })).rejects.toThrow(/run_worker_first/);
	});
});

async function workerHash(bundle: typeof WORKER): Promise<string> {
	const modules = Object.fromEntries(
		Object.entries(bundle.modules).map(([name, m]) => [name, { type: moduleType(name, m.content), bytes: bytesOf(m.content) }]),
	);
	return workerVersionHash(modules, [], undefined);
}

describe("a version's name", () => {
	it("is the one the platform gives it", async () => {
		const shared = JSON.parse(readFileSync(new URL("../../testdata/version-hashes.json", import.meta.url), "utf8"));
		expect(await siteVersionHash(shared.site.files)).toBe(shared.site.sha256);
		const deploy = shared.worker.deploy;
		const modules = Object.fromEntries(
			Object.entries(deploy.modules as Record<string, { type: "esm"; b64: string }>).map(([name, m]) => [
				name,
				{ type: m.type, bytes: Uint8Array.from(atob(m.b64), (ch) => ch.charCodeAt(0)) },
			]),
		);
		expect(await workerVersionHash(modules, deploy.compatibility_flags, deploy.assets)).toBe(shared.worker.sha256);
	});
});

describe("module and content types", () => {
	it("match the table the CLI uses", () => {
		const shared = JSON.parse(readFileSync(new URL("../../testdata/content-types.json", import.meta.url), "utf8"));
		expect(CONTENT_TYPES).toEqual(shared);
		expect(contentType("/a/b/Index.HTML")).toBe("text/html; charset=utf-8");
		expect(contentType("/Makefile")).toBe("application/octet-stream");
		expect(moduleType("x.MJS", "")).toBe("esm");
	});

	it("encode base64 as the platform reads it, large inputs too", () => {
		const big = new Uint8Array(200_000).map((_, i) => i % 256);
		expect(base64(big)).toBe(Buffer.from(big).toString("base64"));
	});
});
