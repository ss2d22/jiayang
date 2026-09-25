"""The Flask integration, against a real Flask app."""

from __future__ import annotations

import logging
import unittest

from flask import Flask

from jiayang.flask import current_user, get_user, get_webhook, login_required, webhook_required
from support import Base, headers, webhook_headers


def app() -> Flask:
    app = Flask(__name__)

    @app.get("/")
    @login_required
    def index() -> str:
        return f"hello {current_user.email}"

    @app.post("/orders")
    @login_required(role="editor")
    def place_order() -> str:
        return f"ordered by {current_user.email}"

    @app.get("/maybe")
    def maybe() -> str:
        user = get_user()
        return f"hello {user.email if user else 'stranger'}"

    @app.get("/forgot")
    def forgot() -> str:
        return f"hello {current_user.email}"

    @app.post("/hooks/stripe")
    @webhook_required(provider="stripe")
    def stripe_hook() -> str:
        return f"took {get_webhook().delivery}"

    @app.post("/hooks/github")
    @webhook_required(provider="github")
    def github_hook() -> str:
        return "took it"

    @app.post("/hooks/forgot")
    def forgot_hook() -> str:
        return f"took {get_webhook().delivery}"

    return app


class FlaskIntegration(Base):
    def setUp(self) -> None:
        super().setUp()
        made = app()
        made.config["PROPAGATE_EXCEPTIONS"] = False
        # One test asks for a 500 on purpose; its traceback isn't news.
        made.logger.setLevel(logging.CRITICAL)
        self.client = made.test_client()

    def test_a_verified_caller_reaches_the_view(self):
        answer = self.client.get("/", headers=headers())
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(answer.text, "hello alice@example.com")

    def test_no_identity_is_401(self):
        self.assertEqual(self.client.get("/").status_code, 401)

    def test_too_little_role_is_403(self):
        self.assertEqual(self.client.post("/orders", headers=headers()).status_code, 200)
        self.assertEqual(self.client.post("/orders", headers=headers("viewer")).status_code, 403)

    def test_a_view_that_renders_either_way(self):
        self.assertEqual(self.client.get("/maybe").text, "hello stranger")
        self.assertEqual(self.client.get("/maybe", headers=headers()).text, "hello alice@example.com")

    # Answering "nobody, carry on" would let the view render as though there were a caller.
    def test_current_user_without_the_decorator_is_an_error(self):
        self.assertEqual(self.client.get("/forgot", headers=headers()).status_code, 500)

    def test_a_webhook_reaches_its_view(self):
        answer = self.client.post("/hooks/stripe", headers=webhook_headers())
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(answer.text, "took evt_1")

    def test_a_webhook_view_refuses_a_person_nobody_and_another_provider(self):
        self.assertEqual(self.client.post("/hooks/stripe", headers=headers()).status_code, 401)
        self.assertEqual(self.client.post("/hooks/stripe").status_code, 401)
        self.assertEqual(self.client.post("/hooks/github", headers=webhook_headers()).status_code, 401)

    # Flask checks per view, so the same app has both and neither lets the other's token in.
    def test_login_required_refuses_a_webhook(self):
        self.assertEqual(self.client.get("/", headers=webhook_headers()).status_code, 401)
        self.assertEqual(self.client.get("/maybe", headers=webhook_headers()).text, "hello stranger")

    def test_get_webhook_without_the_decorator_is_an_error(self):
        self.assertEqual(self.client.post("/hooks/forgot", headers=webhook_headers()).status_code, 500)

    def test_the_token_is_verified_once_a_request(self):
        before = self.jwks.fetches
        self.client.get("/", headers=headers())
        self.client.get("/", headers=headers())
        # One fetch for the first request; the second reads the cached key set.
        self.assertEqual(self.jwks.fetches, before + 1)


if __name__ == "__main__":
    unittest.main()
