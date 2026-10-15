// What `pnpm build` produced, rather than what the source says. Skipped when there's no dist/.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const built = existsSync(`${dist}index.mjs`);

function run(source: string, type: "module" | "commonjs"): string {
	const env = { ...process.env, NO_COLOR: "1", JIAYANG_TOKEN: "", JIAYANG_CONFIG_DIR: "/nonexistent" };
	return execFileSync(process.execPath, [`--input-type=${type}`, "-e", source], { encoding: "utf8", env }).trim();
}

describe.runIf(built)("the built package", () => {
	it("loads as an ES module and as CommonJS, with the same names", () => {
		const esm = run(`const m = await import("${dist}index.mjs"); console.log(Object.keys(m).sort().join(","))`, "module");
		const cjs = run(`const m = require("${dist}index.cjs"); console.log(Object.keys(m).sort().join(","))`, "commonjs");
		expect(esm).toBe(cjs);
		for (const name of ["Jiayang", "NotFoundError", "PlanLimitError", "DeployFailedError", "VERSION"]) expect(esm.split(",")).toContain(name);
	});

	it("reads the saved session from CommonJS too", () => {
		const said = run(
			`const { Jiayang } = require("${dist}index.cjs"); new Jiayang().me().catch((e) => console.log(e.name + ": " + e.message));`,
			"commonjs",
		);
		expect(said).toMatch(/^ConfigError: No token/);
	});

	it("needs nothing from Node to load, so it runs on Workers", () => {
		const bundle = readFileSync(`${dist}index.mjs`, "utf8");
		expect(bundle).not.toMatch(/^import .* from ["']node:/m);
		expect(bundle).not.toMatch(/require\(["']node:/);
	});

	it("says its own version", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(run(`const m = await import("${dist}index.mjs"); console.log(m.VERSION)`, "module")).toBe(pkg.version);
	});

	it("types the CommonJS entry for a CommonJS app", () => {
		const declared = readFileSync(`${dist}index.d.cts`, "utf8");
		expect(declared).toMatch(/\.\/client\.cjs/);
		expect(declared).not.toMatch(/\.\/client\.js/);
	});
});
