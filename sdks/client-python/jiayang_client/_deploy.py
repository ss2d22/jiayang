"""Deploys: the files go up by content first, so a redeploy sends only what changed, then a version
says what the app is made of. A deploy that takes a while is answered with its version on its way
live, and this follows it in the version list until it's live or has failed."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Mapping, Optional, Sequence, Union, cast

from ._errors import (
    ApiError,
    ConflictError,
    ConnectionFailedError,
    DeployFailedError,
    JiayangError,
    RateLimitError,
    RequestTimeoutError,
    ServerError,
)
from ._config import RETRY_AFTER_CAP

if TYPE_CHECKING:
    from ._client import Client
    from ._types import Content, ModuleType, ScanInput, SiteFile, Version, WorkerModule

_BATCH_FILES = 500
_BATCH_BYTES = 8 * 1024 * 1024
_ALONE_BYTES = 4 * 1024 * 1024
_MAX_FILE_BYTES = 25 * 1024 * 1024

Progress = Optional[Callable[[str], None]]


@dataclass
class _Prepared:
    path: str
    data: bytes
    sha256: str
    content_type: str


def bytes_of(content: Content) -> bytes:
    if isinstance(content, str):
        return content.encode("utf-8")
    if isinstance(content, (bytes, bytearray, memoryview)):
        return bytes(content)
    raise JiayangError("File and module content is a str or bytes.")


def module_type(name: str, content: Content) -> ModuleType:
    lower = name.lower()
    if lower.endswith((".js", ".mjs")):
        return "esm"
    if lower.endswith(".wasm"):
        return "wasm"
    return "text" if isinstance(content, str) else "data"


def deploy_worker(
    c: Client,
    ws: str,
    app: str,
    *,
    main_module: str,
    compatibility_date: str,
    modules: Mapping[str, WorkerModule],
    compatibility_flags: Sequence[str],
    assets: Optional[Sequence[SiteFile]],
    not_found_handling: Optional[str],
    run_worker_first: Optional[Union[bool, Sequence[str]]],
    preview: bool,
    wait: bool,
    wait_timeout: float,
    on_progress: Progress,
    scan: Optional[ScanInput] = None,
    kv: bool = False,
    queue: Optional[str] = None,
) -> Version:
    if main_module not in modules:
        raise JiayangError(f"main_module is {main_module}, which isn't one of the modules.")
    raw = {
        name: (module.get("type") or module_type(name, module["content"]), bytes_of(module["content"]))
        for name, module in modules.items()
    }
    body: Dict[str, Any] = {
        "main_module": main_module,
        "compatibility_date": compatibility_date,
        "compatibility_flags": list(compatibility_flags),
        "modules": {
            name: {"type": kind, "b64": base64.b64encode(data).decode("ascii")} for name, (kind, data) in raw.items()
        },
    }
    if assets is not None:
        files = _prepare(assets)
        _upload(c, ws, app, files, on_progress)
        rwf = list(run_worker_first) if run_worker_first not in (None, True, False) else run_worker_first
        body["assets"] = _manifest(files, not_found_handling, rwf)
    sent = _scan_of(scan)
    if sent is not None:
        body["scan"] = sent
    if kv:
        body["kv"] = True
    if queue is not None:
        body["queue"] = {"path": queue}
    named = worker_version_hash(raw, compatibility_flags, body.get("assets"))
    return _publish(c, ws, app, "versions", body, named, preview, wait, wait_timeout, on_progress)


def deploy_site(
    c: Client,
    ws: str,
    app: str,
    files: Sequence[SiteFile],
    *,
    not_found_handling: Optional[str],
    preview: bool,
    wait: bool,
    wait_timeout: float,
    on_progress: Progress,
    scan: Optional[ScanInput] = None,
) -> Version:
    prepared = _prepare(files)
    if not prepared:
        raise JiayangError("A site needs at least one file.")
    _upload(c, ws, app, prepared, on_progress)
    body = _manifest(prepared, not_found_handling, None)
    sent = _scan_of(scan)
    if sent is not None:
        body["scan"] = sent
    named = site_version_hash(body["files"])
    return _publish(c, ws, app, "site", body, named, preview, wait, wait_timeout, on_progress)


def _scan_of(scan: Optional[ScanInput]) -> Optional[Dict[str, Any]]:
    """What the deploy sends for its scan, if anything."""
    if not scan:
        return None
    out: Dict[str, Any] = {}
    lockfiles = [{"path": f["path"], "text": f["text"]} for f in scan.get("lockfiles") or ()]
    if lockfiles:
        out["lockfiles"] = lockfiles
    if scan.get("allow") is not None:
        out["allow"] = scan["allow"]
    return out or None


def site_version_hash(files: Sequence[Mapping[str, Any]]) -> str:
    """The name the platform gives a site's version: each path with the file it serves."""
    digest = hashlib.sha256()
    for f in sorted(files, key=lambda f: str(f["path"]).encode("utf-8")):
        for part in (f["path"], f["sha256"], f["content_type"]):
            digest.update(str(part).encode("utf-8") + b"\0")
    return digest.hexdigest()


def worker_version_hash(
    modules: Mapping[str, "tuple[str, bytes]"], flags: Sequence[str], assets: Optional[Mapping[str, Any]]
) -> str:
    """The name the platform gives a Worker's version: its modules, flags and files."""
    digest = hashlib.sha256()
    for name in sorted(modules, key=lambda n: n.encode("utf-8")):
        kind, data = modules[name]
        encoded = name.encode("utf-8")
        digest.update(struct.pack(">Q", len(encoded)) + encoded + kind.encode("utf-8"))
        digest.update(struct.pack(">Q", len(data)) + data)
    for flag in sorted(set(flags), key=lambda f: f.encode("utf-8")):
        digest.update(b"flag" + flag.encode("utf-8"))
    if assets is not None:
        for f in assets["files"]:
            digest.update(b"asset" + "".join((f["path"], f["sha256"], f["content_type"])).encode("utf-8"))
        if assets.get("not_found_handling") is not None:
            digest.update(b"not-found" + str(assets["not_found_handling"]).encode("utf-8"))
        if assets.get("run_worker_first") is not None:
            first = json.dumps(assets["run_worker_first"], separators=(",", ":"), ensure_ascii=False)
            digest.update(b"worker-first" + first.encode("utf-8"))
    return digest.hexdigest()


def _manifest(files: List[_Prepared], not_found_handling: Optional[str], run_worker_first: Any) -> Dict[str, Any]:
    return {
        "files": [
            {"path": f.path, "sha256": f.sha256, "size": len(f.data), "content_type": f.content_type} for f in files
        ],
        "not_found_handling": not_found_handling,
        "run_worker_first": run_worker_first,
    }


def _prepare(files: Sequence[SiteFile]) -> List[_Prepared]:
    seen = set()
    out: List[_Prepared] = []
    for file in files:
        path = file["path"] if file["path"].startswith("/") else "/" + file["path"]
        if path in seen:
            raise JiayangError(f"{path} is in the files twice.")
        seen.add(path)
        data = bytes_of(file["content"])
        if len(data) > _MAX_FILE_BYTES:
            raise JiayangError(f"{path} is over 25 MiB, the most a site file can be.")
        kind = file.get("content_type") or content_type(path)
        out.append(_Prepared(path, data, hashlib.sha256(data).hexdigest(), kind))
    return out


def _upload(c: Client, ws: str, app: str, files: List[_Prepared], on_progress: Progress) -> None:
    """Sends the files the platform hasn't got: small ones many to a request, a big one on its own."""
    from ._client import app_path

    base = app_path(ws, app)
    hashes = list(dict.fromkeys(f.sha256 for f in files))
    missing = set(c.request("POST", f"{base}/blobs/missing", json_body={"sha256": hashes}, repeatable=True).data["missing"])
    wanted: List[_Prepared] = []
    for file in files:
        if file.sha256 in missing:
            missing.discard(file.sha256)
            wanted.append(file)
    if not wanted:
        return
    if on_progress:
        on_progress(f"Uploading {len(wanted)} of {len(files)} {'file' if len(files) == 1 else 'files'} ...")
    batch: List[_Prepared] = []
    size = 0

    def flush() -> None:
        nonlocal batch, size
        if not batch:
            return
        body, kind = _multipart(batch)
        # Content-addressed, so sending one again stores nothing new.
        c.request("POST", f"{base}/blobs", body=body, content_type=kind, repeatable=True)
        batch, size = [], 0

    for file in wanted:
        if len(file.data) >= _ALONE_BYTES:
            c.request("PUT", f"{base}/blobs/{file.sha256}", body=file.data, content_type=file.content_type, repeatable=True)
            continue
        if len(batch) == _BATCH_FILES or (batch and size + len(file.data) > _BATCH_BYTES):
            flush()
        batch.append(file)
        size += len(file.data)
    flush()


def _multipart(files: List[_Prepared]) -> "tuple[bytes, str]":
    """Each file a part named by its SHA-256 and typed as it will be served."""
    boundary = "jiayang-" + os.urandom(16).hex()
    out = bytearray()
    for file in files:
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{file.sha256}"; filename="{file.sha256}"\r\n'.encode()
        out += f"Content-Type: {file.content_type}\r\n\r\n".encode()
        out += file.data
        out += b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def _publish(
    c: Client,
    ws: str,
    app: str,
    endpoint: str,
    body: Dict[str, Any],
    named: str,
    preview: bool,
    wait: bool,
    wait_timeout: float,
    on_progress: Progress,
) -> Version:
    """Asks for the version, and follows it live. A deploy is never sent twice: one whose answer
    didn't arrive is looked for in the version list instead, since it may have gone through."""
    from ._client import app_path

    base = app_path(ws, app)
    started = time.monotonic()
    while True:
        before = max((v["number"] for v in c.versions.list(ws, app)), default=0)
        try:
            answer = c.request(
                "POST",
                f"{base}/{endpoint}",
                query={"preview": preview},
                json_body=body,
                headers={"prefer": "respond-async"},
                repeatable=False,
            )
        except ConflictError as err:
            if err.code == "version_going_live" and time.monotonic() - started < wait_timeout:
                _wait_turn(c, ws, app, wait_timeout, on_progress)
                continue
            raise
        except RateLimitError as err:
            # Waited out, and sent again only if the version it may have made isn't there.
            if (err.retry_after or 0) > RETRY_AFTER_CAP or time.monotonic() - started >= wait_timeout:
                raise
            if on_progress:
                on_progress("Too many requests for now. Waiting to deploy ...")
            c.sleep(float(err.retry_after) if err.retry_after is not None else c.backoff(0))
            made = next((v for v in _list_quietly(c, ws, app) or [] if v["number"] > before and v.get("sha256") == named), None)
            if made is not None:
                return _settle(c, ws, app, made, wait, wait_timeout, on_progress)
            continue
        except JiayangError as err:
            if not _unanswered(err):
                raise
            if on_progress:
                on_progress("The API didn't answer in time. Looking for the new version ...")
            return _look_for(c, ws, app, before, named, err, wait, wait_timeout, on_progress)
        version = cast("Version", answer.data)
        if version["status"] == "failed":
            raise DeployFailedError(version)
        if version["status"] != "uploaded" or not wait:
            return version
        return _follow(c, ws, app, version["number"], wait_timeout, on_progress)


def _unanswered(err: JiayangError) -> bool:
    """A deploy that ended without the platform saying how it went, which may have gone live all the same."""
    if isinstance(err, (RequestTimeoutError, ConnectionFailedError)):
        return True
    if isinstance(err, ApiError) and err.code == "still_going_live":
        return True
    return isinstance(err, ServerError) and err.code == "" and err.status in (502, 504, 524)


def _landed(version: Version) -> bool:
    preview = version.get("preview")
    return version["status"] == "deployed" and (version["active"] or bool(preview and preview.get("live")))


def _look_for(
    c: Client,
    ws: str,
    app: str,
    before: int,
    named: str,
    err: JiayangError,
    wait: bool,
    wait_timeout: float,
    on_progress: Progress,
) -> Version:
    """Looks for the version this deploy made: newer than any before it, and made of what it sent,
    so a teammate's deploy in the meantime isn't taken for it."""
    started = time.monotonic()
    at_most = c.polling.after_drop if isinstance(err, ConnectionFailedError) else c.polling.look_for
    while True:
        listed = _list_quietly(c, ws, app) or []
        newer = sorted(
            (v for v in listed if v["number"] > before and v.get("sha256") == named), key=lambda v: v["number"], reverse=True
        )
        if newer and (_landed(newer[0]) or newer[0]["status"] in ("failed", "uploaded")):
            return _settle(c, ws, app, newer[0], wait, wait_timeout, on_progress)
        if time.monotonic() - started >= at_most:
            raise err
        c.sleep(c.polling.every)


def _settle(c: Client, ws: str, app: str, ours: Version, wait: bool, wait_timeout: float, on_progress: Progress) -> Version:
    """A version this deploy made, found in the list: returned, followed live, or its failure raised."""
    if ours["status"] == "failed":
        raise DeployFailedError(ours)
    if ours["status"] == "uploaded" and wait:
        return _follow(c, ws, app, ours["number"], wait_timeout, on_progress)
    return ours


def _follow(c: Client, ws: str, app: str, number: int, wait_timeout: float, on_progress: Progress) -> Version:
    if on_progress:
        on_progress(f"Version {number} is going live ...")
    started = time.monotonic()
    while True:
        c.sleep(c.polling.soon if time.monotonic() - started < c.polling.soon_for else c.polling.every)
        listed = _list_quietly(c, ws, app)
        if listed is not None:
            version = next((v for v in listed if v["number"] == number), None)
            if version is None:
                raise JiayangError(f"Version {number} is no longer listed, so it won't go live.")
            if version["status"] == "deployed":
                return version
            if version["status"] == "failed":
                raise DeployFailedError(version)
        if time.monotonic() - started >= wait_timeout:
            minutes = round((time.monotonic() - started) / 60)
            raise JiayangError(
                f"Version {number} is still going live after {minutes} minutes. versions.list shows when it's "
                "live, or why it isn't."
            )


def _wait_turn(c: Client, ws: str, app: str, wait_timeout: float, on_progress: Progress) -> None:
    """Waits while another version of the app goes live."""
    going = [v["number"] for v in c.versions.list(ws, app) if v["status"] == "uploaded"]
    if not going:
        c.sleep(c.polling.every)
        return
    number = max(going)
    if on_progress:
        on_progress(f"Version {number} is still going live. Deploying once it's done ...")
    started = time.monotonic()
    while time.monotonic() - started < wait_timeout:
        c.sleep(c.polling.every)
        listed = _list_quietly(c, ws, app)
        if listed is not None and not any(v["number"] == number and v["status"] == "uploaded" for v in listed):
            return


def _list_quietly(c: Client, ws: str, app: str) -> Optional[List[Version]]:
    """The version list, or None for a moment the platform couldn't answer in."""
    try:
        return c.versions.list(ws, app)
    except (ServerError, ConnectionFailedError, RequestTimeoutError):
        return None


def content_type(path: str) -> str:
    """What a browser should make of a file, by its extension. The platform decides in the end."""
    name = path.rsplit("/", 1)[-1]
    extension = name.rsplit(".", 1)[-1].lower()
    return CONTENT_TYPES.get(extension, "application/octet-stream")


#: The same table the CLI uses (sdks/testdata/content-types.json, which a test holds this to).
CONTENT_TYPES = json.loads(
    """{
    "html": "text/html; charset=utf-8", "htm": "text/html; charset=utf-8", "css": "text/css; charset=utf-8",
    "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
    "json": "application/json; charset=utf-8", "map": "application/json; charset=utf-8",
    "txt": "text/plain; charset=utf-8", "xml": "application/xml; charset=utf-8", "csv": "text/csv; charset=utf-8",
    "md": "text/markdown; charset=utf-8", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg",
    "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif", "ico": "image/x-icon",
    "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf", "pdf": "application/pdf",
    "wasm": "application/wasm", "webmanifest": "application/manifest+json", "mp4": "video/mp4", "m4v": "video/mp4",
    "webm": "video/webm", "mov": "video/quicktime", "ts": "video/mp2t", "ogv": "video/ogg",
    "vtt": "text/vtt; charset=utf-8", "mp3": "audio/mpeg", "m4a": "audio/mp4", "wav": "audio/wav",
    "ogg": "audio/ogg", "oga": "audio/ogg", "flac": "audio/flac", "zip": "application/zip",
    "glb": "model/gltf-binary", "gltf": "model/gltf+json", "usdz": "model/vnd.usdz+zip", "obj": "model/obj",
    "stl": "model/stl", "ktx2": "image/ktx2", "hdr": "image/vnd.radiance", "exr": "image/x-exr",
    "glsl": "text/plain; charset=utf-8", "vert": "text/plain; charset=utf-8", "frag": "text/plain; charset=utf-8",
    "wgsl": "text/plain; charset=utf-8", "bmp": "image/bmp", "tif": "image/tiff", "tiff": "image/tiff",
    "apng": "image/apng", "jxl": "image/jxl", "eot": "application/vnd.ms-fontobject",
    "jsonld": "application/ld+json", "atom": "application/atom+xml", "rss": "application/rss+xml"
}"""
)
