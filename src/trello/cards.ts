import type { TrelloClient } from './client.js'
import type { StatusNames } from '../tracker/types.js'
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
export interface TMember {
  id: string
  fullName: string
  username: string
}
export interface TCard {
  id: string
  shortLink: string
  idShort: number
  name: string
  url: string
  idList: string
  idBoard: string
  desc?: string
  idMembers?: string[]
  idLabels?: string[]
  dateLastActivity?: string
  badges?: { attachments?: number }
  members?: TMember[]
}
export interface TBoard {
  id: string
  name: string
  closed?: boolean
  idOrganization?: string
}

/** Everything the bot resolves by name on a board. */
export interface TrelloNames {
  status: StatusNames
  /** Label marking a card as an /offer (== approval "pending"). */
  offerLabel: string
  /** Label marking an /offer as approved. */
  approvedLabel: string
}

/**
 * Resolved board metadata: names from config → concrete Trello ids. Resolved
 * lazily per board (the bot can post to any board the token sees) and cached by
 * the tracker, so the rest of the code works with ids and never re-queries the
 * board schema.
 */
export interface BoardRefs {
  boardId: string
  listTodo: string
  listDone: string
  listCancelled: string
  offerLabelId: string
  approvedLabelId: string
}

const eq = (a: string, b: string): boolean => a.trim() === b.trim()

interface BoardSchema {
  boardId: string
  lists: TList[]
  labels: TLabel[]
}

/**
 * Read a board's lists and labels in one go. The configured id may be a
 * shortLink (from the board URL) — GET endpoints accept it, but write ops
 * (idBoard/idMember) need the canonical 24-char id, so it is resolved here too.
 */
async function fetchSchema(client: TrelloClient, boardId: string): Promise<BoardSchema> {
  const [board, lists, labels] = await Promise.all([
    client.get<{ id: string }>(`/boards/${boardId}`, { fields: 'id' }),
    client.get<TList[]>(`/boards/${boardId}/lists`, { fields: 'name', filter: 'open' }),
    client.get<TLabel[]>(`/boards/${boardId}/labels`, { fields: 'name', limit: 1000 }),
  ])
  return { boardId: board.id, lists, labels }
}

/** Match the configured names against a board's schema. */
function pickRefs(schema: BoardSchema, names: TrelloNames): { refs: BoardRefs; missing: string[] } {
  const missing: string[] = []

  const findList = (name: string): string => {
    const l = schema.lists.find((x) => eq(x.name, name))
    if (!l) missing.push(`колонка «${name}»`)
    return l?.id ?? ''
  }
  const findLabel = (name: string): string => {
    const l = schema.labels.find((x) => eq(x.name, name))
    if (!l) missing.push(`метка «${name}»`)
    return l?.id ?? ''
  }

  const refs: BoardRefs = {
    boardId: schema.boardId,
    listTodo: findList(names.status.todo),
    listDone: findList(names.status.done),
    listCancelled: findList(names.status.cancelled),
    offerLabelId: findLabel(names.offerLabel),
    approvedLabelId: findLabel(names.approvedLabel),
  }
  return { refs, missing }
}

/** Resolve list/label ids on a board. Throws one actionable error if anything is missing. */
export async function resolveBoardRefs(
  client: TrelloClient,
  boardId: string,
  names: TrelloNames,
): Promise<BoardRefs> {
  const { refs, missing } = pickRefs(await fetchSchema(client, boardId), names)
  if (missing.length > 0) {
    throw new Error(`На доске не хватает: ${missing.join('; ')}.`)
  }
  return refs
}

/** What the board is missing; empty array means it is ready to use. */
export async function missingBoardParts(
  client: TrelloClient,
  boardId: string,
  names: TrelloNames,
): Promise<string[]> {
  return pickRefs(await fetchSchema(client, boardId), names).missing
}

/** Category labels get distinct colours, cycled. */
const CATEGORY_COLORS = ['blue', 'sky', 'lime', 'orange', 'red', 'pink', 'black']

/**
 * Idempotently create everything the bot resolves by name: three lists and the
 * two approval labels (plus optional category labels). Safe to re-run.
 * Reports what it created, so the CLI scaffolder can just print the lines.
 */
export async function setupBoard(
  client: TrelloClient,
  boardId: string,
  names: TrelloNames,
  categoryLabels: string[] = [],
): Promise<string[]> {
  const schema = await fetchSchema(client, boardId)
  const log: string[] = []

  const ensureList = async (name: string): Promise<void> => {
    const found = schema.lists.find((l) => eq(l.name, name))
    if (found) {
      log.push(`  ✓ колонка «${name}» уже есть (${found.id})`)
      return
    }
    const created = await client.post<TList>('/lists', undefined, {
      name,
      idBoard: schema.boardId,
      pos: 'bottom',
    })
    schema.lists.push(created)
    log.push(`  + создана колонка «${name}» (${created.id})`)
  }

  const ensureLabel = async (name: string, color: string): Promise<void> => {
    const found = schema.labels.find((l) => eq(l.name, name))
    if (found) {
      log.push(`  ✓ метка «${name}» уже есть (${found.id})`)
      return
    }
    const created = await client.post<TLabel>('/labels', undefined, {
      name,
      color,
      idBoard: schema.boardId,
    })
    schema.labels.push(created)
    log.push(`  + создана метка «${name}» (${created.id})`)
  }

  await ensureList(names.status.todo)
  await ensureList(names.status.done)
  await ensureList(names.status.cancelled)
  await ensureLabel(names.offerLabel, 'purple')
  await ensureLabel(names.approvedLabel, 'green')
  for (let i = 0; i < categoryLabels.length; i++) {
    await ensureLabel(categoryLabels[i], CATEGORY_COLORS[i % CATEGORY_COLORS.length])
  }

  return log
}

/** Open boards visible to the token, plus the workspace names to group them by. */
export async function listBoards(
  client: TrelloClient,
): Promise<{ boards: TBoard[]; orgs: Map<string, string> }> {
  const [boards, orgs] = await Promise.all([
    client.get<TBoard[]>('/members/me/boards', {
      fields: 'name,closed,idOrganization',
      filter: 'open',
    }),
    client
      .get<{ id: string; displayName: string }[]>('/members/me/organizations', {
        fields: 'displayName',
      })
      .catch(() => []),
  ])
  return {
    boards: boards.filter((b) => !b.closed),
    orgs: new Map(orgs.map((o) => [o.id, o.displayName])),
  }
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

/** Board members that can be set as a card's assignee. */
export async function listMembers(
  client: TrelloClient,
  boardId: string,
  limit = 30,
): Promise<TMember[]> {
  const members = await client.get<TMember[]>(`/boards/${boardId}/members`, {
    fields: 'fullName,username',
  })
  return members.slice(0, limit)
}

/** Cards in a list, most-recently-active first. For /comment and /complete. */
export async function listActiveCards(
  client: TrelloClient,
  listId: string,
  limit = 20,
): Promise<TCard[]> {
  const cards = await client.get<TCard[]>(`/lists/${listId}/cards`, {
    fields: 'name,idShort,shortLink,dateLastActivity',
  })
  return cards
    .sort((a, b) => (b.dateLastActivity ?? '').localeCompare(a.dateLastActivity ?? ''))
    .slice(0, limit)
}

/**
 * Read a card by shortLink, with the fields needed to render it. Returns
 * undefined for a deleted/unknown card. `idBoard` comes back too — the tracker
 * needs it to resolve which board's lists and labels this card belongs to.
 */
export async function fetchCard(
  client: TrelloClient,
  shortLink: string,
): Promise<TCard | undefined> {
  try {
    return await client.get<TCard>(`/cards/${shortLink}`, {
      fields: 'name,idShort,shortLink,url,idList,idBoard,idMembers,idLabels,desc,badges',
      members: 'true',
      member_fields: 'fullName,username',
    })
  } catch (err) {
    if (err instanceof Error && /HTTP 404/.test(err.message)) return undefined
    throw err
  }
}
