from __future__ import annotations

import json
import os
import random
import re
import time
from datetime import datetime, timezone
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Dict,
    Iterator,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
    Union,
    cast,
)
from urllib.parse import quote, urlencode

from ._config import DEFAULT_BASE_URL, RETRY_AFTER_CAP, check_base_url, check_token, read_cli_config, same_origin
from ._errors import ApiError, ConfigError, JiayangError, api_error
from ._http import Response, Transport, urllib_transport
from ._version import __version__

if TYPE_CHECKING:
    from ._types import (
        Access,
        App,
        AppRole,
        AuditCursor,
        AuditEntry,
        AuditPage,
        CreatedToken,
        DomainGrant,
        Driver,
        EnvUpdated,
        EnvVar,
        Grant,
        GroupGrant,
        Kept,
        Me,
        Member,
        MemberRemoved,
        ScanInput,
        SecretMeta,
        SiteFile,
        Token,
        TokenRole,
        Unshared,
        Version,
        Visibility,
        WorkerModule,
        Workspace,
        WorkspaceRole,
    )

#: The slowest uplink an upload is given time for: half a megabit, as the CLI allows.
_SLOWEST_UPLINK = 64 * 1024
#: 5xx codes that asking again won't fix.
_FINAL_CODES = {"logs_unavailable", "storage_refused", "audit_archive_unavailable", "outcome_unknown"}
_SEGMENT_SAFE = "-_.~@"


def segment(raw: str) -> str:
    """A path segment, written as the CLI writes one. An empty name, ``.`` or ``..`` names nothing."""
    if raw in ("", ".", ".."):
        raise JiayangError(f'"{raw}" isn\'t a name the API has anything under.')
    return quote(raw, safe=_SEGMENT_SAFE)


def ws_path(ws: str) -> str:
    return f"/v1/workspaces/{segment(ws)}"


def app_path(ws: str, app: str) -> str:
    return f"{ws_path(ws)}/apps/{segment(app)}"


class Answer:
    """An answer the client took for a success."""

    def __init__(self, status: int, headers: Dict[str, str], data: Any) -> None:
        self.status = status
        self.headers = headers
        self.data = data


class Polling:
    """How often a deploy looks at its version while it goes live, in seconds. Tests make it short."""

    soon = 1.0
    every = 5.0
    soon_for = 15.0
    look_for = 180.0
    after_drop = 20.0


class Client:
    """A client for the Jiayang Cloud API.

    ``token`` is a CLI session (``jyu_``), or a GitHub Actions run's deploy credential (``jyg_``).
    Left out, it's ``JIAYANG_TOKEN``, then the session ``jiayang login`` saved on this computer.
    ``base_url`` is the API's address: left out, ``JIAYANG_API``, then the one the saved session
    is for, then https://api.jiayang.cloud. ``max_retries`` is how many times a request that's safe
    to repeat is tried again, and ``timeout`` how long the platform gets to answer, in seconds.

    >>> from jiayang_client import Client
    >>> jy = Client()
    >>> for app in jy.apps.list("acme"):
    ...     print(app["slug"], app["url"])
    """

    def __init__(
        self,
        token: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        config_dir: Optional[Union[str, "os.PathLike[str]"]] = None,
        max_retries: int = 2,
        timeout: float = 60.0,
        transport: Optional[Transport] = None,
    ) -> None:
        if token is not None:
            check_token(token)
        if base_url is not None:
            check_base_url(base_url)
        self._token = token
        self._base_url = base_url
        self._config_dir = config_dir
        self._retries = max(0, max_retries)
        self._timeout = timeout
        self._transport = transport or urllib_transport()
        self._settings: Optional[Tuple[str, str]] = None
        #: How long to wait before try ``n`` (0-based), in seconds. Tests make it zero.
        self.backoff: Callable[[int], float] = lambda n: min(8.0, 0.5 * 2**n) * (0.75 + random.random() / 2)
        self.polling = Polling()
        self.sleep: Callable[[float], None] = time.sleep
        self.workspaces = Workspaces(self)
        self.members = Members(self)
        self.apps = Apps(self)
        self.versions = Versions(self)
        self.deploy = Deploys(self)
        self.access = Sharing(self)
        self.tokens = Tokens(self)
        self.audit = Audit(self)
        self.secrets = Secrets(self)
        self.env = Env(self)

    def me(self) -> Me:
        """Who you are, your workspaces, and where apps live."""
        return cast("Me", self.request("GET", "/v1/me", repeatable=True).data)

    @property
    def base_url(self) -> str:
        """The API's address this client sends to."""
        return self._resolve()[1]

    def _resolve(self) -> Tuple[str, str]:
        if self._settings is not None:
            return self._settings
        token = self._token if self._token is not None else (os.environ.get("JIAYANG_TOKEN") or None)
        saved: Optional[str] = None
        if token is None:
            config = read_cli_config(self._config_dir)
            if config and config.get("api_token"):
                ends = config.get("session_expires_at")
                if isinstance(ends, str) and _ended(ends):
                    raise ConfigError("The session `jiayang login` saved has ended. Run `jiayang login` again.")
                if not config.get("api_url"):
                    raise ConfigError(
                        "The session `jiayang login` saved doesn't say which API it's for. Run `jiayang login` again."
                    )
                token = str(config["api_token"])
                saved = check_base_url(str(config["api_url"]))
        if token is None:
            raise ConfigError("No token. Pass `token`, set JIAYANG_TOKEN, or run `jiayang login` on this computer first.")
        asked = self._base_url or os.environ.get("JIAYANG_API") or None
        if saved is None:
            base = check_base_url(asked or DEFAULT_BASE_URL)
        elif asked is None:
            base = saved
        else:
            # A saved session goes only to the API that issued it, as the CLI's own does: an address
            # in the environment may be one someone else put there.
            base = check_base_url(asked)
            if not same_origin(base, saved):
                raise ConfigError(
                    f"base_url or JIAYANG_API is set to {base}, but the session `jiayang login` saved is for "
                    f"{saved}. We only send your session there. Unset both, or pass a token for {base}."
                )
        self._settings = (check_token(token), base)
        return self._settings

    def request(
        self,
        method: str,
        path: str,
        *,
        repeatable: bool,
        query: Optional[Mapping[str, Any]] = None,
        json_body: Any = None,
        body: Optional[bytes] = None,
        content_type: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Answer:
        """Sends one request, trying again when that's safe, and raises ``ApiError`` for an error answer."""
        token, base = self._resolve()
        url = base + path
        pairs = [(k, _query_value(v)) for k, v in (query or {}).items() if v is not None and v is not False]
        if pairs:
            url += "?" + urlencode(pairs)
        sent: Dict[str, str] = {
            "accept": "application/json",
            "authorization": f"Bearer {token}",
            "user-agent": f"jiayang-client-python/{__version__}",
        }
        sent.update(headers or {})
        if json_body is not None:
            body = json.dumps(json_body, separators=(",", ":")).encode()
            sent["content-type"] = "application/json"
        elif content_type is not None:
            sent["content-type"] = content_type
        timeout = self._timeout + len(body or b"") / _SLOWEST_UPLINK

        attempt = 0
        while True:
            try:
                answer = self._transport(method, url, sent, body, timeout)
            except JiayangError:
                if repeatable and attempt < self._retries:
                    self.sleep(self.backoff(attempt))
                    attempt += 1
                    continue
                raise
            if 200 <= answer.status < 300:
                data: Any = None
                if answer.body:
                    try:
                        data = json.loads(answer.body)
                    except ValueError:
                        raise JiayangError(f"The API answered {method} {path} with something that isn't JSON.") from None
                return Answer(answer.status, answer.headers, data)
            error = _error_from(answer)
            # A change that isn't safe to repeat is never sent twice, even after a 429: nothing says
            # every 429 comes before the change is made.
            if error.status == 429:
                worth = repeatable and (error.retry_after is None or error.retry_after <= RETRY_AFTER_CAP)
            else:
                worth = repeatable and (error.status == 408 or (error.status >= 500 and error.code not in _FINAL_CODES))
            if worth and attempt < self._retries:
                self.sleep(float(error.retry_after) if error.retry_after is not None else self.backoff(attempt))
                attempt += 1
                continue
            raise error


def _query_value(value: Any) -> str:
    if value is True:
        return "true"
    return str(value)


def _ended(at: str) -> bool:
    try:
        ends = datetime.fromisoformat(at.replace("Z", "+00:00"))
    except ValueError:
        return False
    if ends.tzinfo is None:
        ends = ends.replace(tzinfo=timezone.utc)
    return ends <= datetime.now(timezone.utc)


def _error_from(answer: Response) -> ApiError:
    code = ""
    message = ""
    limit = None
    try:
        parsed = json.loads(answer.body)
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), str) and isinstance(parsed.get("message"), str):
            code = parsed["error"]
            message = parsed["message"]
            limit = parsed.get("limit")
    except ValueError:
        pass  # Not the platform's own answer: a proxy or a gateway on the way.
    if not message:
        message = f"The API answered {answer.status} {answer.reason}".strip() + "."
    after = answer.headers.get("retry-after", "").strip()
    retry_after = int(after) if after.isdigit() else None

    def usable(value: Optional[str]) -> Optional[str]:
        return value if value and len(value) <= 64 and re.fullmatch(r"[A-Za-z0-9-]+", value) else None

    request_id = usable(answer.headers.get("x-request-id")) or usable(answer.headers.get("cf-ray"))
    return api_error(answer.status, code, message, retry_after, request_id, limit)


class _Resource:
    def __init__(self, client: Client) -> None:
        self._c = client


class Workspaces(_Resource):
    def list(self) -> List[Workspace]:
        """Every workspace you're a member of."""
        return self._c.me()["workspaces"]

    def get(self, ws: str) -> Workspace:
        return cast("Workspace", self._c.request("GET", ws_path(ws), repeatable=True).data)

    def create(self, slug: str, name: str) -> Workspace:
        """A new workspace, on Free, with you as its owner."""
        body = {"slug": slug, "name": name}
        return cast("Workspace", self._c.request("POST", "/v1/workspaces", json_body=body, repeatable=False).data)


class Members(_Resource):
    def list(self, ws: str) -> List[Member]:
        return cast("List[Member]", self._c.request("GET", f"{ws_path(ws)}/members", repeatable=True).data)

    def set(self, ws: str, email: str, role: WorkspaceRole, *, custom_role: Optional[str] = None) -> Member:
        """Adds someone to the workspace, or changes their role."""
        body: Dict[str, Any] = {"role": role}
        if custom_role is not None:
            body["custom_role"] = custom_role
        path = f"{ws_path(ws)}/members/{segment(email)}"
        return cast("Member", self._c.request("PUT", path, json_body=body, repeatable=True).data)

    def remove(self, ws: str, email: str) -> MemberRemoved:
        """Takes someone out of the workspace. Says which apps their domain still lets them into."""
        data = self._c.request("DELETE", f"{ws_path(ws)}/members/{segment(email)}", repeatable=True).data
        return {"still_shared_by_domain": (data or {}).get("still_shared_by_domain", [])}


class Apps(_Resource):
    def list(self, ws: str) -> List[App]:
        return cast("List[App]", self._c.request("GET", f"{ws_path(ws)}/apps", repeatable=True).data)

    def get(self, ws: str, app: str) -> App:
        return cast("App", self._c.request("GET", app_path(ws, app), repeatable=True).data)

    def create(self, ws: str, slug: str, name: str, driver: Driver, *, visibility: Optional[Visibility] = None) -> App:
        body: Dict[str, Any] = {"slug": slug, "name": name, "driver": driver}
        if visibility is not None:
            body["visibility"] = visibility
        return cast("App", self._c.request("POST", f"{ws_path(ws)}/apps", json_body=body, repeatable=False).data)

    def update(
        self,
        ws: str,
        app: str,
        *,
        name: Optional[str] = None,
        visibility: Optional[Visibility] = None,
        mcp: Optional[bool] = None,
    ) -> App:
        """Changes its name, who in the workspace can open it, or whether AI clients may connect."""
        body = {k: v for k, v in (("name", name), ("visibility", visibility), ("mcp", mcp)) if v is not None}
        return cast("App", self._c.request("PATCH", app_path(ws, app), json_body=body, repeatable=True).data)

    def delete(self, ws: str, app: str, *, for_good: bool = False) -> Optional[Kept]:
        """Deletes it. Where the platform keeps deleted apps, says until when it can be restored;
        None when it's gone at once. ``for_good`` skips the keeping."""
        answer = self._c.request("DELETE", app_path(ws, app), query={"for_good": for_good}, repeatable=False)
        return cast("Optional[Kept]", answer.data)


class Versions(_Resource):
    def list(self, ws: str, app: str) -> List[Version]:
        """The app's versions, newest first."""
        return cast("List[Version]", self._c.request("GET", f"{app_path(ws, app)}/versions", repeatable=True).data)

    def rollback(self, ws: str, app: str, version: int) -> Version:
        """Makes an earlier version live again."""
        path = f"{app_path(ws, app)}/rollback"
        return cast("Version", self._c.request("POST", path, json_body={"version": version}, repeatable=True).data)

    def promote(self, ws: str, app: str, version: int) -> Version:
        """Makes a preview live, as it is."""
        return self.rollback(ws, app, version)


class Deploys(_Resource):
    def worker(
        self,
        ws: str,
        app: str,
        *,
        main_module: str,
        compatibility_date: str,
        modules: Mapping[str, WorkerModule],
        compatibility_flags: Sequence[str] = (),
        assets: Optional[Sequence[SiteFile]] = None,
        not_found_handling: Optional[str] = None,
        run_worker_first: Optional[Union[bool, Sequence[str]]] = None,
        preview: bool = False,
        wait: bool = True,
        wait_timeout: float = 30 * 60,
        on_progress: Optional[Callable[[str], None]] = None,
        scan: Optional[ScanInput] = None,
        kv: bool = False,
        queue: Optional[str] = None,
    ) -> Version:
        """Deploys a Worker from modules you've built, and waits for it to go live. ``scan`` is the
        project's lock files and allow file, for the deploy's scan. ``kv`` and ``queue`` (the path
        its messages go to) ask for key-value storage and a queue of the app's own, as
        jiayang.json does, on Team and Business."""
        from ._deploy import deploy_worker

        return deploy_worker(
            self._c,
            ws,
            app,
            main_module=main_module,
            compatibility_date=compatibility_date,
            modules=modules,
            compatibility_flags=compatibility_flags,
            assets=assets,
            not_found_handling=not_found_handling,
            run_worker_first=run_worker_first,
            preview=preview,
            wait=wait,
            wait_timeout=wait_timeout,
            on_progress=on_progress,
            scan=scan,
            kv=kv,
            queue=queue,
        )

    def site(
        self,
        ws: str,
        app: str,
        files: Sequence[SiteFile],
        *,
        not_found_handling: Optional[str] = None,
        preview: bool = False,
        wait: bool = True,
        wait_timeout: float = 30 * 60,
        on_progress: Optional[Callable[[str], None]] = None,
        scan: Optional[ScanInput] = None,
    ) -> Version:
        """Deploys a static site from its files, sending only the ones the platform hasn't got.
        ``scan`` is the project's lock files and allow file, for the deploy's scan."""
        from ._deploy import deploy_site

        return deploy_site(
            self._c,
            ws,
            app,
            files,
            not_found_handling=not_found_handling,
            preview=preview,
            wait=wait,
            wait_timeout=wait_timeout,
            on_progress=on_progress,
            scan=scan,
        )


class Sharing(_Resource):
    def list(self, ws: str, app: str) -> Access:
        """Who the app is shared with: people, domains and groups."""
        base = app_path(ws, app)

        def get(path: str) -> Any:
            return self._c.request("GET", path, repeatable=True).data

        return {
            "grants": cast("List[Grant]", get(f"{base}/grants")),
            "domains": cast("List[DomainGrant]", get(f"{base}/domain-grants")),
            "groups": cast("List[GroupGrant]", get(f"{base}/group-grants")),
            "visibility": cast("App", get(base))["visibility"],
        }

    def share(self, ws: str, app: str, email: str, *, role: AppRole = "viewer", add_to_workspace: bool = False) -> Grant:
        """Gives someone access. Takes effect within 60 seconds."""
        body: Dict[str, Any] = {"role": role}
        if add_to_workspace:
            body["add_to_workspace"] = True
        path = f"{app_path(ws, app)}/grants/{segment(email)}"
        return cast("Grant", self._c.request("PUT", path, json_body=body, repeatable=True).data)

    def unshare(self, ws: str, app: str, email: str) -> Unshared:
        """Takes someone's access away, within 60 seconds. Says what still lets them in, if anything."""
        data = self._c.request("DELETE", f"{app_path(ws, app)}/grants/{segment(email)}", repeatable=True).data
        return {"still_shared_by": (data or {}).get("still_shared_by", [])}

    def share_domain(self, ws: str, app: str, domain: str) -> DomainGrant:
        """Shares it with everyone whose address is at ``domain``, as viewers. Only someone at that domain can."""
        path = f"{app_path(ws, app)}/domain-grants/{segment(domain.strip().lstrip('@'))}"
        return cast("DomainGrant", self._c.request("PUT", path, json_body={"role": "viewer"}, repeatable=True).data)

    def unshare_domain(self, ws: str, app: str, domain: str) -> None:
        path = f"{app_path(ws, app)}/domain-grants/{segment(domain.strip().lstrip('@'))}"
        self._c.request("DELETE", path, repeatable=True)

    def share_group(self, ws: str, app: str, group: str) -> GroupGrant:
        """Shares it with one of the workspace's groups, as viewers."""
        path = f"{app_path(ws, app)}/group-grants/{segment(group)}"
        return cast("GroupGrant", self._c.request("PUT", path, json_body={"role": "viewer"}, repeatable=True).data)

    def unshare_group(self, ws: str, app: str, group: str) -> None:
        self._c.request("DELETE", f"{app_path(ws, app)}/group-grants/{segment(group)}", repeatable=True)


class Tokens(_Resource):
    def list(self, ws: str, app: str) -> List[Token]:
        """The app's bypass tokens, revoked and expired ones included. Never their secrets."""
        return cast("List[Token]", self._c.request("GET", f"{app_path(ws, app)}/tokens", repeatable=True).data)

    def create(self, ws: str, app: str, name: str, role: TokenRole, *, expires_in_days: Optional[int] = None) -> CreatedToken:
        """A new bypass token. Its ``secret`` is in this answer and nowhere else, ever."""
        body: Dict[str, Any] = {"name": name, "role": role}
        if expires_in_days is not None:
            body["expires_in_days"] = expires_in_days
        path = f"{app_path(ws, app)}/tokens"
        return cast("CreatedToken", self._c.request("POST", path, json_body=body, repeatable=False).data)

    def revoke(self, ws: str, app: str, token_id: str) -> None:
        """Revokes a token. It stops working at once."""
        self._c.request("DELETE", f"{app_path(ws, app)}/tokens/{segment(token_id)}", repeatable=True)


class Audit(_Resource):
    """The audit log. For owners and admins, members whose role has ``audit.view``, and an app's owners for that app."""

    def list(
        self,
        ws: str,
        *,
        app: Optional[str] = None,
        decision: Optional[str] = None,
        limit: Optional[int] = None,
        before: Optional[str] = None,
        before_id: Optional[str] = None,
        after: Optional[str] = None,
        after_id: Optional[str] = None,
    ) -> AuditPage:
        """One page of the log: newest first, or oldest first from ``after``."""
        query = {
            "app": app,
            "decision": decision,
            "limit": limit,
            "before": before,
            "before_id": before_id,
            "after": after,
            "after_id": after_id,
        }
        answer = self._c.request(
            "GET", f"{ws_path(ws)}/audit", query=query, headers={"jiayang-audit-paging": "next"}, repeatable=True
        )
        return {
            "entries": answer.data,
            "next": _cursor(answer.headers.get("jiayang-audit-next")),
            "recent_only": answer.headers.get("jiayang-audit-recent-only") == "true",
        }

    def iterate(
        self,
        ws: str,
        *,
        app: Optional[str] = None,
        decision: Optional[str] = None,
        before: Optional[str] = None,
        before_id: Optional[str] = None,
        page_size: int = 100,
    ) -> Iterator[AuditEntry]:
        """Every entry, newest first, page after page until the log ends (or ``before`` and on, back).

        >>> for entry in jy.audit.iterate("acme", app="payroll"):
        ...     print(entry["action"])
        """
        seen = set()
        while True:
            page = self.list(ws, app=app, decision=decision, limit=page_size, before=before, before_id=before_id)
            yield from page["entries"]
            nxt = page["next"]
            if nxt is None and len(page["entries"]) >= page_size and page["entries"]:
                last = page["entries"][-1]
                nxt = {"at": last["at"], "id": last["id"]}
            if nxt is None:
                return
            key = f"{nxt['at']},{nxt['id']}"
            # The cursor always moves back. One that doesn't would ask for the same page forever.
            if key in seen:
                raise JiayangError(f"The audit log's paging stopped moving at {key}.")
            seen.add(key)
            before, before_id = nxt["at"], nxt["id"]


def _cursor(raw: Optional[str]) -> Optional[AuditCursor]:
    """``<at>,<id>`` from ``Jiayang-Audit-Next``."""
    if not raw or "," not in raw:
        return None
    at, _, entry = raw.partition(",")
    if not at.strip():
        return None
    return {"at": at.strip(), "id": entry.strip()}


class Secrets(_Resource):
    """Third-party credentials the platform adds to an app's outbound requests. The app never sees them."""

    def list(self, ws: str, app: str) -> List[SecretMeta]:
        """Names and where each goes. Never the values."""
        return cast("List[SecretMeta]", self._c.request("GET", f"{app_path(ws, app)}/secrets", repeatable=True).data)

    def set(
        self,
        ws: str,
        app: str,
        name: str,
        *,
        value: str,
        inject_host: str,
        inject_header: str,
        inject_format: Optional[str] = None,
    ) -> SecretMeta:
        """Stores it, to be added to requests to exactly ``inject_host``. ``inject_format`` is
        ``{value}`` when left out; most APIs want ``Bearer {value}``."""
        body: Dict[str, Any] = {"value": value, "inject_host": inject_host, "inject_header": inject_header}
        if inject_format is not None:
            body["inject_format"] = inject_format
        path = f"{app_path(ws, app)}/secrets/{segment(name)}"
        return cast("SecretMeta", self._c.request("PUT", path, json_body=body, repeatable=True).data)

    def delete(self, ws: str, app: str, name: str) -> None:
        self._c.request("DELETE", f"{app_path(ws, app)}/secrets/{segment(name)}", repeatable=True)


class Env(_Resource):
    """An app's config values. Put credentials in ``secrets`` instead."""

    def list(self, ws: str, app: str) -> List[EnvVar]:
        return cast("List[EnvVar]", self._c.request("GET", f"{app_path(ws, app)}/env", repeatable=True).data)

    def update(
        self,
        ws: str,
        app: str,
        *,
        set: Optional[Mapping[str, str]] = None,  # noqa: A002 - the API's own name
        unset: Sequence[str] = (),
        allow_sensitive: bool = False,
    ) -> EnvUpdated:
        """Sets some values and unsets others, leaving the rest. A live app is redeployed with them."""
        body = {"set": dict(set or {}), "unset": list(unset), "allow_sensitive": allow_sensitive}
        answer = self._c.request("PATCH", f"{app_path(ws, app)}/env", json_body=body, repeatable=True)
        waits = answer.headers.get("jiayang-env-waits-for", "")
        return {
            "vars": answer.data,
            "pushed": answer.headers.get("jiayang-env-pushed") == "true",
            "waits_for": int(waits) if waits.isdigit() else None,
        }
