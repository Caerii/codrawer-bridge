/**
 * The router messages this app reads, as types (docs/protocol.md is canonical).
 *
 * Every message is a JSON object with a `t` tag. Fields are typed the way they may arrive, not
 * the way we wish they would: the handlers that read them keep their defensive checks (`typeof`,
 * `|| []`), because routers, bridges and agents of different vintages share a session. Page
 * coordinates are normalized to 0..1 of the page (x of its width, y of its height); `ts` is Unix
 * ms on the sender's clock.
 *
 * Outbound messages are plain object literals at their call sites (link.send), so the wire format
 * of each one can be read where it is produced.
 */
import type { PageMessage } from './strokes'

/** A key-down bridged from the tablet's keyboard (one per key; the app owns line editing). */
export interface KeyMessage {
  key?: string
  /** The printable character, when the key produces one. */
  char?: string
  mods?: KeyMods
}

export interface KeyMods {
  ctrl?: boolean
  alt?: boolean
  meta?: boolean
}

/** An even-terminal event relayed by the router's term bridge. */
export interface TermMessage {
  /** text (streamed assistant output) · permission · question · note · status */
  kind?: string
  text?: string
}

/** Inbound messages by tag. */
export interface Inbound {
  /** We are in (with or without a pairing code). */
  hello: { replay?: boolean; tablet?: unknown }
  /** e.g. `code: 'unauthorized'` before the router closes on a missing/wrong pairing code. */
  error: { code?: string }
  /** App-level liveness from routers that send it (the tablet's Go router). */
  ping: object
  /** The pen hovering over the tablet (bridge hover). */
  cursor: { gone?: boolean; x?: unknown; y?: unknown; tool?: string }
  stroke_begin: { id: string; layer?: string; brush?: string; ts?: unknown; color?: unknown; author?: string }
  /** pts: [x, y, pressure, t] each. */
  stroke_pts: { id: string; pts?: number[][] }
  stroke_end: { id: string }
  ai_stroke_begin: { id: string; brush?: string }
  ai_stroke_pts: { id: string; pts?: number[][] }
  ai_stroke_end: { id: string }
  ai_intent: { plan?: unknown }
  /** The tablet's saved page (the bridge's page watcher). */
  page: PageMessage
  /** Another client started a new drawing. */
  clear: object
  key: KeyMessage
  /** Yjs updates for the shared document, base64: one (`u`) or a batch (`us`). */
  doc_update: { us?: unknown; u?: unknown }
  /** The router asks for the whole document state, to compact its log. */
  doc_compact: object
  /** A plain-text document; `crdt: true` marks copies from live-editing clients. */
  doc: { text?: unknown; crdt?: boolean }
  term: TermMessage
}

export type InboundType = keyof Inbound
