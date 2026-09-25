// Express (and anything with the same middleware shape: Connect, Fastify's express plugin).
//
//   import { requireUser, requireWebhook } from "@jiayang-cloud/sdk/express";
//   app.post("/hooks/stripe", express.json(), requireWebhook({ provider: "stripe" }), onStripe);
//   app.use(requireUser());
//   app.get("/", (req, res) => res.send(`hello ${req.user.email}`));

import {
	Forbidden,
	Unauthorized,
	requireRole,
	type JiayangEnv,
	type Role,
	type User,
	type VerifyOptions,
	type Webhook,
	type WebhookOptions,
} from "./index.js";
import { envFromProcess, requireUserFrom, requireWebhookFrom, type HasHeaders } from "./node.js";

/** What the middleware puts on the request. */
export interface WithUser {
	user?: User;
}

/** What `requireWebhook()` puts on the request. */
export interface WithWebhook {
	webhook?: Webhook;
}

type Request = HasHeaders & WithUser & WithWebhook;
type Response = { status(code: number): { end(body?: string): void } };
type Next = (err?: unknown) => void;
type Middleware = (req: Request, res: Response, next: Next) => void;

export interface Options extends VerifyOptions {
	/** Defaults to the platform's own variables from `process.env`. */
	env?: JiayangEnv;
	/** The least a caller must be. Anything less gets 403. */
	role?: Role;
}

/** Refuses anyone the platform hasn't vouched for, and sets `req.user` for everyone else. */
export function requireUser(options: Options = {}): Middleware {
	const { env = envFromProcess(), role, ...verify } = options;
	return (req, res, next) => {
		void (async () => {
			try {
				const user = await requireUserFrom(req, env, verify);
				if (role) requireRole(user, role);
				req.user = user;
			} catch (err) {
				return answer(err, res, next);
			}
			// Outside the catch on purpose: what the rest of the app throws is Express's to
			// handle, not something for this to answer 401 to.
			next();
		})();
	};
}

/** Sets `req.user` when there is one, and lets everyone through. For a page that renders either way. */
export function withUser(options: Options = {}): Middleware {
	const { env = envFromProcess(), ...verify } = options;
	return (req, res, next) => {
		void (async () => {
			try {
				req.user = await requireUserFrom(req, env, verify);
			} catch (err) {
				if (!(err instanceof Unauthorized)) return next(err);
			}
			next();
		})();
	};
}

export interface WebhookMiddlewareOptions extends WebhookOptions {
	/** Defaults to the platform's own variables from `process.env`. */
	env?: JiayangEnv;
}

/**
 * Refuses everything but a delivery the platform verified from one of these providers, and sets
 * `req.webhook` for that. Register the route before any `app.use(requireUser())`, which would
 * refuse the delivery first.
 */
export function requireWebhook(options: WebhookMiddlewareOptions): Middleware {
	const { env = envFromProcess(), ...verify } = options;
	return (req, res, next) => {
		void (async () => {
			try {
				req.webhook = await requireWebhookFrom(req, env, verify);
			} catch (err) {
				return answer(err, res, next);
			}
			next();
		})();
	};
}

function answer(err: unknown, res: Response, next: Next): void {
	if (err instanceof Unauthorized) return res.status(401).end("unauthorized");
	if (err instanceof Forbidden) return res.status(403).end("forbidden");
	next(err);
}
