// Next.js, where a server component or a route handler reads the request's headers rather than
// being given the request.
//
//   import { getUser, requireUser } from "@jiayang-cloud/sdk/next";
//   export default async function Page() {
//     const user = await getUser();
//     return <p>hello {user?.email ?? "stranger"}</p>;
//   }
//
// And in app/hooks/stripe/route.ts, for a webhook:
//
//   export async function POST(request: Request) {
//     const hook = await requireWebhook({ provider: "stripe" });
//     const event = await request.json();
//   }

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
import { envFromProcess } from "./node.js";

/** What `headers()` returns, or anything else that can be asked for one. */
export interface Readable {
	get(name: string): string | null | undefined;
}

export interface Options extends VerifyOptions {
	/** Defaults to the platform's own variables from `process.env`. */
	env?: JiayangEnv;
	/** Next's `headers()`, already awaited. Read from `next/headers` when left out. */
	headers?: Readable;
}

/** The verified caller, or throws `Unauthorized` for a route that must refuse. */
export async function requireUser(options: Options = {}): Promise<User> {
	const { env = envFromProcess(), headers, ...verify } = options;
	const from = headers ?? (await nextHeaders());
	const token = from.get(IDENTITY_HEADER);
	if (!token) throw new Unauthorized("no identity token");
	return verifyIdentity(token, env, verify);
}

/** The verified caller, or null. For a page that would rather render than refuse. */
export async function getUser(options: Options = {}): Promise<User | null> {
	try {
		return await requireUser(options);
	} catch (err) {
		if (err instanceof Unauthorized) return null;
		throw err;
	}
}

export interface WebhookRouteOptions extends WebhookOptions {
	/** Defaults to the platform's own variables from `process.env`. */
	env?: JiayangEnv;
	/** Next's `headers()`, already awaited. Read from `next/headers` when left out. */
	headers?: Readable;
}

/** The webhook the platform verified for this request, or throws `Unauthorized`. For a route handler. */
export async function requireWebhook(options: WebhookRouteOptions): Promise<Webhook> {
	// Runs per request, so plain JavaScript that names no provider gets a refusal rather than a crash.
	const { env = envFromProcess(), headers, ...verify } = options ?? ({} as WebhookRouteOptions);
	const from = headers ?? (await nextHeaders());
	const token = from.get(IDENTITY_HEADER);
	if (!token) throw new Unauthorized("no identity token");
	return verifyWebhook(token, env, verify);
}

/**
 * Next's own `headers()`, imported only if it's needed, so this module can be loaded (and tested)
 * somewhere Next isn't, and nothing here depends on a particular version of it.
 *
 * The specifier is a literal on purpose. A bundler has to be able to see it: Next's server build
 * puts this file through one, and an expression it can't resolve becomes an import that throws at
 * runtime. Every caller would then look like a stranger.
 */
async function nextHeaders(): Promise<Readable> {
	let next: { headers: () => Promise<Readable> | Readable };
	try {
		// @ts-expect-error - next is the app's dependency, not ours, so there's nothing here to
		// type-check this against.
		next = await import("next/headers");
	} catch {
		throw new Unauthorized("pass headers() in, or call this where next/headers can be imported");
	}
	// Whatever `headers()` itself throws is Next telling the app it asked at the wrong moment.
	// That is not an unauthorized caller, and turning it into one would hide it.
	return await next.headers();
}
