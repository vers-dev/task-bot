/**
 * Issue a YouGile API key.
 *
 *   YOUGILE_LOGIN=you@example.com YOUGILE_PASSWORD=… npm run yougile:auth
 *
 * Two steps, per the YouGile docs: login/password → companyId, then
 * login/password/companyId → key. The key never expires (max 30 per account),
 * so this is a one-off. Credentials are read from the environment, used for
 * these two calls and never written anywhere.
 */
import { ProxyAgent } from 'undici'
import { loadTrackerConfig } from '../src/config.js'

interface Company {
  id: string
  name?: string
  title?: string
}

async function main(): Promise<void> {
  // TRACKER may still be "trello" while setting YouGile up — read the base URL
  // and proxy without demanding a key that doesn't exist yet.
  const { yougile } = loadTrackerConfig()
  const login = required('YOUGILE_LOGIN')
  const password = required('YOUGILE_PASSWORD')
  const dispatcher = yougile.proxyUrl ? new ProxyAgent(yougile.proxyUrl) : undefined

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const init: Record<string, unknown> = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
    if (dispatcher) init.dispatcher = dispatcher
    const res = await fetch(yougile.baseUrl + path, init as RequestInit)
    const text = await res.text()
    if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status} ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : undefined) as T
  }

  console.log(`Логинюсь на ${yougile.baseUrl}…`)
  const raw = await post<unknown>('/api-v2/auth/companies', { login, password })
  const companies = (Array.isArray(raw) ? raw : ((raw as { content?: Company[] })?.content ?? [])) as Company[]
  if (companies.length === 0) throw new Error('Аккаунт не состоит ни в одной компании')

  const wanted = process.env.YOUGILE_COMPANY_ID?.trim()
  const company = wanted ? companies.find((c) => c.id === wanted) : companies[0]
  if (!company) throw new Error(`Компания ${wanted} не найдена`)
  if (!wanted && companies.length > 1) {
    console.log('\nКомпаний несколько — беру первую. Чтобы выбрать другую, задай YOUGILE_COMPANY_ID:')
    for (const c of companies) console.log(`  • ${c.name ?? c.title ?? '—'}   [${c.id}]`)
    console.log('')
  }
  console.log(`✅ компания: ${company.name ?? company.title ?? company.id} (${company.id})`)

  const key = await post<{ key?: string }>('/api-v2/auth/keys', {
    login,
    password,
    companyId: company.id,
  })
  if (!key?.key) throw new Error(`Ключ не пришёл: ${JSON.stringify(key).slice(0, 200)}`)

  console.log('\n🎉 Ключ выпущен. Впиши в .env:\n')
  console.log('TRACKER=yougile')
  console.log(`YOUGILE_BASE_URL=${yougile.baseUrl}`)
  console.log(`YOUGILE_TOKEN=${key.key}`)
  console.log('\nДальше: npm run init   # посмотреть доски и подготовить нужную')
}

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Не задан ${key} (передай его в окружении, а не в .env, чтобы не хранить пароль)`)
  return value
}

main().catch((err) => {
  console.error('\n❌ yougile:auth failed:', err instanceof Error ? err.message : err)
  console.error('Подсказка: проверь YOUGILE_BASE_URL (ru.yougile.com или yougile.com) и учётные данные.')
  process.exit(1)
})
