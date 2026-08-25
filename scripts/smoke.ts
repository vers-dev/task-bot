/**
 * Smoke test: verify the Trello connection + core operations (incl. attachment,
 * creator-in-description, approval labels, comment, move) against YOUR board
 * before wiring up Telegram.
 *
 *   npm run smoke
 *
 * It authenticates, resolves the board schema, creates a throwaway card with a
 * tiny PNG attachment and a creator line, marks it as an offer + approves it,
 * comments, re-reads it, then archives the test card.
 */
import { loadTrelloConfig } from '../src/config.js'
import { TrelloClient } from '../src/trello/client.js'
import {
  addComment,
  approveOffer,
  attachFile,
  createCard,
  getCard,
  listActiveCards,
  markOffer,
  resolveBoardRefs,
  withCreator,
} from '../src/trello/cards.js'
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
  const cfg = loadTrelloConfig()
  const client = new TrelloClient({
    apiKey: cfg.trelloApiKey,
    token: cfg.trelloToken,
    proxyUrl: cfg.trelloProxy,
  })

  const me = await client.get<{ username: string; fullName: string }>('/members/me', {
    fields: 'username,fullName',
  })
  console.log(`✅ authenticated as @${me.username} (${me.fullName})`)

  const refs = await resolveBoardRefs(client, cfg)
  console.log(`✅ board schema resolved (todo=${refs.listTodo}, done=${refs.listDone})\n`)

  console.log('Creating test card (creator line + attachment)…')
  const created = await createCard(
    client,
    refs.listTodo,
    'Smoke test card (safe to delete)',
    withCreator('Created by the smoke test of task-bot.', '@smoke-test'),
  )
  await attachFile(client, created.id, sampleFile('smoke.png'))
  console.log(`✅ created #${created.idShort} (${created.shortLink})`)

  console.log('\nMarking as offer, then approving…')
  await markOffer(client, refs, created.id)
  await approveOffer(client, refs, created.id)
  console.log('✅ labels applied')

  console.log('\nAdding a comment…')
  await addComment(client, created.id, 'Smoke test comment 👋')
  console.log('✅ commented')

  console.log('\nRe-reading the card…')
  const d = await getCard(client, refs, created.shortLink)
  if (!d) throw new Error('getCard returned undefined for the just-created card')
  console.log(`✅ card: creator="${d.creatorText}", approval=${d.approval}, attachments=${d.attachments}`)
  if (d.creatorText !== '@smoke-test') throw new Error(`creator mismatch: ${d.creatorText}`)
  if (d.approval !== 'approved') throw new Error(`approval mismatch: ${d.approval}`)

  console.log('\nListing active cards (sanity)…')
  const active = await listActiveCards(client, refs, 5)
  console.log(`✅ listActiveCards returned ${active.length} card(s)`)

  console.log('\nArchiving the test card…')
  await client.put(`/cards/${created.id}`, { closed: 'true' })
  console.log('✅ archived')

  console.log('\n🎉 All Trello operations succeeded.')
}

main().catch((err) => {
  console.error('\n❌ Smoke test failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
