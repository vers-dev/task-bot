/**
 * «Создатель» задачи — Telegram-@username автора команды.
 *
 * Ни в Trello (Custom Fields платные), ни в YouGile бот не заводит отдельное
 * поле: строка дописывается в конец описания и оттуда же читается обратно при
 * рендере карточки. Маркер и регулярка общие для обоих трекеров — задачи,
 * созданные до появления YouGile, продолжают парситься.
 */
const CREATOR_MARKER = '— Создатель:'
const CREATOR_RE = /^—\s*Создатель:\s*(.+?)\s*$/m

/** Дописать строку создателя к описанию. */
export function withCreator(desc: string, tag: string): string {
  const base = (desc ?? '').trim()
  return base ? `${base}\n\n${CREATOR_MARKER} ${tag}` : `${CREATOR_MARKER} ${tag}`
}

/** Вытащить создателя из описания, или «—» если строки нет. */
export function parseCreator(desc: string | undefined): string {
  const m = desc?.match(CREATOR_RE)
  return m ? m[1].trim() : '—'
}
