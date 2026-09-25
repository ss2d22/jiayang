"""The Django integration, against a real Django app.

Configured here rather than in a settings module so the test is one file: Django only needs to
know its middleware and where its urls are before anything imports a view.
"""

from __future__ import annotations

import unittest

import django
from django.conf import settings
from django.http import HttpResponse

if not settings.configured:
    settings.configure(
        DEBUG=False,
        ALLOWED_HOSTS=["*"],
        ROOT_URLCONF=__name__,
        # CSRF on, as in a real project, for the webhook view that has to be exempt from it.
        MIDDLEWARE=["django.middleware.csrf.CsrfViewMiddleware", "jiayang.django.JiayangMiddleware"],
        DATABASES={},
        SECRET_KEY="not-a-secret-nothing-here-is-signed",
    )
    django.setup()

from django.test import Client  # noqa: E402
from django.urls import path  # noqa: E402

from jiayang.django import login_required, role_required, webhook_required  # noqa: E402
from support import Base, headers, webhook_headers  # noqa: E402


def index(request) -> HttpResponse:
    user = request.jiayang_user
    return HttpResponse(f"hello {user.email if user else 'stranger'}")


@login_required
def account(request) -> HttpResponse:
    return HttpResponse(f"hello {request.jiayang_user.email}")


@role_required("editor")
def place_order(request) -> HttpResponse:
    return HttpResponse(f"ordered by {request.jiayang_user.email}")


@webhook_required(provider="stripe")
def stripe_hook(request) -> HttpResponse:
    return HttpResponse(f"took {request.jiayang_webhook.delivery}, caller {request.jiayang_user}")


def form(request) -> HttpResponse:
    return HttpResponse("posted")


urlpatterns = [
    path("", index),
    path("account", account),
    path("orders", place_order),
    path("hooks/stripe", stripe_hook),
    path("form", form),
]


class DjangoIntegration(Base):
    def setUp(self) -> None:
        super().setUp()
        self.client = Client()

    def test_the_middleware_sets_the_caller_on_the_request(self):
        answer = self.client.get("/", headers=headers())
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(answer.content, b"hello alice@example.com")

    # A page everyone may see is the reason the middleware refuses nothing by itself.
    def test_the_middleware_lets_a_request_with_no_identity_through(self):
        self.assertEqual(self.client.get("/").content, b"hello stranger")

    def test_a_view_that_needs_someone_is_401(self):
        self.assertEqual(self.client.get("/account").status_code, 401)
        self.assertEqual(self.client.get("/account", headers=headers()).status_code, 200)

    def test_too_little_role_is_403(self):
        self.assertEqual(self.client.get("/orders", headers=headers()).status_code, 200)
        self.assertEqual(self.client.get("/orders", headers=headers("viewer")).status_code, 403)

    def test_a_webhook_reaches_its_view_past_the_csrf_check(self):
        client = Client(enforce_csrf_checks=True)
        answer = client.post("/hooks/stripe", headers=webhook_headers())
        self.assertEqual(answer.status_code, 200)
        # The middleware found nobody, and let it through for the view to decide.
        self.assertEqual(answer.content, b"took evt_1, caller None")
        # The CSRF check is on: a view that isn't exempt refuses the same request.
        self.assertEqual(client.post("/form", headers=webhook_headers()).status_code, 403)

    def test_a_webhook_view_refuses_a_person_and_nobody(self):
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.post("/hooks/stripe", headers=headers()).status_code, 401)
        self.assertEqual(client.post("/hooks/stripe").status_code, 401)

    def test_a_person_s_view_refuses_a_webhook(self):
        self.assertEqual(self.client.get("/account", headers=webhook_headers()).status_code, 401)
        self.assertEqual(self.client.get("/", headers=webhook_headers()).content, b"hello stranger")

    def test_it_reads_the_header_out_of_django_s_own_environ(self):
        # Django puts headers in request.META as HTTP_X_JIAYANG_IDENTITY, which is where it looks.
        answer = self.client.get("/account", headers={"x-jiayang-identity": headers()["X-Jiayang-Identity"]})
        self.assertEqual(answer.status_code, 200)


if __name__ == "__main__":
    unittest.main()
