"""Streamlit and Gradio.

Neither framework is installed to test against. Streamlit's own test harness can't set request
headers, which is the only thing the integration reads, and Gradio's request is documented as a
thin wrapper around Starlette's, which is installed, so that one is the real thing.
"""

from __future__ import annotations

import time
import unittest
from unittest import mock

from starlette.requests import Request

from jiayang import Unauthorized
from jiayang.gradio import get_user as gradio_get_user
from jiayang.gradio import require_user as gradio_require_user
from jiayang.streamlit import get_user as streamlit_get_user
from jiayang.streamlit import require_user as streamlit_require_user
from support import Base, headers, token


class FakeStreamlit:
    """`st.session_state` and `st.context.headers`, which is all the integration touches."""

    def __init__(self, headers: dict[str, str]) -> None:
        self.session_state: dict[str, object] = {}
        self.context = mock.Mock(headers=headers)


class Streamlit(Base):
    def st(self, headers: dict[str, str]) -> FakeStreamlit:
        fake = FakeStreamlit(headers)
        patched = mock.patch("jiayang.streamlit._streamlit", return_value=fake)
        patched.start()
        self.addCleanup(patched.stop)
        return fake

    def test_the_caller_of_the_request_that_opened_the_session(self):
        self.st(headers())
        self.assertEqual(streamlit_require_user().email, "alice@example.com")

    def test_no_identity_is_a_refusal_the_page_can_answer(self):
        self.st({})
        with self.assertRaises(Unauthorized):
            streamlit_require_user()
        self.assertIsNone(streamlit_get_user())

    # The token lives 60 seconds and the session outlives it, so a rerun an hour in must still
    # know who is there. The edge closes the connection when access is taken away.
    def test_a_rerun_after_the_token_expired_still_knows_the_caller(self):
        expired = int(time.time()) - 3600
        fake = self.st({"X-Jiayang-Identity": token(iat=expired, exp=expired + 60)})
        with self.assertRaises(Unauthorized):
            streamlit_require_user()

        fake.session_state.clear()
        fake.context.headers = headers()
        self.assertEqual(streamlit_require_user().email, "alice@example.com")
        # Now expire what the session opened with; the page keeps its answer.
        fake.context.headers = {"X-Jiayang-Identity": token(iat=expired, exp=expired + 60)}
        self.assertEqual(streamlit_require_user().email, "alice@example.com")

    def test_a_refusal_is_not_remembered(self):
        fake = self.st({})
        self.assertIsNone(streamlit_get_user())
        fake.context.headers = headers()
        self.assertEqual(streamlit_require_user().email, "alice@example.com")


def request(headers: dict[str, str]) -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
    }
    return Request(scope)


class Gradio(Base):
    def test_the_caller_behind_a_request(self):
        self.assertEqual(gradio_require_user(request(headers())).email, "alice@example.com")

    def test_no_identity_is_refused(self):
        with self.assertRaises(Unauthorized):
            gradio_require_user(request({}))
        self.assertIsNone(gradio_get_user(request({})))

    # Gradio passes None when a handler is reached through the API or a cached example. That is a
    # caller the app knows nothing about, not a trusted one.
    def test_no_request_at_all_is_refused(self):
        with self.assertRaises(Unauthorized):
            gradio_require_user(None)
        self.assertIsNone(gradio_get_user(None))


if __name__ == "__main__":
    unittest.main()
