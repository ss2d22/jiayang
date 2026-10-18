// What the API sends and takes, field for field. Names are the API's own (snake_case), so these
// match the HTTP docs and the Python client. Times are RFC 3339 strings, kept as sent: the audit
// log pages by microsecond, which a Date can't hold.

export type WorkspaceRole = "owner" | "admin" | "member";
export type AppRole = "viewer" | "editor" | "owner";
export type TokenRole = "viewer" | "editor";
export type Driver = "workers" | "containers";
export type Visibility = "private" | "workspace";

/** Which limit a `plan_limit` or `contact_sales` refusal hit. */
export interface PlanLimitHit {
	what: string;
	max: number;
	plan: string;
}

export interface Features {
	storage: boolean;
	github_deploys: boolean;
	keep_deleted?: boolean;
}

export interface Terms {
	version: string;
	accepted: boolean;
	can_wait?: boolean;
	deadline?: string | null;
}

export interface Workspace {
	id: string;
	slug: string;
	name: string;
	role: WorkspaceRole;
	allowed_email_domains: string[];
	/** `free`, `team`, `business` or `enterprise`. */
	plan: string;
	suspended_by?: string | null;
	over_quota?: boolean;
	database_state?: string | null;
	usage_stop?: string | null;
	unmeasured_stop?: string | null;
	cut_off?: string | null;
	storage_full?: boolean;
	prices?: { month_cents: number; meters?: { meter: string; unit_amount_decimal: string }[] } | null;
	/** What the caller may do here, by permission name, such as `apps.deploy`. */
	permissions?: string[];
}

export interface Me {
	email: string;
	workspaces: Workspace[];
	apps_base_url: string;
	session_expires_at: string;
	terms: Terms;
	features?: Features | null;
	held_in?: { slug: string; name: string }[];
}

export interface CreateWorkspace {
	slug: string;
	name: string;
}

export interface Member {
	email: string;
	role: WorkspaceRole;
	added_by: string;
	created_at: string;
	custom_role?: string | null;
	group_roles?: { role: string; group: string }[];
	added_by_scim?: boolean;
	held?: boolean;
}

export interface PutMember {
	role: WorkspaceRole;
	custom_role?: string;
}

/** What became of the invitation email. The access stands either way. */
export type Invited = "sent" | "over_budget" | "failed";

/**
 * Whose day of invitation emails was spent, when one was: the workspace's, the sender's across all
 * their workspaces, or the whole platform's.
 */
export type InvitationBudget = "workspace" | "sender" | "platform";

export interface PutMemberReply extends Member {
	invited?: Invited;
	/** Set when `invited` is `over_budget`. */
	budget_spent?: InvitationBudget;
}

export interface MemberRemoved {
	/** Apps shared with the person's whole domain, which still let them in as a viewer. */
	still_shared_by_domain: string[];
}

export interface AppOversight {
	people: number;
	outside: number;
	domains?: string[];
	agents?: number;
	sends_to?: string[];
	custom_domains?: string[];
	last_opened?: string | null;
}

export interface App {
	id: string;
	workspace: string;
	slug: string;
	name: string;
	driver: Driver;
	visibility: Visibility;
	hostname: string;
	url: string;
	active_version: number | null;
	my_role: AppRole | null;
	has_database?: boolean;
	static_site?: boolean;
	mcp?: boolean;
	has_files?: boolean;
	created_by: string;
	created_at: string;
	suspended?: boolean;
	oversight?: AppOversight;
	access_requests?: number;
}

export interface CreateApp {
	slug: string;
	name: string;
	driver: Driver;
	visibility?: Visibility;
}

export interface UpdateApp {
	name?: string;
	visibility?: Visibility;
	mcp?: boolean;
}

/** A deleted app the workspace keeps for a while, and when it goes for good. */
export interface Kept {
	restorable_until: string;
}

export interface VersionPreview {
	url: string;
	until: string;
	live: boolean;
}

export interface Version {
	number: number;
	sha256: string;
	size_bytes: number;
	/** `uploaded` while on its way live, then `deployed` or `failed`. */
	status: string;
	active: boolean;
	created_by: string;
	created_at: string;
	port?: number;
	instance_type?: string;
	failure?: string;
	replaced?: number;
	github_run?: string;
	preview?: VersionPreview;
}

export type ModuleType = "esm" | "text" | "wasm" | "data";

/** One module of a Worker, as you give it to `deploy.worker`. */
export interface WorkerModule {
	/** Inferred from the name when left out: `.js` and `.mjs` are `esm`, `.wasm` is `wasm`, other
	 *  text is `text` and other bytes are `data`. */
	type?: ModuleType;
	content: string | Uint8Array | ArrayBuffer;
}

/** One file of a site, as you give it to `deploy.site`, or to a Worker's `assets`. */
export interface SiteFile {
	/** Where it's served, like `/index.html`. A leading `/` is added if missing. */
	path: string;
	content: string | Uint8Array | ArrayBuffer;
	/** Guessed from the extension when left out. The platform decides in the end. */
	content_type?: string;
}

export interface SiteOptions {
	/** `single-page-application`, `404-page` or `none`. */
	not_found_handling?: string;
	/** Only for a Worker: `true`, or the paths its code answers before its files. */
	run_worker_first?: boolean | string[];
}

export interface WorkerBundle {
	main_module: string;
	compatibility_date: string;
	compatibility_flags?: string[];
	modules: Record<string, WorkerModule>;
	assets?: SiteOptions & { files: SiteFile[] };
	/** `"kv": true` in jiayang.json: key-value storage of the app's own, bound as `env.KV`, made on the first deploy that asks. Team and Business. */
	kv?: boolean;
	/** `"queue"` in jiayang.json: a queue of the app's own, bound as `env.QUEUE`, whose messages go to this path. Team and Business. */
	queue?: { path: string };
}

export interface Grant {
	email: string;
	role: AppRole;
	granted_by: string;
	created_at: string;
}

export interface PutGrantReply extends Grant {
	invited?: Invited;
	/** Set when `invited` is `over_budget`. */
	budget_spent?: InvitationBudget;
	/** They had this role already, so nothing changed. */
	unchanged?: boolean;
}

export interface DomainGrant {
	domain: string;
	role: AppRole;
	granted_by: string;
	created_at: string;
}

export interface GroupGrant {
	group: string;
	role: AppRole;
	granted_by: string;
	created_at: string;
}

/** Everything an app is shared with. */
export interface Access {
	grants: Grant[];
	domains: DomainGrant[];
	groups: GroupGrant[];
	/** `workspace` when every member of the workspace can open it as a viewer. */
	visibility: Visibility;
}

export interface Unshared {
	/** What still lets them in as a viewer: `@acme.com`, `group finance` or `everyone in the workspace`. */
	still_shared_by: string[];
}

export type TokenCap = "viewer_grant" | "workspace_member" | "no_grant" | "not_member" | "outside_domains" | "no_account";

/** A bypass token, which lets a script or a service call an app. */
export interface Token {
	id: string;
	name: string;
	role: TokenRole;
	hint: string;
	created_by: string;
	created_at: string;
	expires_at: string | null;
	last_used_at?: string | null;
	revoked_at: string | null;
	effective_role?: TokenRole | null;
	capped_because?: TokenCap;
}

export interface CreateToken {
	name: string;
	role: TokenRole;
	/** 1 to 365. A year when left out. */
	expires_in_days?: number;
}

export interface CreatedToken {
	token: Token;
	/** Shown once. Send it as `Authorization: Bearer <secret>` to `url`. */
	secret: string;
	url: string;
}

export interface AuditEntry {
	id: string;
	at: string;
	source: string;
	action: string;
	decision: string | null;
	reason: string | null;
	status: number | null;
	app_id: string | null;
	app?: string;
	app_deleted?: boolean;
	entry: string | null;
	actor: unknown;
	host: string | null;
	method: string | null;
	path: string | null;
	detail: unknown;
	ingested_at: string;
}

/** Where the log carries on: the last entry read, by its time and id. */
export interface AuditCursor {
	at: string;
	id: string;
}

export interface AuditPage {
	entries: AuditEntry[];
	/** Set when the platform stopped short of a full page and there is more behind it. */
	next: AuditCursor | null;
	/** You read only the last 30 days or so: you own the app but don't manage the workspace. */
	recent_only: boolean;
}

export interface AuditQuery {
	/** Only this app, by slug. */
	app?: string;
	/** Only refused requests. */
	decision?: "deny";
	/** 1 to 500. 100 when left out. */
	limit?: number;
	/** Entries strictly before this RFC 3339 time, for paging back. */
	before?: string;
	/** With `before`: the id of the last entry you have, so entries at the same time aren't skipped. */
	before_id?: string;
	/** Entries that reached the log strictly after this time, oldest first, for following it. */
	after?: string;
	/** With `after`: the id of the last entry you have. */
	after_id?: string;
}

export interface SecretMeta {
	name: string;
	inject_host: string;
	inject_header: string;
	inject_format: string;
	updated_by: string;
	updated_at: string;
}

export interface PutSecret {
	value: string;
	/** Added only to requests to exactly this host. */
	inject_host: string;
	inject_header: string;
	/** `{value}` when left out. Most APIs want `Bearer {value}`. */
	inject_format?: string;
}

export interface EnvVar {
	name: string;
	value: string;
	updated_by: string;
	updated_at: string;
}

export interface PatchEnv {
	set?: Record<string, string>;
	unset?: string[];
	/** Set a value that reads like a credential anyway. Never allows one we're sure about. */
	allow_sensitive?: boolean;
}

export interface EnvUpdated {
	vars: EnvVar[];
	/** The app was redeployed with the change. */
	pushed: boolean;
	/** Another version was going live: the app gets the change once that one is done. */
	waits_for: number | null;
}
