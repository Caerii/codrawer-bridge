"""Scope resolution: folder inheritance, the private tag, per-agent sets, asks and revocation.

Run: `uv run --no-project --with pytest pytest scripts/dev/context_spikes/test_consent.py -q`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from consent import Consent, Node  # noqa: E402


def library() -> Consent:
    c = Consent()
    c.add(
        Node("root", "folder"),
        Node("putnam", "folder", "root"),
        Node("pb", "pdf", "putnam"),  # a problem book
        Node("pb/p41", "page", "pb"),
        Node("pb/p42", "page", "pb", frozenset({"Private"})),  # page tag from xochitl
        Node("week3", "notebook", "putnam"),
        Node("week3/p1", "page", "week3"),
        Node("week3/p2", "page", "week3", frozenset({"#private"})),  # #private written in ink
        Node("diary", "folder", "root", frozenset({"private"})),
        Node("diary/n", "notebook", "diary"),
        Node("papers", "folder", "root"),
        Node("paper1", "pdf", "papers", frozenset({"thesis"})),
        Node("loose", "notebook", "root"),
    )
    # the short setup: Putnam → Primer + coach; papers → research pod
    c.set("putnam", "primer", "allow", set_by="preset")
    c.set("putnam", "coach", "allow", set_by="preset")
    c.set("papers", "pod", "allow", set_by="preset")
    return c


def test_children_inherit_from_their_folder():
    c = library()
    assert c.decide("primer", "pb/p41").effect == "allow"
    assert c.decide("coach", "week3/p1").effect == "allow"


def test_private_tag_overrides_everything():
    c = library()
    assert c.decide("primer", "pb/p42").effect == "deny"  # page tag, in an allowed folder
    assert c.decide("primer", "week3/p2").effect == "deny"  # #private in ink
    c.set("diary", "primer", "allow")  # even an explicit allow
    c.set("diary/n", "*", "allow")
    assert c.decide("primer", "diary/n").effect == "deny"
    assert "private" in c.decide("primer", "diary/n").reason


def test_per_agent_sets_and_new_agents_start_with_nothing():
    c = library()
    assert c.decide("pod", "paper1").effect == "allow"
    assert c.decide("primer", "paper1").effect == "ask"
    assert c.decide("sig-agent", "pb/p41").effect == "ask"  # new agent: nothing yet


def test_closer_rules_win_and_deny_beats_allow_at_one_level():
    c = library()
    c.set("week3", "primer", "deny")
    assert c.decide("primer", "week3/p1").effect == "deny"
    assert c.decide("primer", "pb/p41").effect == "allow"
    c.set("loose", "coach", "allow")
    c.set("loose", "coach", "allow", turn="t9")
    c.set("loose", "*", "deny")
    assert c.decide("coach", "loose").effect == "allow"  # agent-specific beats *
    c.set("loose", "coach", "deny", turn="t9")
    assert c.decide("coach", "loose", turn="t9").effect == "deny"  # deny wins at one level


def test_tag_rules_grant_by_tag():
    c = library()
    c.set("#thesis", "primer", "allow")
    assert c.decide("primer", "paper1").effect == "allow"


def test_this_time_grants_expire_with_the_turn():
    c = library()
    c.set("loose", "primer", "allow", turn="t1")
    assert c.decide("primer", "loose", turn="t1").effect == "allow"
    assert c.decide("primer", "loose", turn="t2").effect == "ask"


def test_asks_are_batched_and_never_repeat_after_a_deny():
    c = library()
    asks = c.pending_asks("pod", ["pb/p41", "week3/p1", "loose", "paper1"])
    assert asks == ["loose", "putnam"]  # one question per top-level folder, none for allowed
    c.set("putnam", "pod", "deny")
    assert c.pending_asks("pod", ["pb/p41", "week3/p1"]) == []


def test_revoke_and_allowed_filter():
    c = library()
    pages = ["pb/p41", "pb/p42", "week3/p1", "week3/p2", "paper1"]
    assert c.allowed("primer", pages) == {"pb/p41", "week3/p1"}
    assert c.revoke("primer") == 1
    assert c.allowed("primer", pages) == set()


def test_unknown_and_cyclic_nodes_fail_closed():
    c = library()
    assert c.decide("primer", "nope").effect == "deny"
    c.add(Node("a", "folder", "b"), Node("b", "folder", "a"))
    assert c.decide("primer", "a").effect == "ask"
