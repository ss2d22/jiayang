"""require_webhook from the tenant side: what it takes, and that it fails closed like require_user."""

from __future__ import annotations

import os
import unittest
from unittest import mock

import jiayang
from jiayang import Unauthorized, Webhook, require_user, require_webhook, verify_webhook
from support import JWKS_URL, Base, headers, webhook_headers, webhook_token


class RequireWebhook(Base):
    def test_it_reads_the_token_and_names_the_delivery(self):
        hook = require_webhook(webhook_headers(), provider="stripe")
        self.assertIsInstance(hook, Webhook)
        self.assertEqual((hook.provider, hook.pattern, hook.delivery), ("stripe", "/hooks/stripe", "evt_1"))
        self.assertEqual(hook.workspace_id, "0b000000-0000-4000-8000-00000000000a")

    def test_it_reads_django_s_environ_as_well(self):
        hook = require_webhook({"HTTP_X_JIAYANG_IDENTITY": webhook_token()}, provider="stripe")
        self.assertEqual(hook.provider, "stripe")

    # Treated as letters, "stripe" would be {"s", "t", "r", ...} and match nothing.
    def test_a_bare_string_is_one_provider(self):
        self.assertEqual(verify_webhook(webhook_token(), provider="stripe").provider, "stripe")
        self.assertEqual(verify_webhook(webhook_token(), provider=("github", "stripe")).provider, "stripe")
        self.assertEqual(verify_webhook(webhook_token(), provider={"stripe"}).provider, "stripe")

    def test_no_provider_refuses_everything_without_fetching_a_key(self):
        for provider in ([], (), None, 7):
            with self.subTest(provider=provider), self.assertRaises(Unauthorized):
                verify_webhook(webhook_token(), provider=provider)  # type: ignore[arg-type]
        self.assertEqual(self.jwks.fetches, 0)

    def test_a_name_it_doesn_t_know_matches_nothing(self):
        for provider in ("", "Stripe", "paddle", ["stripe "]):
            with self.subTest(provider=provider), self.assertRaises(Unauthorized):
                verify_webhook(webhook_token(), provider=provider)

    def test_it_refuses_a_request_with_no_token_whatever_else_it_carries(self):
        bare = {"X-Jiayang-Email": "alice@example.com", "Stripe-Signature": "t=1,v1=00"}
        with self.assertRaises(Unauthorized):
            require_webhook(bare, provider="stripe")

    # The same token is a user's no more than a user's token is a webhook.
    def test_each_refuses_the_other_s_token(self):
        with self.assertRaises(Unauthorized):
            require_user(webhook_headers())
        with self.assertRaises(Unauthorized):
            require_webhook(headers(), provider="stripe")

    def test_it_refuses_when_the_app_isn_t_configured(self):
        for missing in ("JIAYANG_APP_ID", "JIAYANG_IDENTITY_ISSUER", "JIAYANG_JWKS_URL"):
            with self.subTest(missing), mock.patch.dict(os.environ, {missing: ""}), self.assertRaises(Unauthorized):
                require_webhook(webhook_headers(), provider="stripe")

    def test_it_refuses_when_the_keys_can_t_be_fetched(self):
        def down(_url: str) -> bytes:
            raise OSError("no route to the edge")

        jiayang._key_sets[JWKS_URL] = jiayang.KeySet(JWKS_URL, fetch=down)
        with self.assertRaises(Unauthorized):
            require_webhook(webhook_headers(), provider="stripe")


if __name__ == "__main__":
    unittest.main()
