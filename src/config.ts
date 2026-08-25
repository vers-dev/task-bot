import 'dotenv/config'
import os from 'node:os'
import type { StatusNames } from './tracker/types.js'

export type TrackerKind = 'trello' | 'yougile'

export interface TrelloConfig {
  apiKey: string
  token: string
  /** Optional HTTP/HTTPS proxy for reaching api.trello.com (blocked regions). */
  proxyUrl?: string
  /**
   * Optional: restrict the board picker to this single board (id or shortLink).
   * Kept for backwards compatibility — older deployments set TRELLO_BOARD_ID and
   * expect the bot to work with exactly that board.
   */
  onlyBoardId?: string
  /** Label applied to /offer cards (== approval "pending"). */
  offerLabelName: string
  /** Label applied when an /offer is approved. */
  approvedLabelName: string
  /** Category labels ensured on the board (e.g. Backend, Frontend). */
  categoryLabels: string[]
}

export interface YouGileConfig {
  /** https://ru.yougile.com, https://yougile.com or a self-hosted origin. */
  baseUrl: string
  /** API key from `npm run yougile:auth`. */
  token: string
  /** Optional HTTP/HTTPS proxy for reaching the YouGile API. */
  proxyUrl?: string
  /** Status sticker modelling /offer approval. */
  approvalStickerName: string
  /** Task link template with an {id} placeholder (the API doesn't return a URL). */
  taskUrlTemplate?: string
}

export interface TrackerConfig {
  tracker: TrackerKind
  /** Column (status) names — resolved to ids lazily, per board. */
  statusNames: StatusNames
  /** Optional substring filter for the board picker. */
  boardsFilter?: string
  trello: TrelloConfig
  yougile: YouGileConfig
}

export interface Config extends TrackerConfig {
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

/** First non-empty of several env vars (older names kept as fallbacks). */
function optAny(keys: string[], fallback: string): string {
  for (const key of keys) {
    const v = process.env[key]?.trim()
    if (v) return v
  }
  return fallback
}

function parseTracker(): TrackerKind {
  const raw = opt('TRACKER', 'trello').toLowerCase()
  if (raw !== 'trello' && raw !== 'yougile') {
    throw new Error(`TRACKER must be "trello" or "yougile", got "${raw}"`)
  }
  return raw
}

/**
 * Tracker-only config (used by the smoke test and the init scripts — no Telegram
 * needed). Credentials are required only for the ACTIVE tracker, so a Trello
 * deployment never has to invent YouGile values and vice versa.
 */
export function loadTrackerConfig(): TrackerConfig {
  const tracker = parseTracker()
  const need = (key: string, forTracker: TrackerKind): string =>
    tracker === forTracker ? required(key) : (process.env[key]?.trim() ?? '')

  return {
    tracker,
    statusNames: {
      // LIST_* are the current names; TRELLO_LIST_* stay readable so existing
      // production .env files keep working after the upgrade.
      todo: optAny(['LIST_TODO', 'TRELLO_LIST_TODO'], 'Задачи'),
      done: optAny(['LIST_DONE', 'TRELLO_LIST_DONE'], 'Готово'),
      cancelled: optAny(['LIST_CANCELLED', 'TRELLO_LIST_CANCELLED'], 'Отменено'),
    },
    boardsFilter: process.env.BOARDS_FILTER?.trim() || undefined,

    trello: {
      apiKey: need('TRELLO_API_KEY', 'trello'),
      token: need('TRELLO_TOKEN', 'trello'),
      proxyUrl: process.env.TRELLO_PROXY?.trim() || undefined,
      onlyBoardId: process.env.TRELLO_BOARD_ID?.trim() || undefined,
      offerLabelName: opt('TRELLO_LABEL_OFFER', 'Предложение'),
      approvedLabelName: opt('TRELLO_LABEL_APPROVED', 'Одобрено'),
      categoryLabels: opt('TRELLO_CATEGORY_LABELS', 'Backend,Frontend')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },

    yougile: {
      baseUrl: opt('YOUGILE_BASE_URL', 'https://ru.yougile.com').replace(/\/+$/, ''),
      token: need('YOUGILE_TOKEN', 'yougile'),
      proxyUrl: process.env.YOUGILE_PROXY?.trim() || undefined,
      approvalStickerName: opt('YOUGILE_STICKER_APPROVAL', 'Одобрение'),
      taskUrlTemplate: process.env.YOUGILE_TASK_URL?.trim() || undefined,
    },
  }
}

export function loadConfig(): Config {
  const telegramToken = required('TELEGRAM_BOT_TOKEN')
  const tracker = loadTrackerConfig()

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
    ...tracker,
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
