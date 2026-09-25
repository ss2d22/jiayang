"""What the published package has to do, run against the built artifact.

The rest of the suite imports `jiayang` out of this directory, where every file exists whether or
not the build was told to ship it. This one runs from an installed wheel or sdist in an
environment that has never seen the source tree, so a module left out of the package, a missing
py.typed, or a dependency that was only ever a dev dependency fails here rather than in someone
else's `pip install`.

It takes no test runner and nothing beyond the package's own declared dependencies. smoke.sh runs
it against each artifact, with those dependencies installed as uv.lock pins them:

    bash tests/smoke.sh dist/jiayang-*.whl dist/jiayang-*.tar.gz
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import sys
import time
from pathlib import Path

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

import jiayang

APP = "0a000000-0000-4000-8000-000000000001"
ISSUER = "https://edge.example.com"
JWKS_URL = "https://edge.example.com/.well-known/jwks.json"

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
JWK = {**json.loads(RSAAlgorithm.to_jwk(KEY.public_key())), "kid": "identity-k1", "alg": "RS256", "use": "sig"}

failures: list[str] = []


def check(what: str, ok: bool) -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {what}")
    if not ok:
        failures.append(what)


def raises(what: str, error: type[BaseException], call) -> None:
    try:
        call()
    except error:
        check(what, True)
    except BaseException as other:  # noqa: BLE001 - the wrong error is the failure
        check(f"{what} (raised {type(other).__name__}: {other})", False)
    else:
        check(f"{what} (raised nothing)", False)


def token(**extra: object) -> str:
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": APP,
        "sub": "access-sub-alice",
        "email": "alice@example.com",
        "kind": "user",
        "role": "editor",
        "wid": "0b000000-0000-4000-8000-00000000000a",
        "iat": now,
        "exp": now + 60,
    }
    claims.update(extra)
    claims = {name: value for name, value in claims.items() if value is not None}
    return jwt.encode(claims, KEY, algorithm="RS256", headers={"kid": "identity-k1", "typ": "JWT"})


# It has to be the installed one. Run from inside sdks/python, or with it on PYTHONPATH, and the
# source tree next door wins and this proves nothing about the build, silently. Run it from
# somewhere else entirely; the CI step does.
project = Path(__file__).resolve().parent.parent
if project in Path(jiayang.__file__).resolve().parents:
    print(f"FAIL imported the source tree at {jiayang.__file__}, not the built package")
    print("     run this from outside sdks/python, with the artifact installed")
    sys.exit(1)
check("imported the built package, not the source tree", True)

check("exports its documented names", all(hasattr(jiayang, name) for name in jiayang.__all__))

# The version it tells the JWKS endpoint it is, against the one it was published as.
check("knows its own version", jiayang.__version__ == importlib.metadata.version("jiayang"))

# Ships as typed. Without this file every annotation in the package is invisible to a type checker
# in someone else's project, and nothing else would notice.
check("ships py.typed", (Path(jiayang.__file__).parent / "py.typed").is_file())

# The framework integrations are separate modules, each importable only with its framework
# installed. find_spec locates them without running the imports that would need Flask or Django.
for name in ("aio", "flask", "fastapi", "django", "streamlit", "gradio"):
    check(f"ships jiayang.{name}", importlib.util.find_spec(f"jiayang.{name}") is not None)

config = jiayang.Config(APP, ISSUER, JWKS_URL)
keys = jiayang.KeySet(JWKS_URL, fetch=lambda _url: json.dumps({"keys": [JWK]}).encode())

user = jiayang.require_user({"X-Jiayang-Identity": token()}, config, keys=keys)
check("verifies a real token", user.email == "alice@example.com" and user.role == "editor")
check("reads the caller's kind and workspace", user.kind == "user" and user.workspace_id.startswith("0b00"))

hook_token = token(aud=f"webhook:{APP}", sub="webhook:0c1f", kind="webhook", provider="stripe", pattern="/hooks/stripe", delivery="evt_1", email=None, role=None)
hook = jiayang.require_webhook({"X-Jiayang-Identity": hook_token}, config, provider="stripe", keys=keys)
check("verifies a webhook token", hook.provider == "stripe" and hook.delivery == "evt_1" and hook.signed_at is None)
raises("refuses a webhook token as a person", jiayang.Unauthorized, lambda: jiayang.require_user({"X-Jiayang-Identity": hook_token}, config, keys=keys))
raises("refuses a person as a webhook", jiayang.Unauthorized, lambda: jiayang.require_webhook({"X-Jiayang-Identity": token()}, config, provider="stripe", keys=keys))

check("orders roles", jiayang.has_role(user, "viewer") and not jiayang.has_role(user, "owner"))
check("refuses a role it doesn't know", not jiayang.has_role(user, "admin"))  # type: ignore[arg-type]
raises("raises Forbidden for too little", jiayang.Forbidden, lambda: jiayang.require_role(user, "owner"))

raises("denies a request with no token", jiayang.Unauthorized, lambda: jiayang.require_user({}, config, keys=keys))
raises(
    "denies a token signed by someone else",
    jiayang.Unauthorized,
    lambda: jiayang.verify_identity(
        jwt.encode({"iss": ISSUER, "aud": APP}, rsa.generate_private_key(public_exponent=65537, key_size=2048), algorithm="RS256", headers={"kid": "identity-k1"}),
        config,
        keys=keys,
    ),
)
raises(
    "denies a token for another app",
    jiayang.Unauthorized,
    lambda: jiayang.verify_identity(token(aud="0a000000-0000-4000-8000-000000000002"), config, keys=keys),
)
raises("denies an expired token", jiayang.Unauthorized, lambda: jiayang.verify_identity(token(exp=int(time.time()) - 1), config, keys=keys))

# Fails closed: no configuration means nothing to check a token against.
raises("denies when the app isn't configured", jiayang.Unauthorized, lambda: jiayang.Config.from_env({}))

# A key set that can't reach its JWKS denies rather than trusting what it was handed.
def unreachable(_url: str) -> bytes:
    raise OSError("no route to the edge")


raises(
    "denies when the keys are unreachable",
    jiayang.Unauthorized,
    lambda: jiayang.verify_identity(token(), config, keys=jiayang.KeySet(JWKS_URL, fetch=unreachable)),
)

print()
if failures:
    print(f"{len(failures)} check(s) failed")
    sys.exit(1)
print("the package works")
