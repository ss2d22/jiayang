from __future__ import annotations

import unittest
from typing import Any, Dict

from fake import answer, fake, refusal

from jiayang_client import JiayangError


def entry(n: int) -> Dict[str, Any]:
    return {
        "id": f"00000000-0000-4000-8000-{n:012d}",
        # Microseconds, which the next page needs as they are.
        "at": f"2026-10-07T10:00:00.{1_000_000 - n:06d}Z",
        "source": "edge",
        "action": "request",
        "decision": "allow",
        "reason": None,
        "status": 200,
        "app_id": None,
        "entry": "browser",
        "actor": None,
        "host": None,
        "method": "GET",
        "path": "/",
        "detail": None,
        "ingested_at": "2026-10-07T10:00:01Z",
    }


class AuditLog(unittest.TestCase):
    def test_reads_a_page_asking_for_short_pages_it_can_follow_on_from(self) -> None:
        nxt = "2026-09-01T00:00:00.000001Z,00000000-0000-4000-8000-000000000009"
        jy, seen = fake(
            {
                "GET /v1/workspaces/acme/audit": lambda r: answer(
                    200, [entry(1)], {"jiayang-audit-next": nxt, "jiayang-audit-recent-only": "true"}
                )
            }
        )
        page = jy.audit.list("acme", app="payroll", decision="deny", limit=10)
        self.assertEqual(len(page["entries"]), 1)
        self.assertEqual(page["next"], {"at": "2026-09-01T00:00:00.000001Z", "id": "00000000-0000-4000-8000-000000000009"})
        self.assertTrue(page["recent_only"])
        self.assertEqual(seen.seen[0].headers["jiayang-audit-paging"], "next")
        self.assertEqual(seen.seen[0].query, {"app": ["payroll"], "decision": ["deny"], "limit": ["10"]})

    def test_iterates_back_through_every_page(self) -> None:
        jy, seen = fake(
            {
                "GET /v1/workspaces/acme/audit": [
                    lambda r: answer(200, [entry(1), entry(2)]),
                    lambda r: answer(
                        200, [entry(3)], {"jiayang-audit-next": "2026-01-01T00:00:00.000007Z,00000000-0000-4000-8000-000000000007"}
                    ),
                    lambda r: answer(200, [], {"jiayang-audit-next": "2025-12-01T00:00:00.000008Z,00000000-0000-4000-8000-000000000008"}),
                    lambda r: answer(200, [entry(9)]),
                ]
            }
        )
        got = [e["id"][-2:] for e in jy.audit.iterate("acme", page_size=2)]
        self.assertEqual(got, ["01", "02", "03", "09"])
        asked = [(s.query.get("before", [None])[0], (s.query.get("before_id") or [""])[0][-2:] or None) for s in seen.seen]
        self.assertEqual(
            asked,
            [
                (None, None),
                (entry(2)["at"], "02"),
                ("2026-01-01T00:00:00.000007Z", "07"),
                ("2025-12-01T00:00:00.000008Z", "08"),
            ],
        )

    def test_stops_rather_than_asking_for_the_same_page_forever(self) -> None:
        jy, _ = fake(
            {
                "GET /v1/workspaces/acme/audit": lambda r: answer(
                    200, [], {"jiayang-audit-next": "2026-01-01T00:00:00Z,00000000-0000-4000-8000-000000000001"}
                )
            }
        )
        with self.assertRaises(JiayangError):
            list(jy.audit.iterate("acme"))

    def test_waits_out_the_archive_being_busy(self) -> None:
        jy, _ = fake(
            {
                "GET /v1/workspaces/acme/audit": [
                    lambda r: refusal(503, "audit_archive_busy", headers={"retry-after": "0"}),
                    lambda r: answer(200, [entry(1)]),
                ]
            }
        )
        self.assertEqual(len(jy.audit.list("acme")["entries"]), 1)


if __name__ == "__main__":
    unittest.main()
