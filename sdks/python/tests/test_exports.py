"""What `from jiayang import *` hands an app: the documented names, and no module we imported."""

import importlib
import types
import unittest

import jiayang

MODULES = [
    "jiayang",
    "jiayang.aio",
    "jiayang.fastapi",
    "jiayang.flask",
    "jiayang.django",
    "jiayang.streamlit",
    "jiayang.gradio",
]


def star(name: str) -> dict[str, object]:
    scope: dict[str, object] = {}
    exec(f"from {name} import *", scope)
    scope.pop("__builtins__", None)
    return scope


class Exports(unittest.TestCase):
    def test_the_package_exports_what_the_docs_import(self):
        self.assertEqual(
            sorted(jiayang.__all__),
            sorted(
                [
                    "IDENTITY_HEADER",
                    "PROVIDERS",
                    "Config",
                    "Forbidden",
                    "KeySet",
                    "Provider",
                    "Role",
                    "Unauthorized",
                    "User",
                    "Webhook",
                    "has_role",
                    "require_role",
                    "require_user",
                    "require_webhook",
                    "verify_identity",
                    "verify_webhook",
                ]
            ),
        )

    # A star import that brought in `os`, `json` or `jwt` would shadow an app's own names.
    def test_a_star_import_brings_no_module_and_nothing_private(self):
        for name in MODULES:
            module = importlib.import_module(name)
            got = star(name)
            self.assertEqual(sorted(got), sorted(module.__all__), name)
            for export, value in got.items():
                self.assertNotIsInstance(value, types.ModuleType, f"{name}.{export}")
                self.assertFalse(export.startswith("_"), f"{name}.{export}")
            for stdlib in ("os", "json", "time", "threading", "asyncio", "math", "urllib", "jwt"):
                self.assertNotIn(stdlib, got, name)


if __name__ == "__main__":
    unittest.main()
