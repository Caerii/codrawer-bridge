/**
 * The animation messages (docs/protocol.md, "anim_*"; design in
 * docs/investigations/codrawer-animate.md, "Protocol additions") and the reducer that applies
 * them to an {@link Anim}.
 *
 * The principle is ADR 008's: a frame is a page. Its strokes travel the way every page's strokes
 * travel (`page` snapshots from the tablet's page watcher, `stroke_*` from phones and agents,
 * tagged with the frame's page id), so nothing here carries ink except `anim_frame` with
 * `op:"strokes"`, which sets a whole frame at once (an agent's in-between, a generated motion).
 * What these messages add is the animation's *structure*: which pages are frames, in what order,
 * for how long, at what speed, and the shared transport (play, stop, onion skin, which frame each
 * participant is on).
 *
 * Frames are named by id, never by index, so two people editing the strip at once do not move
 * each other's targets. Every structural message carries the animation id; a message for another
 * animation is ignored. Routers relay all of them and keep the latest `anim` per animation (and
 * apply structural ops to it) so a joiner gets the strip right after `hello`.
 *
 * Times: `at` is Unix ms on the sender's clock; holds are ticks; fps ticks per second.
 */

import type { Anim, AnimStroke, FrameSource, LoopMode } from './model'
import { deleteFrame, duplicateFrame, frameIndex, insertFrame, moveFrame, setFps, setHold, setLoop, setStrokes } from './model'
import type { OnionLook } from './onion'

/** A frame as the structure describes it (its strokes come from its page). */
export interface FrameMeta {
  id: string
  hold: number
  key?: boolean
  source?: FrameSource
}

/** The whole structure: sent on creation, on join (replay), and after a compaction. */
export interface AnimDoc {
  t: 'anim'
  id: string
  title: string
  fps: number
  loop: LoopMode
  frames: FrameMeta[]
  /** sender's Unix ms */
  rev: number
}

export type FrameOp =
  | { op: 'add'; frame: FrameMeta; after: string | null }
  | { op: 'dup'; frame: string; id: string }
  | { op: 'delete'; frame: string }
  | { op: 'move'; frame: string; to: number }
  | { op: 'hold'; frame: string; hold: number }
  | { op: 'strokes'; frame: string; strokes: AnimStroke[] }

export type AnimFrame = { t: 'anim_frame'; anim: string } & FrameOp

export interface AnimSet {
  t: 'anim_set'
  anim: string
  fps?: number
  loop?: LoopMode
  title?: string
}

/** Shared transport: every surface starts frame `from` at Unix ms `at` and follows `frameAt`. */
export interface AnimPlay {
  t: 'anim_play'
  anim: string
  state: 'play' | 'stop'
  at: number
  from?: string
}

/** A participant's editing focus (the tablet turns to that frame's page). */
export interface AnimGoto {
  t: 'anim_goto'
  anim: string
  frame: string
  who?: string
}

/** Onion skin settings; per participant, so `who` says whose. */
export interface AnimOnion {
  t: 'anim_onion'
  anim: string
  on: boolean
  before: number
  after: number
  look: OnionLook
  who?: string
}

/** A request for in-betweens; an agent answers with `anim_frame` add + strokes (provenance agent). */
export interface AnimTween {
  t: 'anim_tween'
  anim: string
  after: string
  count: number
  ease?: string
}

export type AnimMessage = AnimDoc | AnimFrame | AnimSet | AnimPlay | AnimGoto | AnimOnion | AnimTween

/** The structure of an animation as an `anim` message (strokes omitted). */
export function toDoc(anim: Anim, rev: number): AnimDoc {
  return {
    t: 'anim',
    id: anim.id,
    title: anim.title,
    fps: anim.fps,
    loop: anim.loop,
    frames: anim.frames.map(({ id, hold, key, source }) => ({ id, hold, ...(key === undefined ? {} : { key }), ...(source ? { source } : {}) })),
    rev,
  }
}

/**
 * Apply a message to an animation. An `anim` replaces the structure but keeps the strokes of
 * frames it still lists (they arrive separately); ops naming unknown frames are ignored, as
 * `stroke_delete` ignores unknown ids, so a late or duplicated op is harmless. Transport and
 * per-participant messages (`anim_play`, `anim_goto`, `anim_onion`, `anim_tween`) do not change
 * the structure and return the animation unchanged.
 */
export function applyAnim(anim: Anim | null, m: AnimMessage): Anim | null {
  if (m.t === 'anim') {
    if (anim && anim.id !== m.id) return anim
    const old = new Map((anim?.frames ?? []).map((f) => [f.id, f.strokes]))
    return {
      id: m.id,
      title: m.title,
      fps: m.fps,
      loop: m.loop,
      frames: m.frames.map((f) => ({ ...f, hold: Math.max(1, Math.round(f.hold)), strokes: old.get(f.id) ?? [] })),
    }
  }
  if (!anim || m.anim !== anim.id) return anim
  if (m.t === 'anim_set') {
    let next = anim
    if (m.fps !== undefined) next = setFps(next, m.fps)
    if (m.loop !== undefined) next = setLoop(next, m.loop)
    if (m.title !== undefined) next = { ...next, title: m.title }
    return next
  }
  if (m.t !== 'anim_frame') return anim
  switch (m.op) {
    case 'add': {
      if (frameIndex(anim, m.frame.id) >= 0) return anim
      const after = m.after === null ? -1 : frameIndex(anim, m.after)
      if (m.after !== null && after < 0) return anim
      return insertFrame(anim, after, { ...m.frame, strokes: [] })
    }
    case 'dup': {
      const i = frameIndex(anim, m.frame)
      return i < 0 || frameIndex(anim, m.id) >= 0 ? anim : duplicateFrame(anim, i, m.id)
    }
    case 'delete': {
      const i = frameIndex(anim, m.frame)
      return i < 0 || anim.frames.length === 1 ? anim : deleteFrame(anim, i)
    }
    case 'move': {
      const i = frameIndex(anim, m.frame)
      const to = Math.max(0, Math.min(anim.frames.length - 1, Math.round(m.to)))
      return i < 0 ? anim : moveFrame(anim, i, to)
    }
    case 'hold': {
      const i = frameIndex(anim, m.frame)
      return i < 0 ? anim : setHold(anim, i, m.hold)
    }
    case 'strokes': {
      const i = frameIndex(anim, m.frame)
      return i < 0 ? anim : setStrokes(anim, i, m.strokes)
    }
  }
}
