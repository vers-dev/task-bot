import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { MediaItem } from './telegram/media.js'

export interface PendingComment {
  text: string
  media: MediaItem[]
}

/**
 * SQLite-backed persistence. Currently holds the pending /comment payload
 * (text + attachments) so the selection survives a bot restart. The issue card
 * and /complete are stateless (state lives in Trello / the callback data).
 */
export class Store {
  private readonly db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_comment (
        op_id      TEXT PRIMARY KEY,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
  }

  savePendingComment(opId: string, payload: PendingComment): void {
    this.db
      .prepare('INSERT OR REPLACE INTO pending_comment (op_id, payload, created_at) VALUES (?, ?, ?)')
      .run(opId, JSON.stringify(payload), Date.now())
  }

  /** Read and delete the pending comment (one-shot). */
  takePendingComment(opId: string): PendingComment | undefined {
    const row = this.db.prepare('SELECT payload FROM pending_comment WHERE op_id = ?').get(opId) as
      | { payload: string }
      | undefined
    if (!row) return undefined
    this.db.prepare('DELETE FROM pending_comment WHERE op_id = ?').run(opId)
    return JSON.parse(row.payload) as PendingComment
  }

  /** Drop pending comments older than ttlMs. */
  gc(ttlMs: number): void {
    this.db.prepare('DELETE FROM pending_comment WHERE created_at < ?').run(Date.now() - ttlMs)
  }

  close(): void {
    this.db.close()
  }
}
