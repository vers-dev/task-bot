/** A media file referenced in a Telegram message (not yet downloaded). */
export interface MediaItem {
  fileId: string
  kind: 'photo' | 'video' | 'animation' | 'document'
  name: string
  mime: string
  size?: number
}

/** A downloaded file ready to be attached to a Trello card. */
export interface DownloadedFile {
  buffer: Buffer
  name: string
  contentType: string
  size: number
}

/**
 * Extract the (single) media item from a Telegram message, if any.
 * A Telegram message carries at most one media type; animations also expose a
 * `document`, so animation is checked first to avoid a duplicate.
 */
export function extractMedia(msg: any): MediaItem | undefined {
  if (Array.isArray(msg?.photo) && msg.photo.length > 0) {
    const p = msg.photo[msg.photo.length - 1] // largest size
    return { fileId: p.file_id, kind: 'photo', name: `photo_${p.file_unique_id}.jpg`, mime: 'image/jpeg', size: p.file_size }
  }
  if (msg?.video) {
    const v = msg.video
    return {
      fileId: v.file_id,
      kind: 'video',
      name: v.file_name ?? `video_${v.file_unique_id}.mp4`,
      mime: v.mime_type ?? 'video/mp4',
      size: v.file_size,
    }
  }
  if (msg?.animation) {
    const a = msg.animation
    return {
      fileId: a.file_id,
      kind: 'animation',
      name: a.file_name ?? `animation_${a.file_unique_id}.mp4`,
      mime: a.mime_type ?? 'video/mp4',
      size: a.file_size,
    }
  }
  if (msg?.document) {
    const d = msg.document
    return {
      fileId: d.file_id,
      kind: 'document',
      name: d.file_name ?? `file_${d.file_unique_id}`,
      mime: d.mime_type ?? 'application/octet-stream',
      size: d.file_size,
    }
  }
  return undefined
}

/**
 * Download a media item's bytes via the Telegram Bot API into a Buffer.
 * `fetchImpl` (the bot's proxy fetch) routes the download through a proxy when
 * api.telegram.org is not directly reachable; falls back to the global fetch.
 */
export async function downloadMedia(
  api: { getFile: (fileId: string) => Promise<{ file_path?: string }> },
  botToken: string,
  item: MediaItem,
  fetchImpl?: typeof fetch,
): Promise<DownloadedFile> {
  const file = await api.getFile(item.fileId)
  if (!file.file_path) {
    throw new Error(`Не удалось получить путь файла ${item.name}`)
  }
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`
  const res = await (fetchImpl ?? fetch)(url)
  if (!res.ok) {
    throw new Error(`Не удалось скачать ${item.name} (HTTP ${res.status})`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  return { buffer, name: item.name, contentType: item.mime, size: item.size ?? buffer.length }
}
