// The token cases in sdks/testdata/vectors.json, shared by every SDK.
import { readFileSync } from "node:fs";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { describe, expect, it } from "vitest";
import { clearKeyCache, isAgent, Unauthorized, verifyIdentity, verifyWebhook, type JiayangEnv, type Provider } from "../src/index";

interface Case {
	name: string;
	token: string;
	now?: number;
	jwks?: unknown;
	user?: { kind: string; sub: string; email: string | null; role: string; workspace_id: string; agent_name: string | null };
}

interface WebhookCase extends Case {
	providers: string[];
	webhook?: { provider: string; pattern: string; delivery: string | null; signed_at: number | null; workspace_id: string };
}

const v = JSON.parse(readFileSync(new URL("../../testdata/vectors.json", import.meta.url), "utf8")) as {
	config: { app_id: string; issuer: string; jwks_url: string };
	now: number;
	jwks: unknown;
	valid: Case[];
	invalid: Case[];
	webhook_valid: WebhookCase[];
	webhook_invalid: WebhookCase[];
	origins: { name: string; ok: boolean; issuer: string; jwks_url: string; dev: string | null }[];
	dev: { issuer: string; jwks_url: string; token: string; user: NonNullable<Case["user"]> };
};

const env: JiayangEnv = { JIAYANG_APP_ID: v.config.app_id, JIAYANG_IDENTITY_ISSUER: v.config.issuer, JIAYANG_JWKS_URL: v.config.jwks_url };

function options(c: Case) {
	clearKeyCache();
	return { now: (c.now ?? v.now) * 1000, fetch: async () => Response.json(c.jwks ?? v.jwks) };
}

const verify = (c: Case) => verifyIdentity(c.token, env, options(c));
const verifyHook = (c: WebhookCase) => verifyWebhook(c.token, env, { ...options(c), provider: c.providers as Provider[] });

describe("shared vectors", () => {
	for (const c of v.valid) {
		it(`accepts ${c.name}`, async () => {
			const u = c.user!;
			const user = await verify(c);
			expect(user).toEqual({ kind: u.kind, sub: u.sub, email: u.email, role: u.role, workspaceId: u.workspace_id, agentName: u.agent_name });
			expect(isAgent(user)).toBe(u.agent_name !== null);
		});
	}
	for (const c of v.invalid) {
		it(`refuses ${c.name}`, async () => {
			await expect(verify(c)).rejects.toBeInstanceOf(Unauthorized);
		});
	}
});

describe("shared webhook vectors", () => {
	for (const c of v.webhook_valid) {
		it(`accepts ${c.name}`, async () => {
			const w = c.webhook!;
			expect(await verifyHook(c)).toEqual({
				provider: w.provider,
				pattern: w.pattern,
				delivery: w.delivery,
				signedAt: w.signed_at,
				workspaceId: w.workspace_id,
			});
		});
	}
	for (const c of v.webhook_invalid) {
		it(`refuses ${c.name}`, async () => {
			await expect(verifyHook(c)).rejects.toBeInstanceOf(Unauthorized);
		});
	}

	// An app in a language we ship no SDK for checks the token with whatever JWT library it has:
	// signature, issuer, audience, expiry. Addressed to the app, that check must not pass a webhook.
	it("is refused by a generic check that the audience is the app", async () => {
		const keys = createLocalJWKSet(v.jwks as JSONWebKeySet);
		for (const c of v.webhook_valid) {
			const generic = jwtVerify(c.token, keys, {
				issuer: v.config.issuer,
				audience: v.config.app_id,
				currentDate: new Date(v.now * 1000),
			});
			await expect(generic, c.name).rejects.toThrow(/aud/);
		}
	});
});

describe("shared origin vectors", () => {
	// A token from wherever the case names, so the origin is all that decides it.
	const from = (issuer: string, jwksUrl: string, dev: string | null): JiayangEnv => ({
		JIAYANG_APP_ID: v.config.app_id,
		JIAYANG_IDENTITY_ISSUER: issuer,
		JIAYANG_JWKS_URL: jwksUrl,
		...(dev === null ? {} : { JIAYANG_DEV: dev }),
	});

	for (const c of v.origins) {
		it(`${c.ok ? "takes" : "refuses"} ${c.name}`, async () => {
			clearKeyCache();
			let fetched = false;
			const fetch = async () => {
				fetched = true;
				return Response.json(v.jwks);
			};
			const token = v.valid[0]!.token;
			const result = verifyIdentity(token, from(c.issuer, c.jwks_url, c.dev), { now: v.now * 1000, fetch });
			if (c.ok) {
				// The token's issuer is the platform's, so a dev origin that's taken still refuses it, on
				// its issuer, after asking for keys.
				await result.catch(() => undefined);
				expect(fetched).toBe(true);
			} else {
				await expect(result).rejects.toThrow(/JIAYANG_DEV=1/);
				expect(fetched, "keys were asked for from an origin that isn't taken").toBe(false);
			}
		});
	}

	const dev = from(v.dev.issuer, v.dev.jwks_url, "1");
	const options = () => {
		clearKeyCache();
		return { now: v.now * 1000, fetch: async () => Response.json(v.jwks) };
	};

	it("takes a token from jiayang dev under JIAYANG_DEV=1", async () => {
		const u = v.dev.user;
		expect(await verifyIdentity(v.dev.token, dev, options())).toEqual({
			kind: u.kind, sub: u.sub, email: u.email, role: u.role, workspaceId: u.workspace_id, agentName: u.agent_name,
		});
	});

	// Production: the same token and the same dev config, without the variable only jiayang dev sets.
	it("refuses a token from jiayang dev without JIAYANG_DEV", async () => {
		const { JIAYANG_DEV: _, ...production } = dev;
		await expect(verifyIdentity(v.dev.token, production, options())).rejects.toBeInstanceOf(Unauthorized);
		await expect(verifyWebhook(v.dev.token, production, { ...options(), provider: "stripe" })).rejects.toThrow(/JIAYANG_DEV=1/);
	});

	it("refuses a token from jiayang dev against the platform's issuer, even under JIAYANG_DEV=1", async () => {
		await expect(verifyIdentity(v.dev.token, { ...env, JIAYANG_DEV: "1" }, options())).rejects.toThrow("invalid identity token");
	});
});
