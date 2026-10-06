"""
Context consent: which agent may read which part of the library, decided once per source.

**The problem.** The library (ADR 011) holds a learner's books, notebooks and annotations. Agents
differ in what they should see: the Primer and the practice coach need the Putnam folder, a
research pod might need a paper folder, a SIG agent may need nothing at all, and a "Private"
folder is nobody's business. The user wants to choose, "but in a way that is not annoying": set
once, by folder, book or tag; asked only about genuinely new access; never asked twice; told
quietly what was read. This module is the decision procedure, pure and testable; the retrieval
layer calls it before it touches the index, so a prompt can never talk an agent past it.

**The model.**

- *Nodes* are the xochitl tree as the sync sees it (`.metadata` `parent` gives the folder
  structure): folders, documents (notebook, pdf, epub), and pages. Every node may carry tags:
  xochitl's document `tags` and page `pageTags`, plus codrawer `#tags` written in ink or typed and
  recognised on the page (§4 of docs/investigations/grounded-context.md).
- *Rules* say `allow` or `deny` for one agent (or `*`, every agent) on a subject: a node id (and
  so everything under it) or a tag (every node carrying it). Each rule has a lifetime: `always`,
  or `once` (valid for one turn id: the "this time" answer).
- *The private tag* (`private`, from xochitl or `#private` in ink) is not a rule: a node carrying
  it, or under a node carrying it, is denied to every agent, whatever any rule says. Removing the
  tag is the only way back. It cannot be overridden from a prompt, an agent, or a preset.

**Resolution** for (agent, node), in order:

1. the private tag on the node or any ancestor → `deny` (reason `private`);
2. walk from the node up to the root; at each level look at rules on that node and rules on the
   tags that node carries; the first level with any applicable rule decides. At one level an
   agent-specific rule beats a `*` rule, and `deny` beats `allow` (a conflict fails closed);
3. no rule anywhere → `ask` (no decision yet: the agent gets nothing now, and the access joins
   the next batched question). A new agent therefore starts with nothing and is asked once.

An explicit `deny` is final and silent: denied access is never asked about again. That, with
bulk rules on folders and tags, is what keeps the asks rare.

**Units.** Times are Unix ms. Ids are strings (xochitl uuids, `page:<doc>/<page>`).
"""

from __future__ import annotations

import time
from collections.abc import Iterable
from dataclasses import dataclass, field

PRIVATE_TAG = "private"
ANY_AGENT = "*"


@dataclass(frozen=True)
class Node:
    """A folder, document or page. `parent` is None at the root."""

    id: str
    kind: str  # folder | notebook | pdf | epub | page
    parent: str | None = None
    tags: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Rule:
    """
    One consent decision. `subject` is a node id or `#tag`; `agent` an agent id or `*`.
    `turn` is set for a `once` rule (the turn it was granted for) and None for `always`.
    """

    subject: str
    agent: str
    effect: str  # allow | deny
    turn: str | None = None
    set_ms: int = 0
    set_by: str = "user"  # user | preset


@dataclass(frozen=True)
class Decision:
    """The answer for one (agent, node): `allow`, `deny` or `ask`, and why (for the log)."""

    effect: str
    reason: str
    rule: Rule | None = None


@dataclass
class Access:
    """One line of the recent-access log: who read what, when and why."""

    ms: int
    agent: str
    node: str
    purpose: str
    turn: str | None
    effect: str


def norm_tag(tag: str) -> str:
    """Tags compare case-insensitively, without the leading `#`."""
    return tag.lstrip("#").strip().lower()


@dataclass
class Consent:
    """The tree, the rules and the access log for one learner's library."""

    nodes: dict[str, Node] = field(default_factory=dict)
    rules: list[Rule] = field(default_factory=list)
    log: list[Access] = field(default_factory=list)

    # ---- the tree -------------------------------------------------------------------------

    def add(self, *nodes: Node) -> None:
        for n in nodes:
            self.nodes[n.id] = Node(n.id, n.kind, n.parent, frozenset(norm_tag(t) for t in n.tags))

    def lineage(self, node_id: str) -> list[Node]:
        """The node, then its parent, up to the root. Cycles are cut (a corrupt tree fails closed
        at rule 1's walk, not in an infinite loop)."""
        out, seen, cur = [], set(), node_id
        while cur is not None and cur in self.nodes and cur not in seen:
            seen.add(cur)
            n = self.nodes[cur]
            out.append(n)
            cur = n.parent
        return out

    # ---- rules ----------------------------------------------------------------------------

    def set(self, subject: str, agent: str, effect: str, turn: str | None = None,
            set_by: str = "user") -> Rule:
        """Record a decision, replacing an earlier one for the same subject, agent and lifetime."""
        assert effect in ("allow", "deny")
        subject = "#" + norm_tag(subject) if subject.startswith("#") else subject
        self.rules = [r for r in self.rules
                      if not (r.subject == subject and r.agent == agent and r.turn == turn)]
        r = Rule(subject, agent, effect, turn, int(time.time() * 1000), set_by)
        self.rules.append(r)
        return r

    def revoke(self, agent: str, subject: str | None = None) -> int:
        """Drop an agent's allows (on one subject, or everywhere): the one-tap revoke."""
        before = len(self.rules)
        self.rules = [r for r in self.rules if not (
            r.agent == agent and r.effect == "allow" and (subject is None or r.subject == subject))]
        return before - len(self.rules)

    def _applicable(self, node: Node, agent: str, turn: str | None) -> list[Rule]:
        subjects = {node.id} | {"#" + t for t in node.tags}
        return [r for r in self.rules
                if r.subject in subjects and r.agent in (agent, ANY_AGENT)
                and (r.turn is None or r.turn == turn)]

    # ---- resolution -----------------------------------------------------------------------

    def decide(self, agent: str, node_id: str, turn: str | None = None) -> Decision:
        """Resolve one access (see the module overview for the order)."""
        chain = self.lineage(node_id)
        if not chain:
            return Decision("deny", "unknown node")
        for n in chain:
            if PRIVATE_TAG in n.tags:
                return Decision("deny", f"private ({n.id})")
        for n in chain:
            rules = self._applicable(n, agent, turn)
            if not rules:
                continue
            specific = [r for r in rules if r.agent == agent] or rules
            deny = [r for r in specific if r.effect == "deny"]
            r = deny[0] if deny else specific[0]
            how = "this time" if r.turn else "always"
            return Decision(r.effect, f"{r.effect} {r.subject} for {r.agent} ({how})", r)
        return Decision("ask", "no decision yet")

    def allowed(self, agent: str, node_ids: Iterable[str], turn: str | None = None) -> set[str]:
        """The subset an agent may read now: what the retrieval layer filters its SQL by."""
        return {n for n in node_ids if self.decide(agent, n, turn).effect == "allow"}

    def pending_asks(self, agent: str, node_ids: Iterable[str]) -> list[str]:
        """
        What to ask about, batched: the *highest* undecided ancestors (one question about a
        folder rather than one per notebook in it), deduplicated.
        """
        asks: set[str] = set()
        for nid in node_ids:
            if self.decide(agent, nid).effect != "ask":
                continue
            chain = self.lineage(nid)
            # the child of the root that contains it: one question per top-level folder (or
            # loose document) covers everything under it
            asks.add(chain[-2].id if len(chain) >= 2 else chain[-1].id)
        return sorted(asks)

    def record(self, agent: str, node_id: str, purpose: str, turn: str | None, effect: str) -> None:
        """Append to the recent-access log (shown by the dock's "What agents can see")."""
        self.log.append(Access(int(time.time() * 1000), agent, node_id, purpose, turn, effect))
