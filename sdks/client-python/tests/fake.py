"""A stand-in for the API: answers by method and path, and keeps every request it was sent."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Union
from urllib.parse import parse_qs, urlsplit

from jiayang_client import Client, Response

TOKEN = "jyu_test"


@dataclass
class Seen:
    method: str
    url: str
    headers: Dict[str, str]
    body: Optional[bytes]

    @property
    def path(self) -> str:
        return urlsplit(self.url).path

    @property
    def query(self) -> Dict[str, List[str]]:
        return parse_qs(urlsplit(self.url).query)

    def json(self) -> Any:
        return json.loads(self.body or b"null")


Handler = Callable[[Seen], Response]


def answer(status: int, body: Any = None, headers: Optional[Dict[str, str]] = None) -> Response:
    data = b"" if body is None else json.dumps(body).encode()
    return Response(status, {"content-type": "application/json", **(headers or {})}, data, "")


def refusal(status: int, error: str, message: str = "", headers: Optional[Dict[str, str]] = None, **extra: Any) -> Response:
    return answer(status, {"error": error, "message": message or error, **extra}, headers)


@dataclass
class Fake:
    routes: Dict[str, Union[Handler, Sequence[Handler]]]
    seen: List[Seen] = field(default_factory=list)
    counts: Dict[str, int] = field(default_factory=dict)

    def __call__(self, method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float) -> Response:
        req = Seen(method, url, dict(headers), body)
        self.seen.append(req)
        key = f"{method} {req.path}"
        n = self.counts.get(key, 0)
        self.counts[key] = n + 1
        route = self.routes.get(key)
        if route is None:
            return refusal(404, "not_found", f"nothing at {key}")
        handler = route[min(n, len(route) - 1)] if isinstance(route, (list, tuple)) else route
        return handler(req)


def fake(routes: Dict[str, Union[Handler, Sequence[Handler]]], **options: Any) -> "tuple[Client, Fake]":
    transport = Fake(routes)
    client = Client(TOKEN, base_url="https://api.example.com", transport=transport, **options)
    client.backoff = lambda n: 0
    client.sleep = lambda s: None
    client.polling.soon = client.polling.every = client.polling.soon_for = 0
    client.polling.look_for = 0.05
    client.polling.after_drop = 0.02
    return client, transport


def version(number: int, status: str = "deployed", **extra: Any) -> Dict[str, Any]:
    return {
        "number": number,
        "sha256": "0" * 64,
        "size_bytes": 10,
        "status": status,
        "active": status == "deployed",
        "created_by": "ada@example.com",
        "created_at": "2026-10-07T10:00:00.123456Z",
        **extra,
    }
