"""A live app's view of the platform: real environment variables, real tokens, stand-in keys.

The framework tests go through each integration's own default path (`Config.from_env()`, the
process-wide key set) rather than passing test seams in, because that path is the one a deployed
app takes.
"""

from __future__ import annotations

import json
import os
import time
import unittest
from unittest import mock

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

import jiayang

APP = "0a000000-0000-4000-8000-000000000001"
ISSUER = "https://edge.example.com"
JWKS_URL = "https://edge.example.com/.well-known/jwks.json"
ENV = {"JIAYANG_APP_ID": APP, "JIAYANG_IDENTITY_ISSUER": ISSUER, "JIAYANG_JWKS_URL": JWKS_URL}

EDGE = rsa.generate_private_key(public_exponent=65537, key_size=2048)
EDGE_JWK = {**json.loads(RSAAlgorithm.to_jwk(EDGE.public_key())), "kid": "identity-k1", "alg": "RS256", "use": "sig"}


def token(role: str = "editor", email: str = "alice@example.com", **extra: object) -> str:
    """An identity token like the edge mints: this app, this issuer, a minute to live."""
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": APP,
        "sub": "access-sub-alice",
        "email": email,
        "kind": "user",
        "role": role,
        "wid": "0b000000-0000-4000-8000-00000000000a",
        "iat": now,
        "exp": now + 60,
    }
    claims.update(extra)
    return jwt.encode(claims, EDGE, algorithm="RS256", headers={"kid": "identity-k1", "typ": "JWT"})


def headers(role: str = "editor", email: str = "alice@example.com") -> dict[str, str]:
    return {"X-Jiayang-Identity": token(role, email)}


def webhook_token(provider: str = "stripe", **extra: object) -> str:
    """What the edge sends with a delivery on a verified path: its own audience, no role, no email."""
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": f"webhook:{APP}",
        "sub": "webhook:0c000000-0000-4000-8000-0000000000f1",
        "kind": "webhook",
        "wid": "0b000000-0000-4000-8000-00000000000a",
        "provider": provider,
        "pattern": "/hooks/stripe",
        "delivery": "evt_1",
        "signed_at": now - 1,
        "iat": now,
        "exp": now + 60,
    }
    claims.update(extra)
    return jwt.encode(claims, EDGE, algorithm="RS256", headers={"kid": "identity-k1", "typ": "webhook+jwt"})


def webhook_headers(provider: str = "stripe") -> dict[str, str]:
    return {"X-Jiayang-Identity": webhook_token(provider)}


class Jwks:
    """Stands in for the edge's JWKS endpoint, and counts who asked."""

    def __init__(self) -> None:
        self.keys = [EDGE_JWK]
        self.fetches = 0

    def __call__(self, url: str) -> bytes:
        assert url == JWKS_URL
        self.fetches += 1
        return json.dumps({"keys": self.keys}).encode()


class Base(unittest.TestCase):
    """An app running on the platform: the variables it's given, and keys it can reach."""

    def setUp(self) -> None:
        self.jwks = Jwks()
        env = mock.patch.dict(os.environ, ENV)
        env.start()
        self.addCleanup(env.stop)
        keys = mock.patch.dict(jiayang._key_sets, {JWKS_URL: jiayang.KeySet(JWKS_URL, fetch=self.jwks)}, clear=True)
        keys.start()
        self.addCleanup(keys.stop)
