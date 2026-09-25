"""Streamlit.

    from jiayang.streamlit import get_user

    user = get_user()
    if user is None:
        st.error("sign in to use this")
        st.stop()
    st.write(f"hello {user.email}")

Verified once per session, then remembered. Streamlit only sees the headers of the request that
opened the session (after that the page talks over a WebSocket), and an identity token is good
for sixty seconds, so checking it again on the next rerun would refuse a caller who never left.

Nothing is lost by remembering it: the edge closes the connection within a minute of someone's
access being taken away, and the script stops with it. `jiayang dev` has no such watcher, so a
session there keeps whoever it opened as until the page is reloaded.
"""

from __future__ import annotations

from typing import Any

from . import Config, Unauthorized, User
from . import require_user as _require_user

__all__ = ["get_user", "require_user"]

_IN_SESSION = "_jiayang_user"


def _streamlit() -> Any:
    import streamlit

    return streamlit


def require_user(config: Config | None = None) -> User:
    """The verified caller, or raises Unauthorized."""
    st = _streamlit()
    state = st.session_state
    found = state.get(_IN_SESSION)
    if found is None:
        # Not remembered on failure: a refusal should be reconsidered, not cached.
        found = state[_IN_SESSION] = _require_user(st.context.headers, config)
    return found


def get_user(config: Config | None = None) -> User | None:
    """The verified caller, or None. For a page that would rather render than refuse."""
    try:
        return require_user(config)
    except Unauthorized:
        return None
