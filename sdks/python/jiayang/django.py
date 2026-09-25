"""Django.

    MIDDLEWARE = ["jiayang.django.JiayangMiddleware", ...]

    from jiayang.django import login_required, role_required

    def index(request):
        user = request.jiayang_user            # None when nobody was vouched for
        return HttpResponse(f"hello {user.email if user else 'stranger'}")

    @login_required
    def account(request): ...

    @role_required("editor")
    def place_order(request): ...

    @webhook_required(provider="stripe")
    def stripe_hook(request):
        event = json.loads(request.body)

The middleware only verifies and records. Nothing is refused until a view says it needs someone,
so an app can have a public page and a private one without two middlewares.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from functools import wraps
from typing import Any, TypeVar, cast

from django.http import HttpRequest, HttpResponse, HttpResponseForbidden
from django.views.decorators.csrf import csrf_exempt

from . import Config, Forbidden, Unauthorized, User, has_role
from . import require_user as _require_user
from . import require_webhook as _require_webhook

__all__ = ["JiayangMiddleware", "get_user", "login_required", "role_required", "webhook_required"]

View = TypeVar("View", bound=Callable[..., Any])


class JiayangMiddleware:
    """Sets `request.jiayang_user` to the verified caller, or None."""

    config: Config | None = None

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        request.jiayang_user = get_user(request, self.config)  # type: ignore[attr-defined]
        return self.get_response(request)


def get_user(request: HttpRequest, config: Config | None = None) -> User | None:
    """The verified caller, or None. Reads Django's own `request.META`."""
    try:
        return _require_user(request.META, config)
    except Unauthorized:
        return None


def _caller(request: HttpRequest, config: Config | None) -> User | None:
    # Whatever the middleware found, or work it out here for an app that doesn't install it.
    found = getattr(request, "jiayang_user", None)
    return found if found is not None else get_user(request, config)


def login_required(view: View | None = None, *, config: Config | None = None) -> Any:
    """Refuses anyone the platform hasn't vouched for. 401."""

    def decorate(view: View) -> View:
        @wraps(view)
        def wrapper(request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
            if _caller(request, config) is None:
                return HttpResponse("unauthorized", status=401)
            return cast(HttpResponse, view(request, *args, **kwargs))

        return cast(View, wrapper)

    return decorate if view is None else decorate(view)


def role_required(least: str, *, config: Config | None = None) -> Callable[[View], View]:
    """Refuses a caller who may not do this. 403, or 401 if there's no caller at all."""

    def decorate(view: View) -> View:
        @wraps(view)
        def wrapper(request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
            user = _caller(request, config)
            if user is None:
                return HttpResponse("unauthorized", status=401)
            if not has_role(user, least):  # type: ignore[arg-type]
                return HttpResponseForbidden(Forbidden(least).body, content_type="text/plain; charset=utf-8")
            return cast(HttpResponse, view(request, *args, **kwargs))

        return cast(View, wrapper)

    return decorate


def webhook_required(*, provider: str | Iterable[str], config: Config | None = None) -> Callable[[View], View]:
    """Refuses everything but a delivery the platform verified from this provider (or these), and
    sets `request.jiayang_webhook` for the view. Anything else is 401.

    The view is exempt from Django's CSRF check: a provider has no CSRF token to send, and the
    platform's token is what lets a delivery in. A browser's request carries no webhook token, so
    it's refused here instead.
    """

    def decorate(view: View) -> View:
        @wraps(view)
        def wrapper(request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
            try:
                request.jiayang_webhook = _require_webhook(request.META, config, provider=provider)  # type: ignore[attr-defined]
            except Unauthorized:
                return HttpResponse("unauthorized", status=401)
            return cast(HttpResponse, view(request, *args, **kwargs))

        return cast(View, csrf_exempt(wrapper))

    return decorate
