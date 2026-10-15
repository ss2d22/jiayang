from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ._types import PlanLimitHit, Version


class JiayangError(Exception):
    """Everything this client raises on purpose is one of these."""


class ConfigError(JiayangError):
    """The client can't start: no token, a token that isn't for the API, or an address that isn't https."""


class ConnectionFailedError(JiayangError):
    """The request never got an answer: no connection, or it dropped."""


class RequestTimeoutError(JiayangError):
    """The platform didn't answer in time. A change may still have been made."""


class ApiError(JiayangError):
    """The platform answered with an error. ``code`` is its stable name for it, like ``not_found``.

    ``code`` is empty when the answer wasn't the platform's own, from a proxy on the way, say.
    ``retry_after`` is how many seconds to wait before asking again, when the platform said.
    ``request_id`` traces a failure on our side: quote it when you contact support.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        retry_after: Optional[int] = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after
        self.request_id = request_id


class BadRequestError(ApiError):
    """400: the request isn't valid. The message says what to change."""


class AuthenticationError(ApiError):
    """401: no session, or one that has ended or been revoked. Sign in again with ``jiayang login``."""


class PermissionDeniedError(ApiError):
    """403: you can't do this, or a CLI session can't (paying, deleting a workspace)."""


class PlanLimitError(PermissionDeniedError):
    """403 ``plan_limit`` or ``contact_sales``: the workspace's plan doesn't allow one more."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        request_id: Optional[str] = None,
        limit: Optional[PlanLimitHit] = None,
    ) -> None:
        super().__init__(status, code, message, None, request_id)
        self.limit = limit


class NotFoundError(ApiError):
    """404: nothing there, or nothing you may see. The platform answers the two the same way."""


class ConflictError(ApiError):
    """409: it clashes with what's there, like a name in use or a version still going live."""


class PayloadTooLargeError(ApiError):
    """413: the upload is too large."""


class RateLimitError(ApiError):
    """429: too many requests for now. ``retry_after`` says how long to wait."""


class ServerError(ApiError):
    """5xx: a fault on our side or on the way. Reads are tried again before this is raised."""


class DeployFailedError(JiayangError):
    """A deploy whose version didn't go live. ``version`` says which, and the message why."""

    def __init__(self, version: Version) -> None:
        super().__init__(
            version.get("failure") or f"Version {version['number']} was uploaded but couldn't go live."
        )
        self.version = version


_BY_STATUS = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    413: PayloadTooLargeError,
    429: RateLimitError,
}


def api_error(
    status: int,
    code: str,
    message: str,
    retry_after: Optional[int],
    request_id: Optional[str],
    limit: Optional[PlanLimitHit],
) -> ApiError:
    """The right class for an error answer."""
    if status == 403 and code in ("plan_limit", "contact_sales"):
        return PlanLimitError(status, code, message, request_id, limit)
    kind = _BY_STATUS.get(status) or (ServerError if status >= 500 else ApiError)
    return kind(status, code, message, retry_after, request_id)
