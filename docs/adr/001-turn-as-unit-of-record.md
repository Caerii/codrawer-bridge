# ADR 001 — The turn is the unit of record

Status: proposed (2026-09-27) · Owner: Alif / SIG platform · Related: SIG GLASS-04, ADR 002, ADR 003

## Context

A codrawer session already carries several kinds of events from several participants: pen
strokes from a tablet, keystrokes from a paired keyboard, `prompt` and `term_prompt` lines,
AI ink, terminal replies. Today they are a flat broadcast stream. Nothing groups "what I drew
and typed" with "what the agent answered", so nothing can be replayed to a late joiner,
audited as one decision, or attributed to one person.

## Decision

A **turn** is the unit of record. A turn opens when a participant submits a line (Enter on the
keyboard, a `prompt`, a `term_prompt`, or a dictated utterance) and closes when the agent's
reply for that line completes (the terminal `result` event or the last `ai_stroke_end` that
answered it).

Every event carries `participant_id` and `turn_id`. The router assigns both: strokes drawn
between two submissions belong to the *next* turn ("the ink since your last Enter"), agent
text and agent ink belong to the turn they answer.

A turn record contains: the submitting participant, the text, the strokes (full polylines),
the rendered attachment if one was made (ADR 002), voice audio and its transcript when
dictation exists, the agent's text, the agent's ink, tool calls, and the receipts (cost,
budget, audit ids) from the SIG compute envelope.

Turns are append-only. Undoing agent ink is a tombstone on the stroke, never a deletion of
the turn (this matches the `ink_tombstones` table in the GLASS-04 plan).

## Consequences

- The router gains a small in-memory turn ledger per session, flushed to the SIG `ink_*`
  tables when Phase 1 of GLASS-04 lands. Until then, turns live for the session.
- Late joiners are hydrated by replaying turns, not raw events.
- The protocol gains `turn_id` on `stroke_begin`, `prompt`, `term_prompt`, `term`, and
  `ai_intent`; old clients ignore it.
- Multiplayer arbitration (ADR 004) and reply sinks (ADR 005) both key on the turn.
