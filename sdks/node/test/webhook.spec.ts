// requireWebhook from the tenant side: what it takes, and that it fails closed like requireUser.
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearKeyCache, requireUser, requireWebhook, Unauthorized, verifyWebhook, type JiayangEnv, type WebhookOptions } from "../src/index";

const APP = "0a000000-0000-4000-8000-000000000001";
const env: JiayangEnv = {
	JIAYANG_APP_ID: APP,
	JIAYANG_IDENTITY_ISSUER: "https://edge.example.com",
	JIAYANG_JWKS_URL: "https://edge.example.com/.well-known/jwks.json",
};
const NOW = Date.parse("2026-09-18T12:00:00Z");

let key: { privateKey: CryptoKey; jwk: JWK };
let fetches = 0;
let down = false;
const fetchJwks = async () => {
	fetches++;
	if (down) throw new TypeError("network down");
	return Response.json({ keys: [key.jwk] });
};

async function hook(provider = "github"): Promise<string> {
	const iat = Math.floor(NOW / 1000);
	return new SignJWT({ kind: "webhook", wid: "0b000000-0000-4000-8000-00000000000a", provider, pattern: "/hooks/*" })
		.setProtectedHeader({ alg: "RS256", kid: "identity-k1", typ: "webhook+jwt" })
		.setIssuer(env.JIAYANG_IDENTITY_ISSUER!)
		.setAudience(`webhook:${APP}`)
		.setSubject("webhook:0c000000-0000-4000-8000-0000000000f1")
		.setIssuedAt(iat)
		.setExpirationTime(iat + 60)
		.sign(key.privateKey);
}

const github: WebhookOptions = { provider: "github", now: NOW, fetch: fetchJwks };
const request = (headers: Record<string, string>) => new Request("https://app.example.com/hooks/github", { method: "POST", headers });

beforeAll(async () => {
	const pair = await generateKeyPair("RS256", { extractable: true });
	key = { privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid: "identity-k1", alg: "RS256", use: "sig" } };
});

beforeEach(() => {
	clearKeyCache();
	fetches = 0;
	down = false;
});

describe("requireWebhook", () => {
	it("reads the token from the request and names the delivery", async () => {
		expect(await requireWebhook(request({ "x-jiayang-identity": await hook() }), env, github)).toEqual({
			provider: "github",
			pattern: "/hooks/*",
			delivery: null,
			signedAt: null,
			workspaceId: "0b000000-0000-4000-8000-00000000000a",
		});
	});

	it("refuses a request with no token, whatever else it carries", async () => {
		const bare = request({ "x-jiayang-email": "alice@example.com", "x-github-event": "push", "x-hub-signature-256": "sha256=00" });
		await expect(requireWebhook(bare, env, github)).rejects.toBeInstanceOf(Unauthorized);
	});

	// The same token is a user's no more than a user's token is a webhook.
	it("is refused by requireUser", async () => {
		await expect(requireUser(request({ "x-jiayang-identity": await hook() }), env, github)).rejects.toBeInstanceOf(Unauthorized);
	});

	// Plain JavaScript can leave the provider out. That's a refusal, not a crash and not a pass.
	it("refuses everything when no provider is named, without fetching a key", async () => {
		const token = await hook();
		for (const options of [undefined, {}, { provider: [] }, { provider: undefined }, { provider: 7 }]) {
			const call = verifyWebhook(token, env, { now: NOW, fetch: fetchJwks, ...(options as object) } as WebhookOptions);
			await expect(call, JSON.stringify(options)).rejects.toBeInstanceOf(Unauthorized);
		}
		await expect(verifyWebhook(token, env, undefined as unknown as WebhookOptions)).rejects.toBeInstanceOf(Unauthorized);
		expect(fetches).toBe(0);
	});

	it("takes a list, or one provider on its own", async () => {
		const token = await hook();
		expect((await verifyWebhook(token, env, { ...github, provider: ["stripe", "github"] })).provider).toBe("github");
		expect((await verifyWebhook(token, env, { ...github, provider: "github" })).provider).toBe("github");
	});

	it("refuses when the app isn't configured", async () => {
		const token = await hook();
		for (const missing of ["JIAYANG_APP_ID", "JIAYANG_IDENTITY_ISSUER", "JIAYANG_JWKS_URL"]) {
			await expect(verifyWebhook(token, { ...env, [missing]: undefined }, github), missing).rejects.toBeInstanceOf(Unauthorized);
		}
	});

	it("refuses when the keys can't be fetched", async () => {
		down = true;
		await expect(verifyWebhook(await hook(), env, github)).rejects.toBeInstanceOf(Unauthorized);
	});
});
