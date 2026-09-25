"""FastAPI (and Starlette).

    from typing import Annotated

    from fastapi import Depends
    from jiayang import User
    from jiayang.fastapi import CurrentUser, requires

    @app.get("/")
    async def index(user: CurrentUser):
        return {"hello": user.email}

    @app.post("/orders")
    async def place_order(user: Annotated[User, Depends(requires("editor"))]):
        ...

    @app.post("/hooks/stripe")
    async def stripe_hook(hook: Annotated[Webhook, Depends(webhook("stripe"))], request: Request):
        event = await request.json()

The dependencies raise HTTPException, so FastAPI answers 401 or 403 and the handler never runs.
Verification is async: fetching the keys doesn't block the loop.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine, Iterable
from typing import Annotated, Any

from fastapi import Depends, HTTPException, Request

from . import Config, Forbidden, Role, Unauthorized, User, Webhook, has_role
from .aio import require_user as _require_user
from .aio import require_webhook as _require_webhook

__all__ = ["CurrentUser", "current_user", "optional_user", "requires", "webhook"]

_ON_STATE = "jiayang_user"


async def _verified(request: Request, config: Config | None = None) -> User:
    """The caller for this request, verified once however many dependencies ask.

    A dependency given a config of its own doesn't share that answer, in either direction: two
    configs are two questions, and the second shouldn't get the first one's answer.
    """
    if config is not None:
        return await _require_user(request.headers, config)
    found = getattr(request.state, _ON_STATE, None)
    if found is None:
        found = await _require_user(request.headers)
        setattr(request.state, _ON_STATE, found)
    return found


async def current_user(request: Request) -> User:
    """A dependency giving the verified caller. 401 if there isn't one."""
    try:
        return await _verified(request)
    except Unauthorized as err:
        raise HTTPException(status_code=401, detail="unauthorized") from err


async def optional_user(request: Request) -> User | None:
    """A dependency giving the verified caller or None, for a route that answers either way."""
    try:
        return await _verified(request)
    except Unauthorized:
        return None


def requires(least: Role, config: Config | None = None) -> Callable[[Request], Coroutine[Any, Any, User]]:
    """A dependency that also refuses a caller who may not do this. 403."""

    async def dependency(request: Request) -> User:
        try:
            user = await _verified(request, config)
        except Unauthorized as err:
            raise HTTPException(status_code=401, detail="unauthorized") from err
        if not has_role(user, least):
            raise HTTPException(status_code=403, detail=str(Forbidden(least))) from None
        return user

    return dependency


def webhook(provider: str | Iterable[str], config: Config | None = None) -> Callable[[Request], Coroutine[Any, Any, Webhook]]:
    """A dependency giving the delivery the platform verified from this provider (or these). 401
    for anything else, a person included."""

    async def dependency(request: Request) -> Webhook:
        try:
            return await _require_webhook(request.headers, config, provider=provider)
        except Unauthorized as err:
            raise HTTPException(status_code=401, detail="unauthorized") from err

    return dependency


CurrentUser = Annotated[User, Depends(current_user)]
"""`async def index(user: CurrentUser)`, so a route says what it needs in its signature."""
