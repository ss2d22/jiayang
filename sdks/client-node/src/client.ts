import {
	DEFAULT_BASE_URL,
	RETRY_AFTER_CAP,
	checkBaseUrl,
	checkToken,
	processEnv,
	readCliConfig,
} from "./config.js";
import { deploySite, deployWorker, type DeployOptions } from "./deploy.js";
import { localFetch, needsLocalFetch } from "./local.js";
import { appPath, segment, wsPath } from "./paths.js";
import {
	ApiError,
	ConfigError,
	ConnectionFailedError,
	JiayangError,
	RequestTimeoutError,
	apiError,
} from "./errors.js";
import type {
	Access,
	App,
	AuditCursor,
	AuditEntry,
	AuditPage,
	AuditQuery,
	CreateApp,
	CreateToken,
	CreateWorkspace,
	CreatedToken,
	DomainGrant,
	EnvUpdated,
	EnvVar,
	Grant,
	GroupGrant,
	Kept,
	Me,
	Member,
	MemberRemoved,
	PatchEnv,
	PlanLimitHit,
	PutGrantReply,
	PutMember,
	PutMemberReply,
	PutSecret,
	SecretMeta,
	SiteFile,
	SiteOptions,
	Token,
	AppRole,
	Unshared,
	UpdateApp,
	Version,
	WorkerBundle,
	Workspace,
} from "./types.js";

export const VERSION = "0.1.0";

export interface ClientOptions {
	/** A CLI session token (`jyu_`), or a GitHub Actions run's deploy credential (`jyg_`). Left
	 *  out, it's `JIAYANG_TOKEN`, then the session `jiayang login` saved on this computer. */
	token?: string;
	/** The API's address. Left out, it's `JIAYANG_API`, then the one the saved session is for,
	 *  then https://api.jiayang.cloud. */
	baseUrl?: string;
	/** Where `jiayang login` keeps its config, when it isn't where the CLI would look. */
	configDir?: string;
	/** How many times a request that's safe to repeat is tried again. 2 when left out. */
	maxRetries?: number;
	/** How long the platform gets to answer, in milliseconds. 60 seconds when left out. An upload
	 *  gets longer, by its size. */
	timeoutMs?: number;
	/** A `fetch` of your own, for a proxy or for tests. */
	fetch?: typeof fetch;
}

/** One request, as the resources ask for it. */
export interface RequestSpec {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	query?: Record<string, string | number | boolean | undefined>;
	json?: unknown;
	/** A body that isn't JSON: a file, or a multipart form. */
	body?: Uint8Array | FormData;
	contentType?: string;
	headers?: Record<string, string>;
	/** Safe to send again after a failure that may have reached the platform. */
	repeatable: boolean;
	/** Bytes going up, so a big upload gets the time it needs. */
	size?: number;
}

export interface Answer<T> {
	status: number;
	headers: Headers;
	data: T;
}

/** The slowest uplink an upload is given time for: half a megabit, as the CLI allows. */
const SLOWEST_UPLINK = 64 * 1024;
/** 5xx codes that asking again won't fix. */
const FINAL_CODES = new Set(["logs_unavailable", "storage_refused", "audit_archive_unavailable", "outcome_unknown"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A client for the Jiayang Cloud API.
 *
 * ```js
 * import { Jiayang } from "@jiayang-cloud/client";
 * const jy = new Jiayang();
 * for (const app of await jy.apps.list("acme")) console.log(app.slug, app.url);
 * ```
 */
export class Jiayang {
	readonly workspaces: Workspaces;
	readonly members: Members;
	readonly apps: Apps;
	readonly versions: Versions;
	readonly deploy: Deploys;
	readonly access: Sharing;
	readonly tokens: Tokens;
	readonly audit: Audit;
	readonly secrets: Secrets;
	readonly env: Env;

	readonly #options: ClientOptions;
	readonly #fetch: typeof fetch;
	readonly #retries: number;
	readonly #timeout: number;
	#settings: Promise<{ token: string; base: string }> | null = null;
	/** How long to wait before try `n` (0-based), in milliseconds. Tests make it zero. */
	backoff: (attempt: number) => number = (attempt) => Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() / 2);
	/** How often a deploy looks at its version while it goes live. Tests make it short. */
	polling = { soon: 1000, every: 5000, soonFor: 15_000, lookFor: 180_000, afterDrop: 20_000 };

	constructor(options: ClientOptions = {}) {
		this.#options = options;
		this.#fetch =
			options.fetch ?? ((input, init) => (needsLocalFetch(String(input)) ? localFetch(input, init) : globalThis.fetch(input, init)));
		this.#retries = Math.max(0, options.maxRetries ?? 2);
		this.#timeout = options.timeoutMs ?? 60_000;
		if (options.token !== undefined) checkToken(options.token);
		if (options.baseUrl !== undefined) checkBaseUrl(options.baseUrl);
		this.workspaces = new Workspaces(this);
		this.members = new Members(this);
		this.apps = new Apps(this);
		this.versions = new Versions(this);
		this.deploy = new Deploys(this);
		this.access = new Sharing(this);
		this.tokens = new Tokens(this);
		this.audit = new Audit(this);
		this.secrets = new Secrets(this);
		this.env = new Env(this);
	}

	/** Who you are, your workspaces, and where apps live. */
	async me(): Promise<Me> {
		return (await this.request<Me>({ method: "GET", path: "/v1/me", repeatable: true })).data;
	}

	/** The API's address this client sends to, once it has worked it out. */
	async baseUrl(): Promise<string> {
		return (await this.#resolve()).base;
	}

	#resolve(): Promise<{ token: string; base: string }> {
		this.#settings ??= (async () => {
			const env = processEnv();
			const given = this.#options.token ?? (env.JIAYANG_TOKEN || undefined);
			let token = given;
			let saved: string | undefined;
			if (token === undefined) {
				const config = await readCliConfig(this.#options.configDir);
				if (config?.api_token) {
					const ends = config.session_expires_at ? Date.parse(config.session_expires_at) : Number.NaN;
					if (!Number.isNaN(ends) && ends <= Date.now()) {
						throw new ConfigError("The session `jiayang login` saved has ended. Run `jiayang login` again.");
					}
					if (!config.api_url) {
						throw new ConfigError(
							"The session `jiayang login` saved doesn't say which API it's for. Run `jiayang login` again.",
						);
					}
					token = config.api_token;
					saved = checkBaseUrl(config.api_url);
				}
			}
			if (token === undefined) {
				throw new ConfigError(
					"No token. Pass `token`, set JIAYANG_TOKEN, or run `jiayang login` on this computer first.",
				);
			}
			const asked = this.#options.baseUrl ?? (env.JIAYANG_API || undefined);
			if (saved === undefined) {
				return { token: checkToken(token), base: checkBaseUrl(asked ?? DEFAULT_BASE_URL) };
			}
			// A saved session goes only to the API that issued it, as the CLI's own does: an address in
			// the environment may be one someone else put there.
			if (asked === undefined) return { token: checkToken(token), base: saved };
			const base = checkBaseUrl(asked);
			if (new URL(base).origin !== new URL(saved).origin) {
				throw new ConfigError(
					`\`baseUrl\` or JIAYANG_API is set to ${base}, but the session \`jiayang login\` saved is for ${saved}. We only send your session there. Unset both, or pass a \`token\` for ${base}.`,
				);
			}
			return { token: checkToken(token), base };
		})();
		// A failed lookup is tried again next time: `jiayang login` may have run since.
		this.#settings.catch(() => {
			this.#settings = null;
		});
		return this.#settings;
	}

	/** Sends one request, trying again when that's safe, and throws an `ApiError` for an error answer. */
	async request<T>(spec: RequestSpec): Promise<Answer<T>> {
		const { token, base } = await this.#resolve();
		let url = `${base}${spec.path}`;
		const query = Object.entries(spec.query ?? {}).filter(([, v]) => v !== undefined && v !== false);
		if (query.length) url += `?${query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}`;
		const headers: Record<string, string> = {
			accept: "application/json",
			authorization: `Bearer ${token}`,
			"user-agent": `jiayang-client-node/${VERSION}`,
			...spec.headers,
		};
		let body: BodyInit | undefined;
		if (spec.json !== undefined) {
			body = JSON.stringify(spec.json);
			headers["content-type"] = "application/json";
		} else if (spec.body !== undefined) {
			body = spec.body as BodyInit;
			if (spec.contentType) headers["content-type"] = spec.contentType;
		}
		const size = spec.size ?? (typeof body === "string" ? body.length : 0);
		const timeout = this.#timeout + Math.floor((size / SLOWEST_UPLINK) * 1000);

		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await this.#fetch(url, {
					method: spec.method,
					headers,
					body,
					redirect: "manual",
					signal: AbortSignal.timeout(timeout),
				});
			} catch (err) {
				const failure = transportError(err, spec.method, spec.path);
				if (spec.repeatable && attempt < this.#retries) {
					await sleep(this.backoff(attempt));
					continue;
				}
				throw failure;
			}
			if (response.status >= 200 && response.status < 300) {
				const text = await response.text();
				let data: unknown = undefined;
				if (text) {
					try {
						data = JSON.parse(text);
					} catch {
						throw new JiayangError(`The API answered ${spec.method} ${spec.path} with something that isn't JSON.`);
					}
				}
				return { status: response.status, headers: response.headers, data: data as T };
			}
			const error = await errorFrom(response);
			const retryAfter = error.retryAfter;
			// A change that isn't safe to repeat is never sent twice, even after a 429: nothing says
			// every 429 comes before the change is made.
			const worth =
				spec.repeatable &&
				(error.status === 429
					? retryAfter === null || retryAfter <= RETRY_AFTER_CAP
					: error.status === 408 || (error.status >= 500 && !FINAL_CODES.has(error.code)));
			if (worth && attempt < this.#retries) {
				await sleep(retryAfter !== null ? retryAfter * 1000 : this.backoff(attempt));
				continue;
			}
			throw error;
		}
	}
}

function transportError(err: unknown, method: string, path: string): JiayangError {
	const name = (err as { name?: string } | null)?.name;
	if (name === "TimeoutError" || name === "AbortError") {
		return new RequestTimeoutError(
			`The API didn't answer ${method} ${path} in time. If it was a change, it may still have been made.`,
		);
	}
	const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
	const why = cause?.code ?? cause?.message ?? (err as Error | null)?.message ?? "unknown";
	return new ConnectionFailedError(`Couldn't reach the API for ${method} ${path} (${why}).`, { cause: err });
}

async function errorFrom(response: Response): Promise<ApiError> {
	const text = await response.text().catch(() => "");
	let code = "";
	let message = "";
	let limit: PlanLimitHit | null = null;
	try {
		const body = JSON.parse(text) as { error?: unknown; message?: unknown; limit?: PlanLimitHit };
		if (typeof body.error === "string" && typeof body.message === "string") {
			code = body.error;
			message = body.message;
			limit = body.limit ?? null;
		}
	} catch {
		// Not the platform's own answer: a proxy or a gateway on the way.
	}
	if (!message) message = `The API answered ${response.status} ${response.statusText}`.trim() + ".";
	const after = response.headers.get("retry-after");
	const retryAfter = after !== null && /^\d+$/.test(after.trim()) ? Number(after.trim()) : null;
	const usable = (v: string | null) => (v && v.length <= 64 && /^[A-Za-z0-9-]+$/.test(v) ? v : null);
	const requestId = usable(response.headers.get("x-request-id")) ?? usable(response.headers.get("cf-ray"));
	return apiError(response.status, code, message, retryAfter, requestId, limit);
}

class Workspaces {
	constructor(private readonly c: Jiayang) {}

	/** Every workspace you're a member of. */
	async list(): Promise<Workspace[]> {
		return (await this.c.me()).workspaces;
	}

	async get(ws: string): Promise<Workspace> {
		return (await this.c.request<Workspace>({ method: "GET", path: wsPath(ws), repeatable: true })).data;
	}

	/** A new workspace, on Free, with you as its owner. */
	async create(workspace: CreateWorkspace): Promise<Workspace> {
		return (await this.c.request<Workspace>({ method: "POST", path: "/v1/workspaces", json: workspace, repeatable: false })).data;
	}
}

class Members {
	constructor(private readonly c: Jiayang) {}

	async list(ws: string): Promise<Member[]> {
		return (await this.c.request<Member[]>({ method: "GET", path: `${wsPath(ws)}/members`, repeatable: true })).data;
	}

	/** Adds someone to the workspace, or changes their role. */
	async set(ws: string, email: string, member: PutMember): Promise<PutMemberReply> {
		const path = `${wsPath(ws)}/members/${segment(email)}`;
		return (await this.c.request<PutMemberReply>({ method: "PUT", path, json: member, repeatable: true })).data;
	}

	/** Takes someone out of the workspace. Says which apps their domain still lets them into. */
	async remove(ws: string, email: string): Promise<MemberRemoved> {
		const path = `${wsPath(ws)}/members/${segment(email)}`;
		const answer = await this.c.request<MemberRemoved | undefined>({ method: "DELETE", path, repeatable: true });
		return { still_shared_by_domain: answer.data?.still_shared_by_domain ?? [] };
	}
}

class Apps {
	constructor(private readonly c: Jiayang) {}

	async list(ws: string): Promise<App[]> {
		return (await this.c.request<App[]>({ method: "GET", path: `${wsPath(ws)}/apps`, repeatable: true })).data;
	}

	async get(ws: string, app: string): Promise<App> {
		return (await this.c.request<App>({ method: "GET", path: appPath(ws, app), repeatable: true })).data;
	}

	async create(ws: string, app: CreateApp): Promise<App> {
		return (await this.c.request<App>({ method: "POST", path: `${wsPath(ws)}/apps`, json: app, repeatable: false })).data;
	}

	/** Changes its name, who in the workspace can open it, or whether AI clients may connect. */
	async update(ws: string, app: string, change: UpdateApp): Promise<App> {
		return (await this.c.request<App>({ method: "PATCH", path: appPath(ws, app), json: change, repeatable: true })).data;
	}

	/** Deletes it. Where the platform keeps deleted apps, says until when it can be restored;
	 *  null when it's gone at once. `forGood` skips the keeping. */
	async delete(ws: string, app: string, options: { forGood?: boolean } = {}): Promise<Kept | null> {
		const answer = await this.c.request<Kept | undefined>({
			method: "DELETE",
			path: appPath(ws, app),
			query: { for_good: options.forGood },
			repeatable: false,
		});
		return answer.data ?? null;
	}
}

class Versions {
	constructor(private readonly c: Jiayang) {}

	/** The app's versions, newest first. */
	async list(ws: string, app: string): Promise<Version[]> {
		return (await this.c.request<Version[]>({ method: "GET", path: `${appPath(ws, app)}/versions`, repeatable: true })).data;
	}

	/** Makes an earlier version live again. */
	async rollback(ws: string, app: string, version: number): Promise<Version> {
		const path = `${appPath(ws, app)}/rollback`;
		return (await this.c.request<Version>({ method: "POST", path, json: { version }, repeatable: true })).data;
	}

	/** Makes a preview live, as it is. */
	async promote(ws: string, app: string, version: number): Promise<Version> {
		return this.rollback(ws, app, version);
	}
}

class Deploys {
	constructor(private readonly c: Jiayang) {}

	/** Deploys a Worker from modules you've built, and waits for it to go live. */
	async worker(ws: string, app: string, bundle: WorkerBundle, options: DeployOptions = {}): Promise<Version> {
		return deployWorker(this.c, ws, app, bundle, options);
	}

	/** Deploys a static site from its files, sending only the ones the platform hasn't got. */
	async site(ws: string, app: string, site: SiteOptions & { files: SiteFile[] }, options: DeployOptions = {}): Promise<Version> {
		return deploySite(this.c, ws, app, site, options);
	}
}

class Sharing {
	constructor(private readonly c: Jiayang) {}

	/** Who the app is shared with: people, domains and groups. */
	async list(ws: string, app: string): Promise<Access> {
		const base = appPath(ws, app);
		const get = <T>(path: string) => this.c.request<T>({ method: "GET", path, repeatable: true }).then((a) => a.data);
		const [grants, domains, groups, about] = await Promise.all([
			get<Grant[]>(`${base}/grants`),
			get<DomainGrant[]>(`${base}/domain-grants`),
			get<GroupGrant[]>(`${base}/group-grants`),
			get<App>(base),
		]);
		return { grants, domains, groups, visibility: about.visibility };
	}

	/** Gives someone access. Takes effect within 60 seconds. */
	async share(ws: string, app: string, email: string, options: { role?: AppRole; add_to_workspace?: boolean } = {}): Promise<PutGrantReply> {
		const path = `${appPath(ws, app)}/grants/${segment(email)}`;
		const json = { role: options.role ?? "viewer", ...(options.add_to_workspace ? { add_to_workspace: true } : {}) };
		return (await this.c.request<PutGrantReply>({ method: "PUT", path, json, repeatable: true })).data;
	}

	/** Takes someone's access away, within 60 seconds. Says what still lets them in, if anything. */
	async unshare(ws: string, app: string, email: string): Promise<Unshared> {
		const path = `${appPath(ws, app)}/grants/${segment(email)}`;
		const answer = await this.c.request<Unshared | undefined>({ method: "DELETE", path, repeatable: true });
		return { still_shared_by: answer.data?.still_shared_by ?? [] };
	}

	/** Shares it with everyone whose address is at `domain`, as viewers. Only someone at that domain can. */
	async shareDomain(ws: string, app: string, domain: string): Promise<DomainGrant> {
		const path = `${appPath(ws, app)}/domain-grants/${segment(domain.trim().replace(/^@/, ""))}`;
		return (await this.c.request<DomainGrant>({ method: "PUT", path, json: { role: "viewer" }, repeatable: true })).data;
	}

	async unshareDomain(ws: string, app: string, domain: string): Promise<void> {
		const path = `${appPath(ws, app)}/domain-grants/${segment(domain.trim().replace(/^@/, ""))}`;
		await this.c.request({ method: "DELETE", path, repeatable: true });
	}

	/** Shares it with one of the workspace's groups, as viewers. */
	async shareGroup(ws: string, app: string, group: string): Promise<GroupGrant> {
		const path = `${appPath(ws, app)}/group-grants/${segment(group)}`;
		return (await this.c.request<GroupGrant>({ method: "PUT", path, json: { role: "viewer" }, repeatable: true })).data;
	}

	async unshareGroup(ws: string, app: string, group: string): Promise<void> {
		await this.c.request({ method: "DELETE", path: `${appPath(ws, app)}/group-grants/${segment(group)}`, repeatable: true });
	}
}

class Tokens {
	constructor(private readonly c: Jiayang) {}

	/** The app's bypass tokens, revoked and expired ones included. Never their secrets. */
	async list(ws: string, app: string): Promise<Token[]> {
		return (await this.c.request<Token[]>({ method: "GET", path: `${appPath(ws, app)}/tokens`, repeatable: true })).data;
	}

	/** A new bypass token. Its `secret` is in this answer and nowhere else, ever. */
	async create(ws: string, app: string, token: CreateToken): Promise<CreatedToken> {
		const path = `${appPath(ws, app)}/tokens`;
		return (await this.c.request<CreatedToken>({ method: "POST", path, json: token, repeatable: false })).data;
	}

	/** Revokes a token. It stops working at once. */
	async revoke(ws: string, app: string, id: string): Promise<void> {
		await this.c.request({ method: "DELETE", path: `${appPath(ws, app)}/tokens/${segment(id)}`, repeatable: true });
	}
}

/** Read the audit log. For owners and admins, members whose role has `audit.view`, and an app's owners for that app. */
class Audit {
	constructor(private readonly c: Jiayang) {}

	/** One page of the log: newest first, or oldest first from `after`. */
	async list(ws: string, query: AuditQuery = {}): Promise<AuditPage> {
		const answer = await this.c.request<AuditEntry[]>({
			method: "GET",
			path: `${wsPath(ws)}/audit`,
			query: { ...query },
			headers: { "jiayang-audit-paging": "next" },
			repeatable: true,
		});
		return {
			entries: answer.data,
			next: cursor(answer.headers.get("jiayang-audit-next")),
			recent_only: answer.headers.get("jiayang-audit-recent-only") === "true",
		};
	}

	/**
	 * Every entry, newest first, page after page until the log ends (or `before` and on, back).
	 *
	 * ```js
	 * for await (const entry of jy.audit.iterate("acme", { app: "payroll" })) console.log(entry.action);
	 * ```
	 */
	async *iterate(
		ws: string,
		query: Omit<AuditQuery, "limit" | "after" | "after_id"> & { page_size?: number } = {},
	): AsyncGenerator<AuditEntry, void, undefined> {
		const { page_size: size = 100, ...rest } = query;
		let before = rest.before;
		let beforeId = rest.before_id;
		const seen = new Set<string>();
		for (;;) {
			const page = await this.list(ws, { ...rest, limit: size, before, before_id: beforeId });
			for (const entry of page.entries) yield entry;
			const last = page.entries.at(-1);
			const next = page.next ?? (page.entries.length >= size && last ? { at: last.at, id: last.id } : null);
			if (!next) return;
			const key = `${next.at},${next.id}`;
			// The cursor always moves back. One that doesn't would ask for the same page forever.
			if (seen.has(key)) throw new JiayangError(`The audit log's paging stopped moving at ${key}.`);
			seen.add(key);
			before = next.at;
			beforeId = next.id;
		}
	}
}

/** `<at>,<id>` from `Jiayang-Audit-Next`. */
function cursor(raw: string | null): AuditCursor | null {
	if (!raw) return null;
	const at = raw.indexOf(",");
	if (at < 1) return null;
	return { at: raw.slice(0, at).trim(), id: raw.slice(at + 1).trim() };
}

/** Third-party credentials the platform adds to an app's outbound requests. The app never sees them. */
class Secrets {
	constructor(private readonly c: Jiayang) {}

	/** Names and where each goes. Never the values. */
	async list(ws: string, app: string): Promise<SecretMeta[]> {
		return (await this.c.request<SecretMeta[]>({ method: "GET", path: `${appPath(ws, app)}/secrets`, repeatable: true })).data;
	}

	async set(ws: string, app: string, name: string, secret: PutSecret): Promise<SecretMeta> {
		const path = `${appPath(ws, app)}/secrets/${segment(name)}`;
		return (await this.c.request<SecretMeta>({ method: "PUT", path, json: secret, repeatable: true })).data;
	}

	async delete(ws: string, app: string, name: string): Promise<void> {
		await this.c.request({ method: "DELETE", path: `${appPath(ws, app)}/secrets/${segment(name)}`, repeatable: true });
	}
}

/** An app's config values. Put credentials in `secrets` instead. */
class Env {
	constructor(private readonly c: Jiayang) {}

	async list(ws: string, app: string): Promise<EnvVar[]> {
		return (await this.c.request<EnvVar[]>({ method: "GET", path: `${appPath(ws, app)}/env`, repeatable: true })).data;
	}

	/** Sets some values and unsets others, leaving the rest. A live app is redeployed with them. */
	async update(ws: string, app: string, change: PatchEnv): Promise<EnvUpdated> {
		const json = { set: change.set ?? {}, unset: change.unset ?? [], allow_sensitive: change.allow_sensitive ?? false };
		const answer = await this.c.request<EnvVar[]>({ method: "PATCH", path: `${appPath(ws, app)}/env`, json, repeatable: true });
		const waits = answer.headers.get("jiayang-env-waits-for");
		return {
			vars: answer.data,
			pushed: answer.headers.get("jiayang-env-pushed") === "true",
			waits_for: waits && /^\d+$/.test(waits) ? Number(waits) : null,
		};
	}
}

