/**
 * Placement clear of the user's ink, the action hash and its code, and consent by pen: the
 * binding, provenance and ordering checks, and the soft initials similarity.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CARD, layoutCard, place, cardHeight, statusMark, wrap, type CardContent } from '../src/card'
import { rect, overlap, inflate, type Rect, type Pt } from '../src/geometry'
import { type Action, actionHash, canonicalJson, consentCode, sha256, effectiveAuthority, canMove } from '../src/task'
import { verifyConsent, initialsSimilarity, type PendingConsent } from '../src/consent'
import { HANDS, written } from './fixtures'
import { PAPER_PRO_MM } from 'hand'

const PAGE = PAPER_PRO_MM as Pt

test('sha256 matches the FIPS test vectors', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
})

const action: Action = {
  task: 't2', kind: 'email.send', nonce: 'n1',
  params: { to: ['sales@panel.example'], subject: 'G3 panel samples', body: 'Could you send two samples?' },
  compensate: 'email.unsend within 30 s',
}

test('the action hash is canonical and changes with any detail', () => {
  const reordered = { nonce: 'n1', compensate: action.compensate, params: { body: action.params.body, subject: action.params.subject, to: action.params.to }, kind: 'email.send', task: 't2' }
  assert.equal(canonicalJson(reordered), canonicalJson(action))
  assert.equal(actionHash(reordered as Action), actionHash(action))
  const comma = { ...action, params: { ...action.params, body: 'Could you send two samples ?' } }
  assert.notEqual(actionHash(comma), actionHash(action))
  assert.match(consentCode(actionHash(action)), /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/)
})

test('authority is the most restrictive of ceiling and grant; terminal states stay terminal', () => {
  assert.equal(effectiveAuthority('draft', 'act_with_consent'), 'draft')
  assert.equal(effectiveAuthority('act_with_consent', 'read'), 'read')
  assert.ok(canMove('working', 'needs_you'))
  assert.ok(!canMove('done', 'working'))
})

test('wrap keeps lines within the card', () => {
  for (const l of wrap('Three candidates fit the 10.3 inch panel; the cheapest has no partial refresh')) assert.ok(l.length <= CARD.charsPerLine)
})

const content: CardContent = { pod: 'research', requester: 'Alif', title: 'Compare e-ink controllers', status: 'working', body: ['…'] }

test('a card is placed clear of the user\'s ink, near the delegated region', () => {
  const ink: Rect[] = [rect(10, 20, 90, 60), rect(10, 70, 120, 110), rect(100, 30, 170, 45)]
  const anchor = rect(10, 20, 90, 60)
  const h = cardHeight(content)
  const p = place([CARD.width, h], anchor, ink, [], PAGE)
  assert.ok(!p.stub)
  for (const r of ink) assert.equal(overlap(inflate(r, CARD.clearance), p.rect), 0)
  assert.ok(p.rect.x0 >= CARD.margin && p.rect.x1 <= PAGE[0] - CARD.margin)
})

test('a full page gets a stub that points to the task page', () => {
  const ink: Rect[] = []
  for (let y = 0; y < 240; y += 14) ink.push(rect(0, y, 180, y + 9))
  const p = place([CARD.width, 60], rect(10, 10, 60, 20), ink, [], PAGE)
  assert.ok(p.stub)
})

test('status marks are discrete and distinct', () => {
  const r = rect(0, 0, 6, 6)
  const kinds = ['queued', 'working', 'needs_you', 'done', 'failed', 'paused', 'cancelled'] as const
  const sigs = new Set(kinds.map((k) => JSON.stringify(statusMark(k, r))))
  assert.equal(sigs.size, kinds.length)
})

test('a card that needs you carries a second rule', () => {
  const a = layoutCard(content, [0, 0]).paths.length
  const b = layoutCard({ ...content, status: 'needs_you' }, [0, 0]).paths.length
  assert.equal(b, a + 1)
})

// --- consent ---------------------------------------------------------------------------------

const T0 = 1_790_000_000_000
const hash = actionHash(action)
function pending(over: Partial<PendingConsent> = {}): PendingConsent {
  return {
    action, hash, code: consentCode(hash), shownAt: T0, expires: T0 + 10 * 60_000,
    requester: { participant: 'p_alif', device: 'paperpro-01' }, highStakes: false, used: new Set(), ...over,
  }
}
const initials = (seed: number, t0 = T0 + 5000, text = 'AJ', hand = HANDS[2]) => written(text, [120, 150], hand, seed, t0)
const enrolled = [1, 2, 3].map((s) => initials(100 + s))

test('initials from the pen, after the question, for this hash: consent', () => {
  const r = verifyConsent(pending(), initials(7), enrolled, T0 + 9000)
  assert.ok(r.ok, r.failed.join('; '))
  assert.ok((r.similarity ?? 0) >= 0.55, `similarity ${r.similarity}`)
  assert.equal(r.needsSecondFactor, false)
})

test('the same initials do not consent to a changed action', () => {
  const changed = { ...action, params: { ...action.params, to: ['someone@else.example'] } }
  const r = verifyConsent(pending({ action: changed }), initials(7), enrolled, T0 + 9000)
  assert.ok(!r.ok)
  assert.match(r.failed.join(), /action changed/)
})

test('ink written before the question cannot answer it', () => {
  const r = verifyConsent(pending(), initials(7, T0 - 60_000), enrolled, T0 + 9000)
  assert.ok(!r.ok)
})

test('strokes sent by a client, or by an agent, are not the pen', () => {
  const forged = initials(7).map((s) => ({ ...s, origin: 'client' as const }))
  assert.ok(!verifyConsent(pending(), forged, enrolled, T0 + 9000).ok)
  const agent = initials(7).map((s) => ({ ...s, layer: 'ai', origin: 'agent' as const }))
  assert.ok(!verifyConsent(pending(), agent, enrolled, T0 + 9000).ok)
})

test('a consumed proposal cannot be consented to twice', () => {
  assert.ok(!verifyConsent(pending({ used: new Set(['n1']) }), initials(7), enrolled, T0 + 9000).ok)
})

test('high-stakes actions always need a second factor', () => {
  const r = verifyConsent(pending({ highStakes: true }), initials(7), enrolled, T0 + 9000)
  assert.ok(r.ok && r.needsSecondFactor)
})

test('other letters score lower than the enrolled initials (a soft signal only)', () => {
  const mine = initialsSimilarity(initials(9), enrolled[0])
  const other = initialsSimilarity(initials(9, T0 + 5000, 'MK', HANDS[0]), enrolled[0])
  assert.ok(mine > other, `mine ${mine.toFixed(2)} vs other ${other.toFixed(2)}`)
  const r = verifyConsent(pending(), initials(9, T0 + 5000, 'MK', HANDS[0]), enrolled, T0 + 9000)
  assert.ok(r.ok && r.needsSecondFactor, 'unfamiliar initials ask for a second factor; they are not silently accepted')
})
