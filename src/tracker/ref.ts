/**
 * Компактные ключи задач и участников для Telegram callback_data.
 *
 * Telegram ограничивает callback_data 64 байтами. Id задачи в YouGile — UUID
 * (36 символов), так что кнопка «задача + исполнитель» («cags:<задача>:<кто>»)
 * в лимит не влезала бы: 5 + 36 + 1 + 36 = 78 байт. UUID — это 16 байт, в
 * base64url они занимают 22 символа, и та же кнопка становится 50-байтовой.
 *
 * Trello обходится короткими shortLink'ами (8 символов) и 24-символьными id
 * участников, поэтому для него кодек тождественный: значения, не похожие на
 * UUID, проходят насквозь.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Длина base64url-представления 16 байт (UUID) — без padding. */
const PACKED_LEN = 22

/** UUID → 22 символа base64url. Не-UUID возвращается как есть. */
export function packUuid(value: string): string {
  if (!UUID_RE.test(value)) return value
  return Buffer.from(value.replace(/-/g, ''), 'hex').toString('base64url')
}

/** Обратная операция к packUuid. Строки другой длины возвращаются как есть. */
export function unpackUuid(ref: string): string {
  if (ref.length !== PACKED_LEN) return ref
  const hex = Buffer.from(ref, 'base64url').toString('hex')
  if (hex.length !== 32) return ref
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}
