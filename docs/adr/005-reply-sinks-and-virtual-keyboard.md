# ADR 005 — Where replies land

Status: proposed (2026-09-27) · Owner: SIG platform · Related: ADR 004

## Context

A terminal reply can be shown on the glasses transcript, typed into the tablet's focused
text field through the bridge's uinput virtual keyboard, shown in the web viewer, and later
drawn on the page as ink. Each surface has a different cost: typing into a document is
durable but slow (12 ms per character) and irreversible without an edit; the glasses are
instant and ephemeral.

## Decision

- Every participant has a **sink preference**: `glasses`, `tablet`, `both` (default for a
  participant who has a tablet bridge, `glasses` otherwise). It is set from the glasses menu
  or `/sink <name>` and persisted per device.
- **Only the turn's owner's tablet is typed into.** A reply is never typed into another
  participant's document (ADR 004 attribution).
- **Typing is opt-in per session and visible.** The virtual keyboard registers as
  `codrawer virtual keyboard`; while it types, the glasses show *typing into tablet…*; a
  single tap on the ring pauses it, a second tap resumes, Escape on the keyboard stops the
  current reply.
- **What is typed.** Streamed text verbatim; notes (tool start/end, done, errors) on their
  own line; the prompt echo is skipped; permission prompts are typed so the document records
  the question, but answers are only accepted from the keyboard.
- **Pace** is a setting (`-type-char-ms`, default 12) and adapts down when the tablet UI
  drops keys (detected by the bridge reading back its own uinput events).

## Consequences

- The bridge learns its participant identity (from the session join) so the router can
  target `term` messages to the owner's bridge only; until then the bridge types replies for
  every turn on its session, which is correct for the single-user case.
- A document edited by the virtual keyboard is the durable record; the glasses are the glance.
