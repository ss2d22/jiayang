from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

from fake import TOKEN, Seen, answer, fake, refusal

from jiayang_client import (
    AuthenticationError,
    BadRequestError,
    Client,
    ConfigError,
    ConflictError,
    ConnectionFailedError,
    JiayangError,
    NotFoundError,
    PermissionDeniedError,
    PlanLimitError,
    RateLimitError,
    Response,
    ServerError,
)
from jiayang_client._client import segment

HERE = Path(__file__).resolve().parent
ROUTES = json.loads((HERE.parent.parent / "testdata" / "client-routes.json").read_text())["routes"]


def _listed(method: str, path: str) -> str:
    for route in ROUTES:
        pattern = "^" + re.sub(r"\{[a-z0-9]+\}", "[^/]+", route["path"]) + "$"
        if route["method"] == method and re.match(pattern, path):
            return f"{route['method']} {route['path']}"
    return f"UNLISTED {method} {path}"


class Requests(unittest.TestCase):
    def test_are_the_ones_in_client_routes_json_every_one_of_them(self) -> None:
        asked = set()

        def transport(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float) -> Response:
            req = Seen(method, url, headers, body)
            asked.add(_listed(method, req.path))
            if req.path.endswith("/blobs/missing"):
                return answer(200, {"missing": req.json()["sha256"]})
            if method == "POST" and re.search(r"/(versions|site)$", req.path):
                return answer(201, {"number": 2, "status": "deployed", "active": True})
            if req.path.endswith("/versions"):
                return answer(200, [{"number": 1, "status": "deployed", "active": True}])
            if req.path == "/v1/me":
                return answer(200, {"workspaces": []})
            if req.path.endswith("/audit"):
                return answer(200, [])
            if method == "DELETE":
                return Response(204)
            if method == "GET" and re.search(r"/(grants|domain-grants|group-grants|tokens|secrets|env|members|apps)$", req.path):
                return answer(200, [])
            return answer(200, {"visibility": "private"})

        jy = Client(TOKEN, base_url="https://api.example.com", transport=transport)
        ws, app = "acme", "hello"
        jy.me()
        jy.workspaces.list()
        jy.workspaces.get(ws)
        jy.workspaces.create(ws, "Acme")
        jy.members.list(ws)
        jy.members.set(ws, "ada@example.com", "member")
        jy.members.remove(ws, "ada@example.com")
        jy.apps.list(ws)
        jy.apps.get(ws, app)
        jy.apps.create(ws, app, "Hello", "workers")
        jy.apps.update(ws, app, name="Hi")
        jy.apps.delete(ws, app)
        jy.versions.list(ws, app)
        jy.versions.rollback(ws, app, 1)
        jy.versions.promote(ws, app, 1)
        jy.deploy.worker(
            ws, app, main_module="index.js", compatibility_date="2026-09-01", modules={"index.js": {"content": "export default {}"}}
        )
        jy.deploy.site(ws, app, [{"path": "/a.html", "content": "a"}, {"path": "/b.bin", "content": bytes(4 * 1024 * 1024)}])
        jy.access.list(ws, app)
        jy.access.share(ws, app, "ada@example.com")
        jy.access.unshare(ws, app, "ada@example.com")
        jy.access.share_domain(ws, app, "@example.com")
        jy.access.unshare_domain(ws, app, "example.com")
        jy.access.share_group(ws, app, "finance")
        jy.access.unshare_group(ws, app, "finance")
        jy.tokens.list(ws, app)
        jy.tokens.create(ws, app, "ci", "viewer")
        jy.tokens.revoke(ws, app, "tok1")
        jy.audit.list(ws)
        list(jy.audit.iterate(ws))
        jy.secrets.list(ws, app)
        jy.secrets.set(ws, app, "STRIPE", value="x", inject_host="api.stripe.com", inject_header="Authorization")
        jy.secrets.delete(ws, app, "STRIPE")
        jy.env.list(ws, app)
        jy.env.update(ws, app, set={"A": "1"})

        self.assertEqual([a for a in asked if a.startswith("UNLISTED")], [])
        self.assertEqual([f"{r['method']} {r['path']}" for r in ROUTES if f"{r['method']} {r['path']}" not in asked], [])


class SigningIn(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        patcher = mock.patch.dict(os.environ, {"JIAYANG_CONFIG_DIR": self.dir.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.dir.cleanup)
        os.environ.pop("JIAYANG_TOKEN", None)
        os.environ.pop("JIAYANG_API", None)
        self.seen: List[Seen] = []

    def transport(self, method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float) -> Response:
        self.seen.append(Seen(method, url, headers, body))
        return answer(200, {"email": "ada@example.com", "workspaces": []})

    def sent(self) -> List[Any]:
        return [(s.url, s.headers["authorization"]) for s in self.seen]

    def test_sends_the_token_as_a_bearer_to_the_address_its_given(self) -> None:
        Client(TOKEN, base_url="https://api.example.com/", transport=self.transport).me()
        self.assertEqual(self.sent(), [("https://api.example.com/v1/me", f"Bearer {TOKEN}")])

    def test_takes_jiayang_token_and_jiayang_api_from_the_environment(self) -> None:
        os.environ["JIAYANG_TOKEN"] = "jyu_fromenv"
        os.environ["JIAYANG_API"] = "https://api.staging.example.com"
        Client(transport=self.transport).me()
        self.assertEqual(self.sent(), [("https://api.staging.example.com/v1/me", "Bearer jyu_fromenv")])

    def test_uses_the_session_jiayang_login_saved_with_the_api_its_for(self) -> None:
        (Path(self.dir.name) / "config.json").write_text(
            json.dumps(
                {"api_url": "http://api.jiayang.localhost:8000", "api_token": "jyu_saved", "session_expires_at": "2999-01-01T00:00:00Z"}
            )
        )
        jy = Client(transport=self.transport)
        jy.me()
        self.assertEqual(self.sent(), [("http://api.jiayang.localhost:8000/v1/me", "Bearer jyu_saved")])
        self.assertEqual(jy.base_url, "http://api.jiayang.localhost:8000")

    def test_sends_the_saved_session_only_to_the_api_its_for(self) -> None:
        (Path(self.dir.name) / "config.json").write_text(
            json.dumps({"api_url": "https://api.jiayang.cloud", "api_token": "jyu_saved", "session_expires_at": "2999-01-01T00:00:00Z"})
        )
        os.environ["JIAYANG_API"] = "https://api.attacker.example"
        with self.assertRaisesRegex(ConfigError, "only send your session there"):
            Client(transport=self.transport).me()
        del os.environ["JIAYANG_API"]
        with self.assertRaises(ConfigError):
            Client(base_url="https://api.attacker.example", transport=self.transport).me()
        self.assertEqual(self.sent(), [])
        # The same API, written another way, is fine.
        os.environ["JIAYANG_API"] = "https://API.jiayang.cloud:443/"
        Client(transport=self.transport).me()
        self.assertEqual(self.sent(), [("https://API.jiayang.cloud:443/v1/me", "Bearer jyu_saved")])
        # A token passed in goes where it's told.
        os.environ["JIAYANG_API"] = "https://api.staging.example.com"
        Client(TOKEN, transport=self.transport).me()
        self.assertEqual(self.sent()[-1], ("https://api.staging.example.com/v1/me", f"Bearer {TOKEN}"))

    def test_wont_guess_the_api_a_saved_session_is_for(self) -> None:
        (Path(self.dir.name) / "config.json").write_text(
            json.dumps({"api_token": "jyu_saved", "session_expires_at": "2999-01-01T00:00:00Z"})
        )
        with self.assertRaisesRegex(ConfigError, "jiayang login"):
            Client(transport=self.transport).me()
        self.assertEqual(self.sent(), [])

    def test_says_so_when_the_saved_session_has_ended_or_there_is_none(self) -> None:
        with self.assertRaisesRegex(ConfigError, "No token"):
            Client(transport=self.transport).me()
        (Path(self.dir.name) / "config.json").write_text(
            json.dumps({"api_token": "jyu_saved", "session_expires_at": "2020-01-01T00:00:00+00:00"})
        )
        with self.assertRaisesRegex(ConfigError, "has ended"):
            Client(transport=self.transport).me()

    def test_refuses_a_token_that_isnt_for_the_api(self) -> None:
        with self.assertRaisesRegex(ConfigError, "bypass token"):
            Client("jyb_abc")
        for token in ("jya_abc", "jyu_a\r\nx: y", ""):
            with self.assertRaises(ConfigError):
                Client(token)

    def test_never_sends_a_token_over_plain_http_to_another_machine(self) -> None:
        with self.assertRaisesRegex(ConfigError, "isn't https"):
            Client(TOKEN, base_url="http://api.example.com")
        with self.assertRaisesRegex(ConfigError, "isn't https"):
            Client(TOKEN, base_url="http://localhost.example.com")
        with self.assertRaises(ConfigError):
            Client(TOKEN, base_url="https://user:pw@api.example.com")
        for local in ("http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000", "http://api.jiayang.localhost:1"):
            Client(TOKEN, base_url=local)


class Errors(unittest.TestCase):
    def test_are_typed_by_status_with_the_platforms_code_and_message(self) -> None:
        jy, _ = fake(
            {
                "GET /v1/workspaces/acme": lambda r: refusal(404, "not_found", "Not found."),
                "POST /v1/workspaces": lambda r: refusal(400, "bad_request", "Use lower-case letters."),
                "GET /v1/me": lambda r: refusal(401, "unauthenticated", "Sign in."),
                "POST /v1/workspaces/acme/apps": lambda r: refusal(
                    403, "plan_limit", "Free has 3 apps.", limit={"what": "apps", "max": 3, "plan": "free"}
                ),
                "DELETE /v1/workspaces/acme/apps/hello": lambda r: refusal(403, "forbidden", "No."),
                "PATCH /v1/workspaces/acme/apps/hello": lambda r: refusal(409, "conflict", "Taken."),
            }
        )
        with self.assertRaises(NotFoundError) as missing:
            jy.workspaces.get("acme")
        self.assertEqual((missing.exception.status, missing.exception.code, str(missing.exception)), (404, "not_found", "Not found."))
        with self.assertRaises(BadRequestError):
            jy.workspaces.create("Acme", "x")
        with self.assertRaises(AuthenticationError):
            jy.me()
        with self.assertRaises(PlanLimitError) as limit:
            jy.apps.create("acme", "a", "a", "workers")
        self.assertIsInstance(limit.exception, PermissionDeniedError)
        self.assertEqual(limit.exception.limit, {"what": "apps", "max": 3, "plan": "free"})
        with self.assertRaises(PermissionDeniedError):
            jy.apps.delete("acme", "hello")
        with self.assertRaises(ConflictError):
            jy.apps.update("acme", "hello")

    def test_say_so_when_the_answer_isnt_the_platforms_own(self) -> None:
        jy, _ = fake(
            {"GET /v1/me": lambda r: Response(502, {"cf-ray": "8abc-LHR"}, b"<html>bad gateway</html>", "Bad Gateway")},
            max_retries=0,
        )
        with self.assertRaises(ServerError) as caught:
            jy.me()
        err = caught.exception
        self.assertEqual((err.status, err.code, err.request_id, err.message), (502, "", "8abc-LHR", "The API answered 502 Bad Gateway."))

    def test_a_redirect_is_an_error_never_followed(self) -> None:
        jy, _ = fake({"GET /v1/me": lambda r: Response(302, {"location": "https://evil.example.com/"})})
        with self.assertRaises(JiayangError):
            jy.me()


class Retries(unittest.TestCase):
    def test_try_a_read_again_after_a_failure_on_our_side_and_then_give_up(self) -> None:
        jy, seen = fake(
            {
                "GET /v1/me": [lambda r: refusal(503, "busy"), lambda r: answer(200, {"email": "a@example.com", "workspaces": []})],
                "GET /v1/workspaces/acme": lambda r: refusal(500, "internal"),
            }
        )
        self.assertEqual(jy.me()["email"], "a@example.com")
        with self.assertRaises(ServerError):
            jy.workspaces.get("acme")
        self.assertEqual(len([s for s in seen.seen if s.path == "/v1/workspaces/acme"]), 3)

    def test_never_send_a_change_twice_that_may_have_been_made(self) -> None:
        jy, seen = fake({"POST /v1/workspaces": lambda r: refusal(502, "unavailable")})
        with self.assertRaises(ServerError):
            jy.workspaces.create("acme", "Acme")
        self.assertEqual(len(seen.seen), 1)

    def test_wait_out_a_429_for_as_long_as_it_says(self) -> None:
        jy, seen = fake(
            {
                "GET /v1/me": [
                    lambda r: refusal(429, "rate_limited", headers={"retry-after": "3"}),
                    lambda r: answer(200, {"workspaces": []}),
                ]
            }
        )
        waits: List[float] = []
        jy.sleep = waits.append
        self.assertEqual(jy.me()["workspaces"], [])
        self.assertEqual((len(seen.seen), waits), (2, [3.0]))

    def test_never_send_a_change_twice_after_a_429(self) -> None:
        jy, seen = fake(
            {
                "POST /v1/workspaces": [
                    lambda r: refusal(429, "rate_limited", headers={"retry-after": "3"}),
                    lambda r: answer(201, {"slug": "acme"}),
                ]
            }
        )
        with self.assertRaises(RateLimitError) as caught:
            jy.workspaces.create("acme", "Acme")
        self.assertEqual((len(seen.seen), caught.exception.retry_after), (1, 3))

    def test_give_up_on_a_429_whose_wait_is_too_long(self) -> None:
        jy, _ = fake({"GET /v1/me": lambda r: refusal(429, "rate_limited", headers={"retry-after": "600"})})
        with self.assertRaises(RateLimitError) as caught:
            jy.me()
        self.assertEqual(caught.exception.retry_after, 600)

    def test_dont_ask_again_for_what_asking_again_wont_fix(self) -> None:
        jy, seen = fake({"GET /v1/me": lambda r: refusal(500, "storage_refused")})
        with self.assertRaises(ServerError):
            jy.me()
        self.assertEqual(len(seen.seen), 1)

    def test_try_a_read_again_when_the_connection_fails(self) -> None:
        calls = []

        def flaky(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float) -> Response:
            calls.append(url)
            if len(calls) == 1:
                raise ConnectionFailedError("Couldn't reach the API (reset).")
            return answer(200, {"email": "a@example.com", "workspaces": []})

        jy = Client(TOKEN, base_url="https://api.example.com", transport=flaky)
        jy.backoff = lambda n: 0
        self.assertEqual(jy.me()["email"], "a@example.com")


class Paths(unittest.TestCase):
    def test_encode_each_name_as_one_segment_as_the_cli_does(self) -> None:
        self.assertEqual(segment("ada@example.com"), "ada@example.com")
        self.assertEqual(segment("a b/c?d#e"), "a%20b%2Fc%3Fd%23e")
        self.assertEqual(segment("é"), "%C3%A9")
        for bad in ("", ".", ".."):
            with self.assertRaises(JiayangError):
                segment(bad)


if __name__ == "__main__":
    unittest.main()
