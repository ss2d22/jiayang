// Builds the package: one bundle per entry, in both module formats, and the types for each.
//
// The entries share the core rather than each bundling a copy of it. Two copies would mean two
// key caches, so twice the JWKS fetches, and errors that fail `instanceof` across them, which
// is the one thing every app does with them.
//
// Runs after tsc has written the declarations into dist/ (`pnpm build` does both, in order).

import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const ENTRIES = ["index", "node", "express", "hono", "next"];
const SIBLING = new RegExp(`^\\./(${ENTRIES.join("|")})\\.js$`);

/** Leaves an import of a sibling entry alone, pointing it at that entry's file in this format.
 *  Anything else inside the package is still bundled. */
const shared = (extension) => ({
	name: "shared-entries",
	setup(build) {
		build.onResolve({ filter: SIBLING }, (args) => ({
			path: args.path.replace(/\.js$/, extension),
			external: true,
		}));
	},
});

const common = {
	entryPoints: ENTRIES.map((name) => `src/${name}.ts`),
	bundle: true,
	// Not "node": the same file runs on Workers, Deno and Bun, and nothing here needs Node's own
	// modules. jose comes along, since an app shouldn't have to install it.
	platform: "neutral",
	conditions: ["workerd", "worker", "browser"],
	mainFields: ["module", "main"],
	target: "es2022",
	// Next is the app's dependency, not ours.
	external: ["next/*"],
	outdir: "dist",
	logLevel: "warning",
};

for (const [format, extension] of [
	["esm", ".mjs"],
	["cjs", ".cjs"],
]) {
	await build({ ...common, format, outExtension: { ".js": extension }, plugins: [shared(extension)] });
}

// tsc's declarations describe the ES modules: this package is "type": "module", so a .d.ts in it
// is ESM. A CommonJS app's TypeScript refuses to `require` what one of those describes (TS1479),
// so each entry gets a .d.cts twin for the require condition, its sibling imports pointed at the
// .cjs files the way the bundles' are.
const DECLARED_SIBLING = new RegExp(`(["'])\\./(${ENTRIES.join("|")})\\.js\\1`, "g");
for (const name of ENTRIES) {
	const esm = await readFile(`dist/${name}.d.ts`, "utf8");
	await writeFile(`dist/${name}.d.cts`, esm.replace(DECLARED_SIBLING, "$1./$2.cjs$1"));
}
