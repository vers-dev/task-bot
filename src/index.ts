import { createServer, type Server } from 'node:http'
import { webhookCallback } from 'grammy'
import { loadConfig } from './config.js'
import { TrelloClient } from './trello/client.js'
import { getMe, resolveBoardRefs } from './trello/cards.js'
import { createBot } from './bot.js'
import { Store } from './store.js'

async function main(): Promise<void> {
  const cfg = loadConfig()

  console.log(`[bot] instance: ${cfg.botInstance} (pid ${process.pid})`)
  console.log(`[bot] build: ${process.env.BUILD_SHA ?? 'dev'}`)

  const client = new TrelloClient({
    apiKey: cfg.trelloApiKey,
    token: cfg.trelloToken,
    proxyUrl: cfg.trelloProxy,
  })
  const me = await getMe(client)
  console.log(`[trello] authenticated as @${me.username} (${me.fullName})`)
  const refs = await resolveBoardRefs(client, cfg)
  console.log(`[trello] board ${cfg.trelloBoardId} resolved ✅ (lists/fields/label OK)`)

  const store = new Store(cfg.dbPath)
  console.log(`[db] sqlite at ${cfg.dbPath}`)

  const bot = createBot(cfg, client, refs, store)

  let server: Server | undefined

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[${signal}] shutting down…`)
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    await bot.stop().catch(() => {})
    store.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))

  if (cfg.webhookUrl) {
    // ── Webhook mode ──────────────────────────────────────────────
    // Telegram POSTs updates to us (no long polling, so no flaky getUpdates
    // through the proxy). Outgoing calls (replies, cards, pin) still go to
    // api.telegram.org via bot.api — i.e. still through the proxy.
    await bot.init()
    await bot.api.setWebhook(cfg.webhookUrl, {
      secret_token: cfg.webhookSecret,
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query'],
    })
    const handle = webhookCallback(bot, 'http', { secretToken: cfg.webhookSecret })
    server = createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('task-bot ok')
        return
      }
      void Promise.resolve(handle(req, res)).catch((err) => {
        console.error('[webhook] handler error:', err)
        if (!res.headersSent) {
          res.writeHead(500)
          res.end()
        }
      })
    })
    // Bind explicitly to 0.0.0.0 (IPv4). Node's default (`::`) isn't reachable via
    // Docker's IPv4 port publish (`127.0.0.1:8090:8090`) → docker-proxy resets the
    // connection → nginx 502. Forcing IPv4 makes the published port work.
    server.listen(cfg.webhookPort, '0.0.0.0', () => {
      console.log(`[bot] webhook mode on :${cfg.webhookPort} → ${cfg.webhookUrl}`)
      console.log(`[bot] running as @${bot.botInfo.username} 🤖`)
    })
  } else {
    // ── Long polling (default) ────────────────────────────────────
    // Drop any leftover webhook registration so getUpdates is allowed.
    await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {})
    console.log('[bot] starting (long polling)…')
    await bot.start({
      onStart: (info) => console.log(`[bot] running as @${info.username} 🤖`),
    })
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
