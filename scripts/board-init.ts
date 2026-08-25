/**
 * Idempotent board scaffolder for the ACTIVE tracker (TRACKER=trello|yougile).
 *
 *   npm run init            # print the boards the token can see
 *   npm run init "Разраб"   # prepare the first board matching that substring
 *
 * Creates whatever the bot resolves by name — the three status columns, plus
 * Trello's approval labels or YouGile's «Одобрение» sticker. Safe to re-run.
 * The bot can do the same thing on its own, via the «➕ Создать» button.
 */
import { loadTrackerConfig } from '../src/config.js'
import { createTracker } from '../src/tracker/factory.js'

async function main(): Promise<void> {
  const cfg = loadTrackerConfig()
  const tracker = createTracker(cfg)
  await tracker.start()
  console.log(`✅ ${tracker.describe()}\n`)

  const boards = await tracker.listBoards()
  if (boards.length === 0) {
    throw new Error('Трекер не отдал ни одной доски — проверь права токена.')
  }

  const needle = process.argv[2]?.trim().toLowerCase()
  if (!needle) {
    console.log('Доступные доски (передай часть имени, чтобы подготовить одну):')
    for (const b of boards) {
      console.log(`  • ${b.group ? `${b.group} / ` : ''}${b.name}   [${b.id}]`)
    }
    return
  }

  const board = boards.find((b) => b.name.toLowerCase().includes(needle))
  if (!board) {
    throw new Error(`Доска с «${needle}» в имени не найдена. Запусти без аргумента, чтобы увидеть список.`)
  }

  console.log(`Готовлю «${board.name}»…`)
  const missingBefore = await tracker.checkBoard(board.id)
  if (missingBefore.length === 0) {
    console.log('  ✓ всё на месте, создавать нечего')
  } else {
    console.log(`  не хватает: ${missingBefore.join('; ')}`)
    await tracker.setupBoard(board.id)
    const missingAfter = await tracker.checkBoard(board.id)
    if (missingAfter.length > 0) {
      throw new Error(`После настройки всё ещё не хватает: ${missingAfter.join('; ')}`)
    }
    console.log('  + создано')
  }

  console.log('\n🎉 Доска готова. Проверь: npm run smoke')
}

main().catch((err) => {
  console.error('\n❌ init failed:', err instanceof Error ? err.message : err)
  console.error('Подсказка: верны ли TRACKER и токен активного трекера?')
  process.exit(1)
})
