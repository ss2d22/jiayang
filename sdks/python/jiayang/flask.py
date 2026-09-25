"""Flask.

    from jiayang.flask import current_user, login_required

    @app.get("/")
    @login_required
    def index():
        return f"hello {current_user.email}"

    @app.post("/orders")
    @login_required(role="editor")
    def place_order():
        ...

    @app.post("/hooks/stripe")
    @webhook_required(provider="stripe")
    def stripe_hook():
        event = request.get_json()
        ...

A refused request never reaches the view: no identity is 401, too little role is 403.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from functools import wraps
from typing import Any, TypeVar, cast

from flask import g, request
from werkzeug.local import LocalProxy

from . import Config, Forbidden, Role, Unauthorized, User, Webhook, require_role
from . import require_user as _require_user
from . import require_webhook as _require_webhook

__all__ = ["current_user", "get_user", "get_webhook", "login_required", "webhook_required"]

_ON_G = "jiayang_user"
_WEBHOOK_ON_G = "jiayang_webhook"

View = TypeVar("View", bound=Callable[..., Any])


def _verified(config: Config | None) -> User:
    """The caller for this request, verified once however many times the view asks."""
    found = getattr(g, _ON_G, None)
    if found is None:
        found = _require_user(request.headers, config)
        setattr(g, _ON_G, found)
    return cast(User, found)


def login_required(view: View | None = None, *, role: Role | None = None, config: Config | None = None) -> Any:
    """Refuses anyone the platform hasn't vouched for, and sets `current_user` for the rest.

    Usable bare (`@login_required`) or called (`@login_required(role="editor")`).
    """

    def decorate(view: View) -> View:
        @wraps(view)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            try:
                user = _verified(config)
                if role:
                    require_role(user, role)
            except Unauthorized:
                return "unauthorized", 401
            except Forbidden as err:
                return f"forbidden: {err.needed}", 403
            return view(*args, **kwargs)

        return cast(View, wrapper)

    return decorate if view is None else decorate(view)


def get_user(config: Config | None = None) -> User | None:
    """The verified caller, or None. For a view that would rather render than refuse."""
    try:
        return _verified(config)
    except Unauthorized:
        return None


def _current() -> User:
    found = getattr(g, _ON_G, None)
    if found is None:
        raise RuntimeError("current_user needs @login_required on this view, or call get_user()")
    return cast(User, found)


current_user: User = cast(User, LocalProxy(_current))
"""The caller `@login_required` verified. Raises if it didn't run: a view asking who is calling
should never be reached without an answer."""


def webhook_required(*, provider: str | Iterable[str], config: Config | None = None) -> Callable[[View], View]:
    """Refuses everything but a delivery the platform verified from this provider (or these), and
    sets `g.jiayang_webhook` for the view. Anything else is 401."""

    def decorate(view: View) -> View:
        @wraps(view)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            try:
                setattr(g, _WEBHOOK_ON_G, _require_webhook(request.headers, config, provider=provider))
            except Unauthorized:
                return "unauthorized", 401
            return view(*args, **kwargs)

        return cast(View, wrapper)

    return decorate


def get_webhook() -> Webhook:
    """The delivery `@webhook_required` verified. Raises if it didn't run on this view."""
    found = getattr(g, _WEBHOOK_ON_G, None)
    if found is None:
        raise RuntimeError("get_webhook() needs @webhook_required on this view")
    return cast(Webhook, found)
