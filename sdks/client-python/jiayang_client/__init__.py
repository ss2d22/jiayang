"""A client for the Jiayang Cloud API: deploy, share, read the audit log and manage tokens from code.

>>> from jiayang_client import Client
>>> jy = Client()  # the session `jiayang login` saved, or JIAYANG_TOKEN
>>> jy.access.share("acme", "payroll", "ada@example.com", role="editor")
"""

from ._client import Answer, Client, Polling
from ._errors import (
    ApiError,
    AuthenticationError,
    BadRequestError,
    ConfigError,
    ConflictError,
    ConnectionFailedError,
    DeployFailedError,
    JiayangError,
    NotFoundError,
    PayloadTooLargeError,
    PermissionDeniedError,
    PlanLimitError,
    RateLimitError,
    RequestTimeoutError,
    ServerError,
)
from ._http import Response, Transport
from ._version import __version__

__all__ = [
    "Answer",
    "ApiError",
    "AuthenticationError",
    "BadRequestError",
    "Client",
    "ConfigError",
    "ConflictError",
    "ConnectionFailedError",
    "DeployFailedError",
    "JiayangError",
    "NotFoundError",
    "PayloadTooLargeError",
    "PermissionDeniedError",
    "PlanLimitError",
    "Polling",
    "RateLimitError",
    "RequestTimeoutError",
    "Response",
    "ServerError",
    "Transport",
    "__version__",
]
