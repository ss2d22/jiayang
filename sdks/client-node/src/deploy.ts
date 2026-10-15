// Deploys: the files go up by content first, so a redeploy sends only what changed, then a version
// says what the app is made of. A deploy that takes a while is answered with its version on its
// way live, and this follows it in the version list until it's live or has failed.

import type { Jiayang } from "./client.js";
import { appPath } from "./paths.js";
import {
	ApiError,
	ConflictError,
	ConnectionFailedError,
	DeployFailedError,
	JiayangError,
	RateLimitError,
	RequestTimeoutError,
	ServerError,
} from "./errors.js";
import { RETRY_AFTER_CAP } from "./config.js";
import type { ModuleType, SiteFile, SiteOptions, Version, WorkerBundle } from "./types.js";

export interface DeployOptions {
	/** Put it up at a preview address of its own and leave the live version as it is. */
	preview?: boolean;
	/** Wait for the version to be live (the default), or return as soon as it's on its way. */
	wait?: boolean;
	/** How long to wait for it, and for another version of the app ahead of it. 30 minutes. */
	waitTimeoutMs?: number;
	/** Told what's happening, a line at a time. */
	onProgress?: (message: string) => void;
	/**
	 * What the deploy's scan reads besides the files: the project's lock files, whole, so the
	 * platform can check the packages they pin, and its `.jiayang-allow`. Without lock files no
	 * package is checked. Up to 8 lock files, 8 MiB together, and 64 KiB of allow file.
	 */
	scan?: ScanInput;
}

/** A lock file as it is, named as in the project: `package-lock.json`, `poetry.lock`. */
export interface Lockfile {
	path: string;
	text: string;
}

export interface ScanInput {
	lockfiles?: Lockfile[];
	/** The text of the project's `.jiayang-allow`. */
	allow?: string;
}

/** A file ready to go up. */
interface Prepared {
	path: string;
	bytes: Uint8Array;
	sha256: string;
	content_type: string;
}

const BATCH_FILES = 500;
const BATCH_BYTES = 8 * 1024 * 1024;
const ALONE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function deployWorker(c: Jiayang, ws: string, app: string, bundle: WorkerBundle, options: DeployOptions): Promise<Version> {
	if (!bundle.modules[bundle.main_module]) {
		throw new JiayangError(`main_module is ${bundle.main_module}, which isn't one of the modules.`);
	}
	const modules: Record<string, { type: ModuleType; b64: string }> = {};
	const raw: Record<string, { type: ModuleType; bytes: Uint8Array }> = {};
	for (const [name, module] of Object.entries(bundle.modules)) {
		const bytes = bytesOf(module.content);
		raw[name] = { type: module.type ?? moduleType(name, module.content), bytes };
		modules[name] = { type: raw[name].type, b64: base64(bytes) };
	}
	const body: Record<string, unknown> = {
		main_module: bundle.main_module,
		compatibility_date: bundle.compatibility_date,
		compatibility_flags: bundle.compatibility_flags ?? [],
		modules,
	};
	if (bundle.kv) body.kv = true;
	if (bundle.queue) body.queue = { path: bundle.queue.path };
	let assets: ReturnType<typeof manifest> | undefined;
	if (bundle.assets) {
		const files = await prepare(bundle.assets.files);
		await upload(c, ws, app, files, options);
		assets = manifest(files, bundle.assets);
		body.assets = assets;
	}
	const scan = scanOf(options);
	if (scan) body.scan = scan;
	const named = await workerVersionHash(raw, bundle.compatibility_flags ?? [], assets);
	return publish(c, ws, app, "versions", body, named, options);
}

export async function deploySite(c: Jiayang, ws: string, app: string, site: SiteOptions & { files: SiteFile[] }, options: DeployOptions): Promise<Version> {
	if (site.run_worker_first !== undefined) {
		throw new JiayangError("run_worker_first is for a Worker's files. A site has no code to run first.");
	}
	const files = await prepare(site.files);
	if (!files.length) throw new JiayangError("A site needs at least one file.");
	await upload(c, ws, app, files, options);
	const body: Record<string, unknown> = manifest(files, site);
	const scan = scanOf(options);
	if (scan) body.scan = scan;
	return publish(c, ws, app, "site", body, await siteVersionHash(body.files as Named[]), options);
}

/** What the deploy sends for its scan, if anything. */
function scanOf(options: DeployOptions): ScanInput | undefined {
	const lockfiles = options.scan?.lockfiles?.map(({ path, text }) => ({ path, text }));
	const allow = options.scan?.allow;
	if (!lockfiles?.length && allow === undefined) return undefined;
	return { ...(lockfiles?.length ? { lockfiles } : {}), ...(allow !== undefined ? { allow } : {}) };
}

/** A file as a version names it. */
interface Named {
	path: string;
	sha256: string;
	content_type: string;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** Byte order, as the platform sorts names. */
function byBytes(a: string, b: string): number {
	const x = utf8(a);
	const y = utf8(b);
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
	}
	return x.length - y.length;
}

function joined(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** A u64, big-endian. */
function u64(n: number): Uint8Array {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigUint64(0, BigInt(n));
	return out;
}

/** The name the platform gives a site's version: each path with the file it serves. */
export async function siteVersionHash(files: Named[]): Promise<string> {
	const zero = new Uint8Array([0]);
	const parts = [...files]
		.sort((a, b) => byBytes(a.path, b.path))
		.flatMap((f) => [utf8(f.path), zero, utf8(f.sha256), zero, utf8(f.content_type), zero]);
	return sha256(joined(parts));
}

/** The name the platform gives a Worker's version: its modules, flags and files. */
export async function workerVersionHash(
	modules: Record<string, { type: ModuleType; bytes: Uint8Array }>,
	flags: string[],
	assets: { files: Named[]; not_found_handling: string | null; run_worker_first: unknown } | undefined,
): Promise<string> {
	const parts: Uint8Array[] = [];
	for (const name of Object.keys(modules).sort(byBytes)) {
		const module = modules[name] as { type: ModuleType; bytes: Uint8Array };
		const named = utf8(name);
		parts.push(u64(named.length), named, utf8(module.type), u64(module.bytes.length), module.bytes);
	}
	for (const flag of [...new Set(flags)].sort(byBytes)) parts.push(utf8("flag"), utf8(flag));
	if (assets) {
		for (const f of assets.files) parts.push(utf8("asset"), utf8(f.path), utf8(f.sha256), utf8(f.content_type));
		if (assets.not_found_handling != null) parts.push(utf8("not-found"), utf8(assets.not_found_handling));
		if (assets.run_worker_first != null) parts.push(utf8("worker-first"), utf8(JSON.stringify(assets.run_worker_first)));
	}
	return sha256(joined(parts));
}

function manifest(files: Prepared[], options: SiteOptions) {
	return {
		files: files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.bytes.length, content_type: f.content_type })),
		not_found_handling: options.not_found_handling ?? null,
		run_worker_first: options.run_worker_first ?? null,
	};
}

export function bytesOf(content: string | Uint8Array | ArrayBuffer): Uint8Array {
	if (typeof content === "string") return new TextEncoder().encode(content);
	if (content instanceof Uint8Array) return content;
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	throw new JiayangError("File and module content is a string, a Uint8Array or an ArrayBuffer.");
}

export function moduleType(name: string, content: string | Uint8Array | ArrayBuffer): ModuleType {
	const lower = name.toLowerCase();
	if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "esm";
	if (lower.endsWith(".wasm")) return "wasm";
	return typeof content === "string" ? "text" : "data";
}

/** Standard base64, as the platform reads modules. */
export function base64(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(out);
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function prepare(files: SiteFile[]): Promise<Prepared[]> {
	const seen = new Set<string>();
	const out: Prepared[] = [];
	for (const file of files) {
		const path = file.path.startsWith("/") ? file.path : `/${file.path}`;
		if (seen.has(path)) throw new JiayangError(`${path} is in the files twice.`);
		seen.add(path);
		const bytes = bytesOf(file.content);
		if (bytes.length > MAX_FILE_BYTES) throw new JiayangError(`${path} is over 25 MiB, the most a site file can be.`);
		out.push({ path, bytes, sha256: await sha256(bytes), content_type: file.content_type ?? contentType(path) });
	}
	return out;
}

/** Sends the files the platform hasn't got: small ones many to a request, a big one on its own. */
async function upload(c: Jiayang, ws: string, app: string, files: Prepared[], options: DeployOptions) {
	const base = appPath(ws, app);
	const hashes = [...new Set(files.map((f) => f.sha256))];
	const { data } = await c.request<{ missing: string[] }>({
		method: "POST",
		path: `${base}/blobs/missing`,
		json: { sha256: hashes },
		repeatable: true,
	});
	const missing = new Set(data.missing);
	const wanted: Prepared[] = [];
	for (const file of files) {
		if (missing.delete(file.sha256)) wanted.push(file);
	}
	if (!wanted.length) return;
	options.onProgress?.(`Uploading ${wanted.length} of ${files.length} ${files.length === 1 ? "file" : "files"} ...`);
	let batch: Prepared[] = [];
	let bytes = 0;
	const flush = async () => {
		if (!batch.length) return;
		const form = new FormData();
		for (const file of batch) form.append(file.sha256, new Blob([file.bytes as BlobPart], { type: file.content_type }), file.sha256);
		const size = batch.reduce((n, f) => n + f.bytes.length, 0);
		// Content-addressed, so sending one again stores nothing new.
		await c.request({ method: "POST", path: `${base}/blobs`, body: form, repeatable: true, size });
		batch = [];
		bytes = 0;
	};
	for (const file of wanted) {
		if (file.bytes.length >= ALONE_BYTES) {
			await c.request({
				method: "PUT",
				path: `${base}/blobs/${file.sha256}`,
				body: file.bytes,
				contentType: file.content_type,
				repeatable: true,
				size: file.bytes.length,
			});
			continue;
		}
		if (batch.length === BATCH_FILES || (batch.length && bytes + file.bytes.length > BATCH_BYTES)) await flush();
		batch.push(file);
		bytes += file.bytes.length;
	}
	await flush();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks for the version, and follows it live. A deploy is never sent twice: one whose answer
 *  didn't arrive is looked for in the version list instead, since it may have gone through. */
async function publish(c: Jiayang, ws: string, app: string, endpoint: string, body: unknown, named: string, options: DeployOptions): Promise<Version> {
	const base = appPath(ws, app);
	const waitFor = options.waitTimeoutMs ?? 30 * 60_000;
	const started = Date.now();
	for (;;) {
		const before = newest(await c.versions.list(ws, app));
		try {
			const answer = await c.request<Version>({
				method: "POST",
				path: `${base}/${endpoint}`,
				query: { preview: options.preview },
				json: body,
				headers: { prefer: "respond-async" },
				repeatable: false,
			});
			const version = answer.data;
			if (version.status === "failed") throw new DeployFailedError(version);
			if (version.status !== "uploaded" || options.wait === false) return version;
			return await follow(c, ws, app, version.number, options, waitFor);
		} catch (err) {
			if (err instanceof ConflictError && err.code === "version_going_live" && Date.now() - started < waitFor) {
				await waitTurn(c, ws, app, options, waitFor);
				continue;
			}
			// Waited out, and sent again only if the version it may have made isn't there.
			if (err instanceof RateLimitError && (err.retryAfter ?? 0) <= RETRY_AFTER_CAP && Date.now() - started < waitFor) {
				options.onProgress?.("Too many requests for now. Waiting to deploy ...");
				await sleep(err.retryAfter !== null ? err.retryAfter * 1000 : c.backoff(0));
				const made = (await listQuietly(c, ws, app))?.find((v) => v.number > before && v.sha256 === named);
				if (made) return settle(c, ws, app, made, options, waitFor);
				continue;
			}
			if (!unanswered(err)) throw err;
			options.onProgress?.("The API didn't answer in time. Looking for the new version ...");
			return await lookFor(c, ws, app, before, named, err as Error, options, waitFor);
		}
	}
}

/** A deploy that ended without the platform saying how it went, which may have gone live all the same. */
function unanswered(err: unknown): boolean {
	if (err instanceof RequestTimeoutError || err instanceof ConnectionFailedError) return true;
	if (err instanceof ApiError && err.code === "still_going_live") return true;
	return err instanceof ServerError && err.code === "" && [502, 504, 524].includes(err.status);
}

function newest(versions: Version[]): number {
	return versions.reduce((n, v) => Math.max(n, v.number), 0);
}

function landed(version: Version): boolean {
	return version.status === "deployed" && (version.active || version.preview?.live === true);
}

/** Looks for the version this deploy made: newer than any before it, and made of what it sent, so a
 *  teammate's deploy in the meantime isn't taken for it. */
async function lookFor(c: Jiayang, ws: string, app: string, before: number, named: string, err: Error, options: DeployOptions, waitFor: number): Promise<Version> {
	const started = Date.now();
	const atMost = err instanceof ConnectionFailedError ? c.polling.afterDrop : c.polling.lookFor;
	for (;;) {
		const ours = (await listQuietly(c, ws, app))
			?.filter((v) => v.number > before && v.sha256 === named)
			.sort((a, b) => b.number - a.number)[0];
		if (ours && (landed(ours) || ours.status === "failed" || ours.status === "uploaded")) {
			return settle(c, ws, app, ours, options, waitFor);
		}
		if (Date.now() - started >= atMost) throw err;
		await sleep(c.polling.every);
	}
}

/** A version this deploy made, found in the list: returned, followed live, or its failure thrown. */
async function settle(c: Jiayang, ws: string, app: string, ours: Version, options: DeployOptions, waitFor: number): Promise<Version> {
	if (ours.status === "failed") throw new DeployFailedError(ours);
	if (ours.status === "uploaded" && options.wait !== false) return follow(c, ws, app, ours.number, options, waitFor);
	return ours;
}

async function follow(c: Jiayang, ws: string, app: string, number: number, options: DeployOptions, waitFor: number): Promise<Version> {
	options.onProgress?.(`Version ${number} is going live ...`);
	const started = Date.now();
	for (;;) {
		await sleep(Date.now() - started < c.polling.soonFor ? c.polling.soon : c.polling.every);
		const listed = await listQuietly(c, ws, app);
		if (listed) {
			const version = listed.find((v) => v.number === number);
			if (!version) throw new JiayangError(`Version ${number} is no longer listed, so it won't go live.`);
			if (version.status === "deployed") return version;
			if (version.status === "failed") throw new DeployFailedError(version);
		}
		if (Date.now() - started >= waitFor) {
			throw new JiayangError(`Version ${number} is still going live after ${Math.round((Date.now() - started) / 60_000)} minutes. versions.list shows when it's live, or why it isn't.`);
		}
	}
}

/** Waits while another version of the app goes live. */
async function waitTurn(c: Jiayang, ws: string, app: string, options: DeployOptions, waitFor: number) {
	const going = (await c.versions.list(ws, app)).filter((v) => v.status === "uploaded").map((v) => v.number);
	if (!going.length) {
		await sleep(c.polling.every);
		return;
	}
	const number = Math.max(...going);
	options.onProgress?.(`Version ${number} is still going live. Deploying once it's done ...`);
	const started = Date.now();
	while (Date.now() - started < waitFor) {
		await sleep(c.polling.every);
		const listed = await listQuietly(c, ws, app);
		if (listed && !listed.some((v) => v.number === number && v.status === "uploaded")) return;
	}
}

/** The version list, or null for a moment the platform couldn't answer in. */
async function listQuietly(c: Jiayang, ws: string, app: string): Promise<Version[] | null> {
	try {
		return await c.versions.list(ws, app);
	} catch (err) {
		if (err instanceof ServerError || err instanceof ConnectionFailedError || err instanceof RequestTimeoutError) return null;
		throw err;
	}
}

/** What a browser should make of a file, by its extension. The platform decides in the end. */
export function contentType(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	const extension = dot === -1 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase();
	return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/** The same table the CLI uses (sdks/testdata/content-types.json, which a test holds this to). */
export const CONTENT_TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	map: "application/json; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	xml: "application/xml; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	pdf: "application/pdf",
	wasm: "application/wasm",
	webmanifest: "application/manifest+json",
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	ts: "video/mp2t",
	ogv: "video/ogg",
	vtt: "text/vtt; charset=utf-8",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	flac: "audio/flac",
	zip: "application/zip",
	glb: "model/gltf-binary",
	gltf: "model/gltf+json",
	usdz: "model/vnd.usdz+zip",
	obj: "model/obj",
	stl: "model/stl",
	ktx2: "image/ktx2",
	hdr: "image/vnd.radiance",
	exr: "image/x-exr",
	glsl: "text/plain; charset=utf-8",
	vert: "text/plain; charset=utf-8",
	frag: "text/plain; charset=utf-8",
	wgsl: "text/plain; charset=utf-8",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
	apng: "image/apng",
	jxl: "image/jxl",
	eot: "application/vnd.ms-fontobject",
	jsonld: "application/ld+json",
	atom: "application/atom+xml",
	rss: "application/rss+xml",
};
