import { Bot, Context, HttpError, InlineKeyboard } from 'grammy'
import nodeFetch from 'node-fetch'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { Config } from './config.js'
import type { Approval, BoardInfo, TaskTracker, TaskView } from './tracker/types.js'
import { downloadMedia, extractMedia, type DownloadedFile, type MediaItem } from './telegram/media.js'
import type { ChatBoard, PendingOp, Store } from './store.js'

const COMMAND_RE = /^\/(issue|offer|comment|complete|project|whoami|help|start)(?:@\S+)?(?:\s+([\s\S]*))?$/i
const ALBUM_DEBOUNCE_MS = 1500
const PENDING_TTL_MS = 10 * 60 * 1000
/** Inline keyboards get unwieldy past this; the rest is hidden behind a hint. */
const BOARD_BUTTON_LIMIT = 20

interface ParsedCommand {
  command: 'issue' | 'offer' | 'comment' | 'complete' | 'project' | 'whoami' | 'help' | 'start'
  rest: string
}

function parseCommand(text: string | undefined): ParsedCommand | undefined {
  if (!text) return undefined
  const m = text.trim().match(COMMAND_RE)
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

/** The board is missing the columns/labels/stickers the bot resolves by name. */
function isBoardIncomplete(err: unknown): boolean {
  return err instanceof Error && /не хватает/i.test(err.message)
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

export function createBot(cfg: Config, tracker: TaskTracker, store: Store): Bot {
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

  const attachNote =
    tracker.attachmentTarget === 'chat'
      ? 'Вложения уходят в чат задачи вместе с комментарием.'
      : 'Вложения крепятся к самой карточке (у комментариев Trello вложений нет).'

  const HELP = [
    `🤖 *task-bot* — ${tracker.describe()} (работает в группах)`,
    '',
    'Команды можно слать обычным текстом или подписью к фото/видео:',
    '',
    '/issue `<заголовок>` — создать задачу.',
    '   • Пустая строка после заголовка → дальше идёт описание задачи.',
    '   • Прикрепи фото/видео (можно альбомом) — станут вложениями.',
    '/offer `<заголовок>` — создать предложение (статус «Ожидает»).',
    '   • Кнопки «Одобрить»/«Отклонить» (доступны только утверждающим).',
    `   • Одобрить → задача остаётся активной. Отклонить → уходит в «${tracker.statusNames.cancelled}».`,
    '/comment `<текст>` — добавить комментарий; задача выбирается из списка.',
    `   • ${attachNote}`,
    '/complete — закрыть задачу как выполненную (выбор из списка).',
    '/project — какой проект у этого чата; там же можно сменить.',
    '/whoami — режим (webhook/polling) и какой инстанс бота отвечает.',
    '',
    '↩️ *Ответом на сообщение* можно писать просто /issue или /comment без текста —',
    'бот возьмёт текст и вложение из того сообщения.',
    '',
    '_Альбомы работают только при выключенном Privacy Mode у бота._',
  ].join('\n')

  const albums = new Map<string, { ctxs: Context[]; timer: ReturnType<typeof setTimeout> }>()
  let opSeq = 0
  const newOpId = (): string => `${Date.now().toString(36)}${(opSeq++).toString(36)}`

  // Display text for the approval line (UI only — state itself lives in the tracker).
  const APPROVAL_LABEL: Record<Approval, string> = {
    pending: 'Ожидает',
    approved: 'Одобрено',
    rejected: 'Отклонено',
  }

  /** Telegram identity of the command author → the task's "Создатель" line. */
  const authorTag = (ctx: Context): string => {
    if (ctx.from?.username) return `@${ctx.from.username}`
    const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim()
    return name || `id${ctx.from?.id ?? '?'}`
  }

  const chatIdOf = (ctx: Context): number | undefined =>
    ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id

  // ── task rendering (STATELESS — re-read from the tracker, ref encoded in buttons) ──

  /** Short handle for one-line replies: «#42», or the title when there is no number. */
  const tag = (d: TaskView): string => d.num || truncate(d.title, 30)

  function cardText(d: TaskView, doneBy?: string): string {
    const head = d.done ? '☑️' : d.cancelled ? '🚫' : '✅'
    const lines = [
      d.num ? `${head} Задача *${d.num}*: ${d.title}` : `${head} Задача: ${d.title}`,
      `👤 Исполнитель: ${d.assigneeName}`,
      `🧑‍💼 Создатель: ${d.creatorText}`,
    ]
    if (d.approval) lines.push(`📝 Одобрение: ${APPROVAL_LABEL[d.approval]}`)
    if (d.attachments !== undefined && d.attachments > 0) lines.push(`📎 Вложений: ${d.attachments}`)
    if (d.done) lines.push(`☑️ ${tracker.statusNames.done} — выполнил ${doneBy ?? d.assigneeName}`)
    if (d.cancelled) lines.push(`🚫 ${tracker.statusNames.cancelled}`)
    return lines.join('\n')
  }

  function cardKeyboard(d: TaskView): InlineKeyboard {
    if (d.done || d.cancelled) {
      return new InlineKeyboard().url('🔗 Открыть задачу', d.url)
    }
    return new InlineKeyboard()
      .text('👤 Исполнитель', `cag:${d.ref}`)
      .row()
      .text('✅ Выполнил', `cfin:${d.ref}`)
      .row()
      .url('🔗 Открыть задачу', d.url)
  }

  function offerKeyboard(d: TaskView): InlineKeyboard {
    // Approve/Reject only while still pending; after a decision, just the link.
    if (d.approval !== 'pending' || d.done || d.cancelled) {
      return new InlineKeyboard().url('🔗 Открыть задачу', d.url)
    }
    return new InlineKeyboard()
      .text('✅ Одобрить', `ofa:${d.ref}`)
      .text('❌ Отклонить', `ofr:${d.ref}`)
      .row()
      .url('🔗 Открыть задачу', d.url)
  }

  // Only whitelisted Telegram users may approve/reject offers (empty list = anyone).
  const isApprover = (userId?: number): boolean =>
    cfg.offerApprovers.length === 0 || (userId !== undefined && cfg.offerApprovers.includes(userId))

  const approverName = (ctx: Context): string =>
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') ||
    (ctx.from?.username ? `@${ctx.from.username}` : 'кто-то')

  async function renderCard(ctx: Context, ref: string, doneBy?: string): Promise<void> {
    const d = await tracker.getTask(ref)
    if (!d) {
      await ctx.editMessageText('Задача не найдена.')
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

  async function unpin(ctx: Context): Promise<void> {
    const msg = ctx.callbackQuery?.message
    if (!msg) return
    try {
      await ctx.api.unpinChatMessage(msg.chat.id, msg.message_id)
    } catch (err) {
      console.error('[bot] unpin failed:', err)
    }
  }

  // ── boards («проекты») ───────────────────────────────────────────

  function boardKeyboard(boards: BoardInfo[], opId: string): InlineKeyboard {
    const kb = new InlineKeyboard()
    for (const b of boards.slice(0, BOARD_BUTTON_LIMIT)) {
      kb.text(b.group ? `${b.group} / ${b.name}` : b.name, `pbs:${opId}:${b.ref}`).row()
    }
    return kb.text('🔄 Обновить список', `pbr:${opId}`)
  }

  async function showBoardPicker(ctx: Context, opId: string, title: string): Promise<void> {
    const boards = await tracker.listBoards()
    if (boards.length === 0) {
      await ctx.reply('Трекер не отдал ни одной доски — проверь права токена.')
      return
    }
    const extra =
      boards.length > BOARD_BUTTON_LIMIT
        ? `\n\n_Показаны первые ${BOARD_BUTTON_LIMIT} из ${boards.length} — сузь список через BOARDS\\_FILTER._`
        : ''
    await ctx.reply(`${title}${extra}`, {
      parse_mode: 'Markdown',
      reply_markup: boardKeyboard(boards, opId),
    })
  }

  /**
   * The board this chat posts to. Binds automatically when there is nothing to
   * choose from; returns undefined when the user has to pick (the caller parks
   * the command and shows the picker).
   */
  async function resolveChatBoard(ctx: Context): Promise<ChatBoard | undefined> {
    const chatId = chatIdOf(ctx)
    if (chatId === undefined) return undefined
    const bound = store.getChatBoard(chatId)
    if (bound) return bound

    const boards = await tracker.listBoards()
    if (boards.length === 0) {
      throw new Error('Трекер не отдал ни одной доски — проверь права токена.')
    }
    if (boards.length === 1) {
      const only = { boardId: boards[0].id, boardName: boards[0].name }
      store.setChatBoard(chatId, only)
      return only
    }
    return undefined
  }

  /** Park a command and ask which board it should go to. */
  async function parkForBoard(ctx: Context, op: PendingOp): Promise<void> {
    store.gc(PENDING_TTL_MS)
    const opId = newOpId()
    store.savePendingOp(opId, op)
    await showBoardPicker(ctx, opId, '📁 В какой проект?')
  }

  /** The chosen board lacks what the bot resolves by name — offer to create it. */
  async function offerBoardSetup(
    ctx: Context,
    board: ChatBoard,
    op: PendingOp,
    err: Error,
    opId?: string,
  ): Promise<void> {
    store.gc(PENDING_TTL_MS)
    const id = opId ?? newOpId()
    store.savePendingOp(id, op)
    const boards = await tracker.listBoards()
    const ref = boards.find((b) => b.id === board.boardId)?.ref ?? board.boardId
    await ctx.reply(`⚠️ Проект «${board.boardName}» не готов: ${err.message}`, {
      reply_markup: new InlineKeyboard().text('➕ Создать', `bfix:${id}:${ref}`),
    })
  }

  // ── command handlers ─────────────────────────────────────────────

  async function createTask(
    ctx: Context,
    board: ChatBoard,
    op: PendingOp,
    opId?: string,
  ): Promise<void> {
    const isOffer = op.kind === 'offer'
    let task: TaskView
    try {
      task = await tracker.createTask({
        boardId: board.boardId,
        title: op.title ?? '',
        description: op.description ?? '',
        creator: op.creator ?? authorTag(ctx),
        offer: isOffer,
      })
    } catch (err) {
      if (isBoardIncomplete(err)) {
        await offerBoardSetup(ctx, board, op, err as Error, opId)
        return
      }
      throw err
    }

    if (op.media.length > 0) {
      await tracker.attach(task, await downloadAll(ctx, op.media))
    }

    const fresh = (await tracker.getTask(task.ref)) ?? task
    const text = isOffer ? `📋 *Предложение*\n${cardText(fresh)}` : cardText(fresh)
    const sent = await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: isOffer ? offerKeyboard(fresh) : cardKeyboard(fresh),
    })
    await tryPin(ctx, sent)
  }

  async function showTaskPicker(
    ctx: Context,
    board: ChatBoard,
    op: PendingOp,
    opId?: string,
  ): Promise<void> {
    let tasks
    try {
      tasks = await tracker.listActive(board.boardId, 20)
    } catch (err) {
      if (isBoardIncomplete(err)) {
        await offerBoardSetup(ctx, board, op, err as Error, opId)
        return
      }
      throw err
    }
    if (tasks.length === 0) {
      await ctx.reply(`Активных задач в проекте «${board.boardName}» не найдено.`)
      return
    }
    const label = (t: { num: string; title: string }): string =>
      t.num ? `${t.num} — ${truncate(t.title)}` : truncate(t.title, 45)

    if (op.kind === 'complete') {
      const kb = new InlineKeyboard()
      tasks.forEach((t) => kb.text(label(t), `d:${t.ref}`).row())
      await ctx.reply('✔️ Какую задачу закрыть?', { reply_markup: kb })
      return
    }

    // /comment: the payload has to survive the pick → keep it parked.
    store.gc(PENDING_TTL_MS)
    const id = opId ?? newOpId()
    store.savePendingOp(id, op)
    const kb = new InlineKeyboard()
    tasks.forEach((t) => kb.text(label(t), `c:${id}:${t.ref}`).row())
    await ctx.reply('💬 К какой задаче добавить комментарий?', { reply_markup: kb })
  }

  /** Run a command once its board is known. */
  async function runOp(ctx: Context, board: ChatBoard, op: PendingOp, opId?: string): Promise<void> {
    if (op.kind === 'issue' || op.kind === 'offer') {
      await createTask(ctx, board, op, opId)
    } else {
      await showTaskPicker(ctx, board, op, opId)
    }
  }

  async function dispatch(ctx: Context, op: PendingOp): Promise<void> {
    // Stamp the author here: the board button may well be pressed by someone else.
    const stamped: PendingOp = { ...op, creator: authorTag(ctx) }
    const board = await resolveChatBoard(ctx)
    if (!board) {
      await parkForBoard(ctx, stamped)
      return
    }
    await runOp(ctx, board, stamped)
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
        case 'issue':
        case 'offer': {
          const c = resolveIssueContent(cmdCtx, parsed.rest, media)
          if (!c.title) {
            await cmdCtx.reply(
              `Использование: /${parsed.command} <заголовок>\n\n<описание> (можно с фото/видео или в ответ на сообщение)`,
            )
            break
          }
          await dispatch(cmdCtx, {
            kind: parsed.command,
            title: c.title,
            description: c.description,
            media: c.media,
          })
          break
        }
        case 'comment': {
          const resolved = resolveContent(cmdCtx, parsed.rest, media)
          if (!resolved.text && resolved.media.length === 0) {
            await cmdCtx.reply('Использование: /comment <текст> (можно с фото/видео)')
            break
          }
          await dispatch(cmdCtx, { kind: 'comment', text: resolved.text, media: resolved.media })
          break
        }
        case 'complete':
          await dispatch(cmdCtx, { kind: 'complete', media: [] })
          break
        case 'project': {
          const chatId = chatIdOf(cmdCtx)
          const bound = chatId !== undefined ? store.getChatBoard(chatId) : undefined
          const current = bound ? `Текущий проект: *${bound.boardName}*` : 'Проект ещё не выбран.'
          await showBoardPicker(cmdCtx, '-', `📁 ${current}\nКуда складывать задачи?`)
          break
        }
        case 'whoami': {
          const chatId = chatIdOf(cmdCtx)
          const bound = chatId !== undefined ? store.getChatBoard(chatId) : undefined
          await cmdCtx.reply(
            [
              `🤖 Режим: *${cfg.webhookUrl ? 'webhook' : 'polling'}*`,
              `Инстанс: *${cfg.botInstance}*`,
              `Трекер: *${tracker.describe()}*`,
              `Проект чата: *${bound?.boardName ?? 'не выбран'}*`,
              `PID: ${process.pid}`,
            ].join('\n'),
            { parse_mode: 'Markdown' },
          )
          break
        }
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

  // ── board picked: bind it to the chat and resume the parked command ──
  bot.callbackQuery(/^pbs:([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const opId = ctx.match[1]
    const boardRef = ctx.match[2]
    try {
      const board = (await tracker.listBoards()).find((b) => b.ref === boardRef)
      if (!board) {
        await ctx.editMessageText('Проект не найден — открой список заново: /project')
        return
      }
      const chatId = chatIdOf(ctx)
      if (chatId === undefined) return
      const bound: ChatBoard = { boardId: board.id, boardName: board.name }
      store.setChatBoard(chatId, bound)
      await ctx.editMessageText(`📁 Проект чата: *${board.name}*`, { parse_mode: 'Markdown' })

      if (opId === '-') return
      const op = store.takePendingOp(opId)
      if (!op) {
        await ctx.reply('Сессия истекла — повтори команду.')
        return
      }
      await runOp(ctx, bound, op, opId)
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  // ── refresh the board list (bypasses the 10-minute cache) ─────────
  bot.callbackQuery(/^pbr:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const opId = ctx.match[1]
    try {
      const boards = await tracker.listBoards(true)
      if (boards.length === 0) {
        await ctx.editMessageText('Трекер не отдал ни одной доски — проверь права токена.')
        return
      }
      await ctx.editMessageReplyMarkup({ reply_markup: boardKeyboard(boards, opId) })
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  // ── create what the board is missing, then resume ─────────────────
  bot.callbackQuery(/^bfix:([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const opId = ctx.match[1]
    const boardRef = ctx.match[2]
    try {
      const board = (await tracker.listBoards()).find((b) => b.ref === boardRef)
      if (!board) {
        await ctx.editMessageText('Проект не найден — открой список заново: /project')
        return
      }
      await tracker.setupBoard(board.id)
      await ctx.editMessageText(`✅ Проект «${board.name}» готов.`)
      const op = store.takePendingOp(opId)
      if (!op) return
      await runOp(ctx, { boardId: board.id, boardName: board.name }, op, opId)
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  // ── /comment selection (payload persisted in SQLite) ─────
  bot.callbackQuery(/^c:([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    try {
      const opId = ctx.match[1]
      const ref = ctx.match[2]
      const op = store.takePendingOp(opId)
      if (!op) {
        await ctx.reply('Сессия истекла — повторите /comment.')
        return
      }
      const d = await tracker.getTask(ref)
      if (!d) {
        await ctx.editMessageText('Задача не найдена.')
        return
      }
      const text = (op.text ?? '').trim()
      let attached = 0
      if (op.media.length > 0) {
        // Caption travels with the files so YouGile can post them as one message.
        const files = await downloadAll(ctx, op.media)
        await tracker.attach(d, files, text)
        attached = files.length
      } else if (text) {
        await tracker.comment(d, text)
      }
      const parts: string[] = []
      if (text) parts.push('комментарий добавлен')
      if (attached > 0) parts.push(`вложений: ${attached}`)
      await ctx.editMessageText(`💬 *${tag(d)}*: ${parts.join(', ') || 'без изменений'}.`, {
        parse_mode: 'Markdown',
      })
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  // ── /complete selection (stateless) ──────────────────────
  bot.callbackQuery(/^d:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    try {
      const d = await tracker.getTask(ctx.match[1])
      if (!d) {
        await ctx.editMessageText('Задача не найдена.')
        return
      }
      await tracker.complete(d)
      await ctx.editMessageText(`✔️ *${tag(d)}* → «${tracker.statusNames.done}».`, {
        parse_mode: 'Markdown',
      })
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  // ── card buttons (stateless: task ref in callback data) ──
  bot.callbackQuery(/^cag:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const ref = ctx.match[1]
    try {
      const d = await tracker.getTask(ref)
      if (!d) {
        await ctx.editMessageText('Задача не найдена.')
        return
      }
      const members = await tracker.listMembers(d.boardId, 30)
      if (members.length === 0) {
        await ctx.answerCallbackQuery({
          text: 'В проекте нет участников — добавь людей в трекере.',
          show_alert: true,
        })
        return
      }
      const kb = new InlineKeyboard()
      members.forEach((a, i) => {
        kb.text(a.name, `cags:${ref}:${a.ref}`)
        if (i % 2 === 1) kb.row()
      })
      kb.row().text('◀️ Назад', `cbk:${ref}`)
      await ctx.editMessageReplyMarkup({ reply_markup: kb })
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  bot.callbackQuery(/^cags:([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const ref = ctx.match[1]
    const memberRef = ctx.match[2]
    try {
      const d = await tracker.getTask(ref)
      if (!d) {
        await ctx.editMessageText('Задача не найдена.')
        return
      }
      await tracker.setAssignee(d, memberRef)
      await renderCard(ctx, ref)
    } catch (err) {
      await replyError(ctx, err)
    }
  })

  bot.callbackQuery(/^cfin:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const ref = ctx.match[1]
    try {
      const d = await tracker.getTask(ref)
      if (!d) {
        await ctx.editMessageText('Задача не найдена.')
        return
      }
      await tracker.complete(d)
      await unpin(ctx)
      const clicker = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ')
      const doneBy = d.assigneeName !== '—' ? d.assigneeName : clicker || '—'
      await renderCard(ctx, ref, doneBy)
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
    try {
      const d = await tracker.getTask(ctx.match[1])
      if (!d) {
        await ctx.editMessageText('Задача не найдена.')
        return
      }
      await tracker.approveOffer(d)
      await unpin(ctx)
      await ctx.editMessageText(
        `✅ *Одобрено* — задача *${tag(d)}* активна\nКто: ${approverName(ctx)}`,
        { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().url('🔗 Открыть задачу', d.url) },
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
    try {
      const d = await tracker.getTask(ctx.match[1])
      if (!d) {
        await ctx.editMessageText('Задача не найдена.')
        return
      }
      await tracker.rejectOffer(d)
      await unpin(ctx)
      await ctx.editMessageText(
        `❌ *Отклонено* → «${tracker.statusNames.cancelled}»\nКто: ${approverName(ctx)}`,
        { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().url('🔗 Открыть задачу', d.url) },
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
