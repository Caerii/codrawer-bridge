// Router addresses typed into the first-run prompt (src/address.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routerUrl } from '../src/address'

test('a bare IP or host gets the router port and the default session', () => {
  assert.equal(routerUrl('192.168.1.20'), 'ws://192.168.1.20:8577/ws/session1')
  assert.equal(routerUrl('  10.0.0.7 \n'), 'ws://10.0.0.7:8577/ws/session1')
  assert.equal(routerUrl('remarkable.local'), 'ws://remarkable.local:8577/ws/session1')
  assert.equal(routerUrl('[fe80::1]'), 'ws://[fe80::1]:8577/ws/session1')
})

test('host:port keeps the port written', () => {
  assert.equal(routerUrl('192.168.1.20:9000'), 'ws://192.168.1.20:9000/ws/session1')
  assert.equal(routerUrl('localhost:8577'), 'ws://localhost:8577/ws/session1')
})

test('a full ws URL is taken as written, adding only what is missing', () => {
  assert.equal(routerUrl('ws://192.168.1.20:8577/ws/demo'), 'ws://192.168.1.20:8577/ws/demo')
  assert.equal(routerUrl('ws://192.168.1.20/ws/demo'), 'ws://192.168.1.20:8577/ws/demo')
  assert.equal(routerUrl('ws://192.168.1.20:8577'), 'ws://192.168.1.20:8577/ws/session1')
  assert.equal(routerUrl('wss://r.example:8443/ws/s?x=1#frag'), 'wss://r.example:8443/ws/s?x=1')
})

test('http and https stand for ws and wss', () => {
  assert.equal(routerUrl('http://192.168.1.20:8577'), 'ws://192.168.1.20:8577/ws/session1')
  assert.equal(routerUrl('HTTPS://r.example:8443/ws/s'), 'wss://r.example:8443/ws/s')
})

test('nothing usable gives null', () => {
  assert.equal(routerUrl(''), null)
  assert.equal(routerUrl('   '), null)
  assert.equal(routerUrl('ftp://192.168.1.20'), null)
  assert.equal(routerUrl('ws://'), null)
  assert.equal(routerUrl('has space'), null)
  assert.equal(routerUrl('ws://user:pw@host'), null)
})
