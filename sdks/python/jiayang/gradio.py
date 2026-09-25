"""Gradio.

    from jiayang.gradio import require_user

    def answer(question, request: gr.Request):
        user = require_user(request)
        return f"{user.email} asked: {question}"

    gr.Interface(answer, "textbox", "textbox").launch()

Gradio passes the request to any handler that asks for one by type. It passes None when the
function is reached some other way (through the API, or a cached example), and that is a caller
this app knows nothing about, so it's refused like any other.
"""

from __future__ import annotations

from typing import Any

from . import Config, Unauthorized, User
from . import require_user as _require_user

__all__ = ["get_user", "require_user"]


def require_user(request: Any, config: Config | None = None) -> User:
    """The verified caller behind a `gr.Request`, or raises Unauthorized."""
    headers = getattr(request, "headers", None)
    if headers is None:
        raise Unauthorized("no request to read an identity from")
    return _require_user(headers, config)


def get_user(request: Any, config: Config | None = None) -> User | None:
    """The verified caller, or None. For a handler that answers either way."""
    try:
        return require_user(request, config)
    except Unauthorized:
        return None
