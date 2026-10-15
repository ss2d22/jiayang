from __future__ import annotations

import ipaddress
import json
import os
import re
from pathlib import Path
from typing import Any, Mapping, Optional, Tuple
from urllib.parse import urlsplit

from ._errors import ConfigError

DEFAULT_BASE_URL = "https://api.jiayang.cloud"

#: The longest ``Retry-After`` the client waits out, in seconds.
RETRY_AFTER_CAP = 60


def config_dir(env: Mapping[str, str], windows: bool) -> Optional[Path]:
    """Where the CLI keeps its config: the same places, in the same order, as ``jiayang`` looks."""

    def var(name: str) -> Optional[str]:
        value = env.get(name)
        return value or None

    if var("JIAYANG_CONFIG_DIR"):
        return Path(env["JIAYANG_CONFIG_DIR"])
    if var("XDG_CONFIG_HOME"):
        return Path(env["XDG_CONFIG_HOME"]) / "jiayang"
    if windows:
        if var("APPDATA"):
            return Path(env["APPDATA"]) / "jiayang"
        if var("USERPROFILE"):
            return Path(env["USERPROFILE"]) / ".config" / "jiayang"
    if var("HOME"):
        return Path(env["HOME"]) / ".config" / "jiayang"
    return None


def read_cli_config(directory: Optional[os.PathLike[str] | str] = None) -> Optional[dict[str, Any]]:
    """The CLI's config.json, or None when there is none."""
    where = Path(directory) if directory is not None else config_dir(os.environ, os.name == "nt")
    if where is None:
        return None
    path = where / "config.json"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        config = json.loads(text)
    except ValueError:
        raise ConfigError(f"{path} isn't valid JSON. Run `jiayang login` to write it again.") from None
    return config if isinstance(config, dict) else None


# Tokens that are ours but aren't for the API, and what to use them for instead.
_NOT_FOR_THE_API = {
    "jyb_": "That's an app's bypass token. It calls the app, not the API. Use a CLI session: run `jiayang login`.",
    "jya_": "That's an agent's credential. It calls the apps the agent was granted, not the API.",
    "jys_": "That's a browser session. Use a CLI session: run `jiayang login`.",
    "jyd_": "That's a sign-in code the CLI polls with, not a session.",
    "jym_": "That's a SCIM token. Your identity provider uses it, at /scim/v2.",
    "jyo_": "That's an AI client's token for an MCP server app, not for the API.",
    "jyr_": "That's an AI client's refresh token, not for the API.",
}


def check_token(token: str) -> str:
    """Refuses a token that can't work here, before it goes anywhere."""
    trimmed = token.strip()
    if not trimmed:
        raise ConfigError("The token is empty.")
    if not re.fullmatch(r"[\x21-\x7e]+", trimmed):
        raise ConfigError("The token has characters no token of ours has.")
    said = _NOT_FOR_THE_API.get(trimmed[:4])
    if said:
        raise ConfigError(said)
    return trimmed


def check_base_url(raw: str) -> str:
    """The address, if it's one a token may go to: https, or plain http to this machine only."""
    try:
        url = urlsplit(raw)
        host = url.hostname or ""
        url.port  # noqa: B018 - a bad port raises here
    except ValueError:
        raise ConfigError(f"{raw} isn't a web address. It looks like {DEFAULT_BASE_URL}.") from None
    if url.scheme not in ("http", "https") or not host:
        raise ConfigError(f"{raw} isn't an http or https address. It looks like {DEFAULT_BASE_URL}.")
    if url.scheme == "http" and not is_local(host):
        raise ConfigError(
            f"{raw} isn't https, so anyone on the network could read the token sent there. Plain http is "
            "only allowed for localhost and loopback addresses."
        )
    if url.username or url.password or url.query or url.fragment:
        raise ConfigError(f"{raw} should be just the API's address, like {DEFAULT_BASE_URL}.")
    return raw.rstrip("/")


def same_origin(a: str, b: str) -> bool:
    """Whether two checked addresses are the same scheme, host and port."""

    def origin(raw: str) -> Tuple[str, str, int]:
        url = urlsplit(raw)
        scheme = url.scheme.lower()
        return (scheme, (url.hostname or "").lower(), url.port or (443 if scheme == "https" else 80))

    return origin(a) == origin(b)


def is_local(host: str) -> bool:
    """localhost, a name under it, or a loopback address."""
    host = host.lower().strip("[]")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False
