/**
 * The delegated task as a structured object, and the action hash that consent is bound to.
 *
 * A task is what a pod receives when the user delegates from the page (ADR 012 §1): the ink
 * region the user selected, what was recognised in it, references to context the user's
 * context scopes allow (ADR 011; a delegation may add a one-time scope that ends with the task),
 * who asked, and the authority the pod is given. Page content inside the task is **data**: the
 * pod's instructions are its own role prompt plus the `ask` the user wrote or chose, and nothing
 * recognised from the page or from a referenced document can widen the authority (ADR 012 §4).
 *
 * A consequential action (sending, filing, paying, merging) is proposed by the pod as an
 * {@link Action}. The action's canonical JSON is hashed; the card shows a short code derived from
 * the hash next to the consent box, the glasses and phone show the same code, and a pen consent
 * is valid only for that hash (consent.ts). Any change to the action, even a comma in an email
 * body, is a different hash, a redrawn card and a fresh consent.
 *
 * Reading order: statuses, scopes and the task; actions; canonical JSON; SHA-256 (pure, so the
 * same code runs in the router, the glasses app and the phone); the consent code.
 */

import type { Rect } from './geometry'

// --- status ------------------------------------------------------------------------------------

/**
 * A card's status. Discrete states only, each with its own mark (card.ts): e-ink has no animation
 * and a refresh costs ~200 ms on the glasses (CLAUDE.md), so progress is never shown as motion.
 */
export type Status = 'queued' | 'working' | 'needs_you' | 'done' | 'failed' | 'paused' | 'cancelled'

/** Transitions a broker accepts. Terminal states have none; `paused` resumes to where it was. */
export const TRANSITIONS: Record<Status, Status[]> = {
  queued: ['working', 'paused', 'cancelled'],
  working: ['needs_you', 'done', 'failed', 'paused', 'cancelled'],
  needs_you: ['working', 'done', 'paused', 'cancelled', 'failed'],
  paused: ['queued', 'working', 'needs_you', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
}

export const canMove = (from: Status, to: Status) => TRANSITIONS[from].includes(to)

// --- authority ---------------------------------------------------------------------------------

/**
 * What a pod may do with a task. Ordered: each level includes the one before.
 * - `read`: read in-scope context and the web, cite, summarise; writes only on its own card.
 * - `draft`: also produce drafts (an email, a document, a PR branch) that stay unsent.
 * - `act_with_consent`: also perform the actions listed in `actions`, each one only after a pen
 *   consent bound to that action's hash.
 */
export type Authority = 'read' | 'draft' | 'act_with_consent'

export const AUTHORITY_ORDER: Authority[] = ['read', 'draft', 'act_with_consent']

/** The effective authority is the most restrictive of the pod's ceiling and the task's grant. */
export function effectiveAuthority(podCeiling: Authority, granted: Authority): Authority {
  return AUTHORITY_ORDER[Math.min(AUTHORITY_ORDER.indexOf(podCeiling), AUTHORITY_ORDER.indexOf(granted))]
}

/**
 * A narrow, one-time context grant made by the act of delegating (ADR 011's model, applied to a
 * task): the sources named here are readable by this pod for this task only, are printed on the
 * card, and expire when the task reaches a terminal state or at `expires`, whichever is first.
 */
export interface TaskScope {
  /** ADR 011 source references, e.g. `notebook:Thesis`, `tag:g3-hardware`, `doc:<uuid>` */
  sources: string[]
  /** Unix ms */
  expires: number
}

/** Who asked: the participant and the device whose pen drew the trigger (ADR 008 §2). */
export interface Requester {
  participant: string
  display: string
  device: string
}

/** A delegated task as the broker stores and the pod receives it. */
export interface Task {
  id: string
  pod: string
  /** the ink the user selected: page, region (mm) and the stroke ids inside it */
  ink: { doc: string; page: string; region: Rect; strokes: string[] }
  /** recognised handwriting in the region (data, never instructions to the pod) */
  recognised: string
  /** the user's request: written next to the trigger, chosen from the dock, or typed after `@pod` */
  ask: string
  /** context the user's standing scopes allow (ADR 011), resolved by the retrieval layer */
  context: string[]
  /** the one-time scope this delegation grants, if any */
  grant?: TaskScope
  requester: Requester
  authority: Authority
  /** action kinds the pod may propose under `act_with_consent`, e.g. `email.send` */
  actions: string[]
  status: Status
  created: number
  /** the task this one was chained from by an arrow (ADR 012 §3) */
  parent?: string
}

// --- actions -----------------------------------------------------------------------------------

/** A consequential action a pod proposes; nothing runs until a consent binds to its hash. */
export interface Action {
  task: string
  /** an action kind from the task's `actions`, e.g. `email.send` */
  kind: string
  /** exactly what will be done: recipients, subject, body, amounts; hashed whole */
  params: Record<string, unknown>
  /** what undoes it, when anything can (`email.unsend` within 30 s, `pr.close`, …) */
  compensate?: string
  /** a per-proposal nonce, so a consent for an earlier identical proposal cannot be replayed */
  nonce: string
}

/** JSON with object keys sorted at every depth: the same value always serialises to the same bytes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`
}

// --- SHA-256 (FIPS 180-4) ----------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** SHA-256 of a UTF-8 string, as 64 lowercase hex digits. */
export function sha256(text: string): string {
  const msg = new TextEncoder().encode(text)
  const n = Math.ceil((msg.length + 9) / 64) * 64
  const buf = new Uint8Array(n)
  buf.set(msg)
  buf[msg.length] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(n - 8, Math.floor((msg.length * 8) / 2 ** 32))
  dv.setUint32(n - 4, (msg.length * 8) >>> 0)
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const W = new Uint32Array(64)
  const rotr = (x: number, r: number) => (x >>> r) | (x << (32 - r))
  for (let off = 0; off < n; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, '0')).join('')
}

/** The action's hash: SHA-256 of its canonical JSON. */
export const actionHash = (a: Action) => sha256(canonicalJson(a))

/**
 * Crockford base-32 without I, L, O, U: no pair a hand or an e-ink glyph confuses (0/O, 1/I/L).
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * The short code printed on the card and on every surface that shows the action: the first 30
 * bits of the hash as six base-32 characters, written `K7Q-3XM`. It lets the user see that the
 * card, the glasses line and the phone describe the same action. It is a display aid; the
 * binding is the full hash the broker checks (consent.ts).
 */
export function consentCode(hash: string): string {
  const bits = parseInt(hash.slice(0, 8), 16) >>> 2
  let s = ''
  for (let i = 5; i >= 0; i--) s += CODE_ALPHABET[(bits >>> (i * 5)) & 31]
  return `${s.slice(0, 3)}-${s.slice(3)}`
}
