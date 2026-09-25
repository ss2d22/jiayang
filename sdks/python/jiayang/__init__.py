"""Verifies the X-Jiayang-Identity token the edge sends your app.

X-Jiayang-Email and X-Jiayang-Role are display-only. Don't authorize on them.

    from jiayang import require_user, Unauthorized

    # Flask
    @app.get("/")
    def index():
        try:
            user = require_user(request.headers)
        except Unauthorized:
            return "unauthorized", 401
        return f"hello {user.email}"

    # Django passes request.META. FastAPI and Starlette pass request.headers.

A webhook delivery on a verified public path carries a token too, of its own kind:
`require_webhook(request.headers, provider="stripe")` checks it, and `require_user` refuses it.

Needs JIAYANG_APP_ID, JIAYANG_IDENTITY_ISSUER and JIAYANG_JWKS_URL, which the platform sets.
Without them every request is refused.

Docs: https://jiayang.cloud/docs/sdks/python/
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import threading
import time
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Final, Literal

import jwt
from jwt.algorithms import RSAAlgorithm

__all__ = [
    "IDENTITY_HEADER",
    "PROVIDERS",
    "Config",
    "Forbidden",
    "KeySet",
    "Provider",
    "Role",
    "Unauthorized",
    "User",
    "Webhook",
    "has_role",
    "require_role",
    "require_user",
    "require_webhook",
    "verify_identity",
    "verify_webhook",
]

__version__ = "0.1.1"

IDENTITY_HEADER = "x-jiayang-identity"
ALGORITHM = "RS256"
MAX_AGE_SECONDS = 300
COOLDOWN_SECONDS = 10
RETRY_SECONDS = 1
FETCH_TIMEOUT_SECONDS = 3
MAX_JWKS_BYTES = 1 << 20
MIN_RSA_BITS = 2048


class Unauthorized(Exception):
    """No valid identity for this app. Respond with 401."""

    status = 401


class Forbidden(Exception):
    """The caller is who they say they are, but not allowed to do this. Respond with 403."""

    status = 403

    def __init__(self, needed: str) -> None:
        super().__init__(f"this needs {needed}")
        self.needed = needed

    @property
    def body(self) -> str:
        """`forbidden: this needs editor`: the plain-text 403 every SDK answers."""
        return f"forbidden: {self}"


@dataclass(frozen=True)
class User:
    kind: str
    """ "user" for a person, "service" for a bypass token."""
    sub: str
    """Stable id. The person's platform id ("usr_…"), or "service:<token id>"."""
    email: str | None
    """None for service tokens."""
    role: str
    workspace_id: str


Role = Literal["viewer", "editor", "owner"]
"""What a caller may do with this app. Ordered: an owner can do what an editor can."""

_RANK: Final[Mapping[str, int]] = {"viewer": 1, "editor": 2, "owner": 3}


def has_role(user: User, least: Role) -> bool:
    """Whether the caller has at least this much.

    A role this version doesn't know counts for nothing, on either side: if the platform ever adds
    one, an app built against an older SDK refuses rather than guessing what it allows, and asking
    for a role that doesn't exist refuses too rather than raising in the middle of a request.
    """
    need = _RANK.get(least)
    return need is not None and _RANK.get(user.role, 0) >= need


def require_role(user: User, least: Role) -> None:
    """Like `has_role`, but raises `Forbidden` so a handler can answer with it."""
    if not has_role(user, least):
        raise Forbidden(least)


Provider = Literal["stripe", "github", "slack", "shopify", "standard_webhooks", "hmac_sha256"]
"""Who signs the webhooks the platform can check for you."""

PROVIDERS: Final[frozenset[str]] = frozenset(("stripe", "github", "slack", "shopify", "standard_webhooks", "hmac_sha256"))


@dataclass(frozen=True)
class Webhook:
    """A delivery whose signature the platform checked before it reached your app, on a public path
    with a verifier. Not a person: it has no email and no role."""

    provider: str
    pattern: str
    """The public path pattern it arrived on, such as "/hooks/stripe"."""
    delivery: str | None
    """The provider's signed id for this delivery, where it signs one. Dedupe on it."""
    signed_at: int | None
    """When the provider signed it, in unix seconds, where it signs a time."""
    workspace_id: str


@dataclass(frozen=True)
class Config:
    app_id: str
    issuer: str
    jwks_url: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Config:
        env = os.environ if env is None else env
        app_id, issuer, jwks_url = (env.get(n, "") for n in ("JIAYANG_APP_ID", "JIAYANG_IDENTITY_ISSUER", "JIAYANG_JWKS_URL"))
        if not (app_id and issuer and jwks_url):
            # Deny if any are missing, since there's nothing to check the token against.
            raise Unauthorized("JIAYANG_APP_ID, JIAYANG_IDENTITY_ISSUER and JIAYANG_JWKS_URL must be set")
        return cls(app_id, issuer, jwks_url)


Fetch = Callable[[str], bytes]


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    # Keys come only from the configured URL. A redirect could go anywhere, even plain http.
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201, ARG002
        raise OSError(f"JWKS redirected ({code})")


_opener = urllib.request.build_opener(_NoRedirects)

# Said outright rather than left to urllib. Cloudflare's Browser Integrity Check refuses urllib's
# own "Python-urllib/3.x" with a 403, and a key set that can't be fetched refuses everyone.
_USER_AGENT = f"jiayang-python/{__version__}"


def _fetch(url: str) -> bytes:
    # timeout only bounds each read. The deadline stops a server trickling bytes from stalling us.
    deadline = time.monotonic() + FETCH_TIMEOUT_SECONDS
    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with _opener.open(request, timeout=FETCH_TIMEOUT_SECONDS) as res:
        if res.status != 200:
            raise OSError(f"JWKS answered {res.status}")
        body = b""
        while chunk := res.read(64 * 1024):
            body += chunk
            if len(body) > MAX_JWKS_BYTES:
                raise OSError("JWKS too large")
            if time.monotonic() > deadline:
                raise OSError("JWKS fetch too slow")
    return body


class KeySet:
    """The edge's public keys, cached for five minutes.

    An unknown kid triggers a refetch at most every ten seconds, so made-up kids can't cause a
    fetch storm. If the keys can't be fetched, verification fails.
    """

    def __init__(self, url: str, fetch: Fetch | None = None, clock: Callable[[], float] = time.monotonic) -> None:
        self._url = url
        self._fetch = fetch or _fetch
        self._clock = clock
        self._lock = threading.Lock()
        self._waiters: Any = None
        self._keys: dict[str, Any] = {}
        self._fetched_at: float | None = None
        self._attempted_at: float | None = None

    def _fresh(self, now: float) -> bool:
        return self._fetched_at is not None and now - self._fetched_at < MAX_AGE_SECONDS

    def key(self, kid: str) -> Any:
        # Lock-free fast path, so a known kid never waits on a refetch for another.
        keys = self._keys
        if kid in keys and self._fresh(self._clock()):
            return keys[kid]
        with self._lock:
            now = self._clock()
            fresh = self._fresh(now)
            since = None if self._attempted_at is None else now - self._attempted_at
            # Retry stale keys after a second and an unknown kid after ten.
            due = since is None or since >= (COOLDOWN_SECONDS if fresh else RETRY_SECONDS)
            if (not fresh or kid not in self._keys) and due:
                self._attempted_at = now
                try:
                    self._keys = _parse_jwks(self._fetch(self._url))
                    self._fetched_at = now
                except Exception:  # noqa: BLE001 - any failure to get keys is a denial
                    if not fresh:
                        self._keys = {}
            if not self._fresh(now):
                raise Unauthorized("couldn't fetch the identity keys")
            key = self._keys.get(kid)
        if key is None:
            raise Unauthorized("unknown signing key")
        return key

    async def akey(self, kid: str) -> Any:
        """`key`, for an app that can't block its event loop.

        The fetch is the only slow part, so it goes to a thread, one at a time: the coroutines
        that want the same missing kid wait on each other rather than each taking a thread of
        their own. Everything about when to fetch and what counts as usable is `key`'s.
        """
        keys = self._keys
        if kid in keys and self._fresh(self._clock()):
            return keys[kid]
        # Made here rather than in __init__: a key set is often built before there's a loop, and
        # an asyncio.Lock belongs to the loop that first awaits it.
        if self._waiters is None:
            self._waiters = asyncio.Lock()
        async with self._waiters:
            keys = self._keys
            if kid in keys and self._fresh(self._clock()):
                return keys[kid]
            return await asyncio.to_thread(self.key, kid)


def _parse_jwks(body: bytes) -> dict[str, Any]:
    doc = json.loads(body)
    keys: dict[str, Any] = {}
    for jwk in doc.get("keys", []) if isinstance(doc, dict) else []:
        if not isinstance(jwk, dict) or jwk.get("kty") != "RSA" or not isinstance(jwk.get("kid"), str):
            continue
        if jwk.get("use", "sig") != "sig" or jwk.get("alg", ALGORITHM) != ALGORITHM:
            continue
        public = {k: jwk[k] for k in ("kty", "n", "e") if k in jwk}
        try:
            key = RSAAlgorithm.from_jwk(public)
        except Exception:  # noqa: BLE001, S112 - a key we can't read verifies nothing
            continue
        if getattr(key, "key_size", 0) >= MIN_RSA_BITS:
            keys[jwk["kid"]] = key
    return keys


_key_sets: dict[str, KeySet] = {}
_key_sets_lock = threading.Lock()


def _key_set(url: str) -> KeySet:
    with _key_sets_lock:
        found = _key_sets.get(url)
        if found is None:
            found = _key_sets[url] = KeySet(url)
        return found


def _header(headers: Mapping[str, Any]) -> str | None:
    """Finds X-Jiayang-Identity in headers of any case, or in a WSGI environ."""
    for name in (IDENTITY_HEADER, "X-Jiayang-Identity", "HTTP_X_JIAYANG_IDENTITY"):
        value = headers.get(name)
        if value:
            return str(value)
    for name, value in headers.items():
        if isinstance(name, str) and name.lower() in (IDENTITY_HEADER, "http_x_jiayang_identity") and value:
            return str(value)
    return None


def require_user(headers: Mapping[str, Any], config: Config | None = None, **options: Any) -> User:
    """Returns the verified caller or raises Unauthorized."""
    token = _header(headers)
    if not token:
        raise Unauthorized("no identity token")
    return verify_identity(token, config, **options)


def verify_identity(
    token: str,
    config: Config | None = None,
    *,
    now: float | None = None,
    keys: KeySet | None = None,
) -> User:
    """Checks an identity token's signature, issuer, audience, expiry and claims."""
    config = config or Config.from_env()
    kid = _kid(token)
    key = (keys or _key_set(config.jwks_url)).key(kid)
    return _verified(token, key, config, now)


def require_webhook(
    headers: Mapping[str, Any],
    config: Config | None = None,
    *,
    provider: str | Iterable[str],
    **options: Any,
) -> Webhook:
    """Returns the webhook the platform verified for this request, or raises Unauthorized.

    `provider` names the one this route takes, or several. A delivery from any other is refused, and
    so is every delivery when none is named. A person's or a bypass token's identity is refused here,
    as a webhook's is by `require_user`.
    """
    token = _header(headers)
    if not token:
        raise Unauthorized("no identity token")
    return verify_webhook(token, config, provider=provider, **options)


def verify_webhook(
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
    key = (keys or _key_set(config.jwks_url)).key(kid)
    return _webhook(token, key, config, now, wanted)


def _providers(provider: object) -> tuple[object, ...]:
    """The providers a route takes, refusing before anything is fetched when there are none.

    A bare string is one name, never a sequence of letters.
    """
    if isinstance(provider, str):
        wanted: tuple[object, ...] = (provider,)
    else:
        try:
            wanted = tuple(provider)  # type: ignore[call-overload]
        except TypeError:
            wanted = ()
    if not wanted:
        raise Unauthorized("no provider named")
    return wanted


def _kid(token: str) -> str:
    """Which key signed this, read from the part of the token nobody has checked yet."""
    if not isinstance(token, str) or token.count(".") != 2:
        raise Unauthorized("invalid identity token")
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as err:
        raise Unauthorized("invalid identity token") from err
    kid = header.get("kid")
    # Pinned so the token's own alg header can't pick the algorithm.
    if header.get("alg") != ALGORITHM or not isinstance(kid, str):
        raise Unauthorized("invalid identity token")
    return kid


def _claims(token: str, key: Any, config: Config, now: float | None, audience: str) -> dict[str, Any]:
    """The checks every token gets, whoever it's for: signature, issuer, audience, times, claim names."""
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=[ALGORITHM],
            audience=audience,
            issuer=config.issuer,
            # Checked below against a single clock that tests can set.
            options={"require": ["exp", "iat", "sub", "iss", "aud"], "verify_exp": False, "verify_nbf": False, "verify_iat": False},
        )
    except jwt.PyJWTError as err:
        raise Unauthorized("invalid identity token") from err

    # Go's JSON decoder matches "EXP" to exp, so every SDK refuses names like it to stay in step.
    if any(name.lower() in _CLAIM_NAMES and name not in _CLAIM_NAMES for name in claims):
        raise Unauthorized("invalid identity token")

    at = time.time() if now is None else now
    exp, nbf, iat = claims.get("exp"), claims.get("nbf"), claims.get("iat")
    if not _number(exp) or not _number(iat) or at >= exp:
        raise Unauthorized("invalid identity token")
    if nbf is not None and (not _number(nbf) or at < nbf):
        raise Unauthorized("invalid identity token")
    return claims


def _verified(token: str, key: Any, config: Config, now: float | None) -> User:
    claims = _claims(token, key, config, now, config.app_id)
    kind, sub, email, role, wid = (claims.get(k) for k in ("kind", "sub", "email", "role", "wid"))
    if kind not in ("user", "service") or not isinstance(sub, str) or sub == "":
        raise Unauthorized("invalid identity token")
    if kind == "user" and not isinstance(email, str):
        raise Unauthorized("invalid identity token")
    if not isinstance(role, str) or not isinstance(wid, str):
        raise Unauthorized("invalid identity token")
    return User(kind=kind, sub=sub, email=email if kind == "user" else None, role=role, workspace_id=wid)


# A webhook's token is addressed to "webhook:<app id>", never to the app id alone, so a check
# written for people can't take a delivery for someone signed in.
_WEBHOOK_AUDIENCE = "webhook:"


def _webhook(token: str, key: Any, config: Config, now: float | None, wanted: tuple[object, ...]) -> Webhook:
    claims = _claims(token, key, config, now, _WEBHOOK_AUDIENCE + config.app_id)
    aud, kind, sub, wid, provider, pattern = (claims.get(k) for k in ("aud", "kind", "sub", "wid", "provider", "pattern"))
    # PyJWT takes a list holding our audience as well. The edge writes a single string.
    if not isinstance(aud, str) or kind != "webhook" or not isinstance(sub, str) or sub == "" or not isinstance(wid, str):
        raise Unauthorized("invalid webhook token")
    # A provider this version doesn't know matches nothing, even when the caller lists it.
    if not isinstance(provider, str) or provider not in PROVIDERS or provider not in wanted:
        raise Unauthorized("not a webhook this route takes")
    if not isinstance(pattern, str) or pattern == "":
        raise Unauthorized("invalid webhook token")

    # Left out where the provider signs no id or no time. When there, each is what the edge writes.
    delivery, signed_at = claims.get("delivery"), claims.get("signed_at")
    if "delivery" in claims and (not isinstance(delivery, str) or delivery == ""):
        raise Unauthorized("invalid webhook token")
    if "signed_at" in claims and not _whole(signed_at):
        raise Unauthorized("invalid webhook token")
    return Webhook(
        provider=provider,
        pattern=pattern,
        delivery=delivery,
        signed_at=None if signed_at is None else int(signed_at),
        workspace_id=wid,
    )


# The edge's claim names, in the case it writes them.
_CLAIM_NAMES = frozenset(
    {"iss", "aud", "sub", "exp", "iat", "nbf", "jti", "kind", "email", "role", "wid", "provider", "pattern", "delivery", "signed_at"}
)

# Beyond this a JSON number may not be the integer that was written, in every language reading it.
_MAX_EXACT = 2**53 - 1


def _number(value: Any) -> bool:
    # json accepts Infinity and NaN, and an exp of Infinity would never expire.
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _whole(value: Any) -> bool:
    """A whole, non-negative number of seconds. JSON has one number type, so 5.0 is 5 here as it is in
    the SDKs that can't tell them apart."""
    if not _number(value) or (isinstance(value, float) and not value.is_integer()):
        return False
    return 0 <= value <= _MAX_EXACT
