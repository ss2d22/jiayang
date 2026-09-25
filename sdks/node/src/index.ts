// Verifies the X-Jiayang-Identity token the edge sends your app.
// X-Jiayang-Email and X-Jiayang-Role are for display only.
//
//   import { requireUser, Unauthorized } from "@jiayang-cloud/sdk";
//   export default {
//     async fetch(request, env) {
//       try {
//         const user = await requireUser(request, env);
//         return new Response(`hello ${user.email}`);
//       } catch (err) {
//         if (err instanceof Unauthorized) return err.toResponse();
//         throw err;
//       }
//     },
//   };
//
// A webhook delivery on a verified public path carries a token too, of its own kind:
// `requireWebhook(request, env, { provider: "stripe" })` checks it, and `requireUser` refuses it.
//
// Works anywhere with WebCrypto and fetch (Workers, Node 20+, Deno, Bun). The build bundles jose.
//
// Docs: https://jiayang.cloud/docs/sdks/node/

import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from "jose";
import { JWKSNoMatchingKey } from "jose/errors";

export const IDENTITY_HEADER = "x-jiayang-identity";

// The edge's claim names, in the case it writes them.
const CLAIM_NAMES = new Set([
	"iss", "aud", "sub", "exp", "iat", "nbf", "jti", "kind", "email", "role", "wid",
	"provider", "pattern", "delivery", "signed_at",
]);

/** Vars the platform binds into every app. */
export interface JiayangEnv {
	/** Your app's id, used as the only accepted audience. */
	JIAYANG_APP_ID?: string;
	JIAYANG_IDENTITY_ISSUER?: string;
	JIAYANG_JWKS_URL?: string;
}

/** What a caller may do with this app. Ordered: an owner can do what an editor can. */
export type Role = "viewer" | "editor" | "owner";

const RANK: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };

export interface User {
	kind: "user" | "service";
	/** Stable id. The person's platform id ("usr_…"), or "service:<token id>". */
	sub: string;
	/** Null for service tokens. */
	email: string | null;
	role: Role;
	workspaceId: string;
}

export class Unauthorized extends Error {
	override name = "Unauthorized";
	readonly status = 401;
	toResponse(): Response {
		return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
	}
}

/** The caller is who they say they are, but not allowed to do this. */
export class Forbidden extends Error {
	override name = "Forbidden";
	readonly status = 403;
	constructor(readonly needed: Role) {
		super(`this needs ${needed}`);
	}
	/** `forbidden: this needs editor`, as plain text: the same 403 every SDK answers. */
	toResponse(): Response {
		return new Response(`forbidden: ${this.message}`, {
			status: 403,
			headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
		});
	}
}

/**
 * Whether the caller has at least this much.
 *
 * A role this version doesn't know counts for nothing: if the platform ever adds one, an app
 * built against an older SDK refuses rather than guessing what it allows.
 */
export function hasRole(user: User, least: Role): boolean {
	const need = RANK[least];
	// Asking for a role that doesn't exist allows nobody, the same way being one counts for
	// nothing. A typo in either place should refuse, not wave everyone through.
	return need !== undefined && (RANK[user.role] ?? 0) >= need;
}

/** Like `hasRole`, but throws `Forbidden` so a handler can answer with it. */
export function requireRole(user: User, least: Role): void {
	if (!hasRole(user, least)) throw new Forbidden(least);
}

export interface VerifyOptions {
	/** Clock override in epoch milliseconds, for tests. */
	now?: number;
	/** Override fetch for the JWKS, for tests or custom transports. */
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

const keySets = new Map<string, JWTVerifyGetKey>();

/** Returns the verified caller or throws Unauthorized. */
export async function requireUser(request: Request, env: JiayangEnv, options: VerifyOptions = {}): Promise<User> {
	const token = request.headers.get(IDENTITY_HEADER);
	if (!token) throw new Unauthorized("no identity token");
	return verifyIdentity(token, env, options);
}

/** Like requireUser, for a token you already have. */
export async function verifyIdentity(token: string, env: JiayangEnv, options: VerifyOptions = {}): Promise<User> {
	const payload = await verified(token, env, options, "");
	const { kind, sub, email, role, wid } = payload;
	if ((kind !== "user" && kind !== "service") || typeof sub !== "string" || sub === "") {
		throw new Unauthorized("invalid identity token");
	}
	if (kind === "user" && typeof email !== "string") throw new Unauthorized("invalid identity token");
	if (typeof role !== "string" || typeof wid !== "string") throw new Unauthorized("invalid identity token");
	return { kind, sub, email: kind === "user" ? (email as string) : null, role: role as Role, workspaceId: wid };
}

/** Who signs the webhooks the platform can check for you. */
export type Provider = "stripe" | "github" | "slack" | "shopify" | "standard_webhooks" | "hmac_sha256";

const PROVIDERS: ReadonlySet<string> = new Set<Provider>(["stripe", "github", "slack", "shopify", "standard_webhooks", "hmac_sha256"]);

/**
 * A delivery whose signature the platform checked before it reached your app, on a public path
 * with a verifier. Not a person: it has no email and no role.
 */
export interface Webhook {
	provider: Provider;
	/** The public path pattern it arrived on, such as "/hooks/stripe". */
	pattern: string;
	/** The provider's signed id for this delivery, where it signs one. Dedupe on it. */
	delivery: string | null;
	/** When the provider signed it, in unix seconds, where it signs a time. */
	signedAt: number | null;
	workspaceId: string;
}

export interface WebhookOptions extends VerifyOptions {
	/**
	 * The provider or providers this route takes. A delivery from any other is refused, and so is
	 * every delivery when the list is empty.
	 */
	provider: Provider | readonly Provider[];
}

/**
 * Returns the webhook the platform verified for this request, or throws Unauthorized. A person's
 * or a bypass token's identity is refused here, as a webhook's is by requireUser.
 */
export async function requireWebhook(request: Request, env: JiayangEnv, options: WebhookOptions): Promise<Webhook> {
	const token = request.headers.get(IDENTITY_HEADER);
	if (!token) throw new Unauthorized("no identity token");
	return verifyWebhook(token, env, options);
}

/** Like requireWebhook, for a token you already have. */
export async function verifyWebhook(token: string, env: JiayangEnv, options: WebhookOptions): Promise<Webhook> {
	// Named by the caller, so a Stripe route can't be handed a GitHub delivery because a pattern was
	// widened later. Read before anything is fetched: an empty list refuses everything anyway.
	const given: unknown = options?.provider;
	const wanted: readonly unknown[] = typeof given === "string" ? [given] : Array.isArray(given) ? given : [];
	if (wanted.length === 0) throw new Unauthorized("no provider named");

	const payload = await verified(token, env, options, WEBHOOK_AUDIENCE);
	const { aud, kind, sub, wid, provider, pattern } = payload;
	// jose takes a list holding our audience as well. The edge writes a single string.
	if (typeof aud !== "string" || kind !== "webhook" || typeof sub !== "string" || sub === "" || typeof wid !== "string") {
		throw new Unauthorized("invalid webhook token");
	}
	// A provider this version doesn't know matches nothing, even when the caller lists it.
	if (typeof provider !== "string" || !PROVIDERS.has(provider) || !wanted.includes(provider)) {
		throw new Unauthorized("not a webhook this route takes");
	}
	if (typeof pattern !== "string" || pattern === "") throw new Unauthorized("invalid webhook token");

	// Left out where the provider signs no id or no time. When there, each is what the edge writes.
	const { delivery, signed_at: signedAt } = payload;
	if (Object.hasOwn(payload, "delivery") && (typeof delivery !== "string" || delivery === "")) {
		throw new Unauthorized("invalid webhook token");
	}
	if (Object.hasOwn(payload, "signed_at") && !(Number.isSafeInteger(signedAt) && (signedAt as number) >= 0)) {
		throw new Unauthorized("invalid webhook token");
	}

	return {
		provider: provider as Provider,
		pattern,
		delivery: typeof delivery === "string" ? delivery : null,
		signedAt: typeof signedAt === "number" ? signedAt : null,
		workspaceId: wid,
	};
}

// A webhook's token is addressed to "webhook:<app id>", never to the app id alone, so a check
// written for people can't take a delivery for someone signed in.
const WEBHOOK_AUDIENCE = "webhook:";

/** The checks every token gets, whoever it's for: signature, issuer, audience, times, claim names. */
async function verified(token: string, env: JiayangEnv, options: VerifyOptions, audiencePrefix: string): Promise<Record<string, unknown>> {
	const { JIAYANG_APP_ID: appId, JIAYANG_IDENTITY_ISSUER: issuer, JIAYANG_JWKS_URL: jwksUrl } = env;
	if (!appId || !issuer || !jwksUrl) {
		// Deny if any are missing, since there's nothing to check the token against.
		throw new Unauthorized("JIAYANG_APP_ID, JIAYANG_IDENTITY_ISSUER and JIAYANG_JWKS_URL must be set");
	}

	let payload: Record<string, unknown>;
	try {
		// Without a kid jose would try the only key in the set. The edge always sends one.
		const { kid } = decodeProtectedHeader(token);
		if (typeof kid !== "string" || kid === "") throw new Unauthorized("invalid identity token");
		({ payload } = await jwtVerify(token, keySet(jwksUrl, options), {
			// Pinned so the token's own alg header can't pick the algorithm.
			algorithms: ["RS256"],
			issuer,
			audience: audiencePrefix + appId,
			requiredClaims: ["exp", "iat", "sub"],
			currentDate: options.now === undefined ? undefined : new Date(options.now),
			clockTolerance: 0,
		}));
	} catch (err) {
		// Said the way the other SDKs say it, so a platform that can't be reached isn't taken for a bad token.
		if (err instanceof KeysUnavailable) throw new Unauthorized("couldn't fetch the identity keys");
		throw new Unauthorized("invalid identity token");
	}

	// Go's JSON decoder matches "EXP" to exp, so every SDK refuses names like it to stay in step.
	for (const name of Object.keys(payload)) {
		if (CLAIM_NAMES.has(name.toLowerCase()) && !CLAIM_NAMES.has(name)) throw new Unauthorized("invalid identity token");
	}
	return payload;
}

/** The key set couldn't be had: the fetch failed, or what came back wasn't a key set. */
class KeysUnavailable extends Error {}

function keySet(url: string, options: VerifyOptions): JWTVerifyGetKey {
	let set = keySets.get(url);
	if (!set) {
		const remote = createRemoteJWKSet(new URL(url), {
			cacheMaxAge: 5 * 60_000,
			cooldownDuration: 10_000,
			timeoutDuration: 3_000,
			...(options.fetch ? { [customFetch]: options.fetch } : {}),
		});
		set = async (header, token) => {
			try {
				return await remote(header, token);
			} catch (err) {
				// Keys that arrived without the one the token names say something about the token.
				if (err instanceof JWKSNoMatchingKey) throw err;
				throw new KeysUnavailable();
			}
		};
		keySets.set(url, set);
	}
	return set;
}

/** Clears cached key sets, for tests. */
export function clearKeyCache(): void {
	keySets.clear();
}
