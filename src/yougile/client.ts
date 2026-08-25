import { ProxyAgent, type Dispatcher } from 'undici'

/**
 * YouGile allows 50 requests per minute per company — 36× stricter than Trello's
 * 300 per 10 seconds. A sliding-window gate keeps the bot under it, and 429s are
 * retried rather than surfaced as an error in the chat.
 */
const RATE_LIMIT = 50
const RATE_WINDOW_MS = 60_000
const MAX_RETRIES = 3

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>

export interface YouGileClientOptions {
  baseUrl: string
  token: string
  proxyUrl?: string
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  form?: FormData
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Thin REST client over the YouGile API v2.
 *
 * Auth is a bearer token (issued once by `npm run yougile:auth`); the global
 * fetch is used so a single client covers proxying (undici ProxyAgent) and
 * multipart uploads, same as the Trello client.
 */
export class YouGileClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly dispatcher?: Dispatcher
  /** Timestamps of requests inside the current window. */
  private readonly hits: number[] = []
  /** Serialises slot accounting (not the requests themselves). */
  private gate: Promise<void> = Promise.resolve()

  constructor(opts: YouGileClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined
  }

  /** Take one slot in the sliding window, waiting if the window is full. */
  private async acquire(): Promise<void> {
    const previous = this.gate
    let release!: () => void
    this.gate = new Promise<void>((r) => (release = r))
    await previous
    try {
      for (;;) {
        const now = Date.now()
        while (this.hits.length > 0 && now - this.hits[0] >= RATE_WINDOW_MS) this.hits.shift()
        if (this.hits.length < RATE_LIMIT) {
          this.hits.push(now)
          return
        }
        const wait = RATE_WINDOW_MS - (now - this.hits[0]) + 50
        console.warn(`[yougile] rate limit reached, waiting ${Math.round(wait / 1000)}s`)
        await sleep(wait)
      }
    } finally {
      release()
    }
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path)
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }

    for (let attempt = 0; ; attempt++) {
      const init: FetchInit = { method, headers: { authorization: `Bearer ${this.token}` } }
      // `dispatcher` (proxy) is an undici extension on global fetch; the undici vs
      // undici-types Dispatcher copies differ structurally, so assign through a cast.
      if (this.dispatcher) (init as { dispatcher?: unknown }).dispatcher = this.dispatcher
      if (opts.form) {
        init.body = opts.form
      } else if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body)
        init.headers = { ...(init.headers as Record<string, string>), 'content-type': 'application/json' }
      }

      await this.acquire()
      const res = await fetch(url, init)

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'))
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1)
        console.warn(`[yougile] HTTP ${res.status} on ${method} ${path}, retry in ${wait}ms`)
        await sleep(wait)
        continue
      }

      const text = await res.text().catch(() => '')
      if (!res.ok) {
        throw new Error(`YouGile ${method} ${path} → HTTP ${res.status} ${describe(text)}`)
      }
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        return text as unknown as T
      }
    }
  }

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, { query })
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body })
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body })
  }

  /** Multipart POST (used for /api-v2/upload-file). */
  postForm<T>(path: string, form: FormData): Promise<T> {
    return this.request<T>('POST', path, { form })
  }
}

/** YouGile puts a human-readable reason in `error`; fall back to the raw body. */
function describe(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string }
    return parsed.error ?? parsed.message ?? body.slice(0, 300)
  } catch {
    return body.slice(0, 300)
  }
}
