import type { TrackerConfig } from '../config.js'
import { parseCreator, withCreator } from '../tracker/creator.js'
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
import { TrelloClient } from './client.js'
import {
  addComment,
  approveOffer,
  attachFile,
  createCard,
  fetchCard,
  getMe,
  listActiveCards,
  listBoards,
  listMembers,
  markOffer,
  missingBoardParts,
  moveCard,
  resolveBoardRefs,
  setAssignee,
  setupBoard,
  type BoardRefs,
  type TCard,
  type TrelloNames,
} from './cards.js'

const BOARDS_TTL_MS = 10 * 60 * 1000

/**
 * Trello behind the TaskTracker port.
 *
 * Statuses are columns, approval is labels + the «Отменено» column — Custom
 * Fields are paywalled on the free plan, so both are modelled with free
 * primitives. Board schemas (list and label ids) are resolved lazily per board
 * and cached: the bot can post to any board the token sees, and resolving them
 * all upfront would be a request per board for boards nobody uses.
 */
export class TrelloTracker implements TaskTracker {
  readonly kind = 'trello' as const
  readonly attachmentTarget = 'card' as const
  readonly statusNames: StatusNames

  private readonly client: TrelloClient
  private readonly cfg: TrackerConfig
  private readonly names: TrelloNames
  private readonly refsCache = new Map<string, BoardRefs>()
  private boards?: { at: number; value: BoardInfo[] }
  private identity = 'Trello'

  constructor(cfg: TrackerConfig) {
    this.cfg = cfg
    this.statusNames = cfg.statusNames
    this.names = {
      status: cfg.statusNames,
      offerLabel: cfg.trello.offerLabelName,
      approvedLabel: cfg.trello.approvedLabelName,
    }
    this.client = new TrelloClient({
      apiKey: cfg.trello.apiKey,
      token: cfg.trello.token,
      proxyUrl: cfg.trello.proxyUrl,
    })
  }

  async start(): Promise<void> {
    const me = await getMe(this.client)
    this.identity = `Trello (@${me.username})`
  }

  describe(): string {
    return this.identity
  }

  // ── boards ─────────────────────────────────────────────────────

  async listBoards(force = false): Promise<BoardInfo[]> {
    if (!force && this.boards && Date.now() - this.boards.at < BOARDS_TTL_MS) {
      return this.boards.value
    }
    const { boards, orgs } = await listBoards(this.client)
    let value: BoardInfo[] = boards.map((b) => ({
      id: b.id,
      // Trello ids are already short enough for callback_data.
      ref: b.id,
      name: b.name,
      group: b.idOrganization ? orgs.get(b.idOrganization) : undefined,
    }))

    // TRELLO_BOARD_ID (legacy single-board setups) pins the picker to one board.
    const only = this.cfg.trello.onlyBoardId
    if (only) {
      const pinned = value.filter((b) => b.id === only || b.id.startsWith(only))
      if (pinned.length > 0) value = pinned
    }
    const filter = this.cfg.boardsFilter?.toLowerCase()
    if (filter) value = value.filter((b) => b.name.toLowerCase().includes(filter))

    this.boards = { at: Date.now(), value }
    return value
  }

  checkBoard(boardId: string): Promise<string[]> {
    return missingBoardParts(this.client, boardId, this.names)
  }

  async setupBoard(boardId: string): Promise<void> {
    await setupBoard(this.client, boardId, this.names, this.cfg.trello.categoryLabels)
    this.refsCache.delete(boardId)
  }

  /** Board schema by id or shortLink, cached under both keys. */
  private async refsFor(boardId: string): Promise<BoardRefs> {
    const cached = this.refsCache.get(boardId)
    if (cached) return cached
    const refs = await resolveBoardRefs(this.client, boardId, this.names)
    this.refsCache.set(boardId, refs)
    this.refsCache.set(refs.boardId, refs)
    return refs
  }

  // ── tasks ──────────────────────────────────────────────────────

  private toView(card: TCard, refs: BoardRefs): TaskView {
    const members = card.members ?? []
    const labels = card.idLabels ?? []
    const cancelled = card.idList === refs.listCancelled

    let approval: Approval | null = null
    if (labels.includes(refs.approvedLabelId)) approval = 'approved'
    else if (labels.includes(refs.offerLabelId)) approval = cancelled ? 'rejected' : 'pending'

    return {
      id: card.id,
      ref: card.shortLink,
      boardId: refs.boardId,
      num: `#${card.idShort}`,
      title: card.name,
      url: card.url,
      assigneeName: members.length
        ? members.map((m) => (m.fullName || `@${m.username}`).trim()).join(', ')
        : '—',
      creatorText: parseCreator(card.desc),
      approval,
      attachments: card.badges?.attachments ?? 0,
      done: card.idList === refs.listDone,
      cancelled,
    }
  }

  async createTask(input: CreateTaskInput): Promise<TaskView> {
    // Resolve first: an unprepared board must fail before a card exists.
    const refs = await this.refsFor(input.boardId)
    const created = await createCard(
      this.client,
      refs.listTodo,
      input.title,
      withCreator(input.description, input.creator),
    )
    if (input.offer) await markOffer(this.client, refs, created.id)
    const view = await this.getTask(created.shortLink)
    if (!view) throw new Error(`Карточка ${created.shortLink} создана, но не читается`)
    return view
  }

  async getTask(ref: string): Promise<TaskView | undefined> {
    const card = await fetchCard(this.client, ref)
    if (!card) return undefined
    return this.toView(card, await this.refsFor(card.idBoard))
  }

  async listActive(boardId: string, limit: number): Promise<TaskBrief[]> {
    const refs = await this.refsFor(boardId)
    const cards = await listActiveCards(this.client, refs.listTodo, limit)
    return cards.map((c) => ({ ref: c.shortLink, num: `#${c.idShort}`, title: c.name }))
  }

  async listMembers(boardId: string, limit: number): Promise<MemberInfo[]> {
    const refs = await this.refsFor(boardId)
    const members = await listMembers(this.client, refs.boardId, limit)
    return members
      .map((m) => ({ ref: m.id, name: (m.fullName || `@${m.username}`).trim() }))
      .filter((m) => m.name.length > 0)
  }

  async setAssignee(task: TaskView, memberRef: string): Promise<void> {
    await setAssignee(this.client, task.id, memberRef)
  }

  async comment(task: TaskView, text: string): Promise<void> {
    await addComment(this.client, task.id, text)
  }

  /** Trello comments can't carry attachments: the caption is a comment, files go on the card. */
  async attach(task: TaskView, files: DownloadedFile[], caption?: string): Promise<void> {
    if (caption?.trim()) {
      await addComment(this.client, task.id, caption.trim())
    }
    for (const file of files) {
      await attachFile(this.client, task.id, file)
    }
  }

  async complete(task: TaskView): Promise<void> {
    const refs = await this.refsFor(task.boardId)
    await moveCard(this.client, task.id, refs.listDone)
  }

  async approveOffer(task: TaskView): Promise<void> {
    const refs = await this.refsFor(task.boardId)
    await approveOffer(this.client, refs, task.id)
  }

  async rejectOffer(task: TaskView): Promise<void> {
    const refs = await this.refsFor(task.boardId)
    await moveCard(this.client, task.id, refs.listCancelled)
  }
}
