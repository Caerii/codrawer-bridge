/**
 * "My marks" on the phone: the gallery of learned marks, the teach pad, the ask card and the quiet
 * confirmations (packages/marks; ADR 013; the host is marks/host.ts).
 *
 *   ⋯ → My marks         a sheet over the page:
 *     gallery            every mark with its examples, meaning, confidence and how it acts now
 *                        (asks first / acts with an undo / acts silently / retracted); badges
 *                        for shared, shadowed on cards, drifting and conflicting; others' shared
 *                        marks below, to adopt
 *     a mark             its examples (remove one), its meaning (edit), rename, share, retract or
 *                        restore, and its history: the lineage and every use with its verdict
 *     teach a mark       a drawing pad (24 mm square, so a mark keeps its real size): draw one to
 *                        five examples, pick a meaning, save. The pad is not the shared page, so
 *                        teaching leaves no ink on anyone's page. The engine refuses a built-in
 *                        shape or a look-alike of an existing mark, and the reason shows here
 *   the ask card         "New mark → ?": a batched `mark_ask` from the host, one row per glyph with
 *                        the action vocabulary and "not a mark"; it lapses on its own
 *   chips                a confirm ("⚡ make a flashcard? ✓ ✗"), or a notice with Undo, under the
 *                        toolbar; they leave on their own (packages/marks teach.ts timings)
 *
 * Everything here is plain DOM; thumbnails are SVG polylines of the stored strokes (page mm).
 */
import { ACTIONS, ASK_OPTIONS, CONFIRM_TTL_MS, NOTIFY_TTL_MS, conflicts, describe, drift, modeFor, stats, withDefaults, type ActionKind, type Mark, type MarkAsk, type MarkInvoke } from 'marks'
import type { Pt } from 'delegate'
import { marks } from '../marks/host'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const sheet = () => $<HTMLDivElement>('#marks')
const body = () => $<HTMLDivElement>('#marks .mk-body')

type View = { kind: 'gallery' } | { kind: 'mark'; id: string } | { kind: 'teach' }
let view: View = { kind: 'gallery' }

// ── Small builders ────────────────────────────────────────────────────────────────────────────

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else e.setAttribute(k, v)
  }
  e.append(...kids)
  return e
}

function button(label: string, onClick: () => void, cls = 'chipbtn'): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls }, label)
  b.onclick = onClick
  return b
}

const SVG = 'http://www.w3.org/2000/svg'

/** A thumbnail of strokes (mm): polylines in a square viewBox around them. */
export function thumb(sets: Pt[][][], size = 56, faded = false): SVGSVGElement {
  const all = sets.flat(2)
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'mk-thumb')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  if (!all.length) return svg
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1])
  const x0 = Math.min(...xs), y0 = Math.min(...ys)
  const side = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0, 1)
  const pad = side * 0.12
  const cx = (Math.max(...xs) + x0) / 2, cy = (Math.max(...ys) + y0) / 2
  svg.setAttribute('viewBox', `${cx - side / 2 - pad} ${cy - side / 2 - pad} ${side + 2 * pad} ${side + 2 * pad}`)
  sets.forEach((strokes, k) => {
    for (const s of strokes) {
      const pl = document.createElementNS(SVG, 'polyline')
      pl.setAttribute('points', s.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' '))
      pl.setAttribute('stroke-width', String(side * 0.045))
      if (faded || k > 0) pl.setAttribute('opacity', k > 0 ? '0.35' : '0.6')
      svg.append(pl)
    }
  })
  return svg
}

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString()
}

/** How a mark acts now, in words (its next use, at a typical confidence). */
function howItActs(m: Mark): string {
  if (m.retracted) return 'retracted'
  const { mode } = modeFor(stats(m), 0.8, ACTIONS[m.meaning.action].consequential)
  return mode === 'confirm' ? 'asks before acting' : mode === 'notify' ? 'acts, with an undo' : 'acts silently'
}

// ── The sheet ─────────────────────────────────────────────────────────────────────────────────

export function openMarks() {
  view = { kind: 'gallery' }
  sheet().hidden = false
  marks.query()
  render()
  ;($<HTMLButtonElement>('#marks [data-mk="close"]')).focus()
}

function closeMarks() {
  sheet().hidden = true
  pad = null
}

function go(v: View) {
  view = v
  render()
  body().scrollTop = 0
}

function render() {
  if (sheet().hidden) return
  const b = body()
  b.replaceChildren()
  if (view.kind === 'gallery') gallery(b)
  else if (view.kind === 'mark') detail(b, view.id)
  else teach(b)
}

function gallery(b: HTMLElement) {
  const me = marks.owner()
  const watch = h('label', { class: 'mk-switch' }, h('input', { type: 'checkbox' }), h('span', {}, 'Watch my ink for marks on this phone'))
  const box = watch.querySelector('input')!
  box.checked = marks.watching
  box.onchange = () => marks.setWatching(box.checked)
  b.append(watch, h('p', { class: 'mk-note' }, 'Draw a glyph of your own beside your notes; codrawer asks once what it means, then acts on it. Built-in marks (circle, tick, strike, arrow) keep their meaning.'))
  b.append(h('div', { class: 'mk-row' }, button('Teach a mark…', () => go({ kind: 'teach' }), 'go')))

  const mine = marks.registry.marks.filter((m) => m.owner === me)
  const clash = conflicts(marks.registry.marks)
  if (!mine.length) b.append(h('p', { class: 'mk-empty' }, 'No marks yet.'))
  const grid = h('div', { class: 'mk-grid' })
  for (const m of mine) {
    const s = stats(m)
    const card = h('button', { type: 'button', class: `mk-card${m.retracted ? ' off' : ''}` })
    const badges: string[] = []
    if (m.shared) badges.push('shared')
    if (m.adoptedFrom) badges.push(`from ${m.adoptedFrom.owner}`)
    if (m.shadowed) badges.push(`a ${m.shadowed} on cards`)
    if (drift(m)?.drifting) badges.push('drifting')
    if (clash.some((c) => c.a === m.id || c.b === m.id)) badges.push('conflict')
    card.append(
      thumb(m.examples.slice(0, 3).map((e) => e.strokes)),
      h('span', { class: 'mk-name' }, m.name),
      h('span', { class: 'mk-meaning' }, describe(m.meaning)),
      h('span', { class: 'mk-meter', style: `--v: ${(s.confidence * 100).toFixed(0)}%`, title: `confidence ${s.confidence.toFixed(2)}` }),
      h('span', { class: 'mk-stats' }, `${s.fired} uses · ${s.accepts} ✓ · ${s.rejects} ✗ · ${howItActs(m)}`),
      ...badges.map((x) => h('span', { class: 'mk-badge' }, x)),
    )
    card.onclick = () => go({ kind: 'mark', id: m.id })
    grid.append(card)
  }
  b.append(grid)

  const theirs = marks.registry.marks.filter((m) => m.owner !== me && m.shared)
  if (theirs.length) {
    b.append(h('h3', {}, 'Shared by others'))
    const g2 = h('div', { class: 'mk-grid' })
    for (const m of theirs) {
      const c = h('div', { class: 'mk-card' }, thumb(m.examples.slice(0, 3).map((e) => e.strokes)), h('span', { class: 'mk-name' }, m.name), h('span', { class: 'mk-meaning' }, `${m.owner}: ${describe(m.meaning)}`))
      c.append(button('Adopt', () => { const err = marks.define({ op: 'adopt', mark: m.id }); if (err) alert(err) }))
      g2.append(c)
    }
    b.append(g2)
  }
}

function meaningEditor(initial: { action: ActionKind; params: Record<string, string> }, onSave: (m: { action: ActionKind; params: Record<string, string> }) => void, label = 'Save meaning'): HTMLElement {
  const wrap = h('div', { class: 'mk-meaning-edit' })
  const sel = h('select', { 'aria-label': 'Action' })
  for (const k of ASK_OPTIONS) sel.append(h('option', { value: k }, ACTIONS[k].describe(withDefaults(k).params)))
  sel.value = initial.action
  const params = h('div', { class: 'mk-params' })
  const draw = () => {
    params.replaceChildren()
    const k = sel.value as ActionKind
    for (const p of ACTIONS[k].params) {
      const v = (k === initial.action ? initial.params[p.name] : undefined) ?? p.default ?? ''
      params.append(h('label', {}, h('span', {}, p.prompt), h('input', { type: 'text', name: p.name, value: v })))
    }
  }
  sel.onchange = draw
  draw()
  const save = button(label, () => {
    const out: Record<string, string> = {}
    for (const i of Array.from(params.querySelectorAll('input'))) if (i.value.trim()) out[i.name] = i.value.trim()
    onSave({ action: sel.value as ActionKind, params: out })
  }, 'go')
  wrap.append(sel, params, save)
  return wrap
}

function detail(b: HTMLElement, id: string) {
  const m = marks.registry.get(id)
  if (!m) return go({ kind: 'gallery' })
  const err = h('p', { class: 'mk-error' })
  const run = (x: Parameters<typeof marks.define>[0]) => { const e = marks.define(x); err.textContent = e ?? ''; render() }
  b.append(h('div', { class: 'mk-row' }, button('‹ All marks', () => go({ kind: 'gallery' }))))

  const name = h('input', { type: 'text', value: m.name, class: 'mk-title', 'aria-label': 'Name' })
  name.onchange = () => run({ op: 'rename', mark: m.id, name: name.value })
  b.append(name, h('p', { class: 'mk-note' }, `${describe(m.meaning)} · ${howItActs(m)} · confidence ${stats(m).confidence.toFixed(2)}${m.shadowed ? ` · on task cards it reads as the built-in ${m.shadowed}` : ''}`))

  b.append(h('h3', {}, `Examples (${m.examples.length})`))
  const ex = h('div', { class: 'mk-examples' })
  for (const e of m.examples) {
    const cell = h('div', { class: 'mk-example', title: `${e.source}, ${ago(e.at)}` }, thumb([e.strokes], 64))
    if (m.examples.length > 1) cell.append(button('×', () => run({ op: 'remove_example', mark: m.id, example: e.id }), 'mk-x'))
    ex.append(cell)
  }
  b.append(ex)
  const d = drift(m)
  if (d?.drifting && d.suggest)
    b.append(h('p', { class: 'mk-warn' }, 'Your recent uses sit farther from the examples than they used to. ', button('Add the latest use as an example', () => run({ op: 'add_example', mark: m.id, occurrence: d.suggest }))))
  for (const c of conflicts(marks.registry.marks).filter((c) => c.a === m.id || c.b === m.id)) {
    const other = marks.registry.get(c.a === m.id ? c.b : c.a)
    b.append(h('p', { class: 'mk-warn' }, `Looks like ${other?.owner === m.owner ? 'your' : `${other?.owner}'s`} "${other?.name}", which means ${c.meanings[c.a === m.id ? 1 : 0]}.`))
  }

  b.append(h('h3', {}, 'Meaning'), meaningEditor(m.meaning, (meaning) => run({ op: 'refine', mark: m.id, meaning })))
  b.append(h('div', { class: 'mk-row' },
    button(m.shared ? 'Stop sharing' : 'Share with the session', () => run({ op: m.shared ? 'unshare' : 'share', mark: m.id })),
    m.retracted ? button('Restore', () => run({ op: 'restore', mark: m.id })) : button('Retract', () => run({ op: 'retract', mark: m.id }), 'chipbtn danger'),
  ), err)

  b.append(h('h3', {}, 'History'))
  const rows: { at: number; text: string; inv?: string; open?: boolean }[] = [
    ...m.lineage.map((e) => ({ at: e.at, text: `${e.op.replace('_', ' ')}${e.to ? `: ${describe(e.to)}` : ''}${e.from ? ` (was ${describe(e.from)})` : ''}${e.note ? ` · ${e.note}` : ''}` })),
    ...m.invocations.map((i) => ({ at: i.at, inv: i.id, open: !i.verdict, text: `used (${i.mode}, ${i.confidence.toFixed(2)}): ${describe(i.meaning)}${i.verdict ? ` → ${i.verdict}${i.via ? ` by ${i.via}` : ''}` : ''}` })),
  ].sort((a, b) => b.at - a.at)
  const list = h('ol', { class: 'mk-history' })
  for (const r of rows.slice(0, 60)) {
    const li = h('li', {}, h('time', {}, ago(r.at)), h('span', {}, r.text))
    if (r.inv && r.open) li.append(button('✓', () => marks.feedback(r.inv!, 'accept')), button('Undo', () => marks.feedback(r.inv!, 'undo')))
    list.append(li)
  }
  b.append(list)
}

// ── Teaching on the pad ───────────────────────────────────────────────────────────────────────

/** The pad's side, mm: a mark keeps its real size (the recogniser's size gate needs it). */
const PAD_MM = 24
let pad: { examples: Pt[][][]; current: Pt[][] } | null = null

function teach(b: HTMLElement) {
  pad ??= { examples: [], current: [] }
  const p = pad
  b.append(h('div', { class: 'mk-row' }, button('‹ All marks', () => { pad = null; go({ kind: 'gallery' }) })))
  b.append(h('h3', {}, 'Teach a mark'), h('p', { class: 'mk-note' }, `Draw your glyph at the size you would on paper (the pad is ${PAD_MM} mm across on the page). Keep one to five examples: drawn a little differently each time is best.`))
  const canvas = h('canvas', { class: 'mk-pad', width: '480', height: '480' })
  const ctx = canvas.getContext('2d')!
  const paint = () => {
    ctx.clearRect(0, 0, 480, 480)
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#1d1d1b'
    ctx.lineWidth = 6
    ctx.lineCap = ctx.lineJoin = 'round'
    for (const s of p.current) {
      ctx.beginPath()
      s.forEach(([x, y], i) => (i ? ctx.lineTo((x / PAD_MM) * 480, (y / PAD_MM) * 480) : ctx.moveTo((x / PAD_MM) * 480, (y / PAD_MM) * 480)))
      if (s.length === 1) ctx.lineTo((s[0][0] / PAD_MM) * 480 + 0.1, (s[0][1] / PAD_MM) * 480)
      ctx.stroke()
    }
  }
  let drawing = false
  const at = (e: PointerEvent): Pt => {
    const r = canvas.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * PAD_MM, ((e.clientY - r.top) / r.height) * PAD_MM]
  }
  canvas.onpointerdown = (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); p.current.push([at(e)]); paint() }
  canvas.onpointermove = (e) => { if (drawing) { p.current[p.current.length - 1].push(at(e)); paint() } }
  canvas.onpointerup = () => { drawing = false }
  paint()
  const kept = h('div', { class: 'mk-examples' }, ...p.examples.map((x) => thumb([x], 56)))
  const err = h('p', { class: 'mk-error' })
  b.append(canvas, h('div', { class: 'mk-row' },
    button('Clear', () => { p.current = []; paint() }),
    button(`Keep example ${p.examples.length + 1}`, () => {
      if (!p.current.length) return
      if (p.examples.length >= 5) { err.textContent = 'Five examples is enough.'; return }
      p.examples.push(p.current)
      p.current = []
      render()
    }),
  ), kept)
  const name = h('input', { type: 'text', placeholder: 'Name (optional)', class: 'mk-title' })
  b.append(h('h3', {}, 'It means'), name, meaningEditor(withDefaults('tag'), (meaning) => {
    const examples = p.current.length ? [...p.examples, p.current] : p.examples
    if (!examples.length) { err.textContent = 'Draw at least one example first.'; return }
    const e = marks.define({ op: 'create', meaning, examples, name: name.value.trim() || undefined, note: 'taught on the phone' })
    if (e) { err.textContent = e; return }
    pad = null
    go({ kind: 'gallery' })
  }, 'Save mark'), err)
}

// ── The ask card ──────────────────────────────────────────────────────────────────────────────

function showAsk(a: MarkAsk) {
  const box = $<HTMLDivElement>('#markAsk')
  box.replaceChildren(h('div', { class: 'mk-ask-head' }, h('b', {}, a.items.length > 1 ? `${a.items.length} new marks → ?` : 'New mark → ?'), h('span', { class: 'spacer' }), button('Later', () => (box.hidden = true))))
  let left = a.items.length
  for (const it of a.items) {
    const row = h('div', { class: 'mk-ask-row' }, thumb([it.ink_mm], 52), h('span', { class: 'mk-note' }, it.reason === 'repeated' ? `drawn ${it.seen}×` : it.reason === 'lasso' ? 'you selected it' : 'beside your notes'))
    const chips = h('div', { class: 'mk-chips' })
    const done = (text: string) => { row.replaceChildren(thumb([it.ink_mm], 40), h('span', { class: 'mk-note' }, text)); if (--left === 0) setTimeout(() => (box.hidden = true), 1500) }
    for (const k of a.options) {
      chips.append(button(ACTIONS[k].label, () => {
        const need = ACTIONS[k].params.find((p) => p.default === undefined && !/optional/.test(p.prompt))
        const go = (params: Record<string, string>) => {
          const err = marks.define({ op: 'create', ask: a.ask, occurrence: it.occurrence, meaning: withDefaults(k, params) })
          done(err ?? `→ ${describe(withDefaults(k, params))}`)
        }
        if (!need) return go({})
        const input = h('input', { type: 'text', placeholder: need.prompt })
        chips.replaceChildren(input, button('OK', () => input.value.trim() && go({ [need.name]: input.value.trim() }), 'go'))
        input.focus()
      }))
    }
    chips.append(button('not a mark', () => { marks.define({ op: 'decline', ask: a.ask, occurrence: it.occurrence }); done('not a mark: never asked again') }, 'chipbtn quiet'))
    row.append(chips)
    box.append(row)
  }
  box.hidden = false
}

// ── Quiet confirmations ───────────────────────────────────────────────────────────────────────

function showInvoke(m: MarkInvoke) {
  if (m.mode === 'silent') return
  const box = $<HTMLDivElement>('#markChips')
  const mark = marks.registry.get(m.mark)
  const chip = h('div', { class: `mk-chip ${m.mode}`, role: 'status' }, thumb(mark ? [mark.examples[0].strokes] : [], 26))
  const text = m.mode === 'confirm' ? `${describe(m.meaning)}?` : `${m.name}: ${describe(m.meaning)}`
  chip.append(h('span', {}, text))
  const gone = () => chip.remove()
  if (m.mode === 'confirm') chip.append(button('✓', () => { marks.feedback(m.invocation, 'accept'); gone() }, 'mk-yes'), button('✗', () => { marks.feedback(m.invocation, 'reject'); gone() }, 'mk-no'))
  else chip.append(button('Undo', () => { marks.feedback(m.invocation, 'undo'); gone() }, 'mk-no'))
  box.append(chip)
  setTimeout(gone, m.mode === 'confirm' ? CONFIRM_TTL_MS : NOTIFY_TTL_MS)
}

// ── Wiring ────────────────────────────────────────────────────────────────────────────────────

export function setupMarksUi() {
  $<HTMLButtonElement>('#marks [data-mk="close"]').onclick = closeMarks
  sheet().addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMarks() })
  marks.onChange(render)
  marks.onAsk(showAsk)
  marks.onInvoke(showInvoke)
}

/** For the menu: how many marks this owner has (shown beside the item). */
export function markCount(): number {
  return marks.registry.marks.filter((m) => m.owner === marks.owner() && !m.retracted).length
}
