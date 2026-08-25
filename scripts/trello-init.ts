/**
 * Idempotent board scaffolder. Creates everything the bot resolves by name:
 * three lists (Задачи / Готово / Отменено) and two labels (Предложение, Одобрено).
 *
 *   npm run trello:init
 *
 * Safe to re-run: it only creates what's missing and reports what already exists.
 * No Custom Fields — those are paywalled on Trello's free plan, so the bot models
 * the creator (card description) and approval (labels + «Отменено» column) for free.
 */
import { loadTrelloConfig } from '../src/config.js'
import { TrelloClient } from '../src/trello/client.js'

interface TList {
  id: string
  name: string
}
interface TLabel {
  id: string
  name: string
}

const eq = (a: string, b: string): boolean => a.trim() === b.trim()

async function main(): Promise<void> {
  const cfg = loadTrelloConfig()
  const client = new TrelloClient({
    apiKey: cfg.trelloApiKey,
    token: cfg.trelloToken,
    proxyUrl: cfg.trelloProxy,
  })

  const me = await client.get<{ username: string }>('/members/me', { fields: 'username' })
  // Write ops (idBoard) need the canonical 24-char id; the URL gives a shortLink.
  const board = (await client.get<{ id: string }>(`/boards/${cfg.trelloBoardId}`, { fields: 'id' })).id
  console.log(`Authenticated as @${me.username}. Board: ${cfg.trelloBoardId} (${board})\n`)

  // ── Lists ──────────────────────────────────────────────────────
  const lists = await client.get<TList[]>(`/boards/${board}/lists`, { fields: 'name', filter: 'open' })
  const ensureList = async (name: string): Promise<void> => {
    const found = lists.find((l) => eq(l.name, name))
    if (found) {
      console.log(`  ✓ колонка «${name}» уже есть (${found.id})`)
      return
    }
    const created = await client.post<TList>('/lists', undefined, { name, idBoard: board, pos: 'bottom' })
    console.log(`  + создана колонка «${name}» (${created.id})`)
  }
  console.log('Колонки:')
  await ensureList(cfg.listTodoName)
  await ensureList(cfg.listDoneName)
  await ensureList(cfg.listCancelledName)

  // ── Labels ─────────────────────────────────────────────────────
  const labels = await client.get<TLabel[]>(`/boards/${board}/labels`, { fields: 'name', limit: 1000 })
  const ensureLabel = async (name: string, color: string): Promise<void> => {
    const found = labels.find((l) => eq(l.name, name))
    if (found) {
      console.log(`  ✓ метка «${name}» уже есть (${found.id})`)
      return
    }
    const created = await client.post<TLabel>('/labels', undefined, { name, color, idBoard: board })
    console.log(`  + создана метка «${name}» (${created.id})`)
  }
  console.log('\nМетки:')
  await ensureLabel(cfg.offerLabelName, 'purple')
  await ensureLabel(cfg.approvedLabelName, 'green')

  // Category labels (Backend / Frontend / …) — distinct colours, cycled.
  const CATEGORY_COLORS = ['blue', 'sky', 'lime', 'orange', 'red', 'pink', 'black']
  if (cfg.categoryLabels.length > 0) {
    console.log('\nМетки-категории:')
    for (let i = 0; i < cfg.categoryLabels.length; i++) {
      await ensureLabel(cfg.categoryLabels[i], CATEGORY_COLORS[i % CATEGORY_COLORS.length])
    }
  }

  console.log('\n🎉 Доска готова. Проверь: npm run smoke')
}

main().catch((err) => {
  console.error('\n❌ trello:init failed:', err instanceof Error ? err.message : err)
  console.error('Подсказка: верны ли TRELLO_API_KEY / TRELLO_TOKEN / TRELLO_BOARD_ID?')
  process.exit(1)
})
