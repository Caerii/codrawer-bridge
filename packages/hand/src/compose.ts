/**
 * Cognitive timing: when the hand pauses, hesitates, slows down or takes a word back.
 *
 * codrawer treats the pace of writing as signal (alifjakir.com/codrawer: an interface that
 * respects "the pace, texture, and ambiguity of actual thought"). A co-thinker's ink should
 * carry the same signal: it should pause where a thought ends, slow down where it is unsure, and
 * occasionally change its mind. This module turns words into *gestures* (planned pen-downs) and
 * annotates each with the pen-up time that precedes it:
 *
 * - **Boundaries.** A pause after each word, longer after a comma or dash, longer still after a
 *   sentence, and before a new line (persona `timing`). Pauses in handwriting cluster at these
 *   linguistic boundaries and lengthen with the size of the unit (Matsuhashi 1981, "Pausing and
 *   planning: the tempo of written discourse production", Res. Teach. Engl. 15, 113–134; within
 *   words, Kandel, Peereman, Grosjacques & Fayol 2011, J. Exp. Psychol. HPP 37, 1310–1322).
 *   Every pause varies by `jitter`.
 * - **Symbols.** The Mathematician pauses before "=" (and other relation signs) and again after
 *   the result that follows it.
 * - **Confidence** (0..1 per word or phrase, from the caller: how sure the agent is). Doubt
 *   adds a *hover* before the word (the pen travels to the spot and waits, raised), slows the
 *   whole word by up to `doubt`, and slows its first strokes most. With probability
 *   `correction · (1 − confidence)^1.5` the word comes out with a slip (two letters swapped, one
 *   dropped or doubled), the hand notices, strikes it through and writes it again after it.
 *
 * Pauses are split into *think* (after lifting, before travelling on: finishing the thought) and
 * *hover* (over the landing point, before touching down: deciding to commit). Both are pen-up;
 * clients see only the gap, but the arm inset in the lab shows the hand waiting.
 *
 * The other half of "does not talk over you", yielding while the user is writing, needs a clock
 * and lives in perform.ts.
 */

import { Writer, bbox, type LaidWord, type Pt } from './layout'
import type { Persona } from './persona'
import type { Rng } from './rng'

/** A piece of text with how sure the writer is of it. */
export interface Phrase {
  text: string
  /** 0 (unsure) .. 1 (certain); default from the options, else 1 */
  confidence?: number
}

/** One planned pen-down and the pen-up time before it. */
export interface Gesture {
  /** intended path, mm */
  pts: Pt[]
  /** `strike`: a stroke through a word being taken back */
  kind: 'ink' | 'strike'
  /** index into the composed words */
  word: number
  /** pen-up thinking time after the previous lift, before the travel, s */
  think: number
  /** hovering over the landing point before touching down, s */
  hover: number
  /** multiplier on the gesture's impulse durations (≥ 1 when unsure) */
  slow: number
  /** extra multiplier on its first impulses, easing to 1 by the third */
  slowFirst: number
}

/** A word as written (a corrected word appears twice: the slip, then the rewrite). */
export interface WordInfo {
  text: string
  confidence: number
  /** intended bounding box, mm */
  box: [number, number, number, number]
  line: number
  /** this is a slip that was struck through */
  struck: boolean
}

/** The composition: gestures in writing order, and the words they belong to. */
export interface Composition {
  gestures: Gesture[]
  words: WordInfo[]
}

/** Options for {@link compose}. */
export interface ComposeOptions {
  /** wrap width, mm (default: no wrapping) */
  width?: number
  /** confidence for every word, or per word (in order); a phrase's own value wins */
  confidence?: number | number[]
}

const SENTENCE_END = /[.?!…]["”’)]*$/
const PHRASE_END = /[,;:]["”’)]*$|^[—–-]$/
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Split phrases into words, keeping each word's confidence and whether a newline precedes it. */
function words(input: string | Phrase[], opts: ComposeOptions): { text: string; c: number; newline: boolean }[] {
  const phrases: Phrase[] = typeof input === 'string' ? [{ text: input }] : input
  const out: { text: string; c: number; newline: boolean }[] = []
  let newline = false
  for (const ph of phrases) {
    for (const tok of ph.text.split(/(\s+)/)) {
      if (!tok) continue
      if (/^\s+$/.test(tok)) {
        if (tok.includes('\n')) newline = true
        continue
      }
      const i = out.length
      const given = Array.isArray(opts.confidence) ? opts.confidence[i] : opts.confidence
      out.push({ text: tok, c: clamp01(ph.confidence ?? given ?? 1), newline })
      newline = false
    }
  }
  return out
}

/** A plausible slip of the pen for `w`, or null when the word is too short to slip. */
export function slip(w: string, rng: Rng): string | null {
  const letters = [...w]
  const idx = letters.map((ch, i) => (/\p{L}/u.test(ch) ? i : -1)).filter((i) => i >= 0)
  if (idx.length < 3) return null
  const kind = rng.next()
  const i = idx[1 + Math.floor(rng.next() * (idx.length - 2))]
  if (kind < 0.45 && idx.includes(i + 1) && letters[i] !== letters[i + 1]) {
    ;[letters[i], letters[i + 1]] = [letters[i + 1], letters[i]] // transposition
  } else if (kind < 0.75) {
    letters.splice(i, 1) // omission
  } else {
    letters.splice(i, 0, letters[i]) // doubling
  }
  const s = letters.join('')
  return s === w ? null : s
}

/**
 * Compose text into gestures for `persona` (see the overview). Deterministic for a given `rng`.
 */
export function compose(input: string | Phrase[], persona: Persona, rng: Rng, opts: ComposeOptions = {}): Composition {
  const T = persona.timing
  const L = persona.letters
  const writer = new Writer(L, rng.fork('layout'), opts.width ?? Infinity)
  const r = rng.fork('cognition')
  const vary = (s: number) => Math.max(0, s * (1 + r.gauss(T.jitter)))
  const gestures: Gesture[] = []
  const infos: WordInfo[] = []
  const list = words(input, opts)

  const emit = (w: LaidWord, c: number, think: number, hover: number, struck: boolean) => {
    const wi = infos.length
    infos.push({ text: w.text, confidence: c, box: w.box, line: w.line, struck })
    const slow = 1 + T.doubt * (1 - c)
    const slowFirst = 1 + 0.6 * T.doubt * (1 - c)
    w.strokes.forEach((s, k) => {
      gestures.push({
        pts: s.pts,
        kind: 'ink',
        word: wi,
        think: k === 0 ? think : s.delayed ? vary(0.04) : 0,
        hover: k === 0 ? hover : 0,
        slow,
        slowFirst: k < 2 ? slowFirst : 1,
      })
    })
    return wi
  }

  let resultNext = false // the word after "=" is a result; pause after it
  let pauseAfterResult = false
  list.forEach((w, i) => {
    const prev = list[i - 1]
    let think = 0
    if (i > 0) {
      if (w.newline) {
        writer.newline()
        think += vary(T.line)
      } else writer.space()
      if (SENTENCE_END.test(prev.text)) think += vary(T.sentence)
      else if (PHRASE_END.test(prev.text)) think += vary(T.phrase)
      else think += vary(T.word)
      if (pauseAfterResult) think += vary(T.afterResult)
    }
    pauseAfterResult = false
    const lead = [...w.text][0]
    if (T.beforeSymbol[lead] !== undefined) think += vary(T.beforeSymbol[lead])
    if (resultNext) {
      pauseAfterResult = true
      resultNext = false
    }
    if (w.text === '=' || w.text.endsWith('=')) resultNext = true
    const doubt = 1 - w.c
    const hover = vary(T.hesitation * Math.pow(doubt, 1.3))

    // a slip, noticed and taken back: write it, pause, strike it through, write the word
    const wrong = r.chance(T.correction * Math.pow(doubt, 1.5)) ? slip(w.text, r) : null
    if (wrong) {
      const laid = writer.word(wrong)
      const wi = emit(laid, w.c, think, hover, true)
      gestures.push({ pts: strike(laid, L.capHeight, r), kind: 'strike', word: wi, think: vary(0.35 + 0.3 * r.next()), hover: 0, slow: 0.8, slowFirst: 1 })
      writer.space()
      emit(writer.word(w.text), w.c, vary(0.2), vary(0.25 * hover), false)
      return
    }
    emit(writer.word(w.text), w.c, think, hover, false)
  })
  return { gestures, words: infos }
}

/**
 * A strike-through for a laid-out word: a slightly rising line through its x-height, a little
 * past both ends, sometimes doubled back (a quick scribble).
 */
function strike(w: LaidWord, cap: number, r: Rng): Pt[] {
  const [x0, , x1] = w.box
  const y = w.baseline - 0.33 * cap
  const rise = 0.06 * (x1 - x0) * (0.5 + r.next())
  const a: Pt = [x0 - 0.6, y + rise / 2 + r.gauss(0.2)]
  const b: Pt = [x1 + 0.6, y - rise / 2 + r.gauss(0.2)]
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + r.gauss(0.25)]
  const pts: Pt[] = [a, mid, b]
  if (r.chance(0.4)) pts.push([x0 + 0.1 * (x1 - x0), y + 0.12 * cap + r.gauss(0.2)])
  return pts
}

/** Gestures for raw paths (drawings, not text): one per path, no pauses beyond the flights. */
export function composePaths(paths: Pt[][]): Composition {
  return {
    gestures: paths.filter((p) => p.length > 0).map((pts, i) => ({ pts, kind: 'ink' as const, word: i, think: 0, hover: 0, slow: 1, slowFirst: 1 })),
    words: paths.map((p) => ({ text: '', confidence: 1, box: bbox([{ pts: p }]), line: 0, struck: false })),
  }
}
