"""What the API sends and takes, field for field.

Names are the API's own, so these match the HTTP docs and the Node client. Answers are plain dicts;
these describe them for a type checker. Times are RFC 3339 strings, kept as sent: the audit log
pages by microsecond.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Literal, Optional, Sequence, TypedDict, Union

if TYPE_CHECKING:
    from typing_extensions import NotRequired

WorkspaceRole = Literal["owner", "admin", "member"]
AppRole = Literal["viewer", "editor", "owner"]
TokenRole = Literal["viewer", "editor"]
Driver = Literal["workers", "containers"]
Visibility = Literal["private", "workspace"]
ModuleType = Literal["esm", "text", "wasm", "data"]
Invited = Literal["sent", "over_budget", "failed"]
InvitationBudget = Literal["workspace", "sender", "platform"]
Content = Union[str, bytes, bytearray, memoryview]


class PlanLimitHit(TypedDict):
    what: str
    max: int
    plan: str


class Features(TypedDict):
    storage: bool
    github_deploys: bool
    keep_deleted: NotRequired[bool]


class Terms(TypedDict):
    version: str
    accepted: bool
    can_wait: NotRequired[bool]
    deadline: NotRequired[Optional[str]]


class Workspace(TypedDict):
    id: str
    slug: str
    name: str
    role: WorkspaceRole
    allowed_email_domains: List[str]
    plan: str
    suspended_by: NotRequired[Optional[str]]
    over_quota: NotRequired[bool]
    database_state: NotRequired[Optional[str]]
    usage_stop: NotRequired[Optional[str]]
    unmeasured_stop: NotRequired[Optional[str]]
    cut_off: NotRequired[Optional[str]]
    storage_full: NotRequired[bool]
    prices: NotRequired[Optional[Dict[str, Any]]]
    permissions: NotRequired[List[str]]


class HeldIn(TypedDict):
    slug: str
    name: str


class Me(TypedDict):
    email: str
    workspaces: List[Workspace]
    apps_base_url: str
    session_expires_at: str
    terms: Terms
    features: NotRequired[Optional[Features]]
    held_in: NotRequired[List[HeldIn]]


class GroupRole(TypedDict):
    role: str
    group: str


class Member(TypedDict):
    email: str
    role: WorkspaceRole
    added_by: str
    created_at: str
    custom_role: NotRequired[Optional[str]]
    group_roles: NotRequired[List[GroupRole]]
    added_by_scim: NotRequired[bool]
    held: NotRequired[bool]
    invited: NotRequired[Invited]
    budget_spent: NotRequired[InvitationBudget]


class MemberRemoved(TypedDict):
    still_shared_by_domain: List[str]


class AppOversight(TypedDict):
    people: int
    outside: int
    domains: NotRequired[List[str]]
    agents: NotRequired[int]
    sends_to: NotRequired[List[str]]
    custom_domains: NotRequired[List[str]]
    last_opened: NotRequired[Optional[str]]


class App(TypedDict):
    id: str
    workspace: str
    slug: str
    name: str
    driver: Driver
    visibility: Visibility
    hostname: str
    url: str
    active_version: Optional[int]
    my_role: Optional[AppRole]
    has_database: NotRequired[bool]
    static_site: NotRequired[bool]
    mcp: NotRequired[bool]
    has_files: NotRequired[bool]
    created_by: str
    created_at: str
    suspended: NotRequired[bool]
    oversight: NotRequired[AppOversight]
    access_requests: NotRequired[int]


class Kept(TypedDict):
    restorable_until: str


class VersionPreview(TypedDict):
    url: str
    until: str
    live: bool


class Version(TypedDict):
    number: int
    sha256: str
    size_bytes: int
    status: str
    active: bool
    created_by: str
    created_at: str
    port: NotRequired[int]
    instance_type: NotRequired[str]
    failure: NotRequired[str]
    replaced: NotRequired[int]
    github_run: NotRequired[str]
    preview: NotRequired[VersionPreview]


class WorkerModule(TypedDict):
    content: Content
    type: NotRequired[ModuleType]


class SiteFile(TypedDict):
    path: str
    content: Content
    content_type: NotRequired[str]


class Lockfile(TypedDict):
    """A lock file as it is, named as in the project: ``package-lock.json``, ``poetry.lock``."""

    path: str
    text: str


class ScanInput(TypedDict, total=False):
    """What a deploy's scan reads besides the files: the project's lock files, whole, so the
    platform can check the packages they pin, and the text of its ``.jiayang-allow``. Without lock
    files no package is checked. Up to 8 lock files, 8 MiB together, and 64 KiB of allow file."""

    lockfiles: Sequence[Lockfile]
    allow: str


class Grant(TypedDict):
    email: str
    role: AppRole
    granted_by: str
    created_at: str
    invited: NotRequired[Invited]
    budget_spent: NotRequired[InvitationBudget]
    unchanged: NotRequired[bool]


class DomainGrant(TypedDict):
    domain: str
    role: AppRole
    granted_by: str
    created_at: str


class GroupGrant(TypedDict):
    group: str
    role: AppRole
    granted_by: str
    created_at: str


class Access(TypedDict):
    grants: List[Grant]
    domains: List[DomainGrant]
    groups: List[GroupGrant]
    visibility: Visibility


class Unshared(TypedDict):
    still_shared_by: List[str]


class Token(TypedDict):
    id: str
    name: str
    role: TokenRole
    hint: str
    created_by: str
    created_at: str
    expires_at: Optional[str]
    last_used_at: NotRequired[Optional[str]]
    revoked_at: Optional[str]
    effective_role: NotRequired[Optional[TokenRole]]
    capped_because: NotRequired[str]


class CreatedToken(TypedDict):
    token: Token
    secret: str
    url: str


class AuditEntry(TypedDict):
    id: str
    at: str
    source: str
    action: str
    decision: Optional[str]
    reason: Optional[str]
    status: Optional[int]
    app_id: Optional[str]
    app: NotRequired[str]
    app_deleted: NotRequired[bool]
    entry: Optional[str]
    actor: Any
    host: Optional[str]
    method: Optional[str]
    path: Optional[str]
    detail: Any
    ingested_at: str


class AuditCursor(TypedDict):
    at: str
    id: str


class AuditPage(TypedDict):
    entries: List[AuditEntry]
    next: Optional[AuditCursor]
    recent_only: bool


class SecretMeta(TypedDict):
    name: str
    inject_host: str
    inject_header: str
    inject_format: str
    updated_by: str
    updated_at: str


class EnvVar(TypedDict):
    name: str
    value: str
    updated_by: str
    updated_at: str


class EnvUpdated(TypedDict):
    vars: List[EnvVar]
    pushed: bool
    waits_for: Optional[int]
