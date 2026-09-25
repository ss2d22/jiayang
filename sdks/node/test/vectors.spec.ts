// The token cases in sdks/testdata/vectors.json, shared by every SDK.
import { readFileSync } from "node:fs";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { describe, expect, it } from "vitest";
import { clearKeyCache, Unauthorized, verifyIdentity, verifyWebhook, type JiayangEnv, type Provider } from "../src/index";

interface Case {
	name: string;
	token: string;
	now?: number;
	jwks?: unknown;
	user?: { kind: string; sub: string; email: string | null; role: string; workspace_id: string };
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
			expect(await verify(c)).toEqual({ kind: u.kind, sub: u.sub, email: u.email, role: u.role, workspaceId: u.workspace_id });
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
