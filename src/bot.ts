import { Bot, Context, HttpError, InlineKeyboard } from 'grammy'
import nodeFetch from 'node-fetch'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { Config } from './config.js'
import type { TrelloClient } from './trello/client.js'
import {
  addComment,
  approveOffer,
  attachFile,
  createCard,
  getCard,
  listActiveCards,
  listMembers,
  markOffer,
  moveCard,
  setAssignee,
  withCreator,
  type Approval,
  type BoardRefs,
  type CardData,
} from './trello/cards.js'
import { downloadMedia, extractMedia, type DownloadedFile, type MediaItem } from './telegram/media.js'
import type { Store } from './store.js'

const HELP = [
  '🤖 *Trello task bot* (работает в группах)',
  '',
  'Команды можно слать обычным текстом или подписью к фото/видео:',
  '',
  '/issue `<заголовок>` — создать задачу на доске.',
  '   • Пустая строка после заголовка → дальше идёт описание задачи.',
  '   • Прикрепи фото/видео (можно альбомом) — станут вложениями.',
  '/offer `<заголовок>` — создать предложение (метка «Предложение», статус «Ожидает»).',
  '   • Кнопки «Одобрить»/«Отклонить» (доступны только утверждающим).',
  '   • Одобрить → задача остаётся активной. Отклонить → уходит в «Отменено».',
  '/comment `<текст>` — добавить комментарий; задача выбирается из списка.',
  '   • Вложения крепятся к самой карточке (у комментариев Trello вложений нет).',
  '/complete — закрыть задачу как выполненную (выбор из списка).',
  '/whoami — режим (webhook/polling) и какой инстанс бота отвечает.',
  '',
  '↩️ *Ответом на сообщение* можно писать просто /issue или /comment без текста —',
  'бот возьмёт текст и вложение из того сообщения.',
  '',
  '_Альбомы работают только при выключенном Privacy Mode у бота._',
].join('\n')

const COMMAND_RE = /^\/(issue|offer|comment|complete|whoami|help|start)(?:@\S+)?(?:\s+([\s\S]*))?$/i
const ALBUM_DEBOUNCE_MS = 1500
const PENDING_TTL_MS = 10 * 60 * 1000

interface ParsedCommand {
  command: 'issue' | 'offer' | 'comment' | 'complete' | 'whoami' | 'help' | 'start'
  rest: string
}

function parseCommand(text: string | undefined): ParsedCommand | undefined {
  if (!text) return undefined
  const m = COMMAND_RE.exec(text.trim())
  if (!m) return undefined
  return { command: m[1].toLowerCase() as ParsedCommand['command'], rest: (m[2] ?? '').trim() }
}

/**
 * Split issue text into title + description on the first blank line.
 * "Заголовок\n\nОписание…" → { title: "Заголовок", description: "Описание…" }.
 */
export function splitTitleDescription(text: string): { title: string; description: string } {
  const m = text.match(/\n\s*\n/)
  if (!m || m.index === undefined) {
    return { title: text.trim(), description: '' }
  }
  return {
    title: text.slice(0, m.index).trim(),
    description: text.slice(m.index + m[0].length).trim(),
  }
}

/** First non-empty line of a text (used as a fallback title). */
export function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return text.trim()
}

/**
 * Title/description/media for /issue and /offer. On a reply: the whole replied
 * message becomes the description, title = typed text or its first line. Inline:
 * blank line splits title from description.
 */
function resolveIssueContent(
  cmdCtx: Context,
  rest: string,
  media: MediaItem[],
): { title: string; description: string; media: MediaItem[] } {
  const reply: any = cmdCtx.message?.reply_to_message
  if (reply) {
    const replyText = String(reply.text ?? reply.caption ?? '').trim()
    const replyMedia = extractMedia(reply)
    const out = [...media]
    if (replyMedia) out.push(replyMedia)
    return { title: rest.trim() || firstLine(replyText), description: replyText, media: out }
  }
  const split = splitTitleDescription(rest)
  return { title: split.title, description: split.description, media }
}

/**
 * Effective text + media for a command: typed text wins, otherwise (for a reply
 * with no text) the replied-to message's text and attachment.
 */
function resolveContent(
  cmdCtx: Context,
  rest: string,
  batchMedia: MediaItem[],
): { text: string; media: MediaItem[] } {
  if (rest) {
    return { text: rest, media: batchMedia }
  }
  const reply: any = cmdCtx.message?.reply_to_message
  if (reply) {
    const text = String(reply.text ?? reply.caption ?? '').trim()
    const item = extractMedia(reply)
    return { text, media: item ? [item] : [] }
  }
  return { text: '', media: batchMedia }
}

function truncate(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

async function replyError(ctx: Context, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  console.error('[bot] handler error:', err)
  await ctx.reply(`⚠️ Ошибка: ${message}`)
}

/**
 * Build a custom fetch that tunnels Telegram calls through an HTTP proxy via
 * https-proxy-agent + node-fetch (native https CONNECT — like `curl -x`, tolerant of
 * cheap proxies). grammy IGNORES globalThis.fetch and uses `client.fetch`, so we hand it
 * in there. The web AbortSignal grammy passes is dropped (node-fetch v2 can't use it);
 * a node-fetch `timeout` guards instead. Reused for media downloads.
 */
function makeTelegramProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new HttpsProxyAgent(proxyUrl)
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const src = (init ?? {}) as { method?: string; headers?: unknown; body?: unknown }
    const headers: Record<string, string> = {}
    const h = src.headers
    if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v))
    else if (Array.isArray(h)) for (const [k, v] of h as [string, string][]) headers[k] = v
    else if (h && typeof h === 'object') Object.assign(headers, h)
    return nodeFetch(url, {
      method: src.method ?? 'GET',
      headers,
      body: src.body as never,
      agent,
      timeout: 30_000,
    }) as unknown as Promise<Response>
  }) as typeof fetch
}

export function createBot(cfg: Config, client: TrelloClient, refs: BoardRefs, store: Store): Bot {
  // Telegram is unreachable directly on prod (blocked region) → tunnel its API + file
  // downloads through a proxy. grammy uses the custom `client.fetch`; media.ts reuses tgFetch.
  const tgFetch = cfg.telegramProxy ? makeTelegramProxyFetch(cfg.telegramProxy) : undefined
  if (tgFetch) console.log('[bot] Telegram proxy enabled (https-proxy-agent)')

  const bot = new Bot(
    cfg.telegramToken,
    (tgFetch ? { client: { fetch: tgFetch } } : undefined) as unknown as ConstructorParameters<typeof Bot>[1],
  )

  // Retry transient network failures ("fetch failed" — typically a flaky proxy) on
  // every Telegram API call. HttpError = network-level; GrammyError (real API errors)
  // is NOT retried. Up to TG_RETRIES attempts with linear backoff.
  const TG_RETRIES = 5
  bot.api.config.use(async (prev, method, payload, signal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await prev(method, payload, signal)
      } catch (err) {
        if (!(err instanceof HttpError) || attempt >= TG_RETRIES) throw err
        console.error(`[tg] network retry ${attempt + 1}/${TG_RETRIES} (${method}): ${(err as Error).message}`)
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (attempt + 1), 4000)))
      }
    }
  })

  const albums = new Map<string, { ctxs: Context[]; timer: ReturnType<typeof setTimeout> }>()
  let opSeq = 0
  const newOpId = (): string => `${Date.now().toString(36)}${(opSeq++).toString(36)}`

  // Display text for the approval line (UI only — state itself lives in labels/column).
  const APPROVAL_LABEL: Record<Approval, string> = {
    pending: 'Ожидает',
    approved: 'Одобрено',
    rejected: 'Отклонено',
  }

  /** Telegram identity of the command author → the card's "Создатель" text. */
  const authorTag = (ctx: Context): string => {
    if (ctx.from?.username) return `@${ctx.from.username}`
    const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim()
    return name || `id${ctx.from?.id ?? '?'}`
  }

  // ── card rendering (STATELESS — re-read from Trello, shortLink encoded in buttons) ──
  function cardText(d: CardData, doneBy?: string): string {
    const head = d.done ? '☑️' : d.cancelled ? '🚫' : '✅'
    const lines = [
      `${head} Задача *#${d.idShort}*: ${d.name}`,
      `👤 Исполнитель: ${d.assigneeName}`,
      `🧑‍💼 Создатель: ${d.creatorText}`,
    ]
    if (d.approval) lines.push(`📝 Одобрение: ${APPROVAL_LABEL[d.approval]}`)
    if (d.attachments > 0) lines.push(`📎 Вложений: ${d.attachments}`)
    if (d.done) lines.push(`☑️ ${cfg.listDoneName} — выполнил ${doneBy ?? d.assigneeName}`)
    if (d.cancelled) lines.push(`🚫 ${cfg.listCancelledName}`)
    return lines.join('\n')
  }

  function cardKeyboard(d: CardData): InlineKeyboard {
    if (d.done || d.cancelled) {
      return new InlineKeyboard().url('🔗 Открыть карточку', d.url)
    }
    return new InlineKeyboard()
      .text('👤 Исполнитель', `cag:${d.shortLink}`)
      .row()
      .text('✅ Выполнил', `cfin:${d.shortLink}`)
      .row()
      .url('🔗 Открыть карточку', d.url)
  }

  function offerKeyboard(d: CardData): InlineKeyboard {
    // Approve/Reject only while still pending; after a decision, just the link.
    if (d.approval !== 'pending' || d.done || d.cancelled) {
      return new InlineKeyboard().url('🔗 Открыть карточку', d.url)
    }
    return new InlineKeyboard()
      .text('✅ Одобрить', `ofa:${d.shortLink}`)
      .text('❌ Отклонить', `ofr:${d.shortLink}`)
      .row()
      .url('🔗 Открыть карточку', d.url)
  }

  // Only whitelisted Telegram users may approve/reject offers (empty list = anyone).
  const isApprover = (userId?: number): boolean =>
    cfg.offerApprovers.length === 0 || (userId !== undefined && cfg.offerApprovers.includes(userId))

  const approverName = (ctx: Context): string =>
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') ||
    (ctx.from?.username ? `@${ctx.from.username}` : 'кто-то')

  async function renderCard(ctx: Context, shortLink: string, doneBy?: string): Promise<void> {
    const d = await getCard(client, refs, shortLink)
    if (!d) {
      await ctx.editMessageText(`Карточка #${shortLink} не найдена.`)
      return
    }
    await ctx.editMessageText(cardText(d, doneBy), {
      parse_mode: 'Markdown',
      reply_markup: cardKeyboard(d),
    })
  }

  async function downloadAll(ctx: Context, media: MediaItem[]): Promise<DownloadedFile[]> {
    const files: DownloadedFile[] = []
    for (const item of media) {
      files.push(await downloadMedia(ctx.api, cfg.telegramToken, item, tgFetch))
    }
    return files
  }

  async function attachAll(cardId: string, files: DownloadedFile[]): Promise<void> {
    for (const f of files) {
      await attachFile(client, cardId, f)
    }
  }

  async function tryPin(
    ctx: Context,
    sent: { chat: { id: number }; message_id: number },
  ): Promise<void> {
    if (!cfg.pinIssues) return
    try {
      await ctx.api.pinChatMessage(sent.chat.id, sent.message_id, { disable_notification: true })
    } catch (err) {
      console.error('[bot] pin failed:', err)
      const desc = (err as { description?: string })?.description ?? (err instanceof Error ? err.message : String(err))
      await ctx.reply(
        `⚠️ Не смог закрепить (${desc}).\nСделай бота админом группы с включённым правом «Закреплять сообщения». Учти: переоткрытие/передобавление бота сбрасывает его права.`,
      )
    }
  }

  // ── /issue ───────────────────────────────────────────────
  async function handleIssue(
    ctx: Context,
    title: string,
    description: string,
    media: MediaItem[],
  ): Promise<void> {
    if (!title) {
      await ctx.reply(
        'Использование: /issue <заголовок>\n\n<описание> (можно с фото/видео или в ответ на сообщение)',
      )
      return
    }
    const created = await createCard(client, refs.listTodo, title, withCreator(description, authorTag(ctx)))

    if (media.length > 0) {
      await attachAll(created.id, await downloadAll(ctx, media))
    }

    const d = await getCard(client, refs, created.shortLink)
    const sent = await ctx.reply(
      d ? cardText(d) : `✅ Создана задача *#${created.idShort}*: ${title}`,
      { parse_mode: 'Markdown', reply_markup: d ? cardKeyboard(d) : undefined },
    )
    await tryPin(ctx, sent)
  }

  // ── /offer (proposal: "Предложение" label + "Ожидает", approve/reject by whitelist) ──
  async function handleOffer(
    ctx: Context,
    title: string,
    description: string,
    media: MediaItem[],
  ): Promise<void> {
    if (!title) {
      await ctx.reply(
        'Использование: /offer <заголовок>\n\n<описание> (можно с фото/видео или в ответ на сообщение)',
      )
      return
    }
    const created = await createCard(client, refs.listTodo, title, withCreator(description, authorTag(ctx)))
    await markOffer(client, refs, created.id)

    if (media.length > 0) {
      await attachAll(created.id, await downloadAll(ctx, media))
    }

    const d = await getCard(client, refs, created.shortLink)
    const text = d ? `📋 *Предложение*\n${cardText(d)}` : `📋 Предложение *#${created.idShort}*: ${title}`
    const sent = await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: d ? offerKeyboard(d) : undefined,
    })
    await tryPin(ctx, sent)
  }

  // ── /comment ─────────────────────────────────────────────
  async function handleComment(ctx: Context, text: string, media: MediaItem[]): Promise<void> {
    if (!text && media.length === 0) {
      await ctx.reply('Использование: /comment <текст> (можно с фото/видео)')
      return
    }
    const cards = await listActiveCards(client, refs, 20)
    if (cards.length === 0) {
      await ctx.reply('Активных задач не найдено.')
      return
    }
    store.gc(PENDING_TTL_MS)
    const opId = newOpId()
    store.savePendingComment(opId, { text, media })
    const kb = new InlineKeyboard()
    cards.forEach((it) =>
      kb.text(`#${it.idShort} — ${truncate(it.name)}`, `c:${opId}:${it.shortLink}`).row(),
    )
    await ctx.reply('💬 К какой задаче добавить комментарий?', { reply_markup: kb })
  }

  // ── /complete (stateless: shortLink in callback data) ────
  async function handleComplete(ctx: Context): Promise<void> {
    const cards = await listActiveCards(client, refs, 20)
    if (cards.length === 0) {
      await ctx.reply('Активных задач не найдено.')
      return
    }
    const kb = new InlineKeyboard()
    cards.forEach((it) => kb.text(`#${it.idShort} — ${truncate(it.name)}`, `d:${it.shortLink}`).row())
    await ctx.reply('✔️ Какую задачу закрыть?', { reply_markup: kb })
  }

  async function handleBatch(ctxs: Context[]): Promise<void> {
    let cmdCtx: Context | undefined
    let parsed: ParsedCommand | undefined
    for (const ctx of ctxs) {
      const p = parseCommand(ctx.message?.text ?? ctx.message?.caption)
      if (p) {
        cmdCtx = ctx
        parsed = p
        break
      }
    }
    if (!cmdCtx || !parsed) return

    const media: MediaItem[] = []
    for (const ctx of ctxs) {
      const item = extractMedia(ctx.message)
      if (item) media.push(item)
    }

    try {
      switch (parsed.command) {
        case 'issue': {
          const c = resolveIssueContent(cmdCtx, parsed.rest, media)
          await handleIssue(cmdCtx, c.title, c.description, c.media)
          break
        }
        case 'offer': {
          const c = resolveIssueContent(cmdCtx, parsed.rest, media)
          await handleOffer(cmdCtx, c.title, c.description, c.media)
          break
        }
        case 'comment': {
          const resolved = resolveContent(cmdCtx, parsed.rest, media)
          await handleComment(cmdCtx, resolved.text, resolved.media)
          break
        }
        case 'complete':
          await handleComplete(cmdCtx)
          break
        case 'whoami':
          await cmdCtx.reply(
            `🤖 Режим: *${cfg.webhookUrl ? 'webhook' : 'polling'}*\nИнстанс: *${cfg.botInstance}*\nPID: ${process.pid}`,
            { parse_mode: 'Markdown' },
          )
          break
        case 'help':
        case 'start':
          await cmdCtx.reply(HELP, { parse_mode: 'Markdown' })
          break
      }
    } catch (err) {
      await replyError(cmdCtx, err)
    }
  }

  // ── message routing (privacy mode OFF → all group messages arrive) ───
  bot.on('message', async (ctx) => {
    if (cfg.allowedChatIds.length > 0 && ctx.chat && !cfg.allowedChatIds.includes(ctx.chat.id)) {
      return
    }
    const groupId = ctx.message.media_group_id
    if (groupId) {
      const entry = albums.get(groupId) ?? { ctxs: [], timer: undefined as never }
      entry.ctxs.push(ctx)
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        albums.delete(groupId)
        void handleBatch(entry.ctxs)
      }, ALBUM_DEBOUNCE_MS)
      albums.set(groupId, entry)
      return
    }
    await handleBatch([ctx])
  })

  // ── /comment selection (payload persisted in SQLite) ─────
  bot.callbackQuery(/^c:([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    try {
      const opId = ctx.match[1]
      const shortLink = ctx.match[2]
      const payload = store.takePendingComment(opId)
      if (!payload) {
        await ctx.reply('Сессия истекла — повторите /comment.')
        return
      }
      const d = await getCard(client, refs, shortLink)
      if (!d) {
        await ctx.editMessageText(`Карточка #${shortLink} не найдена.`)
        return
      }
      if (payload.text.trim()) {
        await addComment(client, d.id, payload.text)
      }
      let attached = 0
      if (payload.media.length > 0) {
        const files = await downloadAll(ctx, payload.media)
        await attachAll(d.id, files)
        attached = files.length
      }
      const parts: string[] = []
      if (payload.text.trim()) parts.push('комментарий добавлен')
      if (attached > 0) parts.push(`вложений: ${attached}`)
      await ctx.editMessageText(
        `💬 *#${d.idShort}*: ${parts.join(', ') || 'без изменений'}.`,
        { parse_mode: 'Markdown' },
      )
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  // ── /complete selection (stateless) ──────────────────────
  bot.callbackQuery(/^d:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    try {
      const shortLink = ctx.match[1]
      const d = await getCard(client, refs, shortLink)
      if (!d) {
        await ctx.editMessageText(`Карточка #${shortLink} не найдена.`)
        return
      }
      await moveCard(client, d.id, refs.listDone)
      await ctx.editMessageText(`✔️ *#${d.idShort}* → «${cfg.listDoneName}».`, {
        parse_mode: 'Markdown',
      })
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  // ── card buttons (stateless: shortLink in callback data) ──
  bot.callbackQuery(/^cag:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const shortLink = ctx.match[1]
    try {
      const members = await listMembers(client, refs, 30)
      if (members.length === 0) {
        await ctx.answerCallbackQuery({
          text: 'На доске нет участников — добавь людей в Trello.',
          show_alert: true,
        })
        return
      }
      const kb = new InlineKeyboard()
      members.forEach((a, i) => {
        kb.text(a.name, `cags:${shortLink}:${a.id}`)
        if (i % 2 === 1) kb.row()
      })
      kb.row().text('◀️ Назад', `cbk:${shortLink}`)
      await ctx.editMessageReplyMarkup({ reply_markup: kb })
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  bot.callbackQuery(/^cags:([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const shortLink = ctx.match[1]
    const memberId = ctx.match[2]
    try {
      const d = await getCard(client, refs, shortLink)
      if (!d) {
        await ctx.editMessageText(`Карточка #${shortLink} не найдена.`)
        return
      }
      await setAssignee(client, d.id, memberId)
      await renderCard(ctx, shortLink)
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  bot.callbackQuery(/^cfin:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const shortLink = ctx.match[1]
    try {
      const d = await getCard(client, refs, shortLink)
      if (!d) {
        await ctx.editMessageText(`Карточка #${shortLink} не найдена.`)
        return
      }
      await moveCard(client, d.id, refs.listDone)
      const msg = ctx.callbackQuery.message
      if (msg) {
        try {
          await ctx.api.unpinChatMessage(msg.chat.id, msg.message_id)
        } catch (err) {
          console.error('[bot] unpin failed:', err)
        }
      }
      const clicker = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ')
      const doneBy = d.assigneeName !== '—' ? d.assigneeName : clicker || '—'
      await renderCard(ctx, shortLink, doneBy)
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  bot.callbackQuery(/^cbk:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    try {
      await renderCard(ctx, ctx.match[1])
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  // ── /offer: Одобрить → остаётся активной; Отклонить → «Отменено» ──
  bot.callbackQuery(/^ofa:(.+)$/, async (ctx) => {
    if (!isApprover(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: 'Одобрять/отклонять могут только утверждающие.', show_alert: true })
      return
    }
    await ctx.answerCallbackQuery()
    const shortLink = ctx.match[1]
    try {
      const d = await getCard(client, refs, shortLink)
      if (!d) {
        await ctx.editMessageText(`Карточка #${shortLink} не найдена.`)
        return
      }
      await approveOffer(client, refs, d.id)
      const msg = ctx.callbackQuery.message
      if (msg) {
        try {
          await ctx.api.unpinChatMessage(msg.chat.id, msg.message_id)
        } catch (err) {
          console.error('[bot] unpin failed:', err)
        }
      }
      await ctx.editMessageText(
        `✅ *Одобрено* — задача *#${d.idShort}* активна\nКто: ${approverName(ctx)}`,
        { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().url('🔗 Открыть карточку', d.url) },
      )
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  bot.callbackQuery(/^ofr:(.+)$/, async (ctx) => {
    if (!isApprover(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: 'Одобрять/отклонять могут только утверждающие.', show_alert: true })
      return
    }
    await ctx.answerCallbackQuery()
    const shortLink = ctx.match[1]
    try {
      const d = await getCard(client, refs, shortLink)
      if (!d) {
        await ctx.editMessageText(`Карточка #${shortLink} не найдена.`)
        return
      }
      await moveCard(client, d.id, refs.listCancelled)
      const msg = ctx.callbackQuery.message
      if (msg) {
        try {
          await ctx.api.unpinChatMessage(msg.chat.id, msg.message_id)
        } catch (err) {
          console.error('[bot] unpin failed:', err)
        }
      }
      await ctx.editMessageText(
        `❌ *Отклонено* → «${cfg.listCancelledName}»\nКто: ${approverName(ctx)}`,
        { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().url('🔗 Открыть карточку', d.url) },
      )
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  // ── fallback for unknown/old callback data ───────────────
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Кнопка устарела — пересоздай через /issue', show_alert: true })
  })

  bot.catch((err) => console.error('[bot] unhandled error:', err.error))

  return bot
}
