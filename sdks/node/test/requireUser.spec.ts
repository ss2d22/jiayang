import { exportJWK, exportSPKI, generateKeyPair, type JWK, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearKeyCache, requireUser, Unauthorized, verifyIdentity, type JiayangEnv } from "../src/index";

// Hostile cases from the tenant side. Only the edge's tokens for this app may pass.

const APP = "0a000000-0000-4000-8000-000000000001";
const OTHER_APP = "0a000000-0000-4000-8000-000000000002";
const env: JiayangEnv = {
	JIAYANG_APP_ID: APP,
	JIAYANG_IDENTITY_ISSUER: "https://edge.example.com",
	JIAYANG_JWKS_URL: "https://edge.example.com/.well-known/jwks.json",
};
const NOW = Date.parse("2026-09-18T12:00:00Z");

type Key = { privateKey: CryptoKey; publicKey: CryptoKey; jwk: JWK };
let edgeKey: Key;
let rotatedKey: Key;
let attackerKey: Key;
let published: JWK[] = [];
let jwksDown = false;
let fetches = 0;

async function key(kid: string): Promise<Key> {
	const pair = await generateKeyPair("RS256", { extractable: true });
	return { ...pair, jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" } };
}

const fetchJwks = async () => {
	fetches++;
	if (jwksDown) throw new TypeError("network down");
	return Response.json({ keys: published });
};

function claims(extra: Record<string, unknown> = {}) {
	const iat = Math.floor(NOW / 1000);
	return {
		iss: env.JIAYANG_IDENTITY_ISSUER,
		aud: APP,
		sub: "access-sub-alice",
		email: "alice@example.com",
		kind: "user",
		role: "editor",
		wid: "0b000000-0000-4000-8000-00000000000a",
		iat,
		exp: iat + 60,
		...extra,
	};
}

async function sign(payload: Record<string, unknown>, with_: Key = edgeKey, kid = String(with_.jwk.kid), alg = "RS256") {
	return new SignJWT(payload).setProtectedHeader({ alg, kid, typ: "JWT" }).sign(with_.privateKey);
}

const verify = (token: string, now = NOW, e: JiayangEnv = env) => verifyIdentity(token, e, { now, fetch: fetchJwks });
const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

beforeAll(async () => {
	edgeKey = await key("identity-k1");
	rotatedKey = await key("identity-k2");
	attackerKey = await key("attacker");
});

beforeEach(() => {
	clearKeyCache();
	published = [edgeKey.jwk];
	jwksDown = false;
	fetches = 0;
});

describe("requireUser", () => {
	it("returns the verified caller", async () => {
		const token = await sign(claims());
		const request = new Request("https://app.example.com/", { headers: { "x-jiayang-identity": token } });
		expect(await requireUser(request, env, { now: NOW, fetch: fetchJwks })).toEqual({
			kind: "user",
			sub: "access-sub-alice",
			email: "alice@example.com",
			role: "editor",
			workspaceId: "0b000000-0000-4000-8000-00000000000a",
		});
	});

	it("returns a service caller with no email", async () => {
		const token = await sign(claims({ kind: "service", sub: "service:bt_ci", email: undefined }));
		expect(await verify(token)).toMatchObject({ kind: "service", sub: "service:bt_ci", email: null });
	});

	it("refuses a request with no token, whatever else it carries", async () => {
		const request = new Request("https://app.example.com/", {
			headers: { "x-jiayang-email": "alice@example.com", "x-jiayang-role": "owner" },
		});
		await expect(requireUser(request, env, { now: NOW, fetch: fetchJwks })).rejects.toBeInstanceOf(Unauthorized);
	});

	it("refuses when the app isn't configured, rather than checking against nothing", async () => {
		const token = await sign(claims());
		for (const missing of ["JIAYANG_APP_ID", "JIAYANG_IDENTITY_ISSUER", "JIAYANG_JWKS_URL"] as const) {
			await expect(verify(token, NOW, { ...env, [missing]: undefined })).rejects.toBeInstanceOf(Unauthorized);
		}
	});
});

describe("hostile tokens", () => {
	const refused = async (token: string, now = NOW) => {
		await expect(verify(token, now)).rejects.toBeInstanceOf(Unauthorized);
	};

	it.each(["", "abc", "a.b", "a.b.c", "a.b.c.d"])("refuses malformed token %j", async (token) => {
		await refused(token);
	});

	it("refuses alg: none", async () => {
		await refused(`${b64(JSON.stringify({ alg: "none", kid: "identity-k1" }))}.${b64(JSON.stringify(claims()))}.`);
	});

	it("refuses HS256 keyed with the public key", async () => {
		const secret = new TextEncoder().encode(await exportSPKI(edgeKey.publicKey));
		const token = await new SignJWT(claims()).setProtectedHeader({ alg: "HS256", kid: "identity-k1" }).sign(secret);
		await refused(token);
	});

	it("refuses a valid signature from the wrong key, under our kid or its own", async () => {
		await refused(await sign(claims(), attackerKey, "identity-k1"));
		await refused(await sign(claims(), attackerKey));
	});

	it("refuses a token minted for another app", async () => {
		await refused(await sign(claims({ aud: OTHER_APP })));
		await refused(await sign(claims({ aud: [OTHER_APP] })));
	});

	it("refuses the wrong issuer", async () => {
		await refused(await sign(claims({ iss: "https://evil.example.com" })));
	});

	it("refuses an expired token, and the same token replayed after expiry", async () => {
		const token = await sign(claims());
		expect(await verify(token)).toBeTruthy();
		await refused(token, NOW + 60_000);
	});

	it("refuses a token not yet valid", async () => {
		await refused(await sign(claims({ nbf: Math.floor(NOW / 1000) + 30 })));
	});

	it.each([
		["no kind", { kind: undefined }],
		["an unknown kind", { kind: "admin" }],
		["a user with no email", { email: undefined }],
		["no role", { role: undefined }],
		["no workspace", { wid: undefined }],
		["an empty sub", { sub: "" }],
	])("refuses a token with %s", async (_, extra) => {
		await refused(await sign(claims(extra)));
	});
});

describe("signing keys", () => {
	it("picks up a rotated key on first sight of its kid", async () => {
		expect(await verify(await sign(claims()))).toBeTruthy();
		published = [rotatedKey.jwk, edgeKey.jwk];
		clearKeyCache();
		expect(await verify(await sign(claims(), rotatedKey))).toBeTruthy();
	});

	it("denies when the JWKS can't be fetched", async () => {
		jwksDown = true;
		await expect(verify(await sign(claims()))).rejects.toBeInstanceOf(Unauthorized);
	});

	// It said "invalid identity token", which sent people looking at the token. Python, Go and
	// Rust say the keys couldn't be fetched, and so does this now, whatever went wrong on the way.
	it("says the keys couldn't be fetched, however the fetch failed", async () => {
		const token = await sign(claims());
		const answers: Array<() => Promise<Response>> = [
			async () => {
				throw new TypeError("network down");
			},
			async () => new Response("error code: 522", { status: 522 }),
			async () => new Response("<html>", { status: 200 }),
			async () => Response.json({ keys: "none" }),
		];
		for (const answer of answers) {
			clearKeyCache();
			await expect(verifyIdentity(token, env, { now: NOW, fetch: answer })).rejects.toThrow("couldn't fetch the identity keys");
		}
		// Keys that came back, just not the one the token names, are a different problem.
		clearKeyCache();
		await expect(verify(await sign(claims(), attackerKey))).rejects.toThrow("invalid identity token");
	});

	it("caches keys between requests", async () => {
		const token = await sign(claims());
		for (let i = 0; i < 5; i++) await verify(token);
		expect(fetches).toBe(1);
	});
});
