"""The token cases in sdks/testdata/vectors.json, shared by every SDK."""

import json
import pathlib
import unittest

import jwt
from jwt.algorithms import RSAAlgorithm

from jiayang import Config, KeySet, Unauthorized, User, Webhook, verify_identity, verify_webhook

VECTORS = json.loads((pathlib.Path(__file__).resolve().parents[2] / "testdata" / "vectors.json").read_text())
CONFIG = Config(
    app_id=VECTORS["config"]["app_id"],
    issuer=VECTORS["config"]["issuer"],
    jwks_url=VECTORS["config"]["jwks_url"],
)


def keys(case: dict) -> KeySet:
    body = json.dumps(case.get("jwks", VECTORS["jwks"])).encode()
    return KeySet(CONFIG.jwks_url, fetch=lambda _url: body, clock=lambda: 0.0)


def verify(case: dict) -> User:
    return verify_identity(case["token"], CONFIG, now=case.get("now", VECTORS["now"]), keys=keys(case))


def verify_hook(case: dict) -> Webhook:
    return verify_webhook(case["token"], CONFIG, provider=case["providers"], now=case.get("now", VECTORS["now"]), keys=keys(case))


class SharedVectors(unittest.TestCase):
    def test_accepts_the_valid_cases(self) -> None:
        for case in VECTORS["valid"]:
            with self.subTest(case["name"]):
                user = verify(case)
                want = case["user"]
                self.assertEqual(
                    (user.kind, user.sub, user.email, user.role, user.workspace_id),
                    (want["kind"], want["sub"], want["email"], want["role"], want["workspace_id"]),
                )

    def test_refuses_the_invalid_cases(self) -> None:
        for case in VECTORS["invalid"]:
            with self.subTest(case["name"]), self.assertRaises(Unauthorized):
                verify(case)


class SharedWebhookVectors(unittest.TestCase):
    def test_accepts_the_valid_cases(self) -> None:
        for case in VECTORS["webhook_valid"]:
            with self.subTest(case["name"]):
                want = case["webhook"]
                self.assertEqual(
                    verify_hook(case),
                    Webhook(
                        provider=want["provider"],
                        pattern=want["pattern"],
                        delivery=want["delivery"],
                        signed_at=want["signed_at"],
                        workspace_id=want["workspace_id"],
                    ),
                )

    def test_signed_at_is_an_int(self) -> None:
        for case in VECTORS["webhook_valid"]:
            with self.subTest(case["name"]):
                signed_at = verify_hook(case).signed_at
                self.assertTrue(signed_at is None or type(signed_at) is int, repr(signed_at))

    def test_refuses_the_invalid_cases(self) -> None:
        for case in VECTORS["webhook_invalid"]:
            with self.subTest(case["name"]), self.assertRaises(Unauthorized):
                verify_hook(case)

    # An app in a language we ship no SDK for checks the token with whatever JWT library it has:
    # signature, issuer, audience, expiry. Addressed to the app, that check must not pass a webhook.
    def test_a_generic_check_that_the_audience_is_the_app_refuses_them(self) -> None:
        key = RSAAlgorithm.from_jwk(VECTORS["jwks"]["keys"][0])
        for case in VECTORS["webhook_valid"]:
            with self.subTest(case["name"]), self.assertRaises(jwt.InvalidAudienceError):
                jwt.decode(
                    case["token"],
                    key,
                    algorithms=["RS256"],
                    audience=CONFIG.app_id,
                    issuer=CONFIG.issuer,
                    options={"verify_exp": False, "verify_iat": False},
                )


if __name__ == "__main__":
    unittest.main()
