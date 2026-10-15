// Builds the package: one bundle in both module formats. Runs after tsc has written the
// declarations into dist/ (`pnpm build` does both, in order).

import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const common = {
	entryPoints: ["src/index.ts"],
	bundle: true,
	// Not "node": it runs on Workers, Deno and Bun too. Reading the CLI's saved session is the one
	// thing that needs Node, and it asks for node:fs only when it runs there.
	platform: "neutral",
	target: "es2022",
	outdir: "dist",
	logLevel: "warning",
};

for (const [format, extension] of [
	["esm", ".mjs"],
	["cjs", ".cjs"],
]) {
	await build({ ...common, format, outExtension: { ".js": extension } });
}

// A .d.ts in a "type": "module" package describes an ES module, which a CommonJS app's TypeScript
// refuses to `require` (TS1479). The require condition gets a .d.cts copy, its imports pointed at
// the CommonJS declarations.
for (const file of ["index", "client", "config", "deploy", "errors", "local", "paths", "types"]) {
	const esm = await readFile(`dist/${file}.d.ts`, "utf8");
	await writeFile(`dist/${file}.d.cts`, esm.replace(/(["'])\.\/([a-z]+)\.js\1/g, "$1./$2.cjs$1"));
}
