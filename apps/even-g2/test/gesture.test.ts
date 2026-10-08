import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { actionFor } from '../src/glasses/gesture'
import { TEXT_ID } from '../src/glasses/ids'

test('ring scroll works when protobuf omits the event source', () => {
  assert.equal(actionFor({ sysEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } } as EvenHubEvent), 'zoom-in')
  assert.equal(actionFor({ sysEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } } as EvenHubEvent), 'zoom-out')
})

test('capture-container scroll wins over empty system metadata', () => {
  assert.equal(actionFor({ sysEvent: {}, textEvent: { containerID: TEXT_ID, eventType: 1 } } as EvenHubEvent), 'zoom-in')
  assert.equal(actionFor({ textEvent: { containerID: TEXT_ID, eventType: 2 } } as EvenHubEvent), 'zoom-out')
  assert.equal(actionFor({ textEvent: { containerID: 999, eventType: 1 } } as EvenHubEvent), '')
})

test('omitted click enum remains a click, unrelated events are ignored', () => {
  assert.equal(actionFor({ sysEvent: {} } as EvenHubEvent), 'toggle-mode')
  assert.equal(actionFor({} as EvenHubEvent), '')
})
