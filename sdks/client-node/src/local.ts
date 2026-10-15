// The local platform (`make dev`) answers on names under .localhost, which not every OS resolves.
// fetch can't be told where a name goes, so on Node a request to one is sent with node:http to
// loopback instead, the way the CLI does it.

type NodeHttp = {
	request(
		url: URL,
		options: {
			method: string;
			headers: Record<string, string>;
			lookup: (host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => void;
		},
		callback: (res: NodeResponse) => void,
	): NodeRequest;
};
type NodeResponse = {
	statusCode?: number;
	statusMessage?: string;
	rawHeaders: string[];
	on(event: "data", cb: (chunk: Uint8Array) => void): void;
	on(event: "end" | "error", cb: (err?: unknown) => void): void;
};
type NodeRequest = {
	on(event: "error", cb: (err: unknown) => void): void;
	destroy(err?: unknown): void;
	end(body?: Uint8Array): void;
};

/** Whether a request to `url` should go through `localFetch`: a name under .localhost, on Node. */
export function needsLocalFetch(url: string): boolean {
	const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
	if (!node) return false;
	const host = new URL(url).hostname.toLowerCase();
	return host.endsWith(".localhost");
}

/** fetch, for a .localhost name, over node:http to 127.0.0.1. */
export const localFetch: typeof fetch = async (input, init) => {
	const url = new URL(String(input));
	// Whatever the body is (a FormData included), as bytes and the type that goes with them.
	const prepared = new Request(url, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body ?? null });
	const body = init?.body == null ? undefined : new Uint8Array(await prepared.arrayBuffer());
	const headers: Record<string, string> = {};
	prepared.headers.forEach((value, name) => {
		headers[name] = value;
	});
	if (body) headers["content-length"] = String(body.length);
	const specifier: string = url.protocol === "https:" ? "node:https" : "node:http";
	const lib = (await import(specifier)) as NodeHttp;
	return new Promise<Response>((resolve, reject) => {
		const signal = init?.signal;
		const req = lib.request(
			url,
			{
				method: prepared.method,
				headers,
				lookup: (_host, options, cb) =>
					options?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4),
			},
			(res) => {
				const chunks: Uint8Array[] = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("error", (err) => reject(err));
				res.on("end", () => {
					const out = new Headers();
					for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i] ?? "", res.rawHeaders[i + 1] ?? "");
					const size = chunks.reduce((n, c) => n + c.length, 0);
					const all = new Uint8Array(size);
					let at = 0;
					for (const c of chunks) {
						all.set(c, at);
						at += c.length;
					}
					const status = res.statusCode ?? 0;
					const empty = status === 204 || status === 304 || (status >= 100 && status < 200);
					resolve(new Response(empty ? null : all, { status, statusText: res.statusMessage ?? "", headers: out }));
				});
			},
		);
		req.on("error", (err) => reject(signal?.aborted ? signal.reason : new TypeError("fetch failed", { cause: err })));
		if (signal) {
			if (signal.aborted) req.destroy(signal.reason);
			signal.addEventListener("abort", () => req.destroy(signal.reason), { once: true });
		}
		req.end(body);
	});
};
