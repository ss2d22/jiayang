"""Sending one request, with nothing but the standard library."""

from __future__ import annotations

import http.client
import socket
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Dict, Optional
from urllib.parse import urlsplit, urlunsplit

from ._config import is_local
from ._errors import ConnectionFailedError, RequestTimeoutError


@dataclass
class Response:
    status: int
    #: Header names in lower case.
    headers: Dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    reason: str = ""


#: ``transport(method, url, headers, body, timeout)``: sends one request and returns its answer, or
#: raises ``ConnectionFailedError`` or ``RequestTimeoutError``. Pass one of your own to ``Client``
#: for a proxy or for tests.
Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float], Response]


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """A redirect would carry the token somewhere else, so none is followed."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def urllib_transport() -> Transport:
    secure = urllib.request.build_opener(_NoRedirects(), urllib.request.HTTPSHandler(context=_tls()))
    # Plain http only ever goes to this machine, and never through a proxy the environment names,
    # which could read the token.
    direct = urllib.request.build_opener(_NoRedirects(), urllib.request.ProxyHandler({}))

    def send(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float) -> Response:
        parts = urlsplit(url)
        opener = direct if is_local(parts.hostname or "") else secure
        # The local platform (`make dev`) answers on names under .localhost, which not every OS
        # resolves. They go to loopback, with the name kept in Host, as the CLI sends them.
        if parts.scheme == "http" and (parts.hostname or "").endswith(".localhost"):
            headers = {**headers, "Host": parts.netloc}
            url = urlunsplit(parts._replace(netloc=f"127.0.0.1:{parts.port}" if parts.port else "127.0.0.1"))
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with opener.open(request, timeout=timeout) as answer:
                return Response(answer.status, _headers(answer.headers), answer.read(), answer.reason or "")
        except urllib.error.HTTPError as answer:
            try:
                data = answer.read()
            except (OSError, http.client.HTTPException):
                data = b""
            return Response(answer.code, _headers(answer.headers), data, answer.reason or "")
        except (socket.timeout, TimeoutError) as err:
            raise RequestTimeoutError(
                f"The API didn't answer {method} {urlsplit(url).path} in time. If it was a change, it may "
                "still have been made."
            ) from err
        except urllib.error.URLError as err:
            if isinstance(err.reason, (socket.timeout, TimeoutError)):
                raise RequestTimeoutError(
                    f"The API didn't answer {method} {urlsplit(url).path} in time. If it was a change, it "
                    "may still have been made."
                ) from err
            raise ConnectionFailedError(f"Couldn't reach the API for {method} {urlsplit(url).path} ({err.reason}).") from err
        except (OSError, http.client.HTTPException) as err:
            raise ConnectionFailedError(f"Couldn't reach the API for {method} {urlsplit(url).path} ({err}).") from err

    return send


def _tls() -> ssl.SSLContext:
    """Trust what the operating system trusts, as the CLI does: its certificate store, with a TLS
    proxy's CA in it included. Python's own default reads only OpenSSL's files, which a Python from
    python.org or uv often doesn't have on macOS and Windows."""
    try:
        import truststore

        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except Exception:  # noqa: BLE001 - truststore missing, or this OS has no store it can read
        return ssl.create_default_context()


def _headers(message) -> Dict[str, str]:  # type: ignore[no-untyped-def]
    return {name.lower(): value for name, value in message.items()} if message is not None else {}
