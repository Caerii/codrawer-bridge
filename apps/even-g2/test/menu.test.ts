// The phone menu's pure parts: invite links (src/phone/invite.ts), the palette (src/phone/palette.ts)
// and the reply typing speed (src/typer.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inviteUrl, isLoopback } from '../src/phone/invite'
import { COLOR_NAMES, defaultColorFor, PARTICIPANT_COLORS } from '../src/phone/palette'
import { readTyperAck, TYPER_SPEED_NOTES, TYPER_SPEEDS, typerRequest } from '../src/typer'

test('an invite carries the router and pairing code, and nothing else', () => {
  const url = inviteUrl('http://192.168.1.10:5188/?ws=ws://old&loupe=128x64&view=text#x', 'ws://192.168.1.20:8577/ws/session1', 'ABCD-EFGH')
  assert.ok(url)
  const u = new URL(url)
  assert.equal(u.origin + u.pathname, 'http://192.168.1.10:5188/')
  assert.equal(u.searchParams.get('ws'), 'ws://192.168.1.20:8577/ws/session1')
  assert.equal(u.searchParams.get('token'), 'ABCD-EFGH')
  assert.deepEqual([...u.searchParams.keys()].sort(), ['token', 'ws'])
  assert.equal(u.hash, '')
})

test('no pairing code, no token parameter; a packaged app has no invite', () => {
  const url = inviteUrl('https://example.test/app/index.html', 'wss://r.example/ws/s', '')
  assert.equal(url, 'https://example.test/app/index.html?ws=wss%3A%2F%2Fr.example%2Fws%2Fs')
  assert.equal(inviteUrl('file:///data/app/index.html', 'ws://x', ''), null)
  assert.equal(inviteUrl('not a url', 'ws://x', ''), null)
})

test('loopback routers are recognised', () => {
  assert.equal(isLoopback('ws://localhost:8577/ws/simtest'), true)
  assert.equal(isLoopback('ws://127.0.0.1:8577/ws/a'), true)
  assert.equal(isLoopback('ws://192.168.1.10:8577/ws/a'), false)
  assert.equal(isLoopback('nonsense'), false)
})

test('a participant keeps the same default colour, from the palette', () => {
  assert.equal(defaultColorFor('k3j9x0ab'), defaultColorFor('k3j9x0ab'))
  for (const id of ['a', 'bb', 'k3j9x0ab', 'zzzzzzzz']) assert.ok(PARTICIPANT_COLORS.includes(defaultColorFor(id)))
  for (const c of PARTICIPANT_COLORS) assert.ok(COLOR_NAMES[c])
})

test('only the bridge acknowledgement sets the reply typing speed', () => {
  assert.deepEqual(readTyperAck({ t: 'typer_config', speed: 'fast', char_ms: 12, burst: 10, enter_ms: 150, ok: true }), { speed: 'fast', charMs: 12, burst: 10 })
  assert.equal(readTyperAck({ t: 'typer_config', speed: 'fast' }), null, 'a request is not the setting')
  assert.equal(readTyperAck({ t: 'typer_config', speed: 'careful', ok: false, error: 'x' }), null, 'nor a refusal')
  assert.equal(readTyperAck({ t: 'typer_config', speed: 'warp', ok: true }), null)
  assert.equal(readTyperAck({ t: 'term', ok: true }), null)
  assert.equal(readTyperAck(null), null)
  assert.deepEqual(typerRequest('instant'), { t: 'typer_config', speed: 'instant' })
  assert.deepEqual(typerRequest(), { t: 'typer_config' })
  for (const s of TYPER_SPEEDS) assert.ok(TYPER_SPEED_NOTES[s])
})
