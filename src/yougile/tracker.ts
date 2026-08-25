import type { TrackerConfig } from '../config.js'
import { parseCreator, withCreator } from '../tracker/creator.js'
import { packUuid, unpackUuid } from '../tracker/ref.js'
import type {
  Approval,
  BoardInfo,
  CreateTaskInput,
  MemberInfo,
  StatusNames,
  TaskBrief,
  TaskTracker,
  TaskView,
} from '../tracker/types.js'
import type { DownloadedFile } from '../telegram/media.js'
import * as api from './api.js'
import { YouGileClient } from './client.js'
import { attachmentsHtml, htmlToText, textToHtml } from './html.js'

const BOARDS_TTL_MS = 10 * 60 * 1000
const USERS_TTL_MS = 5 * 60 * 1000

/** Sticker state names modelling /offer approval. */
const APPROVAL_STATE: Record<Approval, string> = {
  pending: 'Ожидает',
  approved: 'Одобрено',
  rejected: 'Отклонено',
}

/** Columns of one board, resolved from the configured status names. */
interface BoardRefs {
  boardId: string
  projectId?: string
  todo: string
  done: string
  cancelled: string
}

/** The company-level «Одобрение» sticker and its three states. */
interface ApprovalRefs {
  stickerId: string
  states: Record<Approval, string>
}

const eq = (a: string, b: string): boolean => a.trim() === b.trim()

/**
 * YouGile behind the TaskTracker port.
 *
 * Statuses are columns (plus the native `completed` flag), and /offer approval is
 * a text sticker with three states — stickers are free here, so the label-based
 * workaround Trello needs isn't carried over. Files have no task field at all:
 * they are uploaded and posted into the task's chat, which is where YouGile shows
 * attachments anyway.
 */
export class YouGileTracker implements TaskTracker {
  readonly kind = 'yougile' as const
  readonly attachmentTarget = 'chat' as const
  readonly statusNames: StatusNames

  private readonly client: YouGileClient
  private readonly cfg: TrackerConfig
  private readonly refsCache = new Map<string, BoardRefs>()
  /** columnId → boardId, so a task read by id can find its board's columns. */
  private readonly columnToBoard = new Map<string, string>()
  private boards?: { at: number; value: BoardInfo[] }
  private boardMeta = new Map<string, api.YGBoard>()
  /**
   * Users by project, cached briefly: assignee names are needed on every card
   * render, and the API has no per-task user expansion — without this, a click
   * would pull the whole user list against a 50-per-minute budget.
   */
  private readonly usersCache = new Map<string, { at: number; value: api.YGUser[] }>()
  private approval?: ApprovalRefs
  private identity = 'YouGile'

  constructor(cfg: TrackerConfig) {
    this.cfg = cfg
    this.statusNames = cfg.statusNames
    this.client = new YouGileClient({
      baseUrl: cfg.yougile.baseUrl,
      token: cfg.yougile.token,
      proxyUrl: cfg.yougile.proxyUrl,
    })
  }

  async start(): Promise<void> {
    // Cheapest call that proves the key works; a bad key fails with HTTP 401 here
    // instead of somewhere in the middle of the first /issue.
    const users = await api.listUsers(this.client)
    this.identity = `YouGile (${this.cfg.yougile.baseUrl.replace(/^https?:\/\//, '')}, ${users.length} чел.)`
  }

  describe(): string {
    return this.identity
  }

  // ── boards ─────────────────────────────────────────────────────

  async listBoards(force = false): Promise<BoardInfo[]> {
    if (!force && this.boards && Date.now() - this.boards.at < BOARDS_TTL_MS) {
      return this.boards.value
    }
    const [boards, projects] = await Promise.all([
      api.listBoards(this.client),
      api.listProjects(this.client).catch(() => [] as api.YGProject[]),
    ])
    const projectName = new Map(projects.map((p) => [p.id, p.title]))
    this.boardMeta = new Map(boards.map((b) => [b.id, b]))

    let value: BoardInfo[] = boards.map((b) => ({
      id: b.id,
      ref: packUuid(b.id),
      name: b.title,
      group: b.projectId ? projectName.get(b.projectId) : undefined,
    }))
    const filter = this.cfg.boardsFilter?.toLowerCase()
    if (filter) value = value.filter((b) => b.name.toLowerCase().includes(filter))

    this.boards = { at: Date.now(), value }
    return value
  }

  async checkBoard(boardId: string): Promise<string[]> {
    const columns = await api.listColumns(this.client, boardId)
    const missing: string[] = []
    for (const name of [this.statusNames.todo, this.statusNames.done, this.statusNames.cancelled]) {
      if (!columns.some((c) => eq(c.title, name))) missing.push(`колонка «${name}»`)
    }
    missing.push(...(await this.missingApprovalParts()))
    return missing
  }

  async setupBoard(boardId: string): Promise<void> {
    const columns = await api.listColumns(this.client, boardId)
    for (const name of [this.statusNames.todo, this.statusNames.done, this.statusNames.cancelled]) {
      if (!columns.some((c) => eq(c.title, name))) {
        await api.createColumn(this.client, boardId, name)
      }
    }

    const stickerName = this.cfg.yougile.approvalStickerName
    const sticker = (await api.listStickers(this.client, stickerName)).find((s) =>
      eq(s.name, stickerName),
    )
    if (!sticker) {
      await api.createSticker(this.client, stickerName, Object.values(APPROVAL_STATE))
    } else {
      for (const name of Object.values(APPROVAL_STATE)) {
        if (!(sticker.states ?? []).some((s) => eq(s.name, name))) {
          await api.createStickerState(this.client, sticker.id, name)
        }
      }
    }

    this.refsCache.delete(boardId)
    this.approval = undefined
  }

  private async refsFor(boardId: string): Promise<BoardRefs> {
    const cached = this.refsCache.get(boardId)
    if (cached) return cached

    const columns = await api.listColumns(this.client, boardId)
    for (const c of columns) this.columnToBoard.set(c.id, boardId)

    const missing: string[] = []
    const find = (name: string): string => {
      const c = columns.find((x) => eq(x.title, name))
      if (!c) missing.push(`колонка «${name}»`)
      return c?.id ?? ''
    }
    const refs: BoardRefs = {
      boardId,
      projectId: this.boardMeta.get(boardId)?.projectId,
      todo: find(this.statusNames.todo),
      done: find(this.statusNames.done),
      cancelled: find(this.statusNames.cancelled),
    }
    if (missing.length > 0) {
      throw new Error(`На доске не хватает: ${missing.join('; ')}.`)
    }
    this.refsCache.set(boardId, refs)
    return refs
  }

  // ── approval sticker (company-level, resolved once) ─────────────

  /** Sticker refs, or undefined when the sticker isn't set up yet. */
  private async approvalRefs(): Promise<ApprovalRefs | undefined> {
    if (this.approval) return this.approval
    const name = this.cfg.yougile.approvalStickerName
    const sticker = (await api.listStickers(this.client, name)).find((s) => eq(s.name, name))
    if (!sticker) return undefined

    const stateId = (wanted: string): string =>
      (sticker.states ?? []).find((s) => eq(s.name, wanted))?.id ?? ''
    const states = {
      pending: stateId(APPROVAL_STATE.pending),
      approved: stateId(APPROVAL_STATE.approved),
      rejected: stateId(APPROVAL_STATE.rejected),
    }
    if (!states.pending || !states.approved || !states.rejected) return undefined

    this.approval = { stickerId: sticker.id, states }
    return this.approval
  }

  private async missingApprovalParts(): Promise<string[]> {
    return (await this.approvalRefs())
      ? []
      : [`стикер «${this.cfg.yougile.approvalStickerName}» с состояниями ${Object.values(APPROVAL_STATE).join('/')}`]
  }

  /** Same, but for paths that cannot continue without it (/offer). */
  private async requireApproval(): Promise<ApprovalRefs> {
    const refs = await this.approvalRefs()
    if (!refs) {
      throw new Error(`На доске не хватает: ${(await this.missingApprovalParts()).join('; ')}.`)
    }
    return refs
  }

  // ── tasks ──────────────────────────────────────────────────────

  private async usersOf(projectId: string | undefined): Promise<api.YGUser[]> {
    const key = projectId ?? '*'
    const cached = this.usersCache.get(key)
    if (cached && Date.now() - cached.at < USERS_TTL_MS) return cached.value
    const value = await api.listUsers(this.client, projectId)
    this.usersCache.set(key, { at: Date.now(), value })
    return value
  }

  private async boardIdForColumn(columnId: string): Promise<string> {
    const cached = this.columnToBoard.get(columnId)
    if (cached) return cached
    const column = await api.getColumn(this.client, columnId)
    this.columnToBoard.set(columnId, column.boardId)
    return column.boardId
  }

  private taskUrl(id: string): string {
    const template = this.cfg.yougile.taskUrlTemplate
    return template ? template.replace('{id}', id) : `${this.cfg.yougile.baseUrl}/#task/${id}`
  }

  private async toView(task: api.YGTask, refs: BoardRefs): Promise<TaskView> {
    const [users, approvalRefs] = await Promise.all([
      task.assigned?.length ? this.usersOf(refs.projectId) : Promise.resolve([] as api.YGUser[]),
      this.approvalRefs(),
    ])
    const byId = new Map(users.map((u) => [u.id, u]))
    const assigneeName = task.assigned?.length
      ? task.assigned.map((id) => displayName(byId.get(id)) || id).join(', ')
      : '—'

    let approval: Approval | null = null
    if (approvalRefs) {
      const state = task.stickers?.[approvalRefs.stickerId]
      for (const key of ['pending', 'approved', 'rejected'] as const) {
        if (state && state === approvalRefs.states[key]) approval = key
      }
    }

    const description = htmlToText(task.description)
    const num = task.idTaskCommon !== undefined ? `#${task.idTaskCommon}` : ''

    return {
      id: task.id,
      ref: packUuid(task.id),
      boardId: refs.boardId,
      num,
      title: task.title,
      url: this.taskUrl(task.id),
      assigneeName,
      creatorText: parseCreator(description),
      approval,
      // YouGile tasks carry no attachment counter — files live in the task chat.
      attachments: undefined,
      done: task.completed === true || task.columnId === refs.done,
      cancelled: task.columnId === refs.cancelled,
    }
  }

  async createTask(input: CreateTaskInput): Promise<TaskView> {
    // Resolve everything the task needs BEFORE creating it, so an unprepared
    // board fails cleanly instead of leaving a half-marked task behind.
    const refs = await this.refsFor(input.boardId)
    const stickers = input.offer
      ? (({ stickerId, states }) => ({ [stickerId]: states.pending }))(await this.requireApproval())
      : undefined

    const created = await api.createTask(this.client, {
      title: input.title,
      columnId: refs.todo,
      description: textToHtml(withCreator(input.description, input.creator)),
    })
    if (stickers) {
      await api.updateTask(this.client, created.id, { stickers })
    }

    const view = await this.getTask(packUuid(created.id))
    if (!view) throw new Error(`Задача ${created.id} создана, но не читается`)
    return view
  }

  async getTask(ref: string): Promise<TaskView | undefined> {
    const task = await api.getTask(this.client, unpackUuid(ref))
    if (!task || task.deleted) return undefined
    const refs = await this.refsFor(await this.boardIdForColumn(task.columnId))
    return this.toView(task, refs)
  }

  async listActive(boardId: string, limit: number): Promise<TaskBrief[]> {
    const refs = await this.refsFor(boardId)
    const tasks = await api.listTasks(this.client, refs.todo, limit)
    return tasks
      .filter((t) => !t.deleted && !t.completed && !t.archived)
      .slice(0, limit)
      .map((t) => ({
        ref: packUuid(t.id),
        num: t.idTaskCommon !== undefined ? `#${t.idTaskCommon}` : '',
        title: t.title,
      }))
  }

  async listMembers(boardId: string, limit: number): Promise<MemberInfo[]> {
    const refs = await this.refsFor(boardId)
    const users = await this.usersOf(refs.projectId)
    return users
      .map((u) => ({ ref: packUuid(u.id), name: displayName(u) }))
      .filter((m) => m.name.length > 0)
      .slice(0, limit)
  }

  async setAssignee(task: TaskView, memberRef: string): Promise<void> {
    await api.updateTask(this.client, task.id, { assigned: [unpackUuid(memberRef)] })
  }

  async comment(task: TaskView, text: string): Promise<void> {
    await api.sendMessage(this.client, task.id, text, textToHtml(text))
  }

  /** Upload every file, then post them (with the caption) as ONE chat message. */
  async attach(task: TaskView, files: DownloadedFile[], caption = ''): Promise<void> {
    const uploaded: { name: string; contentType: string; url: string }[] = []
    for (const file of files) {
      uploaded.push({
        name: file.name,
        contentType: file.contentType,
        url: await api.uploadFile(this.client, file),
      })
    }
    if (uploaded.length === 0) {
      if (caption.trim()) await this.comment(task, caption)
      return
    }
    const text = [caption.trim(), ...uploaded.map((f) => `${f.name}: ${f.url}`)]
      .filter(Boolean)
      .join('\n')
    await api.sendMessage(this.client, task.id, text, attachmentsHtml(uploaded, caption))
  }

  async complete(task: TaskView): Promise<void> {
    const refs = await this.refsFor(task.boardId)
    await api.updateTask(this.client, task.id, { columnId: refs.done, completed: true })
  }

  async approveOffer(task: TaskView): Promise<void> {
    const approval = await this.requireApproval()
    await api.updateTask(this.client, task.id, {
      stickers: { [approval.stickerId]: approval.states.approved },
    })
  }

  async rejectOffer(task: TaskView): Promise<void> {
    const [refs, approval] = await Promise.all([this.refsFor(task.boardId), this.requireApproval()])
    await api.updateTask(this.client, task.id, {
      columnId: refs.cancelled,
      stickers: { [approval.stickerId]: approval.states.rejected },
    })
  }
}

function displayName(user: api.YGUser | undefined): string {
  if (!user) return ''
  return (user.realName || user.email || '').trim()
}
