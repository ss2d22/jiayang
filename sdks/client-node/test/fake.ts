// A stand-in for the API: answers by method and path, and keeps every request it was sent.

import { Jiayang, type ClientOptions } from "../src/index.js";

export interface Seen {
	method: string;
	url: URL;
	headers: Headers;
	body: string | FormData | Uint8Array | null;
}

export type Handler = (req: Seen, n: number) => Response | Promise<Response>;

export const TOKEN = "jyu_test";

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

export function refusal(status: number, error: string, message = error, headers: Record<string, string> = {}, extra = {}): Response {
	return json(status, { error, message, ...extra }, headers);
}

/** A client whose requests go to `routes`, keyed `METHOD /path`. Waits are zero. */
export function fake(routes: Record<string, Handler | Handler[]>, options: ClientOptions = {}) {
	const seen: Seen[] = [];
	const counts = new Map<string, number>();
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body = (init?.body ?? null) as Seen["body"];
		const req: Seen = { method, url, headers: new Headers(init?.headers), body };
		seen.push(req);
		const key = `${method} ${url.pathname}`;
		const route = routes[key];
		const n = counts.get(key) ?? 0;
		counts.set(key, n + 1);
		if (!route) return refusal(404, "not_found", `nothing at ${key}`);
		const handler = Array.isArray(route) ? (route[Math.min(n, route.length - 1)] as Handler) : route;
		return handler(req, n);
	}) as typeof globalThis.fetch;
	const client = new Jiayang({ token: TOKEN, baseUrl: "https://api.example.com", fetch, ...options });
	client.backoff = () => 0;
	client.polling = { soon: 0, every: 0, soonFor: 0, lookFor: 50, afterDrop: 20 };
	return { client, seen };
}

export function version(number: number, status = "deployed", extra: Record<string, unknown> = {}) {
	return {
		number,
		sha256: "0".repeat(64),
		size_bytes: 10,
		status,
		active: status === "deployed",
		created_by: "ada@example.com",
		created_at: "2026-10-07T10:00:00.123456Z",
		...extra,
	};
}
