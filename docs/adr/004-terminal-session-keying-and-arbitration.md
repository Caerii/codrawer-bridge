# ADR 004 — Terminal sessions in a multiplayer room

Status: proposed (2026-09-27) · Owner: SIG platform · Related: ADR 001, ADR 005

## Context

A codrawer session already has several participants (a tablet, a phone, a desktop viewer,
a simulator). The router attaches one even-terminal session per codrawer session
(`server/term_bridge.py`, remembered across restarts). Two people at one whiteboard must be
able to talk to one agent about one drawing without interleaving or stealing each other's
permission prompts.

## Decision

- **Keying.** One shared terminal session per codrawer session by default. `/private`
  opens a personal terminal session for the participant who typed it; `/shared` returns.
  Keys are `<codrawer session>` and `<codrawer session>/<participant>`.
- **Attribution.** Every prompt line in the transcript and in the tablet document carries
  the sender's display name. The agent's reply is addressed to the turn (ADR 001).
- **Arbitration.** The agent answers one turn at a time per terminal session. A prompt
  submitted while a turn is open is queued and the sender sees *queued behind <name>*;
  the queue drains in order. `Escape` on the sender's keyboard withdraws a queued prompt.
- **Permissions and questions** belong to the participant whose turn raised them. Others see
  the prompt with the owner's name and cannot answer it; if the owner is gone for 60 s the
  prompt is denied and the turn continues.
- **Cost** is attributed to the submitting participant's budget, not the room's.

## Consequences

- The term bridge gains a per-session queue and an owner on each pending prompt.
- The protocol gains `participant_id` on `term_prompt`/`term_answer` and `owner` on `term`
  permission/question messages.
- Private sessions multiply even-terminal sessions; fine on one desktop, revisit when the
  router moves to a host with many rooms.
