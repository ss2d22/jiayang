// Hono, which runs on Workers and hands you the request as it arrived.
//
//   import { getUser, getWebhook, jiayang, webhook } from "@jiayang-cloud/sdk/hono";
//   app.post("/hooks/stripe", webhook({ provider: "stripe" }), (c) => c.text(getWebhook(c).delivery ?? ""));
//   app.use("*", jiayang());
//   app.get("/", (c) => c.text(`hello ${getUser(c).email}`));

import {
	Forbidden,
	Unauthorized,
	requireRole,
	requireUser,
	requireWebhook,
	type JiayangEnv,
	type Role,
	type User,
	type VerifyOptions,
	type Webhook,
	type WebhookOptions,
} from "./index.js";
import { envFromProcess } from "./node.js";

/** Just enough of Hono's context to read the request and carry the caller. */
interface Context {
	req: { raw: Request };
	env: unknown;
	get(key: "user"): User | undefined;
	set(key: "user", value: User): void;
}

export interface Options extends VerifyOptions {
	/**
	 * Defaults to the bindings Hono was given, which on Workers is where the platform puts them, or
	 * to `process.env` when the bindings don't carry them.
	 */
	env?: JiayangEnv;
	/** The least a caller must be. Anything less gets 403. */
	role?: Role;
}

/** Refuses anyone the platform hasn't vouched for, and puts the caller on the context. */
export function jiayang(options: Options = {}) {
	const { env, role, ...verify } = options;
	return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
		try {
			const user = await requireUser(c.req.raw, env ?? platformEnv(c.env), verify);
			if (role) requireRole(user, role);
			c.set("user", user);
		} catch (err) {
			if (err instanceof Unauthorized || err instanceof Forbidden) return err.toResponse();
			throw err;
		}
		await next();
	};
}

/**
 * Where the platform's variables are for this request.
 *
 * On Workers they're bindings, so `c.env`. Everywhere else `c.env` is whatever the server adapter
 * put there (`{ incoming, outgoing }` on @hono/node-server, the server itself on Bun), and a
 * container is given the variables in `process.env`. With them in neither, everyone is refused.
 */
function platformEnv(bindings: unknown): JiayangEnv {
	if (typeof bindings === "object" && bindings !== null && "JIAYANG_APP_ID" in bindings) return bindings as JiayangEnv;
	return envFromProcess();
}

/**
 * The caller `jiayang()` put on the context.
 *
 * Throws if the middleware didn't run: a handler asking who is calling should never be reached
 * without an answer, and returning undefined would let it carry on as though there were one.
 */
export function getUser(c: Context): User {
	const user = c.get("user");
	if (!user) throw new Error("getUser() needs the jiayang() middleware to have run on this route");
	return user;
}

/** What the webhook middleware reads: the request, and the bindings the platform's variables may be in. */
interface WebhookContext {
	req: { raw: Request };
	env: unknown;
}

// Not on the context through c.set, where any middleware can put a value under any name: only
// webhook() writes here, so getWebhook() reads nothing it didn't verify.
const vouched = new WeakMap<WebhookContext, Webhook>();

export interface WebhookMiddlewareOptions extends WebhookOptions {
	/** As for jiayang(): Hono's bindings, or `process.env` when they don't carry the variables. */
	env?: JiayangEnv;
}

/**
 * Refuses everything but a delivery the platform verified from one of these providers. Register
 * the route before any `app.use("*", jiayang())`, which would refuse the delivery first.
 */
export function webhook(options: WebhookMiddlewareOptions) {
	const { env, ...verify } = options;
	return async (c: WebhookContext, next: () => Promise<void>): Promise<Response | void> => {
		try {
			vouched.set(c, await requireWebhook(c.req.raw, env ?? platformEnv(c.env), verify));
		} catch (err) {
			if (err instanceof Unauthorized) return err.toResponse();
			throw err;
		}
		await next();
	};
}

/** The delivery `webhook()` verified. Throws if the middleware didn't run on this route. */
export function getWebhook(c: WebhookContext): Webhook {
	const found = vouched.get(c);
	if (!found) throw new Error("getWebhook() needs the webhook() middleware to have run on this route");
	return found;
}
