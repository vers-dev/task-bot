import type { TrelloClient } from './client.js'
import type { TrelloConfig } from '../config.js'
import type { DownloadedFile } from '../telegram/media.js'

// ── Light shapes of the Trello objects we touch (the API returns much more) ──
interface TList {
  id: string
  name: string
}
interface TLabel {
  id: string
  name: string
}
interface TMember {
  id: string
  fullName: string
  username: string
}
interface TCard {
  id: string
  shortLink: string
  idShort: number
  name: string
  url: string
  idList: string
  desc?: string
  idMembers?: string[]
  idLabels?: string[]
  dateLastActivity?: string
  badges?: { attachments?: number }
  members?: TMember[]
}

/**
 * Approval state of an /offer card. Custom Fields are paywalled on Trello's free
 * plan, so approval is modelled with FREE primitives instead:
 *   - pending  → has the «Предложение» label, still in an active list
 *   - approved → also has the «Одобрено» label (stays active)
 *   - rejected → «Предложение» label + moved to the «Отменено» list
 */
export type Approval = 'pending' | 'approved' | 'rejected'

// The "Создатель" line appended to a card's description (Custom Fields are paid).
const CREATOR_MARKER = '— Создатель:'
const CREATOR_RE = /^—\s*Создатель:\s*(.+?)\s*$/m

/** Append the creator tag to a description (Telegram @username of the author). */
export function withCreator(desc: string, tag: string): string {
  const base = (desc ?? '').trim()
  return base ? `${base}\n\n${CREATOR_MARKER} ${tag}` : `${CREATOR_MARKER} ${tag}`
}

/** Extract the creator tag from a description, or "—" if absent. */
function parseCreator(desc: string | undefined): string {
  const m = desc?.match(CREATOR_RE)
  return m ? m[1].trim() : '—'
}

/**
 * Resolved board metadata: names from config → concrete Trello ids. Resolved once
 * at startup (mirrors how the old Huly code resolved statuses/attributes by name),
 * so the rest of the code works with ids and never re-queries the board schema.
 */
export interface BoardRefs {
  boardId: string
  listTodo: string
  listDone: string
  listCancelled: string
  /** Label marking a card as an /offer (== approval "pending"). */
  offerLabelId: string
  /** Label marking an /offer as approved. */
  approvedLabelId: string
}

/**
 * Resolve list/label ids on the board by their configured names. Throws a single
 * actionable error listing everything missing (→ run trello:init).
 */
export async function resolveBoardRefs(client: TrelloClient, cfg: TrelloConfig): Promise<BoardRefs> {
  // The configured id may be a shortLink (from the board URL). GET endpoints accept it,
  // but write ops (idBoard/idMember) need the canonical 24-char id → resolve it once.
  const [board, lists, labels] = await Promise.all([
    client.get<{ id: string }>(`/boards/${cfg.trelloBoardId}`, { fields: 'id' }),
    client.get<TList[]>(`/boards/${cfg.trelloBoardId}/lists`, { fields: 'name', filter: 'open' }),
    client.get<TLabel[]>(`/boards/${cfg.trelloBoardId}/labels`, { fields: 'name', limit: 1000 }),
  ])

  const missing: string[] = []
  const eq = (a: string, b: string): boolean => a.trim() === b.trim()

  const findList = (name: string): string => {
    const l = lists.find((x) => eq(x.name, name))
    if (!l) missing.push(`колонка «${name}»`)
    return l?.id ?? ''
  }
  const findLabel = (name: string): string => {
    const l = labels.find((x) => eq(x.name, name))
    if (!l) missing.push(`метка «${name}»`)
    return l?.id ?? ''
  }

  const refs: BoardRefs = {
    boardId: board.id,
    listTodo: findList(cfg.listTodoName),
    listDone: findList(cfg.listDoneName),
    listCancelled: findList(cfg.listCancelledName),
    offerLabelId: findLabel(cfg.offerLabelName),
    approvedLabelId: findLabel(cfg.approvedLabelName),
  }

  if (missing.length > 0) {
    throw new Error(
      `На доске не хватает: ${missing.join('; ')}. Запусти «npm run trello:init» — он создаст недостающее.`,
    )
  }
  return refs
}

/** Authenticated Trello account (for the startup health line). */
export function getMe(client: TrelloClient): Promise<{ username: string; fullName: string }> {
  return client.get('/members/me', { fields: 'username,fullName' })
}

export interface CreatedCard {
  id: string
  shortLink: string
  idShort: number
  url: string
}

/** Create a card in a list. `desc` is the full description (creator line included). */
export async function createCard(
  client: TrelloClient,
  listId: string,
  name: string,
  desc = '',
): Promise<CreatedCard> {
  const card = await client.post<TCard>('/cards', undefined, { idList: listId, name, desc })
  return { id: card.id, shortLink: card.shortLink, idShort: card.idShort, url: card.url }
}

/** Add a label to a card. */
function addLabel(client: TrelloClient, cardId: string, labelId: string): Promise<unknown> {
  return client.post(`/cards/${cardId}/idLabels`, { value: labelId })
}

/** Mark a card as an /offer (adds the «Предложение» label → approval "pending"). */
export function markOffer(client: TrelloClient, refs: BoardRefs, cardId: string): Promise<unknown> {
  return addLabel(client, cardId, refs.offerLabelId)
}

/** Approve an /offer (adds the «Одобрено» label; the card stays in its active list). */
export function approveOffer(client: TrelloClient, refs: BoardRefs, cardId: string): Promise<unknown> {
  return addLabel(client, cardId, refs.approvedLabelId)
}

/** Move a card to another list (status change: → Готово / → Отменено). */
export function moveCard(client: TrelloClient, cardId: string, listId: string): Promise<unknown> {
  return client.put(`/cards/${cardId}`, { idList: listId })
}

/** Set the card's assignee to a single board member (replaces existing members). */
export function setAssignee(client: TrelloClient, cardId: string, memberId: string): Promise<unknown> {
  return client.put(`/cards/${cardId}`, { idMembers: memberId })
}

/** Add a plain-text comment to a card. */
export function addComment(client: TrelloClient, cardId: string, text: string): Promise<unknown> {
  return client.post(`/cards/${cardId}/actions/comments`, { text })
}

/**
 * Attach a downloaded file to a card. Trello comments can't carry attachments, so
 * /comment attachments land on the card itself (noted in the bot's reply).
 */
export async function attachFile(
  client: TrelloClient,
  cardId: string,
  file: DownloadedFile,
): Promise<void> {
  const form = new FormData()
  form.append('name', file.name)
  // Copy into a plain Uint8Array so the Blob part is a well-typed ArrayBufferView
  // regardless of whether the DOM lib is in scope (Buffer's backing buffer is loosely typed).
  form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.contentType }), file.name)
  await client.postForm(`/cards/${cardId}/attachments`, form)
}

export interface MemberInfo {
  id: string
  name: string
}

/** Board members that can be set as a card's assignee. */
export async function listMembers(
  client: TrelloClient,
  refs: BoardRefs,
  limit = 30,
): Promise<MemberInfo[]> {
  const members = await client.get<TMember[]>(`/boards/${refs.boardId}/members`, {
    fields: 'fullName,username',
  })
  return members
    .map((m) => ({ id: m.id, name: (m.fullName || `@${m.username}`).trim() }))
    .filter((m) => m.name.length > 0)
    .slice(0, limit)
}

export interface CardBrief {
  shortLink: string
  idShort: number
  name: string
}

/** Active cards (the "Задачи" list), most-recently-active first. For /comment and /complete. */
export async function listActiveCards(
  client: TrelloClient,
  refs: BoardRefs,
  limit = 20,
): Promise<CardBrief[]> {
  const cards = await client.get<TCard[]>(`/lists/${refs.listTodo}/cards`, {
    fields: 'name,idShort,shortLink,dateLastActivity',
  })
  return cards
    .sort((a, b) => (b.dateLastActivity ?? '').localeCompare(a.dateLastActivity ?? ''))
    .slice(0, limit)
    .map((c) => ({ shortLink: c.shortLink, idShort: c.idShort, name: c.name }))
}

export interface CardData {
  id: string
  shortLink: string
  idShort: number
  name: string
  url: string
  idList: string
  /** Joined display names of card members, or "—". */
  assigneeName: string
  /** Creator (Telegram @username) parsed from the description, or "—". */
  creatorText: string
  approval: Approval | null
  attachments: number
  done: boolean
  cancelled: boolean
}

/**
 * Re-read everything needed to render a card straight from Trello (by shortLink).
 * Keeps the card buttons STATELESS — any bot instance can handle a click and cards
 * survive restarts (the shortLink lives in the callback data, all state in Trello).
 */
export async function getCard(
  client: TrelloClient,
  refs: BoardRefs,
  shortLink: string,
): Promise<CardData | undefined> {
  let card: TCard
  try {
    card = await client.get<TCard>(`/cards/${shortLink}`, {
      fields: 'name,idShort,shortLink,url,idList,idMembers,idLabels,desc,badges',
      members: 'true',
      member_fields: 'fullName,username',
    })
  } catch (err) {
    if (err instanceof Error && /HTTP 404/.test(err.message)) return undefined
    throw err
  }

  const members = card.members ?? []
  const assigneeName = members.length
    ? members.map((m) => (m.fullName || `@${m.username}`).trim()).join(', ')
    : '—'

  const labels = card.idLabels ?? []
  const cancelled = card.idList === refs.listCancelled
  let approval: Approval | null = null
  if (labels.includes(refs.approvedLabelId)) approval = 'approved'
  else if (labels.includes(refs.offerLabelId)) approval = cancelled ? 'rejected' : 'pending'

  return {
    id: card.id,
    shortLink: card.shortLink,
    idShort: card.idShort,
    name: card.name,
    url: card.url,
    idList: card.idList,
    assigneeName,
    creatorText: parseCreator(card.desc),
    approval,
    attachments: card.badges?.attachments ?? 0,
    done: card.idList === refs.listDone,
    cancelled,
  }
}
