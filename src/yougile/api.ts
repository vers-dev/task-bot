import type { DownloadedFile } from '../telegram/media.js'
import type { YouGileClient } from './client.js'

// ── Light shapes of the YouGile objects we touch ──────────────────
export interface YGProject {
  id: string
  title: string
}
export interface YGBoard {
  id: string
  title: string
  projectId?: string
}
export interface YGColumn {
  id: string
  title: string
  boardId: string
}
export interface YGUser {
  id: string
  email?: string
  realName?: string
}
export interface YGTask {
  id: string
  title: string
  description?: string
  columnId: string
  archived?: boolean
  completed?: boolean
  deleted?: boolean
  assigned?: string[]
  /** { stickerId: stickerStateId } */
  stickers?: Record<string, string>
  idTaskCommon?: string | number
  idTaskProject?: string | number
}
export interface YGStickerState {
  id: string
  name: string
}
export interface YGSticker {
  id: string
  name: string
  states?: YGStickerState[]
}

/** List endpoints answer with `{ content, paging }`; be tolerant of a bare array. */
function unwrap<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[]
  const content = (res as { content?: unknown } | null)?.content
  return Array.isArray(content) ? (content as T[]) : []
}

const PAGE = 1000

export function listProjects(client: YouGileClient): Promise<YGProject[]> {
  return client.get<unknown>('/api-v2/projects', { limit: PAGE }).then(unwrap<YGProject>)
}

export function listBoards(client: YouGileClient): Promise<YGBoard[]> {
  return client.get<unknown>('/api-v2/boards', { limit: PAGE }).then(unwrap<YGBoard>)
}

export function listColumns(client: YouGileClient, boardId: string): Promise<YGColumn[]> {
  return client
    .get<unknown>('/api-v2/columns', { boardId, limit: PAGE })
    .then(unwrap<YGColumn>)
}

export function getColumn(client: YouGileClient, columnId: string): Promise<YGColumn> {
  return client.get<YGColumn>(`/api-v2/columns/${columnId}`)
}

export function createColumn(
  client: YouGileClient,
  boardId: string,
  title: string,
): Promise<{ id: string }> {
  return client.post<{ id: string }>('/api-v2/columns', { title, boardId })
}

export function listUsers(client: YouGileClient, projectId?: string): Promise<YGUser[]> {
  return client
    .get<unknown>('/api-v2/users', { limit: PAGE, projectId })
    .then(unwrap<YGUser>)
}

/** Text ("string") stickers are company-level objects; /offer approval is one of them. */
export function listStickers(client: YouGileClient, name?: string): Promise<YGSticker[]> {
  return client
    .get<unknown>('/api-v2/string-stickers', { limit: PAGE, name })
    .then(unwrap<YGSticker>)
}

export function createSticker(
  client: YouGileClient,
  name: string,
  states: string[],
): Promise<{ id: string }> {
  return client.post<{ id: string }>('/api-v2/string-stickers', {
    name,
    states: states.map((s) => ({ name: s })),
  })
}

/** Add a state to an existing sticker (used when the sticker exists but is short a state). */
export function createStickerState(
  client: YouGileClient,
  stickerId: string,
  name: string,
): Promise<{ id: string }> {
  return client.post<{ id: string }>(`/api-v2/string-stickers/${stickerId}/states`, { name })
}

export function createTask(
  client: YouGileClient,
  input: { title: string; columnId: string; description: string },
): Promise<{ id: string }> {
  return client.post<{ id: string }>('/api-v2/tasks', input)
}

export async function getTask(client: YouGileClient, id: string): Promise<YGTask | undefined> {
  try {
    return await client.get<YGTask>(`/api-v2/tasks/${id}`)
  } catch (err) {
    if (err instanceof Error && /HTTP 40[34]/.test(err.message)) return undefined
    throw err
  }
}

export function updateTask(
  client: YouGileClient,
  id: string,
  patch: Partial<Pick<YGTask, 'title' | 'description' | 'columnId' | 'completed' | 'archived' | 'assigned' | 'stickers'>>,
): Promise<unknown> {
  return client.put(`/api-v2/tasks/${id}`, patch)
}

/**
 * Tasks of a column, newest first. `/api-v2/task-list` is the current endpoint —
 * the GET on `/api-v2/tasks` is marked deprecated. There is no project filter in
 * the API, which is exactly why the bot lists per board (per chat's project).
 */
export function listTasks(
  client: YouGileClient,
  columnId: string,
  limit: number,
): Promise<YGTask[]> {
  return client
    .get<unknown>('/api-v2/task-list', { columnId, limit })
    .then(unwrap<YGTask>)
}

/** In YouGile a task's chat id equals the task id; comments are chat messages. */
export function sendMessage(
  client: YouGileClient,
  taskId: string,
  text: string,
  textHtml: string,
): Promise<unknown> {
  return client.post(`/api-v2/chats/${taskId}/messages`, { text, textHtml })
}

/** Upload a file and get back its URL (tasks have no attachment field). */
export async function uploadFile(
  client: YouGileClient,
  file: DownloadedFile,
): Promise<string> {
  const form = new FormData()
  // Copy into a plain Uint8Array so the Blob part is a well-typed ArrayBufferView
  // regardless of whether the DOM lib is in scope.
  form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.contentType }), file.name)
  const res = await client.postForm<unknown>('/api-v2/upload-file', form)
  const url = extractUrl(res)
  if (!url) {
    throw new Error(`YouGile upload-file вернул неожиданный ответ: ${JSON.stringify(res).slice(0, 200)}`)
  }
  return url
}

/**
 * The upload endpoint's response shape isn't pinned down in the public docs, so
 * accept the plausible variants: a bare URL string, or an object carrying it
 * under a handful of names.
 */
function extractUrl(res: unknown): string | undefined {
  if (typeof res === 'string' && res.startsWith('http')) return res
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>
    for (const key of ['url', 'link', 'fileUrl', 'href', 'path']) {
      const v = o[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
    if (o.content && typeof o.content === 'object') return extractUrl(o.content)
  }
  return undefined
}
