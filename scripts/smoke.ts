/**
 * Smoke test: verify the ACTIVE tracker (TRACKER=trello|yougile) end to end —
 * create, attach a file, mark as an offer, approve, comment, re-read, close.
 *
 *   npm run smoke            # first board the token sees
 *   npm run smoke "Разраб"   # board whose name contains that substring
 *
 * Everything runs against a REAL board and leaves one closed task behind
 * («Smoke test task (safe to delete)»).
 */
import { loadTrackerConfig } from '../src/config.js'
import { createTracker } from '../src/tracker/factory.js'
import type { DownloadedFile } from '../src/telegram/media.js'

// 1×1 transparent PNG.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const sampleFile = (name: string): DownloadedFile => ({
  buffer: PNG_1PX,
  name,
  contentType: 'image/png',
  size: PNG_1PX.length,
})

async function main(): Promise<void> {
  const cfg = loadTrackerConfig()
  const tracker = createTracker(cfg)
  await tracker.start()
  console.log(`✅ ${tracker.describe()}`)

  const needle = process.argv[2]?.trim().toLowerCase()
  const boards = await tracker.listBoards()
  const board = needle ? boards.find((b) => b.name.toLowerCase().includes(needle)) : boards[0]
  if (!board) throw new Error('Не нашёл доску для теста — проверь список: npm run init')

  const missing = await tracker.checkBoard(board.id)
  if (missing.length > 0) {
    throw new Error(`Доска «${board.name}» не готова: ${missing.join('; ')}. Запусти: npm run init "${board.name}"`)
  }
  console.log(`✅ доска «${board.name}» готова\n`)

  console.log('Создаю тестовую задачу-предложение (создатель + вложение)…')
  const task = await tracker.createTask({
    boardId: board.id,
    title: 'Smoke test task (safe to delete)',
    description: 'Created by the smoke test of task-bot.',
    creator: '@smoke-test',
    offer: true,
  })
  await tracker.attach(task, [sampleFile('smoke.png')], 'Вложение из smoke-теста')
  console.log(`✅ создана ${task.num || task.id}`)

  console.log('\nОдобряю предложение…')
  await tracker.approveOffer(task)
  console.log('✅ одобрено')

  console.log('\nДобавляю комментарий…')
  await tracker.comment(task, 'Smoke test comment 👋')
  console.log('✅ комментарий добавлен')

  console.log('\nПеречитываю задачу…')
  const fresh = await tracker.getTask(task.ref)
  if (!fresh) throw new Error('getTask вернул undefined для только что созданной задачи')
  console.log(
    `✅ creator="${fresh.creatorText}", approval=${fresh.approval}, attachments=${fresh.attachments ?? 'n/a'}`,
  )
  if (fresh.creatorText !== '@smoke-test') throw new Error(`creator mismatch: ${fresh.creatorText}`)
  if (fresh.approval !== 'approved') throw new Error(`approval mismatch: ${fresh.approval}`)

  console.log('\nСписок активных задач (sanity)…')
  const active = await tracker.listActive(board.id, 5)
  console.log(`✅ listActive вернул ${active.length} задач(и)`)

  console.log('\nНазначаю исполнителя…')
  const members = await tracker.listMembers(board.id, 5)
  if (members.length === 0) {
    console.log('⚠️  участников на доске нет — пропускаю')
  } else {
    await tracker.setAssignee(fresh, members[0].ref)
    const assigned = await tracker.getTask(task.ref)
    console.log(`✅ исполнитель: ${assigned?.assigneeName}`)
    if (assigned?.assigneeName === '—') throw new Error('исполнитель не назначился')
  }

  console.log('\nЗакрываю тестовую задачу…')
  await tracker.complete(fresh)
  const closed = await tracker.getTask(task.ref)
  if (!closed?.done) throw new Error('задача не перешла в «выполнено»')
  console.log('✅ закрыта')

  console.log(`\n🎉 Все операции ${tracker.kind} прошли успешно.`)
}

main().catch((err) => {
  console.error('\n❌ Smoke test failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
