"""The async verification: the same answers as the sync one, without stopping the loop."""

from __future__ import annotations

import asyncio
import threading
import time
import unittest

import jiayang
from jiayang import Unauthorized, verify_identity, verify_webhook
from jiayang.aio import require_user, require_webhook
from jiayang.aio import verify_identity as averify
from jiayang.aio import verify_webhook as averify_webhook
from support import JWKS_URL, Base, headers, token, webhook_headers, webhook_token


class Aio(Base):
    def test_it_gives_the_same_caller_the_sync_one_does(self):
        given = token()
        theirs = asyncio.run(averify(given))
        self.assertEqual(theirs, verify_identity(given))
        self.assertEqual(theirs.email, "alice@example.com")

    def test_it_reads_the_header_like_everything_else(self):
        user = asyncio.run(require_user(headers()))
        self.assertEqual(user.role, "editor")

    def test_a_token_it_can_t_verify_is_refused(self):
        async def run() -> None:
            with self.assertRaises(Unauthorized):
                await averify("not.a.token")
            with self.assertRaises(Unauthorized):
                await require_user({})

        asyncio.run(run())

    def test_it_gives_the_same_webhook_the_sync_one_does(self):
        given = webhook_token()
        theirs = asyncio.run(averify_webhook(given, provider="stripe"))
        self.assertEqual(theirs, verify_webhook(given, provider="stripe"))
        self.assertEqual(asyncio.run(require_webhook(webhook_headers(), provider=["stripe"])).delivery, "evt_1")

    def test_each_refuses_the_other_s_token(self):
        async def run() -> None:
            with self.assertRaises(Unauthorized):
                await require_webhook(headers(), provider="stripe")
            with self.assertRaises(Unauthorized):
                await require_user(webhook_headers())
            with self.assertRaises(Unauthorized):
                await require_webhook({}, provider="stripe")
            with self.assertRaises(Unauthorized):
                await averify_webhook(webhook_token(), provider=[])

        asyncio.run(run())

    # A hundred requests arriving at once on a cold key set: one fetch, and the ninety-nine others
    # wait for it rather than each taking a thread.
    def test_concurrent_first_requests_fetch_the_keys_once(self):
        threads: set[int] = set()
        slow = self.jwks

        def fetch(url: str) -> bytes:
            threads.add(threading.get_ident())
            time.sleep(0.05)
            return slow(url)

        self.jwks.fetches = 0
        jiayang._key_sets[JWKS_URL] = jiayang.KeySet(JWKS_URL, fetch=fetch)

        async def run() -> list[object]:
            return await asyncio.gather(*(averify(token()) for _ in range(100)))

        users = asyncio.run(run())
        self.assertEqual(len(users), 100)
        self.assertEqual(self.jwks.fetches, 1)
        self.assertEqual(len(threads), 1)

    # Nothing may run on the loop's thread for as long as a fetch takes.
    def test_the_loop_keeps_running_while_the_keys_are_fetched(self):
        def slow(url: str) -> bytes:
            time.sleep(0.2)
            return self.jwks(url)

        jiayang._key_sets[JWKS_URL] = jiayang.KeySet(JWKS_URL, fetch=slow)

        async def run() -> int:
            ticks = 0

            async def tick() -> None:
                nonlocal ticks
                while True:
                    await asyncio.sleep(0.01)
                    ticks += 1

            ticking = asyncio.ensure_future(tick())
            await averify(token())
            ticking.cancel()
            return ticks

        self.assertGreater(asyncio.run(run()), 5)


if __name__ == "__main__":
    unittest.main()
