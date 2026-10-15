// Writes vectors.json: identity tokens every SDK must accept or refuse, checked by each SDK's tests.
// `valid` and `invalid` are for requireUser, `webhook_valid` and `webhook_invalid` for requireWebhook.
// Run with `node sdks/testdata/generate.mjs`. keys.json holds test-only keys and is reused if present,
// so regenerating only changes the PS256 signatures, which are randomised.

import { constants, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = import.meta.dirname;
const APP = "0a000000-0000-4000-8000-000000000001";
const OTHER_APP = "0a000000-0000-4000-8000-000000000002";
const ISSUER = "https://edge.example.com";
const JWKS_URL = "https://edge.example.com/.well-known/jwks.json";
const NOW = 1_789_819_200; // 2026-09-19T12:00:00Z
const WID = "0b000000-0000-4000-8000-00000000000a";
const VERIFIER = "0c000000-0000-4000-8000-0000000000f1";

const keysFile = path.join(dir, "keys.json");
const keys = existsSync(keysFile) ? JSON.parse(readFileSync(keysFile, "utf8")) : makeKeys();
if (!existsSync(keysFile)) writeFileSync(keysFile, `${JSON.stringify(keys, null, "\t")}\n`);
const priv = Object.fromEntries(Object.entries(keys).map(([name, jwk]) => [name, createPrivateKey({ key: jwk, format: "jwk" })]));

function makeKeys() {
	const make = (bits) => generateKeyPairSync("rsa", { modulusLength: bits }).privateKey.export({ format: "jwk" });
	return { edge: make(2048), rotated: make(2048), attacker: make(2048), small: make(1024) };
}

const b64 = (data) => Buffer.from(data).toString("base64url");
const json = (value) => b64(JSON.stringify(value));

function publicJwk(name, kid, extra = {}) {
	const { kty, n, e } = createPublicKey(priv[name]).export({ format: "jwk" });
	return { kty, kid, alg: "RS256", use: "sig", n, e, ...extra };
}

/** A change of null leaves the claim out. One that has to be there as JSON null says so with this. */
const JSON_NULL = Symbol("null");

function edit(base, changes) {
	const c = { ...base };
	for (const [k, v] of Object.entries(changes)) {
		if (v === null) delete c[k];
		else c[k] = v === JSON_NULL ? null : v;
	}
	return c;
}

function claims(changes = {}) {
	const base = {
		iss: ISSUER,
		aud: APP,
		sub: "access-sub-alice",
		email: "alice@example.com",
		kind: "user",
		role: "editor",
		wid: WID,
		iat: NOW,
		exp: NOW + 60,
	};
	return edit(base, changes);
}

// What the edge mints for a delivery on a verified public path (edge/src/identity.ts): its own
// audience, no role and no email, and delivery and signed_at only where the provider signs them.
function webhookClaims(changes = {}) {
	const base = {
		iss: ISSUER,
		aud: `webhook:${APP}`,
		sub: `webhook:${VERIFIER}`,
		iat: NOW,
		exp: NOW + 60,
		jti: "0d000000-0000-4000-8000-000000000001",
		kind: "webhook",
		wid: WID,
		provider: "stripe",
		pattern: "/hooks/stripe",
		delivery: "evt_1PmT0dLkdIwHu7ix5nR2cWq8",
		signed_at: NOW - 2,
	};
	return edit(base, changes);
}

const RSA = {
	RS256: { hash: "sha256" },
	RS384: { hash: "sha384" },
	RS512: { hash: "sha512" },
	PS256: { hash: "sha256", pss: true },
};

/** Signs claims, or a payload already written as JSON text when it has to be spelled a certain way. */
function signed(body, { key = "edge", kid = "identity-k1", alg = "RS256", header = {} } = {}) {
	const head = { alg, typ: "JWT", ...(kid === null ? {} : { kid }), ...header };
	const input = `${json(head)}.${typeof body === "string" ? b64(body) : json(body)}`;
	const { hash, pss } = RSA[alg];
	const options = pss ? { key: priv[key], padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : priv[key];
	return `${input}.${b64(sign(hash, Buffer.from(input), options))}`;
}

const good = (changes) => signed(claims(changes));
const WEBHOOK_HEADER = { header: { typ: "webhook+jwt" } };
const hook = (changes) => signed(webhookClaims(changes), WEBHOOK_HEADER);

const edgeJwks = { keys: [publicJwk("edge", "identity-k1")] };

// What the edge mints for a workspace's agent (edge/src/identity.ts): a service, so every SDK
// takes it, with `sub` saying it's an agent and `agent_name` who.
const AGENT = "agent:ag_0123456789abcdef";
const agent = (changes = {}) => good({ kind: "service", sub: AGENT, email: null, agent_name: "release-bot", ...changes });
const person = { kind: "user", sub: "access-sub-alice", email: "alice@example.com", role: "editor", workspace_id: WID, agent_name: null };

const valid = [
	{ name: "a person", token: good(), user: person },
	{
		name: "a bypass token, whose email is ignored",
		token: good({ kind: "service", sub: "service:bt_ci", email: "ignored@example.com", role: "viewer" }),
		user: { kind: "service", sub: "service:bt_ci", email: null, role: "viewer", workspace_id: WID, agent_name: null },
	},
	{ name: "one second before expiry", token: good(), now: NOW + 59, user: person },
	{
		name: "an agent, by name",
		token: agent(),
		user: { kind: "service", sub: AGENT, email: null, role: "editor", workspace_id: WID, agent_name: "release-bot" },
	},
	{
		name: "an agent whose name has spaces and accents",
		token: agent({ agent_name: "Nightly réport bot", role: "viewer" }),
		user: { kind: "service", sub: AGENT, email: null, role: "viewer", workspace_id: WID, agent_name: "Nightly réport bot" },
	},
	{
		name: "a scheduled job, which is no agent",
		token: good({ kind: "service", sub: "scheduler:0e000000-0000-4000-8000-000000000001", email: null }),
		user: { kind: "service", sub: "scheduler:0e000000-0000-4000-8000-000000000001", email: null, role: "editor", workspace_id: WID, agent_name: null },
	},
	// Only an agent's token names one. Anywhere else the claim says nothing, as a bypass token's
	// email says nothing.
	{
		name: "a bypass token carrying an agent name, ignored",
		token: good({ kind: "service", sub: "service:bt_ci", email: null, agent_name: "release-bot" }),
		user: { kind: "service", sub: "service:bt_ci", email: null, role: "editor", workspace_id: WID, agent_name: null },
	},
	{ name: "a person carrying an agent name, ignored", token: good({ agent_name: "release-bot" }), user: person },
];

const body = claims();
const spki = createPublicKey(priv.edge).export({ format: "pem", type: "spki" });
const hsInput = `${json({ alg: "HS256", typ: "JWT", kid: "identity-k1" })}.${json(body)}`;
const tampered = good().split(".");

const invalid = [
	...["", "abc", "a.b", "a.b.c", "a.b.c.d", "..."].map((token) => ({ name: `malformed ${JSON.stringify(token)}`, token })),
	{ name: "alg none", token: `${json({ alg: "none", kid: "identity-k1" })}.${json(body)}.` },
	{ name: "alg none with typ", token: `${json({ alg: "none", typ: "JWT", kid: "identity-k1" })}.${json(body)}.` },
	{ name: "HS256 keyed with our public key", token: `${hsInput}.${b64(createHmac("sha256", spki).update(hsInput).digest())}` },
	...["RS384", "RS512", "PS256"].map((alg) => ({ name: `${alg} with our key`, token: signed(body, { alg }) })),
	{ name: "the wrong key under our kid", token: signed(body, { key: "attacker" }) },
	{ name: "the wrong key under its own kid", token: signed(body, { key: "attacker", kid: "attacker" }) },
	{ name: "no kid", token: signed(body, { kid: null }) },
	{ name: "a signature from a different token", token: `${tampered[0]}.${json(claims({ role: "owner" }))}.${tampered[2]}` },
	{ name: "a corrupted signature", token: `${tampered[0]}.${tampered[1]}.${tampered[2].slice(0, -4)}AAAA` },
	{ name: "expired", token: good(), now: NOW + 60 },
	{ name: "replayed an hour later", token: good(), now: NOW + 3600 },
	...Object.entries({
		"another app's audience": { aud: OTHER_APP },
		"another app in a list": { aud: [OTHER_APP] },
		"the wrong issuer": { iss: "https://evil.example.com" },
		"not yet valid": { nbf: NOW + 30 },
		"no exp": { exp: null },
		"no iat": { iat: null },
		"no aud": { aud: null },
		"no iss": { iss: null },
		"exp as a string": { exp: String(NOW + 60) },
		"exp as a bool": { exp: true },
		"no kind": { kind: null },
		"an unknown kind": { kind: "admin" },
		"a kind that isn't a string": { kind: 1 },
		"a kind in another case": { kind: null, Kind: "user" },
		"a user with no email": { email: null },
		"no role": { role: null },
		"no workspace": { wid: null },
		"an empty sub": { sub: "" },
		"a numeric sub": { sub: 42 },
		"a second exp in capitals": { EXP: NOW + 3600 },
		"an agent_name claim in another case": { Agent_Name: "release-bot" },
	}).map(([name, changes]) => ({ name, token: good(changes) })),
	// An agent's token always says who: one that doesn't is refused, as a person's with no email is.
	...Object.entries({
		"an agent with no name": { agent_name: null },
		"an agent with an empty name": { agent_name: "" },
		"an agent whose name isn't a string": { agent_name: 7 },
		"an agent whose name is null": { agent_name: JSON_NULL },
		"an agent with no id": { sub: "agent:" },
		"an agent name in another case": { agent_name: null, Agent_Name: "release-bot" },
	}).map(([name, changes]) => ({ name, token: agent(changes) })),
	{
		name: "our key marked for encryption",
		token: good(),
		jwks: { keys: [publicJwk("edge", "identity-k1", { use: "enc" })] },
	},
	{
		name: "a key published for another algorithm",
		token: signed(body, { key: "rotated", kid: "identity-k2" }),
		jwks: { keys: [publicJwk("rotated", "identity-k2", { alg: "RS512" })] },
	},
	{
		name: "a 1024-bit key",
		token: signed(body, { key: "small", kid: "small" }),
		jwks: { keys: [publicJwk("small", "small")] },
	},
	{
		name: "a symmetric key in the key set",
		token: `${json({ alg: "HS256", typ: "JWT", kid: "hmac" })}.${json(body)}.${b64(createHmac("sha256", "secret").update(`${json({ alg: "HS256", typ: "JWT", kid: "hmac" })}.${json(body)}`).digest())}`,
		jwks: { keys: [{ kty: "oct", kid: "hmac", k: b64("secret") }] },
	},
	// A webhook is nobody, whatever else it carries: refused on its audience, and on its kind when
	// the audience is the app's.
	{ name: "a webhook token", token: hook() },
	{ name: "a webhook token that also carries role and email", token: hook({ role: "owner", email: "alice@example.com" }) },
	{ name: "a webhook kind addressed to the app, with role and email", token: hook({ aud: APP, role: "owner", email: "alice@example.com" }) },
];

// ---- webhooks ---------------------------------------------------------------------------------

const stripe = { provider: "stripe", pattern: "/hooks/stripe", delivery: "evt_1PmT0dLkdIwHu7ix5nR2cWq8", signed_at: NOW - 2, workspace_id: WID };
const unsigned = (provider, pattern) => ({
	token: hook({ provider, pattern, delivery: null, signed_at: null }),
	webhook: { provider, pattern, delivery: null, signed_at: null, workspace_id: WID },
});

const webhookValid = [
	{ name: "a stripe delivery, with its id and signed time", token: hook(), providers: ["stripe"], webhook: stripe },
	{ name: "a github delivery, which signs neither", providers: ["github"], ...unsigned("github", "/hooks/github") },
	{ name: "a shopify delivery, which signs neither", providers: ["shopify"], ...unsigned("shopify", "/hooks/shopify") },
	{
		name: "a slack event",
		token: hook({ provider: "slack", pattern: "/hooks/slack", delivery: "Ev08MFMKH6J2", signed_at: NOW - 5 }),
		providers: ["slack"],
		webhook: { provider: "slack", pattern: "/hooks/slack", delivery: "Ev08MFMKH6J2", signed_at: NOW - 5, workspace_id: WID },
	},
	{
		name: "a standard webhooks message",
		token: hook({ provider: "standard_webhooks", pattern: "/hooks/resend", delivery: "msg_2mXf0bOTLwBzCbhVeEBU2t8m1Jn", signed_at: NOW }),
		providers: ["standard_webhooks"],
		webhook: { provider: "standard_webhooks", pattern: "/hooks/resend", delivery: "msg_2mXf0bOTLwBzCbhVeEBU2t8m1Jn", signed_at: NOW, workspace_id: WID },
	},
	{ name: "a list of two holding the token's provider", token: hook(), providers: ["github", "stripe"], webhook: stripe },
	{ name: "one second before expiry", token: hook(), providers: ["stripe"], now: NOW + 59, webhook: stripe },
	{ name: "a prefix pattern", providers: ["hmac_sha256"], ...unsigned("hmac_sha256", "/hooks/*") },
	{ name: "a claim it doesn't know, ignored", token: hook({ attempt: 3 }), providers: ["stripe"], webhook: stripe },
	// JSON has one number type, so an SDK that can tell 5.0 from 5 must not refuse what one that
	// can't would take.
	{
		name: "signed_at spelled with a fraction of zero",
		token: signed(spelled(JSON.stringify(webhookClaims()), `"signed_at":${NOW - 2}`, `"signed_at":${NOW - 2}.0`), WEBHOOK_HEADER),
		providers: ["stripe"],
		webhook: stripe,
	},
];

/** JSON text with one spelling changed, which JSON.stringify can't be asked for. */
function spelled(text, from, to) {
	if (!text.includes(from)) throw new Error(`${from} isn't in ${text}`);
	return text.replace(from, to);
}

const webhookBody = webhookClaims();
const hsWebhook = `${json({ alg: "HS256", typ: "webhook+jwt", kid: "identity-k1" })}.${json(webhookBody)}`;

const webhookInvalid = [
	{ name: "a person's token", token: good(), providers: ["stripe"] },
	{ name: "a service token", token: good({ kind: "service", sub: "service:bt_ci", email: null }), providers: ["stripe"] },
	{ name: "a person's token addressed to webhooks", token: good({ aud: `webhook:${APP}` }), providers: ["stripe"] },
	{ name: "a provider not in the list", token: hook(), providers: ["github"] },
	{ name: "an empty list", token: hook(), providers: [] },
	{ name: "a provider this SDK doesn't know, listed", token: hook({ provider: "paddle" }), providers: ["paddle"] },
	{ name: "the provider named in another case", token: hook(), providers: ["Stripe"] },
	{ name: "the provider's name in another case", token: hook({ provider: "Stripe" }), providers: ["stripe"] },
	{ name: "expired", token: hook(), providers: ["stripe"], now: NOW + 60 },
	{ name: "replayed an hour later", token: hook(), providers: ["stripe"], now: NOW + 3600 },
	...Object.entries({
		"no kind": { kind: null },
		"an unknown kind": { kind: "hook" },
		"a kind of Webhook": { kind: "Webhook" },
		"a kind in another case": { kind: null, Kind: "webhook" },
		"the bare app id as audience": { aud: APP },
		"the audience in a list": { aud: [`webhook:${APP}`] },
		"another app's webhook audience": { aud: `webhook:${OTHER_APP}` },
		"no aud": { aud: null },
		"the wrong issuer": { iss: "https://evil.example.com" },
		"not yet valid": { nbf: NOW + 30 },
		"no sub": { sub: null },
		"an empty sub": { sub: "" },
		"no provider": { provider: null },
		"a provider that isn't a string": { provider: 1 },
		"a provider in a list": { provider: ["stripe"] },
		"no pattern": { pattern: null },
		"an empty pattern": { pattern: "" },
		"a pattern that isn't a string": { pattern: 1 },
		"an empty delivery": { delivery: "" },
		"a numeric delivery": { delivery: 12345 },
		"a null delivery": { delivery: JSON_NULL },
		"signed_at as a string": { signed_at: String(NOW - 2) },
		"signed_at as a bool": { signed_at: true },
		"a negative signed_at": { signed_at: -1 },
		"a fractional signed_at": { signed_at: NOW - 2.5 },
		"a null signed_at": { signed_at: JSON_NULL },
		"signed_at past the largest exact integer": { signed_at: 2 ** 53 },
		"no workspace": { wid: null },
		"a workspace that isn't a string": { wid: 7 },
		"a second provider claim in capitals": { Provider: "github" },
		"a second pattern claim in another case": { Pattern: "/hooks/*" },
		"a second delivery claim in another case": { DELIVERY: "evt_other" },
		"a second signed_at claim in another case": { Signed_At: NOW },
	}).map(([name, changes]) => ({ name, token: hook(changes), providers: ["stripe"] })),
	{ name: "the wrong key under our kid", token: signed(webhookBody, { key: "attacker", ...WEBHOOK_HEADER }), providers: ["stripe"] },
	{ name: "no kid", token: signed(webhookBody, { kid: null, ...WEBHOOK_HEADER }), providers: ["stripe"] },
	{ name: "alg none", token: `${json({ alg: "none", typ: "webhook+jwt", kid: "identity-k1" })}.${json(webhookBody)}.`, providers: ["stripe"] },
	{ name: "HS256 keyed with our public key", token: `${hsWebhook}.${b64(createHmac("sha256", spki).update(hsWebhook).digest())}`, providers: ["stripe"] },
];

// Where tokens may come from. The platform's issuer and key set are always https. Only `jiayang dev`
// uses http, on this machine, and an SDK takes that only when JIAYANG_DEV is exactly "1". `dev` is
// JIAYANG_DEV's value, or null for unset.
const DEV_ISSUER = "http://127.0.0.1:8787";
const DEV_JWKS = "http://127.0.0.1:8787/.jiayang/jwks.json";
const origin = (name, ok, issuer, jwksUrl, dev) => ({ name, ok, issuer, jwks_url: jwksUrl, dev });
const origins = [
	origin("the platform's", true, ISSUER, JWKS_URL, null),
	origin("the platform's, with JIAYANG_DEV set", true, ISSUER, JWKS_URL, "1"),
	origin("the platform's, spelled in capitals", true, "HTTPS://edge.example.com", "HTTPS://edge.example.com/.well-known/jwks.json", null),
	origin("jiayang dev's, with JIAYANG_DEV=1", true, DEV_ISSUER, DEV_JWKS, "1"),
	origin("jiayang dev's on localhost", true, "http://localhost:8787", "http://localhost:8787/.jiayang/jwks.json", "1"),
	origin("jiayang dev's on LOCALHOST", true, "http://LOCALHOST:8787", "http://LOCALHOST:8787/.jiayang/jwks.json", "1"),
	origin("jiayang dev's on [::1]", true, "http://[::1]:8787", "http://[::1]:8787/.jiayang/jwks.json", "1"),
	origin("jiayang dev's, keys fetched from a Docker container", true, DEV_ISSUER, "http://host.docker.internal:8787/.jiayang/jwks.json", "1"),
	origin("jiayang dev's without JIAYANG_DEV", false, DEV_ISSUER, DEV_JWKS, null),
	origin("jiayang dev's with JIAYANG_DEV empty", false, DEV_ISSUER, DEV_JWKS, ""),
	origin("jiayang dev's with JIAYANG_DEV=0", false, DEV_ISSUER, DEV_JWKS, "0"),
	origin("jiayang dev's with JIAYANG_DEV=true", false, DEV_ISSUER, DEV_JWKS, "true"),
	origin("jiayang dev's with JIAYANG_DEV padded", false, DEV_ISSUER, DEV_JWKS, " 1"),
	origin("our issuer with keys over http here", false, ISSUER, DEV_JWKS, "1"),
	origin("our issuer with keys over http here, without JIAYANG_DEV", false, ISSUER, DEV_JWKS, null),
	origin("an http issuer elsewhere", false, "http://edge.example.com", "http://edge.example.com/.well-known/jwks.json", "1"),
	origin("an http issuer here with keys from elsewhere", false, DEV_ISSUER, JWKS_URL, "1"),
	origin("an http issuer at the Docker host", false, "http://host.docker.internal:8787", DEV_JWKS, "1"),
	origin("an issuer whose name only starts like ours", false, "http://127.0.0.1.evil.test:8787", DEV_JWKS, "1"),
	origin("an issuer on a name ending in localhost elsewhere", false, "http://localhost.evil.test:8787", DEV_JWKS, "1"),
	origin("an issuer with a user before the host", false, "http://127.0.0.1:8787@evil.test", DEV_JWKS, "1"),
	origin("keys with a user before the host", false, DEV_ISSUER, "http://127.0.0.1:8787@evil.test/.jiayang/jwks.json", "1"),
	origin("keys with a backslash before the host", false, DEV_ISSUER, "http://127.0.0.1:8787\\@evil.test/.jiayang/jwks.json", "1"),
	origin("keys at a name that only starts like Docker's", false, DEV_ISSUER, "http://host.docker.internal.evil.test/.jiayang/jwks.json", "1"),
	origin("a scheme that isn't http", false, "ws://127.0.0.1:8787", "ws://127.0.0.1:8787/.jiayang/jwks.json", "1"),
	origin("every address", false, "http://0.0.0.0:8787", "http://0.0.0.0:8787/.jiayang/jwks.json", "1"),
	origin("a port out of range", false, "http://127.0.0.1:99999", "http://127.0.0.1:99999/.jiayang/jwks.json", "1"),
	origin("keys on a port out of range", false, DEV_ISSUER, "http://127.0.0.1:99999/.jiayang/jwks.json", "1"),
	// Other spellings of this machine. Some URL parsers read them as 127.0.0.1 and some don't, so
	// every SDK refuses them and all four agree.
	origin("127.0.0.1 shortened to 127.1", false, "http://127.1:8787", "http://127.1:8787/.jiayang/jwks.json", "1"),
	origin("127.0.0.1 as one hex number", false, "http://0x7f000001:8787", "http://0x7f000001:8787/.jiayang/jwks.json", "1"),
	origin("127.0.0.1 as one decimal number", false, "http://2130706433:8787", "http://2130706433:8787/.jiayang/jwks.json", "1"),
	origin("127.0.0.1 with an octal part", false, "http://0177.0.0.1:8787", "http://0177.0.0.1:8787/.jiayang/jwks.json", "1"),
	origin("[::1] written out in full", false, "http://[0:0:0:0:0:0:0:1]:8787", "http://[0:0:0:0:0:0:0:1]:8787/.jiayang/jwks.json", "1"),
	origin("keys at 127.1", false, DEV_ISSUER, "http://127.1:8787/.jiayang/jwks.json", "1"),
];

// A token as `jiayang dev` mints it. Signed with the same test key, so the only thing between it and
// a caller is where the SDK was told tokens come from.
const devToken = signed(claims({ iss: DEV_ISSUER, sub: "dev:you@example.com", email: "you@example.com", role: "owner" }));

const vectors = {
	comment:
		"Generated by generate.mjs. Every SDK must accept exactly the valid cases, with this user, and the webhook_valid cases, with this webhook, given these providers. It must take exactly the origins marked ok, and the dev token only under a dev origin it takes.",
	config: { app_id: APP, issuer: ISSUER, jwks_url: JWKS_URL },
	now: NOW,
	jwks: edgeJwks,
	valid,
	invalid,
	webhook_valid: webhookValid,
	webhook_invalid: webhookInvalid,
	origins,
	dev: {
		issuer: DEV_ISSUER,
		jwks_url: DEV_JWKS,
		token: devToken,
		user: { kind: "user", sub: "dev:you@example.com", email: "you@example.com", role: "owner", workspace_id: WID, agent_name: null },
	},
};
writeFileSync(path.join(dir, "vectors.json"), `${JSON.stringify(vectors, null, "\t")}\n`);
console.log(`${valid.length} valid, ${invalid.length} invalid, ${webhookValid.length} webhook valid, ${webhookInvalid.length} webhook invalid`);
