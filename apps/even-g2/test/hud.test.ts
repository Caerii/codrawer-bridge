// HUD text pieces that need no glasses: wrapping, completion, the transcript.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COLS, wrapLine } from '../src/hud/wrap'
import { suggestions } from '../src/hud/completion'
import { appendOutput, appendTyped, clearTranscript, scrollTranscript, transcript, TRANSCRIPT_MAX } from '../src/hud/transcript'

test('wrapLine breaks at a space past half a row, else hard at the column', () => {
  assert.deepEqual(wrapLine('short'), ['short'])
  const words = 'the quick brown fox jumps over the lazy dog and keeps running far'
  for (const row of wrapLine(words)) assert.ok(row.length <= COLS)
  assert.deepEqual(wrapLine('aaaa bbbb cccc', 10), ['aaaa bbbb', 'cccc'])
  assert.deepEqual(wrapLine('a bbbbbbbbbbbbbb', 10), ['a bbbbbbbb', 'bbbbbb'])
})

test('suggestions match a bare /prefix only', () => {
  assert.deepEqual(suggestions('/te').map((c) => c.name), ['/term', '/text'])
  assert.deepEqual(suggestions('/T').map((c) => c.name), ['/term', '/text'])
  assert.deepEqual(suggestions('/term x'), [])
  assert.deepEqual(suggestions('term'), [])
  assert.equal(suggestions('/').length, 11)
})

test('the transcript keeps the newest lines and jumps back to them on new output', () => {
  clearTranscript()
  for (let i = 0; i < TRANSCRIPT_MAX + 5; i++) appendTyped(`line ${i}`)
  assert.equal(transcript.lines.length, TRANSCRIPT_MAX)
  assert.equal(transcript.lines[0], 'line 5')
  scrollTranscript(5)
  scrollTranscript(1)
  assert.equal(transcript.scrollBack, 6)
  scrollTranscript(1e6)
  assert.equal(transcript.scrollBack, TRANSCRIPT_MAX - 1)
  scrollTranscript(-1e6)
  assert.equal(transcript.scrollBack, 0)
  scrollTranscript(3)
  appendOutput('a\n\n  \nb')
  assert.equal(transcript.scrollBack, 0)
  assert.deepEqual(transcript.lines.slice(-2), ['a', 'b']) // blank lines dropped
  appendOutput('x'.repeat(300))
  assert.equal(transcript.lines[transcript.lines.length - 1].length, 200)
})
