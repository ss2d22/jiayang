from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List

from jiayang_client import Client, ConnectionFailedError, JiayangError, NotFoundError, RequestTimeoutError

SEEN: List[Dict[str, Any]] = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:
        pass

    def answer(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        SEEN.append({"method": self.command, "path": self.path, "host": self.headers["host"], "body": body})
        if self.path == "/slow":
            threading.Event().wait(1)
            return
        if self.path == "/v1/me":
            data = json.dumps({"email": "ada@example.com", "workspaces": []}).encode()
            self.send_response(200)
        elif self.path == "/away":
            data = b""
            self.send_response(302)
            self.send_header("location", "http://127.0.0.1:1/")
        else:
            data = json.dumps({"error": "not_found", "message": "Not found."}).encode()
            self.send_response(404)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_DELETE = answer


class Transport(unittest.TestCase):
    server: ThreadingHTTPServer
    port: int

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def test_reaches_the_local_platform_on_loopback_keeping_the_name_in_host(self) -> None:
        jy = Client("jyu_local", base_url=f"http://api.jiayang.localhost:{self.port}")
        self.assertEqual(jy.me()["email"], "ada@example.com")
        self.assertEqual(SEEN[-1]["host"], f"api.jiayang.localhost:{self.port}")
        with self.assertRaises(NotFoundError):
            jy.apps.get("acme", "nope")

    def test_follows_no_redirect(self) -> None:
        jy = Client("jyu_local", base_url=f"http://127.0.0.1:{self.port}")
        before = len(SEEN)
        with self.assertRaises(JiayangError):
            jy.request("GET", "/away", repeatable=True)
        self.assertEqual(len(SEEN), before + 1)

    def test_times_out(self) -> None:
        jy = Client("jyu_local", base_url=f"http://127.0.0.1:{self.port}", timeout=0.2, max_retries=0)
        with self.assertRaises(RequestTimeoutError):
            jy.request("GET", "/slow", repeatable=True)

    def test_trusts_what_the_operating_system_trusts(self) -> None:
        import ssl

        import truststore

        from jiayang_client._http import _tls

        context = _tls()
        self.assertIsInstance(context, truststore.SSLContext)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_says_when_nothing_answers(self) -> None:
        jy = Client("jyu_local", base_url="http://127.0.0.1:1", max_retries=0)
        with self.assertRaises(ConnectionFailedError):
            jy.me()


if __name__ == "__main__":
    unittest.main()
