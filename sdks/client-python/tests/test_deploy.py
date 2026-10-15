from __future__ import annotations

import base64
import hashlib
import json
import unittest
from pathlib import Path
from typing import List

from fake import answer, fake, refusal, version

from jiayang_client import ConflictError, DeployFailedError, JiayangError, RequestTimeoutError, Response
from jiayang_client._deploy import CONTENT_TYPES, content_type, module_type, site_version_hash, worker_version_hash

BASE = "/v1/workspaces/acme/apps/hello"
SOURCE = "export default { fetch() { return new Response('hi') } }"
WORKER = {"main_module": "index.js", "compatibility_date": "2026-09-01", "modules": {"index.js": {"content": SOURCE}}}
OURS = worker_version_hash({"index.js": ("esm", SOURCE.encode())}, [], None)


class Worker(unittest.TestCase):
    def test_sends_its_modules_in_base64_typed_by_name(self) -> None:
        jy, seen = fake({f"GET {BASE}/versions": lambda r: answer(200, [version(1)]), f"POST {BASE}/versions": lambda r: answer(201, version(2))})
        wasm = b"\x00asm"
        live = jy.deploy.worker(
            "acme",
            "hello",
            main_module="index.js",
            compatibility_date="2026-09-01",
            compatibility_flags=["nodejs_compat"],
            modules={"index.js": {"content": SOURCE}, "add.wasm": {"content": wasm}, "page.html": {"content": "<p>"}, "b.bin": {"content": bytearray(wasm)}},
        )
        self.assertEqual(live["number"], 2)
        sent = next(s for s in seen.seen if s.method == "POST")
        self.assertEqual(sent.headers["content-type"], "application/json")
        self.assertEqual(sent.headers["prefer"], "respond-async")
        self.assertEqual(
            sent.json(),
            {
                "main_module": "index.js",
                "compatibility_date": "2026-09-01",
                "compatibility_flags": ["nodejs_compat"],
                "modules": {
                    "index.js": {"type": "esm", "b64": base64.b64encode(SOURCE.encode()).decode()},
                    "add.wasm": {"type": "wasm", "b64": "AGFzbQ=="},
                    "page.html": {"type": "text", "b64": "PHA+"},
                    "b.bin": {"type": "data", "b64": "AGFzbQ=="},
                },
            },
        )

    # Review: a bundle couldn't ask for key-value storage or a queue, so a first deploy went up
    # with neither and env.KV was undefined.
    def test_asks_for_key_value_storage_and_a_queue_as_jiayang_json_would(self) -> None:
        jy, seen = fake({f"GET {BASE}/versions": lambda r: answer(200, []), f"POST {BASE}/versions": lambda r: answer(201, version(1))})
        jy.deploy.worker("acme", "hello", kv=True, queue="/jobs/queue", **WORKER)
        sent = next(s for s in seen.seen if s.method == "POST").json()
        self.assertEqual((sent["kv"], sent["queue"]), (True, {"path": "/jobs/queue"}))
        jy, seen = fake({f"GET {BASE}/versions": lambda r: answer(200, []), f"POST {BASE}/versions": lambda r: answer(201, version(1))})
        jy.deploy.worker("acme", "hello", **WORKER)
        sent = next(s for s in seen.seen if s.method == "POST").json()
        self.assertNotIn("kv", sent)
        self.assertNotIn("queue", sent)

    def test_refuses_a_main_module_that_isnt_among_the_modules(self) -> None:
        jy, seen = fake({})
        with self.assertRaisesRegex(JiayangError, "main.js"):
            jy.deploy.worker("acme", "hello", **{**WORKER, "main_module": "main.js"})
        self.assertEqual(seen.seen, [])

    def test_puts_a_preview_up(self) -> None:
        made = version(1, active=False, preview={"url": "https://p", "until": "x", "live": True})
        jy, seen = fake({f"GET {BASE}/versions": lambda r: answer(200, []), f"POST {BASE}/versions": lambda r: answer(201, made)})
        self.assertTrue(jy.deploy.worker("acme", "hello", preview=True, **WORKER)["preview"]["live"])
        self.assertEqual(next(s for s in seen.seen if s.method == "POST").query, {"preview": ["true"]})


class Following(unittest.TestCase):
    def test_waits_for_a_version_on_its_way_and_returns_it_once_its_live(self) -> None:
        progress: List[str] = []
        jy, _ = fake(
            {
                f"GET {BASE}/versions": [
                    lambda r: answer(200, [version(1)]),
                    lambda r: answer(200, [version(2, "uploaded"), version(1)]),
                    lambda r: answer(200, [version(2), version(1, active=False)]),
                ],
                f"POST {BASE}/versions": lambda r: answer(202, version(2, "uploaded")),
            }
        )
        live = jy.deploy.worker("acme", "hello", on_progress=progress.append, **WORKER)
        self.assertEqual((live["number"], live["status"], live["active"]), (2, "deployed", True))
        self.assertIn("Version 2 is going live ...", progress)

    def test_returns_at_once_without_waiting(self) -> None:
        jy, _ = fake({f"GET {BASE}/versions": lambda r: answer(200, []), f"POST {BASE}/versions": lambda r: answer(202, version(1, "uploaded"))})
        self.assertEqual(jy.deploy.worker("acme", "hello", wait=False, **WORKER)["status"], "uploaded")

    def test_raises_deploy_failed_with_the_platforms_reason(self) -> None:
        failed = version(1, "failed", failure="Cloudflare refused the app's code: boom")
        jy, _ = fake(
            {
                f"GET {BASE}/versions": [lambda r: answer(200, []), lambda r: answer(200, [failed])],
                f"POST {BASE}/versions": lambda r: answer(202, version(1, "uploaded")),
            }
        )
        with self.assertRaises(DeployFailedError) as caught:
            jy.deploy.worker("acme", "hello", **WORKER)
        self.assertEqual(str(caught.exception), "Cloudflare refused the app's code: boom")
        self.assertEqual(caught.exception.version["number"], 1)

    def test_waits_its_turn_behind_another_version_then_deploys(self) -> None:
        jy, seen = fake(
            {
                f"GET {BASE}/versions": [
                    lambda r: answer(200, [version(2, "uploaded"), version(1)]),
                    lambda r: answer(200, [version(2, "uploaded"), version(1)]),
                    lambda r: answer(200, [version(2), version(1)]),
                    lambda r: answer(200, [version(2)]),
                ],
                f"POST {BASE}/versions": [lambda r: refusal(409, "version_going_live"), lambda r: answer(201, version(3))],
            }
        )
        self.assertEqual(jy.deploy.worker("acme", "hello", **WORKER)["number"], 3)
        self.assertEqual(len([s for s in seen.seen if s.method == "POST"]), 2)

    def test_gives_up_waiting_its_turn_after_wait_timeout(self) -> None:
        jy, _ = fake(
            {
                f"GET {BASE}/versions": lambda r: answer(200, [version(2, "uploaded")]),
                f"POST {BASE}/versions": lambda r: refusal(409, "version_going_live"),
            }
        )
        with self.assertRaises(ConflictError):
            jy.deploy.worker("acme", "hello", wait_timeout=0.02, **WORKER)

    def test_looks_for_the_version_when_the_answer_never_came(self) -> None:
        jy, seen = fake(
            {
                f"GET {BASE}/versions": [
                    lambda r: answer(200, [version(1)]),
                    lambda r: answer(200, [version(1)]),
                    lambda r: answer(200, [version(2, sha256=OURS), version(1)]),
                ],
                f"POST {BASE}/versions": lambda r: Response(504, {}, b"gateway timeout", "Gateway Timeout"),
            }
        )
        self.assertEqual(jy.deploy.worker("acme", "hello", **WORKER)["number"], 2)
        self.assertEqual(len([s for s in seen.seen if s.method == "POST"]), 1)

    def test_doesnt_take_a_teammates_version_for_its_own(self) -> None:
        theirs = {"sha256": "f" * 64, "created_by": "bob@example.com"}
        timeout = lambda r: Response(504, {}, b"gateway timeout", "Gateway Timeout")  # noqa: E731
        jy, _ = fake(
            {
                f"GET {BASE}/versions": [
                    lambda r: answer(200, [version(1)]),
                    lambda r: answer(200, [version(2, **theirs), version(1)]),
                    lambda r: answer(200, [version(3, sha256=OURS), version(2, **theirs), version(1)]),
                ],
                f"POST {BASE}/versions": timeout,
            }
        )
        self.assertEqual(jy.deploy.worker("acme", "hello", **WORKER)["number"], 3)
        jy, _ = fake(
            {
                f"GET {BASE}/versions": [
                    lambda r: answer(200, [version(1)]),
                    lambda r: answer(200, [version(2, **theirs), version(1)]),
                ],
                f"POST {BASE}/versions": timeout,
            }
        )
        with self.assertRaises(JiayangError):
            jy.deploy.worker("acme", "hello", **WORKER)

    def test_waits_out_a_429_and_sends_again_only_if_it_wasnt_made(self) -> None:
        slow = lambda r: refusal(429, "rate_limited", headers={"retry-after": "0"})  # noqa: E731
        jy, seen = fake(
            {
                f"GET {BASE}/versions": lambda r: answer(200, [version(1)]),
                f"POST {BASE}/versions": [slow, lambda r: answer(201, version(2, sha256=OURS))],
            }
        )
        self.assertEqual(jy.deploy.worker("acme", "hello", **WORKER)["number"], 2)
        self.assertEqual(len([s for s in seen.seen if s.method == "POST"]), 2)
        jy, seen = fake(
            {
                f"GET {BASE}/versions": [
                    lambda r: answer(200, [version(1)]),
                    lambda r: answer(200, [version(2, sha256=OURS), version(1)]),
                ],
                f"POST {BASE}/versions": slow,
            }
        )
        self.assertEqual(jy.deploy.worker("acme", "hello", **WORKER)["number"], 2)
        self.assertEqual(len([s for s in seen.seen if s.method == "POST"]), 1)

    def test_raises_the_original_failure_when_no_version_turns_up(self) -> None:
        def times_out(r):  # type: ignore[no-untyped-def]
            raise RequestTimeoutError("The API didn't answer in time.")

        jy, _ = fake({f"GET {BASE}/versions": lambda r: answer(200, [version(1)]), f"POST {BASE}/versions": times_out})
        with self.assertRaises(RequestTimeoutError):
            jy.deploy.worker("acme", "hello", **WORKER)


class Site(unittest.TestCase):
    def test_uploads_only_whats_missing_small_files_together_and_a_big_one_alone(self) -> None:
        big = b"\x07" * (4 * 1024 * 1024)
        big_sha = hashlib.sha256(big).hexdigest()
        jy, seen = fake(
            {
                f"GET {BASE}/versions": lambda r: answer(200, []),
                f"POST {BASE}/blobs/missing": lambda r: answer(200, {"missing": r.json()["sha256"]}),
                f"POST {BASE}/blobs": lambda r: Response(204),
                f"PUT {BASE}/blobs/{big_sha}": lambda r: Response(204),
                f"POST {BASE}/site": lambda r: answer(201, version(1)),
            }
        )
        jy.deploy.site(
            "acme",
            "hello",
            [
                {"path": "index.html", "content": "<h1>hi</h1>"},
                {"path": "/app.css", "content": "h1{}"},
                {"path": "/copy.css", "content": "h1{}"},
                {"path": "/big.bin", "content": big},
            ],
            not_found_handling="404-page",
        )
        batch = next(s for s in seen.seen if s.method == "POST" and s.path == f"{BASE}/blobs")
        boundary = batch.headers["content-type"].split("boundary=")[1]
        parts = [p for p in (batch.body or b"").split(f"--{boundary}".encode()) if p.strip() not in (b"", b"--")]
        self.assertEqual(len(parts), 2)
        html = hashlib.sha256(b"<h1>hi</h1>").hexdigest()
        self.assertIn(f'name="{html}"; filename="{html}"'.encode(), parts[0])
        self.assertIn(b"Content-Type: text/html; charset=utf-8\r\n\r\n<h1>hi</h1>\r\n", parts[0])
        alone = next(s for s in seen.seen if s.method == "PUT")
        self.assertEqual(alone.headers["content-type"], "application/octet-stream")
        site = next(s for s in seen.seen if s.path == f"{BASE}/site")
        manifest = site.json()
        self.assertEqual([f["path"] for f in manifest["files"]], ["/index.html", "/app.css", "/copy.css", "/big.bin"])
        self.assertEqual((manifest["not_found_handling"], manifest["run_worker_first"]), ("404-page", None))
        self.assertNotIn("jiayang-site-entry", site.headers)

    def test_sends_nothing_the_platform_already_has(self) -> None:
        jy, seen = fake(
            {
                f"GET {BASE}/versions": lambda r: answer(200, []),
                f"POST {BASE}/blobs/missing": lambda r: answer(200, {"missing": []}),
                f"POST {BASE}/site": lambda r: answer(201, version(1)),
            }
        )
        jy.deploy.site("acme", "hello", [{"path": "/index.html", "content": "hi"}])
        self.assertEqual(
            [f"{s.method} {s.path}" for s in seen.seen],
            [f"POST {BASE}/blobs/missing", f"GET {BASE}/versions", f"POST {BASE}/site"],
        )
        self.assertEqual(
            seen.seen[-1].json()["files"],
            [{"path": "/index.html", "sha256": hashlib.sha256(b"hi").hexdigest(), "size": 2, "content_type": "text/html; charset=utf-8"}],
        )

    def test_sends_the_lock_files_and_allow_file_for_the_scan(self) -> None:
        jy, seen = fake(
            {
                f"GET {BASE}/versions": lambda r: answer(200, []),
                f"POST {BASE}/blobs/missing": lambda r: answer(200, {"missing": []}),
                f"POST {BASE}/site": lambda r: answer(201, version(1)),
                f"POST {BASE}/versions": lambda r: answer(201, version(2)),
            }
        )
        scan = {"lockfiles": [{"path": "package-lock.json", "text": "{}"}], "allow": "AKIA* in /index.html\n"}
        jy.deploy.site("acme", "hello", [{"path": "/index.html", "content": "hi"}], scan=scan)
        self.assertEqual(json.loads(seen.seen[-1].body or b"")["scan"], scan)
        jy.deploy.worker("acme", "hello", scan={"allow": ""}, **WORKER)
        self.assertEqual(json.loads(seen.seen[-1].body or b"")["scan"], {"allow": ""})
        jy.deploy.site("acme", "hello", [{"path": "/index.html", "content": "hi"}], scan={"lockfiles": []})
        self.assertNotIn("scan", json.loads(seen.seen[-1].body or b""))

    def test_refuses_a_file_twice_and_an_empty_site(self) -> None:
        jy, _ = fake({})
        with self.assertRaisesRegex(JiayangError, "twice"):
            jy.deploy.site("acme", "hello", [{"path": "/a.txt", "content": "a"}, {"path": "a.txt", "content": "b"}])
        with self.assertRaises(JiayangError):
            jy.deploy.site("acme", "hello", [])


class VersionName(unittest.TestCase):
    def test_is_the_one_the_platform_gives_it(self) -> None:
        shared = json.loads((Path(__file__).resolve().parents[2] / "testdata" / "version-hashes.json").read_text())
        self.assertEqual(site_version_hash(shared["site"]["files"]), shared["site"]["sha256"])
        deploy = shared["worker"]["deploy"]
        modules = {name: (m["type"], base64.b64decode(m["b64"])) for name, m in deploy["modules"].items()}
        self.assertEqual(
            worker_version_hash(modules, deploy["compatibility_flags"], deploy["assets"]), shared["worker"]["sha256"]
        )


class Types(unittest.TestCase):
    def test_match_the_table_the_cli_uses(self) -> None:
        shared = json.loads((Path(__file__).resolve().parents[2] / "testdata" / "content-types.json").read_text())
        self.assertEqual(CONTENT_TYPES, shared)
        self.assertEqual(content_type("/a/b/Index.HTML"), "text/html; charset=utf-8")
        self.assertEqual(content_type("/Makefile"), "application/octet-stream")
        self.assertEqual(module_type("x.MJS", ""), "esm")


if __name__ == "__main__":
    unittest.main()
