// What `pnpm build` produced, rather than what the source says.
//
// Every other test imports from src/, where there is only ever one copy of anything. The package
// is five bundles, and what has to hold across them (one Unauthorized, one key cache) is a
// property of how they were built.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const built = existsSync(`${dist}index.mjs`);

/** Runs a snippet in a fresh process, since this one has its own copy of everything. */
function run(source: string, ...args: string[]): string {
	return execFileSync(process.execPath, ["--input-type=module", "-e", source, ...args], { encoding: "utf8" }).trim();
}

describe.runIf(built)("the built package", () => {
	it("throws one Unauthorized, whichever entry it came from", () => {
		const answer = run(`
			const root = await import("${dist}index.mjs");
			const node = await import("${dist}node.mjs");
			const next = await import("${dist}next.mjs");
			const hono = await import("${dist}hono.mjs");
			const answers = [];
			for (const call of [
				() => node.requireUserFrom({ headers: {} }, {}),
				() => next.requireUser({ env: {}, headers: { get: () => null } }),
				() => hono.jiayang({ env: {} })({ req: { raw: new Request("https://a.invalid/") }, env: {}, get: () => undefined, set: () => {} }, async () => {}),
				() => node.requireWebhookFrom({ headers: {} }, {}, { provider: "stripe" }),
				() => next.requireWebhook({ env: {}, headers: { get: () => null }, provider: "stripe" }),
				() => hono.webhook({ env: {}, provider: "stripe" })({ req: { raw: new Request("https://a.invalid/") }, env: {} }, async () => {}),
			]) {
				try { const answer = await call(); answers.push(answer instanceof Response ? answer.status === 401 : "no refusal"); }
				catch (err) { answers.push(err instanceof root.Unauthorized); }
			}
			console.log(JSON.stringify(answers));
		`);
		expect(JSON.parse(answer)).toEqual([true, true, true, true, true, true]);
	});

	it("does the same in commonjs", () => {
		const answer = run(`
			const { createRequire } = await import("node:module");
			const require = createRequire("${dist}");
			const root = require("${dist}index.cjs");
			const node = require("${dist}node.cjs");
			try { await node.requireUserFrom({ headers: {} }, {}); } catch (err) { console.log(err instanceof root.Unauthorized); }
		`);
		expect(answer).toBe("true");
	});

	// One copy of the core means one key cache: two would be twice the fetches, and clearing one
	// wouldn't clear the other.
	it("has one core, not one per entry", () => {
		const answer = run(`
			const root = await import("${dist}index.mjs");
			const express = await import("${dist}express.mjs");
			console.log(JSON.stringify({ cleared: typeof root.clearKeyCache, shared: !("clearKeyCache" in express) }));
		`);
		expect(JSON.parse(answer)).toEqual({ cleared: "function", shared: true });
	});
});

// The package as an app gets it: installed beside the app, read through its manifest, and checked
// by the app's own TypeScript in whatever module system the app is.
describe.runIf(built)("the package installed in an app", () => {
	const ENTRIES = ["@jiayang-cloud/sdk", "@jiayang-cloud/sdk/node", "@jiayang-cloud/sdk/express", "@jiayang-cloud/sdk/hono", "@jiayang-cloud/sdk/next"];
	const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");
	const apps: string[] = [];
	afterAll(() => apps.forEach((app) => rmSync(app, { recursive: true, force: true })));

	/** An app of this module system with the package in its node_modules: the manifest and dist/, as npm installs them. */
	function app(type: "commonjs" | "module"): string {
		const root = mkdtempSync(join(tmpdir(), "jiayang-sdk-"));
		apps.push(root);
		const installed = join(root, "node_modules/@jiayang-cloud/sdk");
		cpSync(dist, join(installed, "dist"), { recursive: true });
		cpSync(join(dist, "../package.json"), join(installed, "package.json"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", private: true, type }));
		writeFileSync(
			join(root, "app.ts"),
			`import { Unauthorized, requireUser, requireWebhook, type Provider, type User, type Webhook } from "@jiayang-cloud/sdk";
			import { envFromProcess, requireUserFrom, requireWebhookFrom } from "@jiayang-cloud/sdk/node";
			import { requireUser as middleware, requireWebhook as webhookMiddleware } from "@jiayang-cloud/sdk/express";
			import { getWebhook, jiayang, webhook } from "@jiayang-cloud/sdk/hono";
			import { getUser, requireWebhook as routeWebhook } from "@jiayang-cloud/sdk/next";

			export async function caller(headers: Record<string, string>): Promise<User | null> {
				try {
					return await requireUserFrom({ headers }, envFromProcess());
				} catch (err) {
					if (err instanceof Unauthorized) return null;
					throw err;
				}
			}
			const providers: Provider[] = ["stripe", "github"];
			export async function delivery(headers: Record<string, string>): Promise<Webhook> {
				return requireWebhookFrom({ headers }, envFromProcess(), { provider: providers });
			}
			export const everything = [
				requireUser, middleware(), jiayang(), getUser,
				requireWebhook, webhookMiddleware({ provider: "stripe" }), webhook({ provider: "slack" }), getWebhook, routeWebhook,
			];
			`,
		);
		return root;
	}

	/** The app's own type check, as `module` sets it; tsc's complaints if it has any. */
	function typecheck(root: string, module: string): string {
		const compilerOptions = { module, strict: true, noEmit: true, target: "es2022", lib: ["es2022", "dom"], types: [] };
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions, files: ["app.ts"] }));
		try {
			execFileSync(process.execPath, [tsc, "-p", root], { encoding: "utf8" });
			return "";
		} catch (err) {
			return String((err as { stdout?: string }).stdout ?? err);
		}
	}

	// An Express or NestJS app compiled to CommonJS requires the package, and TypeScript refuses to
	// require an entry whose only types describe an ES module (TS1479).
	it("type-checks in a CommonJS app", () => {
		const root = app("commonjs");
		for (const module of ["node16", "nodenext", "commonjs"]) expect(typecheck(root, module), module).toBe("");
	});

	it("type-checks in an ES module app", () => {
		const root = app("module");
		for (const module of ["node16", "nodenext", "esnext"]) expect(typecheck(root, module), module).toBe("");
	});

	// TypeScript before exports (moduleResolution node10, the default for `module: commonjs` until
	// 6.0) reads `types` for the package and typesVersions for a subpath. The TypeScript here can't
	// resolve that way any more, so check that each leads where the require condition does.
	it("points a TypeScript that predates exports at the same types", () => {
		const pkg = JSON.parse(readFileSync(join(dist, "../package.json"), "utf8"));
		expect(pkg.types).toBe(pkg.exports["."].require.types);
		expect(pkg.main).toBe(pkg.exports["."].require.default);
		for (const [subpath, conditions] of Object.entries(pkg.exports as Record<string, { require: { types: string } }>)) {
			if (subpath === "." || subpath === "./package.json") continue;
			expect(pkg.typesVersions["*"][subpath.slice(2)], subpath).toEqual([conditions.require.types]);
		}
		for (const file of [pkg.main, pkg.types, ...Object.values(pkg.typesVersions["*"]).flat()]) {
			expect(existsSync(join(dist, "..", file as string)), file as string).toBe(true);
		}
	});

	it("loads every entry by name, from either module system", () => {
		const cjs = app("commonjs");
		execFileSync(process.execPath, ["-e", `for (const e of ${JSON.stringify(ENTRIES)}) require(e)`], { cwd: cjs });
		const esm = app("module");
		const imports = `for (const e of ${JSON.stringify(ENTRIES)}) await import(e)`;
		execFileSync(process.execPath, ["--input-type=module", "-e", imports], { cwd: esm });
	});
});
