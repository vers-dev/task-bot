import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packUuid, unpackUuid } from '../src/tracker/ref.js'

const UUIDS = [
  '7c270d09-33a3-473c-8963-0b1c54a10f25',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  'A1B2C3D4-E5F6-4789-ABCD-0123456789EF',
]

test('packUuid → 22 символа base64url', () => {
  for (const uuid of UUIDS) {
    const packed = packUuid(uuid)
    assert.equal(packed.length, 22, `${uuid} → ${packed}`)
    assert.match(packed, /^[A-Za-z0-9_-]+$/)
  }
})

test('round-trip возвращает исходный UUID', () => {
  for (const uuid of UUIDS) {
    assert.equal(unpackUuid(packUuid(uuid)), uuid.toLowerCase())
  }
})

test('не-UUID проходит насквозь (Trello shortLink и id участника)', () => {
  const passthrough = ['aBcD1234', '5f2a1c9e4d3b7a6c8e0f1234', '', 'Задачи']
  for (const value of passthrough) {
    assert.equal(packUuid(value), value)
    assert.equal(unpackUuid(value), value)
  }
})

test('callback_data влезает в лимит Telegram (64 байта)', () => {
  const task = packUuid('7c270d09-33a3-473c-8963-0b1c54a10f25')
  const member = packUuid('e4f1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b')
  const opId = Date.now().toString(36) + 'zz' // как в newOpId()

  const samples = [
    `c:${opId}:${task}`,
    `d:${task}`,
    `cag:${task}`,
    `cags:${task}:${member}`,
    `cfin:${task}`,
    `cbk:${task}`,
    `ofa:${task}`,
    `ofr:${task}`,
    `pb:`,
    `pbs:${task}`,
    `bfix:${task}`,
  ]
  for (const data of samples) {
    assert.ok(
      Buffer.byteLength(data, 'utf8') <= 64,
      `${data} — ${Buffer.byteLength(data, 'utf8')} байт`,
    )
  }
})
