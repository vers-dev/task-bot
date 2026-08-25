import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCreator, withCreator } from '../src/tracker/creator.js'

test('withCreator дописывает строку к описанию', () => {
  assert.equal(withCreator('Описание', '@vasya'), 'Описание\n\n— Создатель: @vasya')
})

test('withCreator без описания даёт только строку создателя', () => {
  assert.equal(withCreator('', '@vasya'), '— Создатель: @vasya')
  assert.equal(withCreator('   ', '@vasya'), '— Создатель: @vasya')
})

test('parseCreator читает то, что записал withCreator', () => {
  for (const tag of ['@vasya', 'Иван Петров', 'id123456']) {
    assert.equal(parseCreator(withCreator('Текст\nв две строки', tag)), tag)
  }
})

test('parseCreator без строки создателя возвращает «—»', () => {
  assert.equal(parseCreator('Просто описание'), '—')
  assert.equal(parseCreator(undefined), '—')
  assert.equal(parseCreator(''), '—')
})
