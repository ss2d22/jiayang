import { ConfigError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.jiayang.cloud";

/** The longest `Retry-After` the client waits out, in seconds. */
export const RETRY_AFTER_CAP = 60;

/** What the CLI keeps in config.json, of what this client reads. */
export interface CliConfig {
	api_url?: string | null;
	api_token?: string | null;
	session_expires_at?: string | null;
}

/** Where the CLI keeps its config: the same places, in the same order, as `jiayang` looks. */
export function configDir(env: Record<string, string | undefined>, windows: boolean): string | null {
	const set = (name: string) => {
		const value = env[name];
		return value ? value : null;
	};
	const join = (...parts: string[]) => parts.join(windows ? "\\" : "/");
	const dir = set("JIAYANG_CONFIG_DIR");
	if (dir) return dir;
	const xdg = set("XDG_CONFIG_HOME");
	if (xdg) return join(xdg, "jiayang");
	if (windows) {
		const appData = set("APPDATA");
		if (appData) return join(appData, "jiayang");
		const profile = set("USERPROFILE");
		if (profile) return join(profile, ".config", "jiayang");
	}
	const home = set("HOME");
	return home ? join(home, ".config", "jiayang") : null;
}

/** The environment, where there is one. Workers have none unless asked for it. */
export function processEnv(): Record<string, string | undefined> {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
	return env ?? {};
}

/** The CLI's config.json, or null when there is none or this runtime can't read files. */
export async function readCliConfig(dir?: string): Promise<CliConfig | null> {
	const proc = (globalThis as { process?: { platform?: string; versions?: { node?: string } } }).process;
	if (!proc?.versions?.node) return null;
	const windows = proc.platform === "win32";
	const where = dir ?? configDir(processEnv(), windows);
	if (!where) return null;
	let text: string;
	try {
		// Named through a variable so a bundler leaves it alone: Workers and browsers have no files.
		const specifier: string = "node:fs/promises";
		const fs = (await import(specifier)) as { readFile(path: string, encoding: "utf8"): Promise<string> };
		text = await fs.readFile(`${where}${windows ? "\\" : "/"}config.json`, "utf8");
	} catch {
		return null;
	}
	try {
		return JSON.parse(text) as CliConfig;
	} catch {
		throw new ConfigError(`${where}/config.json isn't valid JSON. Run \`jiayang login\` to write it again.`);
	}
}

/** Tokens that are ours but aren't for the API, and what to use them for instead. */
const NOT_FOR_THE_API: Record<string, string> = {
	jyb_: "That's an app's bypass token. It calls the app, not the API. Use a CLI session: run `jiayang login`.",
	jya_: "That's an agent's credential. It calls the apps the agent was granted, not the API.",
	jys_: "That's a browser session. Use a CLI session: run `jiayang login`.",
	jyd_: "That's a sign-in code the CLI polls with, not a session.",
	jym_: "That's a SCIM token. Your identity provider uses it, at /scim/v2.",
	jyo_: "That's an AI client's token for an MCP server app, not for the API.",
	jyr_: "That's an AI client's refresh token, not for the API.",
};

/** Refuses a token that can't work here, before it goes anywhere. */
export function checkToken(token: string): string {
	const trimmed = token.trim();
	if (!trimmed) throw new ConfigError("The token is empty.");
	if (!/^[\x21-\x7e]+$/.test(trimmed)) throw new ConfigError("The token has characters no token of ours has.");
	const said = NOT_FOR_THE_API[trimmed.slice(0, 4)];
	if (said) throw new ConfigError(said);
	return trimmed;
}

/** The address, if it's one a token may go to: https, or plain http to this machine only. */
export function checkBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError(`${raw} isn't a web address. It looks like ${DEFAULT_BASE_URL}.`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new ConfigError(`${raw} isn't an http or https address.`);
	}
	if (url.protocol === "http:" && !isLocal(url.hostname)) {
		throw new ConfigError(
			`${raw} isn't https, so anyone on the network could read the token sent there. Plain http is only allowed for localhost and loopback addresses.`,
		);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new ConfigError(`${raw} should be just the API's address, like ${DEFAULT_BASE_URL}.`);
	}
	return url.href.replace(/\/+$/, "");
}

/** localhost, a name under it, or a loopback address. */
export function isLocal(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}
