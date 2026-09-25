import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearKeyCache, Forbidden, Unauthorized, type JiayangEnv } from "../src/index";
import { requireUserFrom, requireWebhookFrom } from "../src/node";
import { requireUser as expressRequireUser, requireWebhook as expressRequireWebhook, withUser } from "../src/express";
import { getUser, getWebhook, jiayang, webhook } from "../src/hono";
import { getUser as nextGetUser, requireUser as nextRequireUser, requireWebhook as nextRequireWebhook } from "../src/next";

// The adapters only ever find the token and hand it to the same verification the core does, so
// what's worth testing is how each framework's shape is read and what it answers with.

const APP = "0a000000-0000-4000-8000-000000000001";
const env: JiayangEnv = {
	JIAYANG_APP_ID: APP,
	JIAYANG_IDENTITY_ISSUER: "https://edge.example.com",
	JIAYANG_JWKS_URL: "https://edge.example.com/.well-known/jwks.json",
};
const NOW = Date.parse("2026-09-18T12:00:00Z");

let edgeKey: { privateKey: CryptoKey; jwk: JWK };
let published: JWK[] = [];
const fetchJwks = async () => Response.json({ keys: published });
const verify = { now: NOW, fetch: fetchJwks };

async function token(role = "editor"): Promise<string> {
	const iat = Math.floor(NOW / 1000);
	return new SignJWT({
		iss: env.JIAYANG_IDENTITY_ISSUER,
		aud: APP,
		sub: "access-sub-alice",
		email: "alice@example.com",
		kind: "user",
		role,
		wid: "0b000000-0000-4000-8000-00000000000a",
		iat,
		exp: iat + 60,
	})
		.setProtectedHeader({ alg: "RS256", kid: "identity-k1", typ: "JWT" })
		.sign(edgeKey.privateKey);
}

/** What the edge sends with a Stripe delivery on a verified path. */
async function webhookToken(): Promise<string> {
	const iat = Math.floor(NOW / 1000);
	return new SignJWT({
		iss: env.JIAYANG_IDENTITY_ISSUER,
		aud: `webhook:${APP}`,
		sub: "webhook:0c000000-0000-4000-8000-0000000000f1",
		kind: "webhook",
		wid: "0b000000-0000-4000-8000-00000000000a",
		provider: "stripe",
		pattern: "/hooks/stripe",
		delivery: "evt_1",
		signed_at: iat - 1,
		iat,
		exp: iat + 60,
	})
		.setProtectedHeader({ alg: "RS256", kid: "identity-k1", typ: "webhook+jwt" })
		.sign(edgeKey.privateKey);
}

const STRIPE = { provider: "stripe", pattern: "/hooks/stripe", delivery: "evt_1", workspaceId: "0b000000-0000-4000-8000-00000000000a" };

beforeAll(async () => {
	const pair = await generateKeyPair("RS256", { extractable: true });
	edgeKey = { privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid: "identity-k1", alg: "RS256", use: "sig" } };
});

beforeEach(() => {
	clearKeyCache();
	published = [edgeKey.jwk];
});

describe("node-shaped headers", () => {
	it("reads the token from a request or from headers alone", async () => {
		const t = await token();
		const expected = { email: "alice@example.com", role: "editor" };
		expect(await requireUserFrom({ headers: { "x-jiayang-identity": t } }, env, verify)).toMatchObject(expected);
		expect(await requireUserFrom({ "x-jiayang-identity": t }, env, verify)).toMatchObject(expected);
	});

	// The edge sends exactly one. Two means something else put one there, and picking either would
	// be choosing which of them to believe.
	it("refuses a token that arrived twice", async () => {
		const t = await token();
		const twice = { headers: { "x-jiayang-identity": [t, t] } };
		await expect(requireUserFrom(twice, env, verify)).rejects.toBeInstanceOf(Unauthorized);
	});

	it("refuses a request with none", async () => {
		await expect(requireUserFrom({ headers: {} }, env, verify)).rejects.toBeInstanceOf(Unauthorized);
	});

	it("reads a webhook the same way, and each refuses the other's token", async () => {
		const hook = await webhookToken();
		const stripe = { ...verify, provider: "stripe" as const };
		expect(await requireWebhookFrom({ headers: { "x-jiayang-identity": hook } }, env, stripe)).toMatchObject(STRIPE);
		await expect(requireWebhookFrom({ headers: { "x-jiayang-identity": await token() } }, env, stripe)).rejects.toBeInstanceOf(Unauthorized);
		await expect(requireUserFrom({ headers: { "x-jiayang-identity": hook } }, env, verify)).rejects.toBeInstanceOf(Unauthorized);
	});

	it("refuses a webhook token that arrived twice, or none", async () => {
		const hook = await webhookToken();
		const stripe = { ...verify, provider: "stripe" as const };
		await expect(requireWebhookFrom({ headers: { "x-jiayang-identity": [hook, hook] } }, env, stripe)).rejects.toBeInstanceOf(Unauthorized);
		await expect(requireWebhookFrom({ headers: {} }, env, stripe)).rejects.toBeInstanceOf(Unauthorized);
	});
});

describe("express", () => {
	const run = (middleware: ReturnType<typeof expressRequireUser>, headers: Record<string, string | string[]>) =>
		new Promise<{
			status?: number;
			body?: string;
			headers?: Record<string, string>;
			user?: unknown;
			passed: boolean;
			err?: unknown;
		}>((resolve) => {
			const req = { headers } as Parameters<typeof middleware>[0];
			const sent: Record<string, string> = {};
			const res = {
				setHeader: (name: string, value: string) => (sent[name.toLowerCase()] = value),
				status: (code: number) => ({
					end: (body?: string) => resolve({ status: code, body, headers: sent, passed: false }),
				}),
			};
			middleware(req, res, (err?: unknown) =>
				resolve(err ? { passed: false, err } : { user: req.user, passed: true }),
			);
		});

	it("sets req.user and carries on", async () => {
		const out = await run(expressRequireUser({ env, ...verify }), { "x-jiayang-identity": await token() });
		expect(out.passed).toBe(true);
		expect(out.user).toMatchObject({ email: "alice@example.com" });
	});

	it("answers 401 for no identity and 403 for the wrong role", async () => {
		const none = await run(expressRequireUser({ env, ...verify }), {});
		expect(none.status).toBe(401);

		const viewer = await run(expressRequireUser({ env, role: "editor", ...verify }), {
			"x-jiayang-identity": await token("viewer"),
		});
		expect(viewer.status).toBe(403);
		// The same plain text every SDK answers.
		expect(viewer.body).toBe("forbidden: this needs editor");
	});

	// A shared cache in front of the app mustn't serve one caller's refusal to the next.
	it("marks a 401 and a 403 no-store", async () => {
		const none = await run(expressRequireUser({ env, ...verify }), {});
		expect(none.headers).toEqual({ "cache-control": "no-store" });

		const viewer = await run(expressRequireUser({ env, role: "editor", ...verify }), {
			"x-jiayang-identity": await token("viewer"),
		});
		expect(viewer.headers).toEqual({ "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
	});

	// A page that renders either way still has to know when it doesn't know.
	it("withUser lets anyone through and leaves req.user unset", async () => {
		const out = await run(withUser({ env, ...verify }), {});
		expect(out.passed).toBe(true);
		expect(out.user).toBeUndefined();
	});

	it("requireUser refuses a webhook token", async () => {
		const out = await run(expressRequireUser({ env, ...verify }), { "x-jiayang-identity": await webhookToken() });
		expect(out.status).toBe(401);
	});

	describe("requireWebhook", () => {
		const hooked = (headers: Record<string, string>, provider: "stripe" | "github" = "stripe") =>
			new Promise<{ status?: number; webhook?: unknown; passed: boolean }>((resolve) => {
				const middleware = expressRequireWebhook({ env, provider, ...verify });
				const req = { headers } as Parameters<typeof middleware>[0];
				const res = {
					setHeader: () => undefined,
					status: (code: number) => ({ end: () => resolve({ status: code, passed: false }) }),
				};
				middleware(req, res, () => resolve({ webhook: req.webhook, passed: true }));
			});

		it("sets req.webhook and carries on", async () => {
			const out = await hooked({ "x-jiayang-identity": await webhookToken() });
			expect(out.passed).toBe(true);
			expect(out.webhook).toMatchObject(STRIPE);
		});

		it("answers 401 to a person, to nobody, and to another provider's route", async () => {
			expect((await hooked({ "x-jiayang-identity": await token() })).status).toBe(401);
			expect((await hooked({})).status).toBe(401);
			expect((await hooked({ "x-jiayang-identity": await webhookToken() }, "github")).status).toBe(401);
		});

		// How the README mounts it: the webhook's route first, then the user middleware for the rest.
		// A route that answers ends the chain, so the delivery never meets requireUser, and a person
		// sent to the webhook's path is refused there rather than let through.
		it("works in front of app-wide requireUser", async () => {
			type Req = Parameters<ReturnType<typeof expressRequireUser>>[0] & { path: string };
			type Res = { setHeader(name: string, value: string): unknown; status(code: number): { end(body?: string): void } };
			type Step = { path?: string; handle: (req: Req, res: Res, next: (err?: unknown) => void) => void };
			const chain: Step[] = [
				{ path: "/hooks/stripe", handle: expressRequireWebhook({ env, provider: "stripe", ...verify }) },
				{ path: "/hooks/stripe", handle: (req, res) => res.status(200).end(`took ${req.webhook?.delivery}`) },
				{ handle: expressRequireUser({ env, ...verify }) },
				{ path: "/", handle: (req, res) => res.status(200).end(`hello ${req.user?.email}`) },
			];
			// Express's own order: each step whose path matches, until one answers.
			const serve = (path: string, headers: Record<string, string>) =>
				new Promise<string>((resolve) => {
					const req = { path, headers } as Req;
					const res = {
						setHeader: () => undefined,
						status: (code: number) => ({ end: (body?: string) => resolve(`${code} ${body ?? ""}`.trim()) }),
					};
					const step = (i: number): void => {
						const at = chain.slice(i).findIndex((s) => s.path === undefined || s.path === path);
						if (at === -1) return resolve("404");
						chain[i + at]!.handle(req, res, () => step(i + at + 1));
					};
					step(0);
				});

			expect(await serve("/hooks/stripe", { "x-jiayang-identity": await webhookToken() })).toBe("200 took evt_1");
			expect(await serve("/hooks/stripe", { "x-jiayang-identity": await token() })).toBe("401 unauthorized");
			expect(await serve("/", { "x-jiayang-identity": await token() })).toBe("200 hello alice@example.com");
			expect(await serve("/", { "x-jiayang-identity": await webhookToken() })).toBe("401 unauthorized");
		});
	});
});

describe("hono", () => {
	/** A context as Hono makes it. `bindings` is `c.env`: the platform's variables on Workers. */
	const context = (headers: Record<string, string>, bindings: unknown = env) => {
		const store = new Map<string, unknown>();
		return {
			req: { raw: new Request("https://app.example.com/", { headers }) },
			env: bindings,
			get: (k: "user") => store.get(k) as never,
			set: (k: "user", v: unknown) => void store.set(k, v),
		};
	};

	it("puts the caller on the context", async () => {
		const c = context({ "x-jiayang-identity": await token() });
		let reached = false;
		const answer = await jiayang({ env, ...verify })(c, async () => void (reached = true));
		expect(answer).toBeUndefined();
		expect(reached).toBe(true);
		expect(getUser(c)).toMatchObject({ email: "alice@example.com" });
	});

	it("answers rather than calling on when there's no caller", async () => {
		const c = context({});
		let reached = false;
		const answer = await jiayang({ env, ...verify })(c, async () => void (reached = true));
		expect(reached).toBe(false);
		expect((answer as Response).status).toBe(401);
	});

	// A handler asking who is calling must never be answered "nobody, carry on".
	it("getUser says so when the middleware didn't run", () => {
		expect(() => getUser(context({}))).toThrow(/middleware/);
	});

	it("jiayang() refuses a webhook token", async () => {
		const c = context({ "x-jiayang-identity": await webhookToken() });
		expect(((await jiayang({ env, ...verify })(c, async () => {})) as Response).status).toBe(401);
	});

	describe("webhook()", () => {
		it("puts the delivery where getWebhook finds it", async () => {
			const c = context({ "x-jiayang-identity": await webhookToken() });
			let reached = false;
			expect(await webhook({ env, provider: "stripe", ...verify })(c, async () => void (reached = true))).toBeUndefined();
			expect(reached).toBe(true);
			expect(getWebhook(c)).toMatchObject(STRIPE);
		});

		it("answers 401 to a person and to nobody, and never calls on", async () => {
			for (const headers of [{ "x-jiayang-identity": await token() }, {}]) {
				let reached = false;
				const answer = await webhook({ env, provider: "stripe", ...verify })(context(headers), async () => void (reached = true));
				expect((answer as Response).status).toBe(401);
				expect(reached).toBe(false);
			}
		});

		// c.set is open to every middleware on the route. What getWebhook answers has to be webhook()'s.
		it("getWebhook ignores a webhook some other middleware set, and says the middleware didn't run", () => {
			const c = context({});
			c.set("webhook" as "user", { ...STRIPE, signedAt: null } as never);
			expect(() => getWebhook(c)).toThrow(/middleware/);
		});

		// Hono runs a route's handlers in the order they were registered, and one that answers ends it.
		it("works in front of app.use('*', jiayang())", async () => {
			const hook = webhook({ env, provider: "stripe", ...verify });
			const everyone = jiayang({ env, ...verify });
			const serve = async (headers: Record<string, string>) => {
				const c = context(headers);
				return (await hook(c, async () => {})) ?? new Response(getWebhook(c).delivery);
			};
			expect(await (await serve({ "x-jiayang-identity": await webhookToken() })).text()).toBe("evt_1");
			expect((await serve({ "x-jiayang-identity": await token() })).status).toBe(401);
			// And everything after it still takes people only.
			expect(((await everyone(context({ "x-jiayang-identity": await webhookToken() }), async () => {})) as Response).status).toBe(401);
		});
	});

	// Off Workers, c.env is the server adapter's own (this is @hono/node-server's), and a container
	// is given the platform's variables in process.env.
	describe("off Workers", () => {
		const nodeServer = { incoming: {}, outgoing: {} };
		afterEach(() => void vi.unstubAllEnvs());

		it("reads the platform's variables from process.env", async () => {
			for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
			const c = context({ "x-jiayang-identity": await token() }, nodeServer);
			expect(await jiayang(verify)(c, async () => {})).toBeUndefined();
			expect(getUser(c)).toMatchObject({ email: "alice@example.com" });
		});

		it("still refuses everyone when neither has them", async () => {
			for (const name of Object.keys(env)) vi.stubEnv(name, undefined);
			const c = context({ "x-jiayang-identity": await token() }, nodeServer);
			expect(((await jiayang(verify)(c, async () => {})) as Response).status).toBe(401);
		});

		it("takes the bindings over process.env wherever there are bindings", async () => {
			for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
			vi.stubEnv("JIAYANG_APP_ID", "0a000000-0000-4000-8000-000000000002");
			const c = context({ "x-jiayang-identity": await token() });
			expect(await jiayang(verify)(c, async () => {})).toBeUndefined();
		});
	});
});

describe("next", () => {
	const headers = (value?: string) => ({ get: (name: string) => (name === "x-jiayang-identity" ? (value ?? null) : null) });

	it("verifies the caller from the request's headers", async () => {
		const user = await nextRequireUser({ env, headers: headers(await token()), ...verify });
		expect(user).toMatchObject({ email: "alice@example.com" });
	});

	it("getUser is null rather than an error, for a page that renders either way", async () => {
		expect(await nextGetUser({ env, headers: headers(), ...verify })).toBeNull();
		await expect(nextRequireUser({ env, headers: headers(), ...verify })).rejects.toBeInstanceOf(Unauthorized);
	});

	it("requireWebhook takes a delivery and refuses a person or nobody", async () => {
		const stripe = { env, provider: "stripe" as const, ...verify };
		expect(await nextRequireWebhook({ ...stripe, headers: headers(await webhookToken()) })).toMatchObject(STRIPE);
		await expect(nextRequireWebhook({ ...stripe, headers: headers(await token()) })).rejects.toBeInstanceOf(Unauthorized);
		await expect(nextRequireWebhook({ ...stripe, headers: headers() })).rejects.toBeInstanceOf(Unauthorized);
	});

	it("requireWebhook refuses when no provider is named, rather than crashing", async () => {
		const call = nextRequireWebhook(undefined as unknown as Parameters<typeof nextRequireWebhook>[0]);
		await expect(call).rejects.toBeInstanceOf(Unauthorized);
		const unnamed = { env, headers: headers(await webhookToken()), ...verify } as unknown as Parameters<typeof nextRequireWebhook>[0];
		await expect(nextRequireWebhook(unnamed)).rejects.toBeInstanceOf(Unauthorized);
	});

	it("a page's getUser is null for a webhook token", async () => {
		expect(await nextGetUser({ env, headers: headers(await webhookToken()), ...verify })).toBeNull();
	});
});

describe("what a refusal is", () => {
	it("tells 401 and 403 apart, and both carry a response", async () => {
		expect(new Unauthorized("no").toResponse().status).toBe(401);
		const refused = new Forbidden("editor").toResponse();
		expect(refused.status).toBe(403);
		expect(await refused.text()).toBe("forbidden: this needs editor");
		expect(refused.headers.get("content-type")).toBe("text/plain; charset=utf-8");
	});
});
