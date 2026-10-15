import { describe, expect, it } from "vitest";
import { JiayangError, type AuditEntry } from "../src/index.js";
import { fake, json, refusal } from "./fake.js";

const entry = (n: number): AuditEntry => ({
	id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
	// Microseconds, which a Date would lose and the next page needs.
	at: `2026-10-07T10:00:00.${String(1_000_000 - n).padStart(6, "0")}Z`,
	source: "edge",
	action: "request",
	decision: "allow",
	reason: null,
	status: 200,
	app_id: null,
	entry: "browser",
	actor: null,
	host: null,
	method: "GET",
	path: "/",
	detail: null,
	ingested_at: "2026-10-07T10:00:01Z",
});

describe("the audit log", () => {
	it("reads a page, asking for short pages it can follow on from", async () => {
		const { client, seen } = fake({
			"GET /v1/workspaces/acme/audit": () =>
				json(200, [entry(1)], { "jiayang-audit-next": "2026-09-01T00:00:00.000001Z,00000000-0000-4000-8000-000000000009", "jiayang-audit-recent-only": "true" }),
		});
		const page = await client.audit.list("acme", { app: "payroll", decision: "deny", limit: 10 });
		expect(page.entries).toHaveLength(1);
		expect(page.next).toEqual({ at: "2026-09-01T00:00:00.000001Z", id: "00000000-0000-4000-8000-000000000009" });
		expect(page.recent_only).toBe(true);
		const req = seen[0];
		expect(req?.headers.get("jiayang-audit-paging")).toBe("next");
		expect(Object.fromEntries(req?.url.searchParams ?? [])).toEqual({ app: "payroll", decision: "deny", limit: "10" });
	});

	it("iterates back through every page, by the last entry or where the platform says", async () => {
		const pages = [
			() => json(200, [entry(1), entry(2)]),
			// Short, from deep in the archive, with more behind it.
			() => json(200, [entry(3)], { "jiayang-audit-next": "2026-01-01T00:00:00.000007Z,00000000-0000-4000-8000-000000000007" }),
			() => json(200, [], { "jiayang-audit-next": "2025-12-01T00:00:00.000008Z,00000000-0000-4000-8000-000000000008" }),
			() => json(200, [entry(9)]),
		];
		const { client, seen } = fake({ "GET /v1/workspaces/acme/audit": pages });
		const got: string[] = [];
		for await (const e of client.audit.iterate("acme", { page_size: 2 })) got.push(e.id.slice(-2));
		expect(got).toEqual(["01", "02", "03", "09"]);
		const asked = seen.map((r) => [r.url.searchParams.get("before"), r.url.searchParams.get("before_id")?.slice(-2) ?? null]);
		expect(asked).toEqual([
			[null, null],
			[entry(2).at, "02"],
			["2026-01-01T00:00:00.000007Z", "07"],
			["2025-12-01T00:00:00.000008Z", "08"],
		]);
	});

	it("stops rather than asking for the same page forever", async () => {
		const { client } = fake({
			"GET /v1/workspaces/acme/audit": () => json(200, [], { "jiayang-audit-next": "2026-01-01T00:00:00Z,00000000-0000-4000-8000-000000000001" }),
		});
		const reading = (async () => {
			for await (const _ of client.audit.iterate("acme")) void _;
		})();
		await expect(reading).rejects.toThrow(JiayangError);
	});

	it("waits out the archive being busy", async () => {
		const { client } = fake({
			"GET /v1/workspaces/acme/audit": [() => refusal(503, "audit_archive_busy", "Busy.", { "retry-after": "0" }), () => json(200, [entry(1)])],
		});
		expect((await client.audit.list("acme")).entries).toHaveLength(1);
	});
});
