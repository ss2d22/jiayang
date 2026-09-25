// For frameworks built on Node's own http server: Express, Fastify, Koa, or `node:http` itself.
// They hand you headers rather than a fetch Request, so this reads the token from those and hands
// it to the same verification everything else uses.

import {
	IDENTITY_HEADER,
	Unauthorized,
	verifyIdentity,
	verifyWebhook,
	type JiayangEnv,
	type User,
	type VerifyOptions,
	type Webhook,
	type WebhookOptions,
} from "./index.js";

/** Headers as Node gives them: a repeated header arrives as an array. */
export type NodeHeaders = Record<string, string | string[] | undefined>;

/** Anything with headers on it: `http.IncomingMessage`, an Express request, a Koa request. */
export interface HasHeaders {
	headers: NodeHeaders;
}

/**
 * The verified caller, from Node-style headers.
 *
 * A token that arrived twice is refused rather than one of them being picked: the edge sends
 * exactly one, so two means something else put one there.
 */
export async function requireUserFrom(
	from: HasHeaders | NodeHeaders,
	env: JiayangEnv,
	options: VerifyOptions = {},
): Promise<User> {
	return verifyIdentity(tokenFrom(from), env, options);
}

/** The webhook the platform verified, from Node-style headers. A repeated token is refused here too. */
export async function requireWebhookFrom(from: HasHeaders | NodeHeaders, env: JiayangEnv, options: WebhookOptions): Promise<Webhook> {
	return verifyWebhook(tokenFrom(from), env, options);
}

function tokenFrom(from: HasHeaders | NodeHeaders): string {
	const headers = "headers" in from && from.headers ? (from as HasHeaders).headers : (from as NodeHeaders);
	const token = headers[IDENTITY_HEADER];
	if (Array.isArray(token)) throw new Unauthorized("more than one identity token");
	if (!token) throw new Unauthorized("no identity token");
	return token;
}

/** The platform's own variables, read from `process.env`. */
export function envFromProcess(): JiayangEnv {
	const from = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
	return {
		JIAYANG_APP_ID: from.JIAYANG_APP_ID,
		JIAYANG_IDENTITY_ISSUER: from.JIAYANG_IDENTITY_ISSUER,
		JIAYANG_JWKS_URL: from.JIAYANG_JWKS_URL,
	};
}
