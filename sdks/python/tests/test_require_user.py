"""Hostile cases from the tenant side. Only the edge's tokens for this app may pass."""

from __future__ import annotations

import base64
import json
import unittest
import warnings
from pathlib import Path

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm
from jwt.warnings import InsecureKeyLengthWarning

import jiayang
from jiayang import Config, KeySet, Unauthorized, require_user, verify_identity

APP = "0a000000-0000-4000-8000-000000000001"
OTHER_APP = "0a000000-0000-4000-8000-000000000002"
CONFIG = Config(app_id=APP, issuer="https://edge.example.com", jwks_url="https://edge.example.com/.well-known/jwks.json")
NOW = 1_789_819_200  # 2026-09-19T12:00:00Z


def new_key(kid: str, bits: int = 2048):
    private = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    jwk = json.loads(RSAAlgorithm.to_jwk(private.public_key()))
    jwk.update(kid=kid, alg="RS256", use="sig")
    return private, jwk


EDGE, EDGE_JWK = new_key("identity-k1")
ROTATED, ROTATED_JWK = new_key("identity-k2")
ATTACKER, ATTACKER_JWK = new_key("attacker")


def claims(**extra):
    base = {
        "iss": CONFIG.issuer,
        "aud": APP,
        "sub": "access-sub-alice",
        "email": "alice@example.com",
        "kind": "user",
        "role": "editor",
        "wid": "0b000000-0000-4000-8000-00000000000a",
        "iat": NOW,
        "exp": NOW + 60,
    }
    base.update(extra)
    return {k: v for k, v in base.items() if v is not None}


def sign(payload, key=EDGE, kid="identity-k1", alg="RS256"):
    return jwt.encode(payload, key, algorithm=alg, headers={"kid": kid, "typ": "JWT"})


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class Jwks:
    """A stand-in JWKS endpoint and clock."""

    def __init__(self, keys=None):
        self.keys = keys if keys is not None else [EDGE_JWK]
        self.down = False
        self.fetches = 0
        self.clock = 0.0

    def fetch(self, url: str) -> bytes:
        assert url == CONFIG.jwks_url
        self.fetches += 1
        if self.down:
            raise OSError("network down")
        return json.dumps({"keys": self.keys}).encode()

    def key_set(self) -> KeySet:
        return KeySet(CONFIG.jwks_url, fetch=self.fetch, clock=lambda: self.clock)


class Base(unittest.TestCase):
    def setUp(self):
        self.jwks = Jwks()
        self.keys = self.jwks.key_set()

    def verify(self, token, now=NOW, config=CONFIG):
        return verify_identity(token, config, now=now, keys=self.keys)

    def refused(self, token, now=NOW):
        with self.assertRaises(Unauthorized):
            self.verify(token, now)


class RequireUser(Base):
    def test_returns_the_verified_caller(self):
        user = require_user({"X-Jiayang-Identity": sign(claims())}, CONFIG, now=NOW, keys=self.keys)
        self.assertEqual(user.kind, "user")
        self.assertEqual(user.sub, "access-sub-alice")
        self.assertEqual(user.email, "alice@example.com")
        self.assertEqual(user.role, "editor")
        self.assertEqual(user.workspace_id, "0b000000-0000-4000-8000-00000000000a")

    def test_reads_the_header_from_a_wsgi_environ_or_any_case(self):
        token = sign(claims())
        for headers in ({"HTTP_X_JIAYANG_IDENTITY": token}, {"x-jiayang-identity": token}, {"X-Jiayang-Identity": token}):
            self.assertEqual(require_user(headers, CONFIG, now=NOW, keys=self.keys).sub, "access-sub-alice")

    def test_returns_a_service_caller_with_no_email(self):
        user = self.verify(sign(claims(kind="service", sub="service:bt_ci", email=None)))
        self.assertEqual((user.kind, user.sub, user.email), ("service", "service:bt_ci", None))

    def test_ignores_an_email_on_a_service_token(self):
        self.assertIsNone(self.verify(sign(claims(kind="service", sub="service:bt_ci"))).email)

    def test_refuses_a_request_with_no_token_whatever_else_it_carries(self):
        with self.assertRaises(Unauthorized):
            require_user({"X-Jiayang-Email": "alice@example.com", "X-Jiayang-Role": "owner"}, CONFIG, now=NOW, keys=self.keys)
        with self.assertRaises(Unauthorized):
            require_user({"X-Jiayang-Identity": ""}, CONFIG, now=NOW, keys=self.keys)

    def test_refuses_when_the_app_isnt_configured(self):
        env = {"JIAYANG_APP_ID": APP, "JIAYANG_IDENTITY_ISSUER": CONFIG.issuer, "JIAYANG_JWKS_URL": CONFIG.jwks_url}
        self.assertEqual(Config.from_env(env), CONFIG)
        for missing in env:
            with self.assertRaises(Unauthorized):
                Config.from_env({k: v for k, v in env.items() if k != missing})
            with self.assertRaises(Unauthorized):
                Config.from_env({**env, missing: ""})


class HostileTokens(Base):
    def test_malformed(self):
        for token in ["", "abc", "a.b", "a.b.c", "a.b.c.d", "...", None, 7]:
            with self.subTest(token=token):
                self.refused(token)

    def test_alg_none(self):
        header = b64(json.dumps({"alg": "none", "kid": "identity-k1"}).encode())
        self.refused(f"{header}.{b64(json.dumps(claims()).encode())}.")

    def test_hs256_keyed_with_the_public_key(self):
        pem = EDGE.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        header = b64(json.dumps({"alg": "HS256", "kid": "identity-k1", "typ": "JWT"}).encode())
        body = b64(json.dumps(claims()).encode())
        import hashlib
        import hmac

        mac = hmac.new(pem, f"{header}.{body}".encode(), hashlib.sha256).digest()
        self.refused(f"{header}.{body}.{b64(mac)}")

    def test_other_rsa_algorithms_even_with_our_key(self):
        for alg in ("RS384", "RS512", "PS256"):
            with self.subTest(alg=alg):
                self.refused(sign(claims(), alg=alg))

    def test_valid_signature_from_the_wrong_key(self):
        self.refused(sign(claims(), key=ATTACKER, kid="identity-k1"))
        self.refused(sign(claims(), key=ATTACKER, kid="attacker"))

    def test_minted_for_another_app(self):
        self.refused(sign(claims(aud=OTHER_APP)))
        self.refused(sign(claims(aud=[OTHER_APP])))

    def test_wrong_issuer(self):
        self.refused(sign(claims(iss="https://evil.example.com")))

    def test_expired_and_replayed_after_expiry(self):
        token = sign(claims())
        self.assertTrue(self.verify(token))
        self.refused(token, now=NOW + 60)
        self.refused(token, now=NOW + 3600)

    def test_not_yet_valid(self):
        self.refused(sign(claims(nbf=NOW + 30)))

    def test_missing_or_odd_claims(self):
        for name, extra in [
            ("no exp", {"exp": None}),
            ("no iat", {"iat": None}),
            ("no aud", {"aud": None}),
            ("no iss", {"iss": None}),
            ("exp as a string", {"exp": str(NOW + 60)}),
            ("exp as a bool", {"exp": True}),
            ("exp of Infinity", {"exp": float("inf")}),
            ("iat as a string", {"iat": str(NOW)}),
            ("nbf as a string", {"nbf": str(NOW - 5)}),
            ("no kind", {"kind": None}),
            ("an unknown kind", {"kind": "admin"}),
            ("a user with no email", {"email": None}),
            ("no role", {"role": None}),
            ("no workspace", {"wid": None}),
            ("an empty sub", {"sub": ""}),
            ("a numeric sub", {"sub": 42}),
        ]:
            with self.subTest(name):
                self.refused(sign(claims(**extra)))


class SigningKeys(Base):
    def test_picks_up_a_rotated_key_on_first_sight_of_its_kid(self):
        self.assertTrue(self.verify(sign(claims())))
        self.jwks.keys = [ROTATED_JWK, EDGE_JWK]
        self.jwks.clock += 11
        self.assertTrue(self.verify(sign(claims(), key=ROTATED, kid="identity-k2")))

    def test_made_up_kids_dont_become_a_stream_of_fetches(self):
        self.verify(sign(claims()))
        for i in range(20):
            self.refused(sign(claims(), key=ATTACKER, kid=f"made-up-{i}"))
        self.assertEqual(self.jwks.fetches, 1)

    def test_denies_when_the_keys_cant_be_fetched(self):
        self.jwks.down = True
        self.refused(sign(claims()))

    def test_denies_once_cached_keys_expire_and_the_endpoint_is_down(self):
        self.assertTrue(self.verify(sign(claims())))
        self.jwks.down = True
        self.jwks.clock += 301
        self.refused(sign(claims()))

    def test_a_down_endpoint_is_asked_at_most_once_per_cooldown_for_new_kids(self):
        self.verify(sign(claims()))
        self.jwks.clock += 11
        self.jwks.down = True
        for i in range(50):
            self.refused(sign(claims(), key=ATTACKER, kid=f"made-up-{i}"))
        self.assertEqual(self.jwks.fetches, 2)
        # Cached keys still serve a known kid.
        self.assertTrue(self.verify(sign(claims())))

    def test_caches_keys_between_requests(self):
        token = sign(claims())
        for _ in range(5):
            self.verify(token)
        self.assertEqual(self.jwks.fetches, 1)

    def test_refetches_after_five_minutes(self):
        self.verify(sign(claims()))
        self.jwks.clock += 301
        self.verify(sign(claims()))
        self.assertEqual(self.jwks.fetches, 2)

    def test_ignores_keys_that_arent_rsa_signing_keys_or_are_too_small(self):
        small, small_jwk = new_key("small", bits=1024)
        self.jwks.keys = [
            {**EDGE_JWK, "use": "enc"},
            {**ROTATED_JWK, "alg": "RS512"},
            small_jwk,
            {"kty": "oct", "kid": "hmac", "k": b64(b"secret")},
        ]
        self.refused(sign(claims()))
        self.refused(sign(claims(), key=ROTATED, kid="identity-k2"))
        with warnings.catch_warnings():
            # 1024-bit on purpose. The SDK should refuse it.
            warnings.simplefilter("ignore", InsecureKeyLengthWarning)
            self.refused(sign(claims(), key=small, kid="small"))



class Fetching(unittest.TestCase):
    """The real fetch, against a local server."""

    def serve(self, handler):
        import http.server
        import threading

        server = http.server.HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def test_never_follows_a_redirect(self):
        import http.server

        body = json.dumps({"keys": [EDGE_JWK]}).encode()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                if self.path == "/jwks":
                    self.send_response(302)
                    self.send_header("location", "/elsewhere")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(body)

            def log_message(self, *args):
                pass

        base = self.serve(Handler)
        config = Config(app_id=APP, issuer=CONFIG.issuer, jwks_url=f"{base}/jwks")
        keys = KeySet(config.jwks_url)
        with self.assertRaises(Unauthorized):
            verify_identity(sign(claims()), config, now=NOW, keys=keys)
        # The same keys verify at the direct URL, so it was the redirect that got refused.
        direct = Config(app_id=APP, issuer=CONFIG.issuer, jwks_url=f"{base}/elsewhere")
        self.assertTrue(verify_identity(sign(claims()), direct, now=NOW, keys=KeySet(direct.jwks_url)))

    def test_refuses_an_oversized_key_set(self):
        import http.server

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b" " * (2 << 20))

            def log_message(self, *args):
                pass

        base = self.serve(Handler)
        with self.assertRaises(Unauthorized):
            KeySet(f"{base}/jwks").key("identity-k1")

    # Cloudflare in front of the real issuer answers urllib's own User-Agent with a 403, which
    # would be every caller refused.
    def test_says_what_is_asking(self):
        import http.server

        body = json.dumps({"keys": [EDGE_JWK]}).encode()
        asked_as = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                asked_as.append(self.headers.get_all("User-Agent"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        base = self.serve(Handler)
        KeySet(f"{base}/jwks").key("identity-k1")
        self.assertEqual(asked_as, [[f"jiayang-python/{jiayang.__version__}"]])

    def test_knows_its_own_version(self):
        pyproject = (Path(__file__).resolve().parent.parent / "pyproject.toml").read_text()
        self.assertIn(f'\nversion = "{jiayang.__version__}"\n', pyproject)


if __name__ == "__main__":
    unittest.main()
