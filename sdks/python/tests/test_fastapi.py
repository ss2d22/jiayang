"""The FastAPI integration, against a real app and a real client."""

from __future__ import annotations

import unittest
from typing import Annotated

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from jiayang import User, Webhook
from jiayang.fastapi import CurrentUser, optional_user, requires, webhook
from support import Base, headers, webhook_headers


def app() -> FastAPI:
    app = FastAPI()

    @app.get("/")
    async def index(user: CurrentUser) -> dict[str, str | None]:
        return {"hello": user.email}

    @app.post("/orders")
    async def place_order(user: User = Depends(requires("editor"))) -> dict[str, str | None]:
        return {"ordered_by": user.email}

    @app.get("/maybe")
    async def maybe(user: User | None = Depends(optional_user)) -> dict[str, str]:
        return {"hello": user.email if user else "stranger"}

    @app.post("/hooks/stripe")
    async def stripe_hook(hook: Annotated[Webhook, Depends(webhook("stripe"))]) -> dict[str, str | None]:
        return {"took": hook.delivery}

    @app.post("/hooks/either")
    async def either_hook(hook: Annotated[Webhook, Depends(webhook(["github", "stripe"]))]) -> dict[str, str]:
        return {"from": hook.provider}

    return app


class FastapiIntegration(Base):
    def setUp(self) -> None:
        super().setUp()
        self.client = TestClient(app())

    def test_a_verified_caller_reaches_the_route(self):
        answer = self.client.get("/", headers=headers())
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(answer.json(), {"hello": "alice@example.com"})

    def test_no_identity_is_401(self):
        self.assertEqual(self.client.get("/").status_code, 401)

    def test_too_little_role_is_403(self):
        self.assertEqual(self.client.post("/orders", headers=headers()).status_code, 200)
        answer = self.client.post("/orders", headers=headers("viewer"))
        self.assertEqual(answer.status_code, 403)
        self.assertEqual(answer.json()["detail"], "forbidden: this needs editor")

    def test_a_route_that_answers_either_way(self):
        self.assertEqual(self.client.get("/maybe").json(), {"hello": "stranger"})
        self.assertEqual(self.client.get("/maybe", headers=headers()).json(), {"hello": "alice@example.com"})

    def test_a_webhook_reaches_its_route(self):
        answer = self.client.post("/hooks/stripe", headers=webhook_headers())
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(answer.json(), {"took": "evt_1"})
        self.assertEqual(self.client.post("/hooks/either", headers=webhook_headers()).json(), {"from": "stripe"})

    def test_a_webhook_route_refuses_a_person_nobody_and_another_provider(self):
        self.assertEqual(self.client.post("/hooks/stripe", headers=headers()).status_code, 401)
        self.assertEqual(self.client.post("/hooks/stripe").status_code, 401)
        self.assertEqual(self.client.post("/hooks/stripe", headers=webhook_headers("github")).status_code, 401)

    def test_a_person_s_route_refuses_a_webhook(self):
        self.assertEqual(self.client.get("/", headers=webhook_headers()).status_code, 401)
        self.assertEqual(self.client.get("/maybe", headers=webhook_headers()).json(), {"hello": "stranger"})

    def test_the_keys_are_fetched_once_not_once_a_request(self):
        before = self.jwks.fetches
        for _ in range(3):
            self.client.get("/", headers=headers())
        self.assertEqual(self.jwks.fetches, before + 1)


if __name__ == "__main__":
    unittest.main()
