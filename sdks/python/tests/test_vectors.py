"""The token cases in sdks/testdata/vectors.json, shared by every SDK."""

import json
import os
import pathlib
import unittest
from unittest.mock import patch

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
                    (user.kind, user.sub, user.email, user.role, user.workspace_id, user.agent_name),
                    (want["kind"], want["sub"], want["email"], want["role"], want["workspace_id"], want["agent_name"]),
                )
                self.assertEqual(user.is_agent, want["agent_name"] is not None)

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


class SharedOriginVectors(unittest.TestCase):
    """Where tokens may come from: https for the platform, http on this machine only under jiayang dev."""

    @staticmethod
    def env(issuer: str, jwks_url: str, dev: str | None) -> dict[str, str]:
        env = {"JIAYANG_APP_ID": CONFIG.app_id, "JIAYANG_IDENTITY_ISSUER": issuer, "JIAYANG_JWKS_URL": jwks_url}
        if dev is not None:
            env["JIAYANG_DEV"] = dev
        return env

    def test_takes_exactly_the_origins_marked_ok(self) -> None:
        for case in VECTORS["origins"]:
            with self.subTest(case["name"]):
                env = self.env(case["issuer"], case["jwks_url"], case["dev"])
                if case["ok"]:
                    self.assertEqual(Config.from_env(env).issuer, case["issuer"])
                else:
                    with self.assertRaisesRegex(Unauthorized, "JIAYANG_DEV=1"):
                        Config.from_env(env)

    def test_a_config_built_by_hand_takes_a_dev_origin_only_when_told(self) -> None:
        dev = VECTORS["dev"]
        with self.assertRaises(Unauthorized):
            Config(app_id=CONFIG.app_id, issuer=dev["issuer"], jwks_url=dev["jwks_url"])
        self.assertTrue(Config(app_id=CONFIG.app_id, issuer=dev["issuer"], jwks_url=dev["jwks_url"], dev=True).dev)

    def test_takes_a_token_from_jiayang_dev_under_jiayang_dev(self) -> None:
        dev = VECTORS["dev"]
        config = Config.from_env(self.env(dev["issuer"], dev["jwks_url"], "1"))
        user = verify_identity(dev["token"], config, now=VECTORS["now"], keys=keys({}))
        want = dev["user"]
        self.assertEqual((user.kind, user.sub, user.email, user.role), (want["kind"], want["sub"], want["email"], want["role"]))

    # Production: the same token and the same dev config, without the variable only jiayang dev sets.
    # Refused before any key is asked for.
    def test_refuses_a_token_from_jiayang_dev_without_jiayang_dev(self) -> None:
        dev = VECTORS["dev"]
        fetched = []
        never = KeySet(dev["jwks_url"], fetch=lambda url: fetched.append(url) or b"{}")
        with patch.dict(os.environ, self.env(dev["issuer"], dev["jwks_url"], None), clear=True):
            with self.assertRaisesRegex(Unauthorized, "JIAYANG_DEV=1"):
                verify_identity(dev["token"], now=VECTORS["now"], keys=never)
            with self.assertRaisesRegex(Unauthorized, "JIAYANG_DEV=1"):
                verify_webhook(dev["token"], provider="stripe", now=VECTORS["now"], keys=never)
        self.assertEqual(fetched, [])

    def test_refuses_a_token_from_jiayang_dev_against_the_platform_issuer(self) -> None:
        config = Config.from_env(self.env(CONFIG.issuer, CONFIG.jwks_url, "1"))
        with self.assertRaises(Unauthorized):
            verify_identity(VECTORS["dev"]["token"], config, now=VECTORS["now"], keys=keys({}))


if __name__ == "__main__":
    unittest.main()
