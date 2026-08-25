import 'dotenv/config'
import os from 'node:os'

export interface TrelloConfig {
  trelloApiKey: string
  trelloToken: string
  /** Board id or shortLink (e.g. "a1B2c3D4" from the board URL). */
  trelloBoardId: string
  /** Optional HTTP/HTTPS proxy for reaching api.trello.com (blocked regions). */
  trelloProxy?: string

  /** List (column) names — resolved to ids at startup. */
  listTodoName: string
  listDoneName: string
  listCancelledName: string

  /** Label applied to /offer cards (== approval "pending"). */
  offerLabelName: string
  /** Label applied when an /offer is approved. */
  approvedLabelName: string
  /** Category labels ensured on the board (e.g. Backend, Frontend). */
  categoryLabels: string[]
}

export interface Config extends TrelloConfig {
  telegramToken: string
  /** Telegram chat ids the bot answers in. Empty = all chats. */
  allowedChatIds: number[]
  /** Pin the card message after /issue (needs "Pin messages" right). */
  pinIssues: boolean
  /** Telegram user ids allowed to Approve/Reject offers. Empty = anyone in allowed chats. */
  offerApprovers: number[]
  /** Human label for this running instance (for /whoami). */
  botInstance: string
  /** SQLite database file path. */
  dbPath: string
  /** Optional HTTP/HTTPS proxy for reaching api.telegram.org (e.g. blocked regions). */
  telegramProxy?: string
  /** If set, run in webhook mode (Telegram POSTs updates here) instead of long polling. */
  webhookUrl?: string
  /** Port the webhook HTTP server listens on (behind nginx). Default 8090. */
  webhookPort: number
  /** Secret echoed by Telegram in X-Telegram-Bot-Api-Secret-Token (recommended). */
  webhookSecret?: string
}

function required(key: string): string {
  const value = process.env[key]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var: ${key}`)
  }
  return value.trim()
}

function opt(key: string, fallback: string): string {
  const v = process.env[key]?.trim()
  return v && v.length > 0 ? v : fallback
}

/** Load only the Trello-related config (used by the smoke test — no Telegram needed). */
export function loadTrelloConfig(): TrelloConfig {
  return {
    trelloApiKey: required('TRELLO_API_KEY'),
    trelloToken: required('TRELLO_TOKEN'),
    trelloBoardId: required('TRELLO_BOARD_ID'),
    trelloProxy: process.env.TRELLO_PROXY?.trim() || undefined,

    listTodoName: opt('TRELLO_LIST_TODO', 'Задачи'),
    listDoneName: opt('TRELLO_LIST_DONE', 'Готово'),
    listCancelledName: opt('TRELLO_LIST_CANCELLED', 'Отменено'),

    offerLabelName: opt('TRELLO_LABEL_OFFER', 'Предложение'),
    approvedLabelName: opt('TRELLO_LABEL_APPROVED', 'Одобрено'),
    categoryLabels: opt('TRELLO_CATEGORY_LABELS', 'Backend,Frontend')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

export function loadConfig(): Config {
  const telegramToken = required('TELEGRAM_BOT_TOKEN')
  const trello = loadTrelloConfig()

  const allowedChatIds = (process.env.ALLOWED_CHAT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n))

  const pinIssues = (process.env.PIN_ISSUES ?? 'true').trim().toLowerCase() !== 'false'
  const offerApprovers = (process.env.OFFER_APPROVERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n))
  const botInstance = process.env.BOT_INSTANCE?.trim() || os.hostname()
  const dbPath = (process.env.DB_PATH ?? 'data/bot.db').trim()
  const telegramProxy = process.env.TELEGRAM_PROXY?.trim() || undefined

  const webhookUrl = process.env.WEBHOOK_URL?.trim() || undefined
  const webhookPort = Number(process.env.WEBHOOK_PORT ?? '8090') || 8090
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || undefined

  return {
    ...trello,
    telegramToken,
    allowedChatIds,
    pinIssues,
    offerApprovers,
    botInstance,
    dbPath,
    telegramProxy,
    webhookUrl,
    webhookPort,
    webhookSecret,
  }
}
