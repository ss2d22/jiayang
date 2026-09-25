"""Roles are ordered, and one this version doesn't know allows nothing."""

import unittest

from jiayang import Forbidden, User, has_role, require_role


def who(role: str) -> User:
    return User(kind="user", sub="u1", email="a@example.com", role=role, workspace_id="w1")


class Roles(unittest.TestCase):
    def test_an_owner_can_do_what_an_editor_can(self):
        ladder = [
            ("viewer", ["viewer"], ["editor", "owner"]),
            ("editor", ["viewer", "editor"], ["owner"]),
            ("owner", ["viewer", "editor", "owner"], []),
        ]
        for role, allowed, refused in ladder:
            for least in allowed:
                self.assertTrue(has_role(who(role), least), f"{role} >= {least}")
            for least in refused:
                self.assertFalse(has_role(who(role), least), f"{role} < {least}")

    # If the platform ever adds a role, an app built against an older SDK must refuse rather than
    # guess what it allows.
    def test_a_role_this_version_does_not_know_allows_nothing(self):
        for unknown in ("superuser", "", "OWNER", "admin"):
            self.assertFalse(has_role(who(unknown), "viewer"), unknown)

    def test_asking_for_a_role_that_does_not_exist_allows_nobody(self):
        """The other side of the same rule: a typo should refuse, not raise or wave everyone through."""
        for unknown in ("admin", "", "EDITOR", "superuser"):
            for has in ("viewer", "editor", "owner"):
                self.assertFalse(has_role(who(has), unknown), f"{unknown} let a {has} through")
                with self.assertRaises(Forbidden):
                    require_role(who(has), unknown)

    def test_require_role_raises_something_a_handler_can_answer_with(self):
        require_role(who("owner"), "editor")
        with self.assertRaises(Forbidden) as caught:
            require_role(who("viewer"), "editor")
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.needed, "editor")
