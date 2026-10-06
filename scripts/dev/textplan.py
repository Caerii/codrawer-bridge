"""Plan text for the Paper Pro's text box: markdown and snippets to native paragraphs, and a safe fallback.

**The problem.** Replies, dictation, completions and snippets all end as text in xochitl's
focused text box. The design in `docs/investigations/keyboard-and-text.md` puts that text in
through the codrawer-layer XOVI extension, as `text_insert` operations on xochitl's own
`SceneController` (`replaceText`, `cycleParagraphStyle`, `setTextStyle`), instead of synthetic
keystrokes. xochitl's text model is paragraphs with one style each (Title, Subheading,
Subheading 2, Body, Bullet, Numbered, Checkbox; indented variants), plus Bold and Italic runs. It
has no code style and no maths. So someone has to turn an agent's markdown (or a snippet) into
that shape; this module is a desktop prototype of that planner, so the mapping can be argued
about with tests before it moves into the bridge (Rust `typer.rs` neighbourhood) or the router.

**What it produces.** A list of blocks, each `{"style": …, "text": …, "bold": [[a, b]…],
"italic": [[a, b]…]}` with character offsets into `text` (UTF-16 code units, which is what Qt
counts, so a cursor index from xochitl and an offset here agree). One `text_insert` operation
carries a reply's blocks (section 1.4 of the doc). Snippets add one marker: the block and offset
where the cursor should end (`cursor`), from a `$0` in the template.

**The fallback.** Without the extension the bridge must still use the uinput typer, and under
xochitl's "United States" keyboard language seven ASCII characters cannot be typed at all
(``[ ] ^ ` { } ~``; read from xochitl's keymap by `epaper_keymap.py`). Worse, the keys a PC layout
uses for five of them are *dead keys* there, so typing them corrupts the next character too.
:func:`fallback_text` removes or substitutes those characters before the typer sees them and
reports what it changed, so the glasses can say so.

Run `uv run python scripts/dev/textplan.py --test` for the checks, or pass a markdown file to see
the operations it would send. Pure: no I/O beyond reading that file.
"""

from __future__ import annotations

import json
import re
import sys

# ── Paragraph styles (xochitl's scene::ParagraphStyle::Type, by the names its toolbar uses) ──
#
# The wire names are ours; the extension maps them to ParagraphStyle::Type values (Title,
# Subheading, Subheading2, Paragraph, Bulletpoint, NumberedList, CheckboxUnchecked,
# CheckboxChecked and the *Indented variants) read from the binary's meta-strings.

STYLES = ("title", "h1", "h2", "body", "bullet", "number", "checkbox", "checkbox_done")

_HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
_CHECK = re.compile(r"^\s*[-*+]\s+\[([ xX])\]\s+(.*)$")
_BULLET = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_NUMBER = re.compile(r"^(\s*)\d+[.)]\s+(.*)$")


def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def _inline(text: str) -> tuple[str, list[list[int]], list[list[int]]]:
    """Strip `**bold**`, `__bold__`, `*italic*`, `_italic_` and backticks; return the plain
    text and the bold/italic ranges in UTF-16 offsets. Backticked code keeps its content
    verbatim (xochitl has no code style) and is never parsed for emphasis."""
    out: list[str] = []
    bold: list[list[int]] = []
    italic: list[list[int]] = []
    pos = 0  # UTF-16 offset of the end of `out`
    i = 0
    while i < len(text):
        if text[i] == "`":
            j = text.find("`", i + 1)
            if j > i:
                seg = text[i + 1:j]
                out.append(seg)
                pos += _utf16_len(seg)
                i = j + 1
                continue
        for mark, ranges in (("**", bold), ("__", bold), ("*", italic), ("_", italic)):
            if text.startswith(mark, i):
                j = text.find(mark, i + len(mark))
                inner = text[i + len(mark):j] if j > i else ""
                # emphasis needs non-space content and, for `_`, a word boundary (snake_case stays)
                if inner and not inner[0].isspace() and not inner[-1].isspace() and not (
                    mark == "_" and i > 0 and text[i - 1].isalnum()
                ):
                    out.append(inner)
                    n = _utf16_len(inner)
                    ranges.append([pos, pos + n])
                    pos += n
                    i = j + len(mark)
                    break
        else:
            out.append(text[i])
            pos += _utf16_len(text[i])
            i += 1
    return "".join(out), bold, italic


def plan_markdown(md: str) -> list[dict]:
    """Markdown (as agents write it) → blocks. Fenced code is kept as body paragraphs, one per
    line, verbatim; it belongs in the editor panel (doc section 6) when that exists."""
    blocks: list[dict] = []
    in_fence = False
    for raw in md.splitlines():
        line = raw.rstrip()
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            blocks.append({"style": "body", "text": line, "bold": [], "italic": []})
            continue
        style, body, indent = "body", line, 0
        if m := _HEADING.match(line):
            style = ("title", "h1", "h2")[len(m.group(1)) - 1]
            body = m.group(2)
        elif m := _CHECK.match(line):
            style = "checkbox_done" if m.group(1) in "xX" else "checkbox"
            body = m.group(2)
        elif m := _BULLET.match(line):
            style, indent, body = "bullet", int(len(m.group(1)) >= 2), m.group(2)
        elif m := _NUMBER.match(line):
            style, indent, body = "number", int(len(m.group(1)) >= 2), m.group(2)
        text, bold, italic = _inline(body)
        b = {"style": style, "text": text, "bold": bold, "italic": italic}
        if indent:
            b["indent"] = 1
        blocks.append(b)
    while blocks and not blocks[-1]["text"] and blocks[-1]["style"] == "body":
        blocks.pop()
    return blocks


# ── Snippets ──────────────────────────────────────────────────────────────────────────────────
#
# A trigger is `;;` + a name, expanded when followed by space or Tab (doc section 5). Templates
# are markdown, so they share the planner; `$0` marks where the cursor goes. These are the
# Putnam write-up skeletons the Primer's learner asked for (ADR 010); the real set lives in a
# user-editable file synced from the desktop, not in code.

SNIPPETS: dict[str, str] = {
    "thm": "## Theorem.\n$0",
    "lem": "## Lemma.\n$0",
    "pf": "*Proof.* $0\n\n∎",
    "contra": "*Proof.* Suppose, for contradiction, that $0.\n\n… a contradiction. ∎",
    "ind": "*Proof* (induction on n).\n- **Base case** (n = 1): $0\n- **Inductive step**: assume P(k); show P(k+1).\n\nHence P(n) for all n ≥ 1. ∎",
    "cases": "- **Case 1**: $0\n- **Case 2**: ",
    "putnam": "# Problem\n$0\n## Answer\n\n## Proof\n",
    "claim": "**Claim.** $0\n*Proof of claim.* ",
}


def expand_snippet(name: str) -> dict | None:
    """The blocks for `;;name`, and the cursor position after insertion as
    `{"block": i, "offset": utf16}`; None if there is no such snippet."""
    tpl = SNIPPETS.get(name)
    if tpl is None:
        return None
    blocks = plan_markdown(tpl.replace("$0", "\x00"))
    cursor = {"block": len(blocks) - 1, "offset": _utf16_len(blocks[-1]["text"]) if blocks else 0}
    for i, b in enumerate(blocks):
        k = b["text"].find("\x00")
        if k >= 0:
            off = _utf16_len(b["text"][:k])
            b["text"] = b["text"].replace("\x00", "")
            for r in b["bold"] + b["italic"]:
                r[0] -= r[0] > off
                r[1] -= r[1] > off
            cursor = {"block": i, "offset": off}
    return {"blocks": blocks, "cursor": cursor}


# ── The uinput fallback ──────────────────────────────────────────────────────────────────────

# What xochitl's "UnitedStates" keymap cannot produce (epaper_keymap.py, 2026-10-06, OS 3.29.0.149).
US_MISSING = "[]^`{}~"
# Readable stand-ins when substitution is asked for. Brackets become parentheses so structure
# survives; `^` becomes `**` (power, as in Python); `~` and backtick become their nearest
# typeable neighbours.
SUBSTITUTE = {"[": "(", "]": ")", "{": "(", "}": ")", "^": "**", "~": "-", "`": "'"}


def fallback_text(text: str, missing: str = US_MISSING, substitute: bool = False) -> tuple[str, dict[str, int]]:
    """Text the uinput typer can type without corrupting anything, and a count of each character
    it removed or replaced. Characters outside ASCII are left for the typer to skip (it has no
    key for them either); only the dead-key hazards need removing up front."""
    changed: dict[str, int] = {}
    out = []
    for c in text:
        if c in missing:
            changed[c] = changed.get(c, 0) + 1
            if substitute:
                out.append(SUBSTITUTE.get(c, ""))
            continue
        out.append(c)
    return "".join(out), changed


# ── Self-test ────────────────────────────────────────────────────────────────────────────────


def _test() -> None:
    b = plan_markdown("# Answer\nThe sum is **even**, see `a_n`.\n- one\n  - nested\n1. first\n- [x] done\n- [ ] todo")
    assert [x["style"] for x in b] == ["title", "body", "bullet", "bullet", "number", "checkbox_done", "checkbox"], b
    assert b[1]["text"] == "The sum is even, see a_n." and b[1]["bold"] == [[11, 15]], b[1]
    assert b[3].get("indent") == 1
    assert plan_markdown("snake_case_name stays")[0]["italic"] == []
    assert plan_markdown("x ≤ 𝔽 **y**")[0]["bold"] == [[7, 8]]  # 𝔽 is two UTF-16 units
    s = expand_snippet("pf")
    assert s and s["blocks"][0]["text"] == "Proof. " and s["cursor"] == {"block": 0, "offset": 7}, s
    assert s["blocks"][0]["italic"] == [[0, 6]]
    s = expand_snippet("ind")
    assert s and s["cursor"]["block"] == 1 and s["blocks"][1]["style"] == "bullet", s
    assert expand_snippet("nope") is None
    t, ch = fallback_text("a[i] = x^2 {ok}")
    assert t == "ai = x2 ok" and ch == {"[": 1, "]": 1, "^": 1, "{": 1, "}": 1}
    assert fallback_text("x^2", substitute=True)[0] == "x**2"
    print("textplan: all checks pass")


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1] == "--test":
        _test()
        return 0
    if len(argv) > 1 and argv[1].startswith(";;"):
        print(json.dumps({"op": "text_insert", "id": "s1", **(expand_snippet(argv[1][2:]) or {})}, ensure_ascii=False))
        return 0
    md = open(argv[1], encoding="utf-8").read() if len(argv) > 1 else sys.stdin.read()
    print(json.dumps({"op": "text_insert", "id": "t1", "undo": "one", "blocks": plan_markdown(md)}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
