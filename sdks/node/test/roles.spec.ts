import { describe, expect, it } from "vitest";
import { Forbidden, hasRole, requireRole, type Role, type User } from "../src/index";

const who = (role: string): User =>
	({ kind: "user", sub: "u1", email: "a@example.com", role, workspaceId: "w1" }) as User;

describe("roles", () => {
	it("an owner can do what an editor can, and an editor what a viewer can", () => {
		const ladder: [string, Role[], Role[]][] = [
			["viewer", ["viewer"], ["editor", "owner"]],
			["editor", ["viewer", "editor"], ["owner"]],
			["owner", ["viewer", "editor", "owner"], []],
		];
		for (const [role, allowed, refused] of ladder) {
			for (const least of allowed) expect(hasRole(who(role), least), `${role} >= ${least}`).toBe(true);
			for (const least of refused) expect(hasRole(who(role), least), `${role} < ${least}`).toBe(false);
		}
	});

	// If the platform ever adds a role, an app built against an older SDK must refuse rather than
	// guess what it allows.
	it("a role this version doesn't know allows nothing", () => {
		for (const unknown of ["superuser", "", "OWNER", "admin"]) {
			expect(hasRole(who(unknown), "viewer"), unknown).toBe(false);
		}
	});

	it("requireRole throws something a handler can answer with", () => {
		expect(() => requireRole(who("owner"), "editor")).not.toThrow();
		try {
			requireRole(who("viewer"), "editor");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(Forbidden);
			expect((err as Forbidden).status).toBe(403);
			expect((err as Forbidden).toResponse().status).toBe(403);
		}
	});

	// The other side of the same rule. Asking for a role that doesn't exist is a typo, and a typo
	// should refuse rather than let everyone through.
	it("asking for a role that doesn't exist allows nobody", () => {
		for (const unknown of ["admin", "", "EDITOR", "superuser"] as Role[]) {
			for (const has of ["viewer", "editor", "owner"]) {
				expect(hasRole(who(has), unknown), `${unknown} let a ${has} through`).toBe(false);
				expect(() => requireRole(who(has), unknown)).toThrow(Forbidden);
			}
		}
	});
});
