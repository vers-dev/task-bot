import type { DownloadedFile } from '../telegram/media.js'

/**
 * Порт трекера задач — единственное, что знает о трекерах `bot.ts`.
 *
 * Реализации: `trello/tracker.ts` и `yougile/tracker.ts`. Всё, что специфично
 * для конкретного трекера (id колонок, метки против стикеров, shortLink против
 * UUID, чат задачи против комментариев к карточке), живёт внутри реализации и
 * наружу не протекает.
 */

/**
 * Состояние одобрения задачи, созданной через /offer.
 *   Trello  — метки «Предложение»/«Одобрено» + колонка «Отменено» (Custom Fields платные).
 *   YouGile — статусный стикер «Одобрение» с тремя состояниями (стикеры бесплатны).
 */
export type Approval = 'pending' | 'approved' | 'rejected'

/** Имена колонок-статусов, задаются в конфиге и резолвятся в id внутри реализации. */
export interface StatusNames {
  todo: string
  done: string
  cancelled: string
}

/** Доска — то, что бот показывает пользователю как «проект». */
export interface BoardInfo {
  /** Нативный id трекера (уходит в SQLite и в вызовы API). */
  id: string
  /** Компактный ключ для callback_data. */
  ref: string
  name: string
  /** Проект (YouGile) или workspace (Trello) — для группировки в списке. */
  group?: string
}

/** Кандидат в исполнители. `ref` уже упакован под callback_data. */
export interface MemberInfo {
  ref: string
  name: string
}

/** Строка в списке выбора задачи (/comment, /complete). */
export interface TaskBrief {
  ref: string
  /** «#42» или '' — не все трекеры дают короткий номер. */
  num: string
  title: string
}

/** Всё, что нужно для отрисовки карточки задачи в Telegram. */
export interface TaskView {
  /** Нативный id трекера. */
  id: string
  /** Компактный ключ для callback_data (≤ 22 символов). */
  ref: string
  /** Доска, на которой живёт задача — по ней резолвятся колонки-статусы. */
  boardId: string
  /** «#42» для показа, или '' если трекер не даёт номер. */
  num: string
  title: string
  url: string
  /** Имена исполнителей через запятую, или «—». */
  assigneeName: string
  /** Создатель (Telegram-@username), вытащенный из описания, или «—». */
  creatorText: string
  approval: Approval | null
  /** undefined → трекер не отдаёт счётчик, строку «📎 Вложений» не рисуем. */
  attachments?: number
  done: boolean
  cancelled: boolean
}

export interface CreateTaskInput {
  boardId: string
  title: string
  description: string
  /** Telegram-@username автора команды — уйдёт строкой в описание. */
  creator: string
  /**
   * Задача-предложение (/offer): создаётся сразу в состоянии «Ожидает».
   * Пометка ставится внутри реализации — в YouGile прямо в теле создания, в
   * Trello отдельным вызовом, — чтобы неготовая доска ломалась ДО создания
   * задачи, а не после.
   */
  offer?: boolean
}

export interface TaskTracker {
  readonly kind: 'trello' | 'yougile'
  /** Имена колонок-статусов для текстов бота («→ «Готово»»). */
  readonly statusNames: StatusNames
  /**
   * Проверить доступ на старте (падает с понятной ошибкой при неверном токене)
   * и запомнить то, что понадобится describe(). Вызывается один раз из index.ts.
   */
  start(): Promise<void>
  /** Строка для стартового лога и /whoami — доступна после start(). */
  describe(): string

  /** Доски, доступные токену. `force` сбрасывает кэш. */
  listBoards(force?: boolean): Promise<BoardInfo[]>
  /** Имена недостающих на доске колонок; пустой массив = доска готова. */
  checkBoard(boardId: string): Promise<string[]>
  /** Идемпотентно создать всё, чего не хватает (колонки, метки/стикер). */
  setupBoard(boardId: string): Promise<void>

  createTask(input: CreateTaskInput): Promise<TaskView>
  getTask(ref: string): Promise<TaskView | undefined>
  listActive(boardId: string, limit: number): Promise<TaskBrief[]>
  listMembers(boardId: string, limit: number): Promise<MemberInfo[]>

  setAssignee(task: TaskView, memberRef: string): Promise<void>
  comment(task: TaskView, text: string): Promise<void>
  /**
   * Прикрепить файлы к задаче, опционально с подписью. Принимает пачку, а не
   * файл: в YouGile это позволяет уложить весь альбом с текстом комментария в
   * одно сообщение чата вместо N запросов (лимит API — 50 в минуту на компанию).
   */
  attach(task: TaskView, files: DownloadedFile[], caption?: string): Promise<void>
  /** Куда уходят вложения — для формулировки в ответе бота. */
  readonly attachmentTarget: 'card' | 'chat'

  complete(task: TaskView): Promise<void>
  approveOffer(task: TaskView): Promise<void>
  rejectOffer(task: TaskView): Promise<void>
}
