# ADR 012: Delegation on paper

Status: proposed (2026-10-06) · Owner: Alif / SIG platform · Related:

- ADR 002 (image attachment), 003 (agent ink as a governed action), 004 (terminal keying and
  arbitration), 005 (reply sinks), 008 (page model), 009 (call and response in native ink),
  011 (grounded context and its consent model; branch `research/grounded-context`);
- SIG GLASS-04;
- `docs/investigations/delegation-on-paper.md`, `packages/delegate`, `docs/media/delegate-*`.

## Context

codrawer can now write agent ink natively on the reMarkable page, on a layer of its own (ADR 009),
and it reads the user's ink with stable ids (ADR 008). The next step the user asked for is
*delegation*:

- trigger pods and agents from the tablet;
- let them do consequential work, unattended;
- have them come back for follow-up, visually and in ink, answered with the pen.

ADR 009's `@ask` is synchronous call and response. Delegation is asynchronous, so it needs
three more things:

- a durable object on the page that holds a task's state;
- a way to answer it with marks;
- a governance model strong enough that a page, a PDF or a pod cannot turn page text into
  action.

The smart_remarkable review showed the failure mode: full-shell agents driven by page text,
gated only by a prompt.

## Decision

### 1. A delegation is a task card on the page

- **Triggers.**
  - lasso, then "Delegate…" (or "Ask agent" plus a pod pick from the dock);
  - lasso, then `@pod` written beside it;
  - `@pod` typed in a text box;
  - the dock's "Delegate page to…";
  - later, a learned personal delegate mark (ADR 013, `packages/marks`: a mark meaning
    "delegate to @pod" emits this `task_create` with `trigger:"mark"`).

  A pod is chosen explicitly, never inferred from the content.
- **The task** is a structured object (`packages/delegate/src/task.ts`):
  - the ink region, with page id, rect and stroke ids, plus its image and geometry (ADR 002);
  - the recognised text, as **data**;
  - the user's ask;
  - context references resolved by ADR 011's retrieval layer;
  - an optional one-time grant;
  - the requester's participant and device;
  - an authority level.
- **The card.** The broker draws a card beside the delegated ink, clear of all ink (placement
  from the `page` snapshot's stroke boxes, with a stub when the page is full). It is written in
  the pod's handwriting persona (packages/hand), on the pod's own layer (`codrawer: <pod>`).
- **Status is a discrete mark in a box, with no animation:**

  | status | mark |
  | --- | --- |
  | queued | ☐ |
  | working | / |
  | needs you | ! (plus a doubled left rule) |
  | done | ✓ |
  | failed | ✗ |
  | paused | ‖ |
  | cancelled | struck |

  An additive status trail (`10:19 needs you`) records the history.
- **Pods return structured content; the broker draws.** Pods never draw on cards. That rule is
  what makes a card's answer regions and consent box trustworthy.

### 2. Answers are marks, read against the card's regions

The card's layout names its answer regions: each option's row, label and box, the consent box
and the correction box. The classifier (`marks.ts`) reads a gesture's *shape* from geometry, then
its *meaning* against those regions:

| mark | means |
| --- | --- |
| circle on a label | choose |
| tick in a box | choose |
| line through a label | reject that option |
| line through the title, or ✗ over the card | cancel |
| arrow from card to card | chain (hand off the result) |
| arrow from a card to ink | add that ink to the task |
| writing in the box or margin | a correction to the pod |
| initials in the consent box | consent candidate |
| `‖` in the top margin | pause all pods |

- **Ambiguous marks are not guessed.** The card shows "?" and waits for a second mark.
- **Off-card marks are not answers.** A mark that is not on a card region is the user's page
  and means nothing to any pod.
- **Timing.** A mark counts only if it began after the card drew the decision.
- **Phone and ring answers.** A tap on the phone or a ring choice is the same `task_answer`,
  with its `via`.

### 3. Consent by pen is bound to one action

A pod at `act_with_consent` may only *propose* an action. The broker then:

1. hashes it (SHA-256 of canonical JSON);
2. draws the verb, a consent box and the hash's 6-character code on the card (the glasses and
   phone show the same code);
3. accepts initials in the box only if all of these hold:
   - the action still hashes to that value;
   - the nonce is unused;
   - the strokes are `layer:"user"` with `origin:"pen"`, a tag set by the router from the
     tablet bridge's authenticated connection, never from the message;
   - the strokes come from the requester's device;
   - the strokes began after the code was drawn and before the window closed;
4. executes the action itself, never the pod: locally, or through SIG's connector broker.

Similarity to enrolled initials is a **soft** signal. Initials are a weak biometric, so
low similarity, nothing enrolled, or a high-stakes action requires a second factor that confirms
the same code: a ring tap or a phone tap. Every action carries a compensation where one exists
(unsend within 30 s, unshare, close PR). Actions with none count as high-stakes.

### 4. Governance

- **Authority levels**, each including the one before:
  - `read`: in-scope retrieval, public GET, and its own return;
  - `draft`: also drafts in a sandbox it owns;
  - `act_with_consent`: also proposals of listed action kinds.

  Effective authority is `min(pod ceiling, trigger grant)`, SIG's "most restrictive" rule.
- **Structural injection defence.**
  - The only authorising input is the user's own pen mark on a broker-drawn card region.
  - Page text, recognised text, PDFs and fetched pages are delivered as untrusted data.
  - Pods are not shells: their tools are codrawer MCP tools chosen by authority level. Local
    pods' Claude Code permissions deny Bash, Write and Edit outside a scratch directory; cloud
    pods run in SIG's governed sandboxes.
  - A hijacked pod can produce only a return, and a return can only propose.
  - Read pods do not combine private context with web fetch by default.
- **Context (ADR 011, not redefined here).**
  - A task's context is the lassoed ink plus only sources in the pod's scope.
  - Delegating may grant a narrow, **one-time** scope for that task. It is printed on the card,
    logged, and expires when the task ends; it is never a standing permission.
  - At most one batched ask, at dispatch. A pod that needs more mid-task does not prompt: it
    returns the request as one of its drawn decisions.
- **Audit with ink provenance.** Every state change, read, answer and consent appends an audit
  row. Answers and consents carry the CRDT stroke ids of the marks and the `page` rev, so the
  approval is the user's actual ink on that page.
- **Rate limits.**
  - Tasks: 3 running and 20 per day per user.
  - Pods: one task each.
  - Actions: 10 per hour, 1 per minute per kind.
  - Repeated triggers on one region within 10 s are discarded.
  - Compute runs in GLASS-01 envelopes.
- **Pause all pods.**
  - Routes: the dock button, the `‖` gesture, a ring long-press, or `Ctrl+Alt+P`.
  - Effect: every task goes to `paused`, and pending consents are withdrawn (their codes become
    invalid).
  - Nothing resumes on its own.
- **Attention budget on the glasses.**
  - Only "needs you" pushes, and only at a pen-up lull.
  - At most 3 pushes per hour and 1 per pod per 20 minutes; the rest are batched.
  - "Focus" sets the budget to 0.

### 5. Threads

Each task has a thread: trigger ink, the full report, sources with quotes, decisions and their
marks, actions and receipts, and a replay of the pod's steps.

- The thread is authoritative in the broker's store and rendered on the phone and web.
- When native page insertion is proven, the broker also writes a task page into a "codrawer
  tasks" notebook. That page answers exactly like a card.

### 6. Architecture

- **The broker is a module of the desktop Python router** (`server/tasks/`). The tablet sleeps
  and its Go router is stroke-only. The Go router relays `task_*`, and the tablet commits card
  ink to pod layers (ADR 009).
- **Pods run in two places:**
  - local even-terminal sessions (Phases 1–2);
  - SIG cloud pods over the tailnet (Phase 3), through `pod_session_commands` / `swarm_jobs`
    with Work Contracts.
- **The codrawer MCP server (ADR 003) is the pod-facing API.** It adds `task.get`,
  `context.search`, `web.fetch`, `task.status`, `task.return`, `task.propose` and
  `task.answers` to the ink tools, with a per-task token.
- **Persistence:** `.codrawer/tasks.sqlite` plus `audit.jsonl`; SIG write-through with GLASS-04.
- **Protocol (additive):** `task_create`, `task_status`, `task_return`, `task_answer`, `consent`,
  `pods_pause` / `pods_resume`. Card ink travels as ordinary `stroke_*` on `layer:"ai"` with the
  pod as `author`. Every surface shows the same cards from the same layout code.

### 7. Phases

1. **One read-only research pod.** Lasso or dock dispatch; a card with status and a return
   summary; choices answered by circle or tick (or a phone tap); the glance line; the audit log;
   thresholds tuned on real ink.
2. **Draft-only pods and consent.** Consent by pen for sending, with enrolment, second factor
   and undo; chaining by arrows; corrections; pause all; rate limits.
3. **The SIG pod fleet.** Consent as an approval-queue approval with `approved_via=paper`;
   learned delegate marks; threads as notebook pages; cards in shared sessions answerable only
   by their requester (ADR 004).

## Consequences

- **Delegation becomes part of the notebook.** Cards, answers and consents are ink in the user's
  hand and the pods' hands, durable and auditable by stroke id.
- **The broker owns rendering of every answerable surface.** This costs flexibility (a pod
  cannot design its own form) and buys a trustworthy consent region.
- **Small modules.** Mark recognition is in-context geometry, not vision, so it is small, fast,
  testable and explainable. It is limited to the grammar; anything else goes to the pod as
  image plus strokes.
- **Consent leans on device provenance.** The router must tag `origin` by connection and reject
  `layer:"user"` from non-bridge connections. This is a protocol-level change that also
  hardens ADR 009's trust boundary (today, the pairing code).
- **The spike's thresholds come from synthetic hands.** Real-ink tuning is a Phase 1 exit
  criterion.
- **Open probes:**
  - removing a committed line on our own layer (status-mark replacement);
  - native page insertion (task pages);
  - recognising `@pod` and yes/no in handwriting;
  - G2 glyph coverage;
  - the SIG monorepo's real APIs. This ADR's SIG mapping comes from secondary notes.
