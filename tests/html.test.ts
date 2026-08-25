import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentsHtml, escapeHtml, htmlToText, textToHtml } from '../src/yougile/html.js'
import { parseCreator, withCreator } from '../src/tracker/creator.js'

test('escapeHtml обезвреживает разметку из Telegram', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  assert.equal(escapeHtml("a & b's"), 'a &amp; b&#39;s')
})

test('textToHtml сохраняет переводы строк', () => {
  assert.equal(textToHtml('первая\nвторая'), 'первая<br>вторая')
  assert.equal(textToHtml(''), '')
})

test('htmlToText разбирает разметку, включая написанную в UI YouGile', () => {
  assert.equal(htmlToText('<p>первая</p><p>вторая</p>'), 'первая\nвторая')
  assert.equal(htmlToText('a<br>b'), 'a\nb')
  assert.equal(htmlToText('<b>жирный</b> текст'), 'жирный текст')
  assert.equal(htmlToText(undefined), '')
})

test('описание переживает round-trip: строка создателя читается обратно', () => {
  const description = withCreator('Описание задачи\nв две строки', '@vasya')
  const stored = textToHtml(description)
  assert.equal(parseCreator(htmlToText(stored)), '@vasya')
})

test('текст с разметкой не ломает разбор создателя', () => {
  const description = withCreator('Смотри <div> и & символы', '@vasya')
  assert.equal(parseCreator(htmlToText(textToHtml(description))), '@vasya')
})

test('attachmentsHtml: картинки инлайном, остальное ссылкой', () => {
  const html = attachmentsHtml(
    [
      { name: 'shot.png', contentType: 'image/png', url: 'https://ex.com/1.png' },
      { name: 'doc.pdf', contentType: 'application/pdf', url: 'https://ex.com/2.pdf' },
    ],
    'подпись',
  )
  assert.match(html, /^подпись<br>/)
  assert.match(html, /<img src="https:\/\/ex\.com\/1\.png"/)
  assert.match(html, /<a href="https:\/\/ex\.com\/2\.pdf">📎 doc\.pdf<\/a>/)
})

test('attachmentsHtml без подписи не начинается с разделителя', () => {
  const html = attachmentsHtml([{ name: 'a.png', contentType: 'image/png', url: 'https://ex.com/a.png' }])
  assert.match(html, /^<img /)
})
