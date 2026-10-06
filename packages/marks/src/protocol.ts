/**
 * The marks messages, as types (docs/protocol.md, "Personal marks", is canonical).
 *
 * Who sends what:
 *
 *     recogniser host ──mark_seen───▶ all        a gesture was read as a mark, an ambiguity or a candidate
 *     recogniser host ──mark_ask────▶ all        one batched question: "this mark → ?"
 *     any surface ─────mark_define──▶ host       an answer, or an edit: create, refine, retract, share, …
 *     recogniser host ──mark_invoke─▶ all        a mark fired (or proposes to): its meaning and target
 *     any surface ─────mark_feedback▶ host       accept, reject or undo of an invocation
 *     any surface ─────mark_query───▶ host       ask for the registry
 *     recogniser host ──marks───────▶ all        the registry visible to the asker
 *
 * The recogniser host is whichever participant runs the engine for an owner: today the owner's
 * phone (apps/even-g2, "Watch for my marks"), later the desktop router's broker. Routers relay
 * every `mark_*` message and `marks` like `dock_action`.
 *
 * Coordinates follow protocol.md (normalized page coordinates, Unix ms), with one exception:
 * **glyph ink** (`ink_mm`: an example or an occurrence's shape) is in millimetres relative to the
 * glyph's own bounding box, because a mark's examples are shapes, not places on a page, and the
 * recogniser's size gate needs real size.
 */

import type { ActionKind, Meaning, Target } from './actions'
import type { Relation } from './context'
import type { LineageOp, Mark, Verdict } from './registry'
import type { CandidateReason } from './teach'

type Pt = [number, number]
/** [x0, y0, x1, y1], normalized page coordinates */
export type Box = [number, number, number, number]

export interface MarkSeen {
  t: 'mark_seen'
  occurrence: string
  owner: string
  strokes: string[]
  page?: string
  bbox: Box
  /** mark: recognised; ambiguous: two marks fit; candidate: unknown, worth asking about */
  result: 'mark' | 'ambiguous' | 'candidate'
  mark?: string
  marks?: string[]
  confidence?: number
  reason?: CandidateReason
  relation?: Relation
  why: string
  ts: number
}

export interface AskItem {
  occurrence: string
  strokes: string[]
  page?: string
  bbox: Box
  ink_mm: Pt[][]
  reason: CandidateReason
  /** how many times this shape has been seen */
  seen: number
}

export interface MarkAsk {
  t: 'mark_ask'
  ask: string
  owner: string
  items: AskItem[]
  options: ActionKind[]
  ts: number
}

/** `op` names the change; the other fields are what that change needs. */
export interface MarkDefine {
  t: 'mark_define'
  op: LineageOp | 'decline'
  by: string
  /** the mark changed (absent for create and decline) */
  mark?: string
  /** create / decline from an ask: which question and occurrence it answers */
  ask?: string
  occurrence?: string
  meaning?: Meaning
  name?: string
  /** create or add_example without an occurrence: examples drawn elsewhere (the phone's pad) */
  examples?: Pt[][][]
  /** remove_example */
  example?: string
  rotation?: number
  note?: string
  ts: number
}

export interface MarkInvoke {
  t: 'mark_invoke'
  invocation: string
  mark: string
  owner: string
  name: string
  meaning: Meaning
  /** confirm: waits for an accept; notify: done, with an undo offered; silent: done */
  mode: 'confirm' | 'notify' | 'silent'
  confidence: number
  why: string
  occurrence: { strokes: string[]; bbox: Box; page?: string }
  target: Target
  /** the message the action became (sent alongside unless mode is confirm) */
  effect: Record<string, unknown> | null
  ts: number
}

export interface MarkFeedback {
  t: 'mark_feedback'
  invocation: string
  verdict: Exclude<Verdict, 'expired'>
  by: string
  via: 'phone' | 'pen' | 'glasses' | 'ring'
  ts: number
}

export interface MarkQuery {
  t: 'mark_query'
  by: string
}

export interface MarksSnapshot {
  t: 'marks'
  owner: string
  marks: Mark[]
  ts: number
}

export type MarkMessage = MarkSeen | MarkAsk | MarkDefine | MarkInvoke | MarkFeedback | MarkQuery | MarksSnapshot

/** The message tags routers relay. */
export const MARK_TYPES = ['mark_seen', 'mark_ask', 'mark_define', 'mark_invoke', 'mark_feedback', 'mark_query', 'marks'] as const
