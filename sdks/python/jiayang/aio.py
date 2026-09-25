"""The same verification, for an app that can't block its event loop.

    from jiayang.aio import require_user

    @app.get("/")
    async def index(request: Request):
        user = await require_user(request.headers)
        return f"hello {user.email}"

Only fetching the keys blocks, and that happens once every five minutes at most, so that goes to
a thread and the rest stays on the loop. Everything else is `jiayang`'s: the same rules, the same
refusals, the same tests.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from . import Config, KeySet, Unauthorized, User, Webhook, _header, _key_set, _kid, _providers, _verified, _webhook

__all__ = ["require_user", "require_webhook", "verify_identity", "verify_webhook"]


async def require_user(headers: Mapping[str, Any], config: Config | None = None, **options: Any) -> User:
    """Returns the verified caller or raises Unauthorized."""
    token = _header(headers)
    if not token:
        raise Unauthorized("no identity token")
    return await verify_identity(token, config, **options)


async def verify_identity(
    token: str,
    config: Config | None = None,
    *,
    now: float | None = None,
    keys: KeySet | None = None,
) -> User:
    """Checks an identity token's signature, issuer, audience, expiry and claims."""
    config = config or Config.from_env()
    kid = _kid(token)
    key = await (keys or _key_set(config.jwks_url)).akey(kid)
    return _verified(token, key, config, now)


async def require_webhook(
    headers: Mapping[str, Any],
    config: Config | None = None,
    *,
    provider: str | Iterable[str],
    **options: Any,
) -> Webhook:
    """Returns the webhook the platform verified for this request, or raises Unauthorized."""
    token = _header(headers)
    if not token:
        raise Unauthorized("no identity token")
    return await verify_webhook(token, config, provider=provider, **options)


async def verify_webhook(
    token: str,
    config: Config | None = None,
    *,
    provider: str | Iterable[str],
    now: float | None = None,
    keys: KeySet | None = None,
) -> Webhook:
    """Like `require_webhook`, for a token you already have."""
    wanted = _providers(provider)
    config = config or Config.from_env()
    kid = _kid(token)
    key = await (keys or _key_set(config.jwks_url)).akey(kid)
    return _webhook(token, key, config, now, wanted)
