/**
 * What a mark can mean: the action vocabulary, mapped onto primitives codrawer already has.
 *
 * A personal mark never invents a capability. Its meaning is one of a short list of actions, each
 * of which turns into a message some other part of codrawer already reads (or, for the Primer and
 * LaTeX, is specified to read): the mark is a *shortcut to an existing door*, never a new door.
 * That is what keeps marks inside ADR 012's governance: a mark carries the user's intent no further
 * than the primitive it maps to would, and a consequential primitive still needs its own consent.
 *
 * | action        | params                  | becomes                                              | stakes |
 * | ------------- | ----------------------- | ---------------------------------------------------- | ------ |
 * | `delegate`    | `pod`, `ask?`           | `task_create` (ADR 012), trigger `mark`              | low: a read pod only drafts a card |
 * | `send`        | `to`                    | `task_create` to the `drafts` pod, `act_with_consent`; the send itself waits for initials on the card | consequential |
 * | `flashcard`   | `deck?`                 | `primer_request` `what:"flashcard"` (front = target ink) | low |
 * | `ask_agent`   | `prompt?`               | `term_prompt`, `attach:"page"` with the target region | low |
 * | `latex`       | `mode?`                 | `latex_recognize` (docs/investigations/latex-on-tablet.md §5) | low |
 * | `tag`         | `tag`                   | the invocation itself is the record (`#tag` on the target) | low |
 * | `replay_from` |                         | a client opens Thinking replay at the target's first stroke | low |
 *
 * **Stakes.** A consequential action is always *proposed*: its invocation waits for an explicit
 * accept however trusted the mark is (teach.ts), and `send` additionally goes through ADR 012's
 * consent by pen on the drafts card. The others are reversible or only produce a draft, so a
 * well-earned mark may run them silently.
 *
 * Every effect names the ink it acts on by stroke id and region (normalized page coordinates,
 * protocol.md), so the consumer reads the user's ink itself (ADR 002), never a description of it.
 */

/** The actions a mark can mean. */
export type ActionKind = 'delegate' | 'send' | 'flashcard' | 'ask_agent' | 'latex' | 'tag' | 'replay_from'

/** A meaning: an action and its parameters (all strings, so they edit as text on any surface). */
export interface Meaning {
  action: ActionKind
  params: Record<string, string>
}

/** How the vocabulary presents itself on the ask card and in the gallery. */
export interface ActionSpec {
  kind: ActionKind
  /** a short label for the ask card (written in a pod's hand on paper, so short) */
  label: string
  /** what the meaning does, for the gallery */
  describe: (p: Record<string, string>) => string
  /** parameters it needs, with a default where there is a sensible one */
  params: { name: string; prompt: string; default?: string }[]
  consequential: boolean
}

export const ACTIONS: Record<ActionKind, ActionSpec> = {
  delegate: {
    kind: 'delegate', label: 'delegate', consequential: false,
    describe: (p) => `delegate to @${p.pod || 'research'}${p.ask ? `: ${p.ask}` : ''}`,
    params: [{ name: 'pod', prompt: 'which pod', default: 'research' }, { name: 'ask', prompt: 'the ask (optional)' }],
  },
  send: {
    kind: 'send', label: 'send to…', consequential: true,
    describe: (p) => `send to ${p.to || '(someone)'} (asks for your initials)`,
    params: [{ name: 'to', prompt: 'to whom' }],
  },
  flashcard: {
    kind: 'flashcard', label: 'flashcard', consequential: false,
    describe: (p) => `make a flashcard${p.deck ? ` in ${p.deck}` : ''}`,
    params: [{ name: 'deck', prompt: 'deck (optional)' }],
  },
  ask_agent: {
    kind: 'ask_agent', label: 'ask agent', consequential: false,
    describe: (p) => `ask the agent${p.prompt ? `: ${p.prompt}` : ' about this'}`,
    params: [{ name: 'prompt', prompt: 'what to ask (optional)' }],
  },
  latex: {
    kind: 'latex', label: 'LaTeX', consequential: false,
    describe: (p) => `render as LaTeX${p.mode ? ` (${p.mode})` : ''}`,
    params: [{ name: 'mode', prompt: 'inline or display', default: 'display' }],
  },
  tag: {
    kind: 'tag', label: '#tag', consequential: false,
    describe: (p) => `tag #${(p.tag || 'tag').replace(/^#/, '')}`,
    params: [{ name: 'tag', prompt: 'which tag', default: 'todo' }],
  },
  replay_from: {
    kind: 'replay_from', label: 'replay', consequential: false,
    describe: () => 'replay the page from here',
    params: [],
  },
}

/** The ask card's options, in the order offered (most common first, then "not a mark"). */
export const ASK_OPTIONS: ActionKind[] = ['tag', 'flashcard', 'ask_agent', 'delegate', 'latex', 'replay_from', 'send']

/** A meaning in words. */
export const describe = (m: Meaning) => ACTIONS[m.action].describe(m.params)

/** Fill a meaning's parameters with their defaults. */
export function withDefaults(action: ActionKind, params: Record<string, string> = {}): Meaning {
  const out: Record<string, string> = {}
  for (const p of ACTIONS[action].params) if (p.default !== undefined) out[p.name] = p.default
  return { action, params: { ...out, ...params } }
}

/** Where the mark's action applies: the target ink, by id and region. */
export interface Target {
  doc?: string
  page?: string
  /** stroke ids (`stroke_begin` ids or the page's CRDT ids) */
  strokes: string[]
  /** [x0, y0, x1, y1], normalized page coordinates */
  region?: [number, number, number, number]
  /** Unix ms of the target's earliest stroke (for replay_from) */
  since?: number
}

/** Who acts: the mark's owner and the invocation that carries the action. */
export interface Origin {
  owner: string
  mark: string
  invocation: string
}

/**
 * The message an action becomes, or null when the invocation itself is the record (`tag`) or the
 * client acts locally (`replay_from`). Pure: the caller sends it.
 */
export function effectOf(m: Meaning, target: Target, origin: Origin, ts: number): Record<string, unknown> | null {
  const where = { doc: target.doc, page: target.page, region: target.region, strokes: target.strokes }
  const via = { source: 'mark', mark: origin.mark, invocation: origin.invocation }
  switch (m.action) {
    case 'delegate':
      return { t: 'task_create', pod: m.params.pod || 'research', trigger: 'mark', ...where, ask: m.params.ask ?? '', requester: origin.owner, ...via, ts }
    case 'send':
      // ADR 012: a send is drafted by the drafts pod and needs consent by pen on its card.
      return { t: 'task_create', pod: 'drafts', trigger: 'mark', ...where, ask: `send this to ${m.params.to}`, authority: 'act_with_consent', requester: origin.owner, ...via, ts }
    case 'flashcard':
      return { t: 'primer_request', what: 'flashcard', learner: origin.owner, deck: m.params.deck || undefined, front: where, ...via, ts }
    case 'ask_agent':
      return { t: 'term_prompt', text: m.params.prompt || 'The user marked this ink on the page: read it and respond.', attach: 'page', region: target.region, strokes: target.strokes, ...via }
    case 'latex':
      return { t: 'latex_recognize', id: `lx_${origin.invocation}`, strokes: target.strokes, region: target.region, page: target.page, mode: m.params.mode || 'display', ...via }
    case 'tag':
    case 'replay_from':
      return null
  }
}
