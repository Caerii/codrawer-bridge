"""
codrawer-agentd: the desktop agent that answers the reMarkable dock's "Ask" entries, in ink.

**The problem.** The codrawer-layer extension puts a dock in xochitl's toolbar. Two of its entries,
"Ask about this page" and the lasso's "Ask about selection", send a ``dock_action`` (``ask_page``,
``ask_selection`` with the lasso's ``bbox``) through the tablet's router (docs/protocol.md,
``dock_action``). The routers only relay it; something has to listen, read the page, ask a model,
and answer. This package is that listener. It joins the tablet's session as an ordinary client,
so nothing on the tablet changes.

**The facts it rests on.**

- The page is the router's ``page`` snapshot, replayed to every joiner, plus the live strokes
  recorded since (protocol.md, ``page``; the Rust router replays both). page.py keeps it.
- Drawings reach the model as files it Reads (ADR 002): render.py draws the page, or the lassoed
  region with a margin, to a PNG under the terminal's working directory.
- The model is Claude Code on the user's subscription. By default (claude_stream.py) agentd keeps
  warm ``claude -p`` stream-json processes with no tools, no settings and a short system prompt,
  and sends the image as a content block: ~0.5 s to first text, ~2.5 s from tap to first stroke
  (2026-10-07), against ~23 s and more through even-terminal (terminal.py, ``--backend
  even-terminal``, as ``/term`` uses it). Every ask gets a fresh process: no context carries over.
- Asks on one page follow its thread (threads.py): a compact text record of what was asked and
  answered there, sent as page data with the next ask; a dock toggle turns it off.
- Page content is data, never instructions (ADR 012, "Structural injection defence"): prompt.py
  fences everything that came from the page and tells the model to Read one file and nothing else;
  terminal.py denies every permission the session asks for.
- Agent ink is ``stroke_*`` on ``layer:"ai"``; with NATIVE_AGENT_INK the tablet bridge commits each
  finished stroke as real ink on the "codrawer: agent" layer (ADR 009 §1, ADR 003). hand.py has
  ``packages/hand`` write the answer in a persona, placement.py finds free space near the
  selection from the snapshot's ink, and service.py plays the strokes at the hand's own timing.
- The tablet's Go and Rust routers relay only a fixed list of message types to other clients: not
  ``term`` and not ``ai_intent``. The glasses get the answer as a ``primer`` message whose ``move``
  is a ``notice`` (its ``glance`` is the glasses' line, its ``text`` the phone panel's); service.py
  also sends ``ai_intent``, which the desktop router relays.

**Data flow.**

    tablet router ──page/stroke_*──▶ PageModel (page.py)
                  ──dock_action──▶ PageQueue (queue.py) ──▶ Agentd.answer (service.py):
        free space reserved (placement.py) ─▶ render PNG (render.py) ─▶ prompt (prompt.py)
        ─▶ even-terminal (terminal.py), streaming ─▶ each finished sentence laid out by the warm
        hand worker (hand.py, packages/hand) and written at pace into the block (stream.py)
        ─▶ glasses line; one JSON line per request in ``.codrawer/agentd/requests.jsonl``

Run it: ``uv run python -m codrawer_bridge.agentd --ws ws://<tablet>:8577/ws/session1 --token
<code>`` (``--help`` for the rest; ``--dry-run`` renders and prints the prompt without sending).
"""
