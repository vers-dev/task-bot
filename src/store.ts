import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { MediaItem } from './telegram/media.js'

export type PendingKind = 'comment' | 'issue' | 'offer' | 'complete'

/**
 * A command whose execution is parked until the user picks something with a
 * button — the task for /comment, the board for /issue and /offer.
 */
export interface PendingOp {
  kind: PendingKind
  /**
   * Telegram identity of whoever typed the command. Captured up front so the
   * creator stays right even if somebody else presses the project button.
   */
  creator?: string
  /** /issue, /offer */
  title?: string
  description?: string
  /** /comment */
  text?: string
  media: MediaItem[]
}

export interface ChatBoard {
  boardId: string
  boardName: string
}

/** DDL, applied on every start (all statements are idempotent). */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pending_op (
     op_id      TEXT PRIMARY KEY,
     kind       TEXT NOT NULL,
     payload    TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS chat_board (
     chat_id    INTEGER PRIMARY KEY,
     board_id   TEXT NOT NULL,
     board_name TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Superseded by pending_op. Its rows lived ~10 minutes, so dropping it loses
  // nothing of value.
  'DROP TABLE IF EXISTS pending_comment',
]

/**
 * SQLite-backed persistence:
 *   - parked commands, so a selection survives a bot restart;
 *   - the board («проект») each chat posts to.
 *
 * Task cards themselves stay stateless — their state lives in the tracker and
 * the task ref travels in the callback data.
 */
export class Store {
  private readonly db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    for (const statement of SCHEMA) {
      this.db.prepare(statement).run()
    }
  }

  savePendingOp(opId: string, op: PendingOp): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO pending_op (op_id, kind, payload, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(opId, op.kind, JSON.stringify(op), Date.now())
  }

  /** Read and delete a parked command (one-shot). */
  takePendingOp(opId: string): PendingOp | undefined {
    const row = this.db.prepare('SELECT payload FROM pending_op WHERE op_id = ?').get(opId) as
      | { payload: string }
      | undefined
    if (!row) return undefined
    this.db.prepare('DELETE FROM pending_op WHERE op_id = ?').run(opId)
    return JSON.parse(row.payload) as PendingOp
  }

  /** Drop parked commands older than ttlMs. */
  gc(ttlMs: number): void {
    this.db.prepare('DELETE FROM pending_op WHERE created_at < ?').run(Date.now() - ttlMs)
  }

  getChatBoard(chatId: number): ChatBoard | undefined {
    const row = this.db
      .prepare('SELECT board_id, board_name FROM chat_board WHERE chat_id = ?')
      .get(chatId) as { board_id: string; board_name: string } | undefined
    return row ? { boardId: row.board_id, boardName: row.board_name } : undefined
  }

  setChatBoard(chatId: number, board: ChatBoard): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO chat_board (chat_id, board_id, board_name, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(chatId, board.boardId, board.boardName, Date.now())
  }

  close(): void {
    this.db.close()
  }
}
