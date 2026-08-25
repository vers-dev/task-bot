import { ProxyAgent, type Dispatcher } from 'undici'

const BASE = 'https://api.trello.com/1'

// Node's global fetch (undici-backed). We use it rather than undici's *imported* fetch
// because the global one serialises a global FormData/Blob body correctly — Trello's
// attachment endpoint rejects the multipart otherwise — while still honouring the
// non-standard `dispatcher` option for proxying.
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>

export interface TrelloClientOptions {
  apiKey: string
  token: string
  /** Optional HTTP/HTTPS proxy for reaching api.trello.com (blocked regions). */
  proxyUrl?: string
}

interface RequestOptions {
  /** Extra query params (key/token are added automatically). */
  query?: Record<string, string | number | boolean | undefined>
  /** JSON body (sent as application/json). Mutually exclusive with `form`. */
  body?: unknown
  /** Multipart body (for attachments). Mutually exclusive with `body`. */
  form?: FormData
}

/**
 * Thin REST client over the Trello API (https://api.trello.com/1).
 *
 * Trello is stateless HTTP — no persistent connection, unlike the old Huly
 * WebSocket client. Auth is `key` + `token` on every request (query params).
 * `undici` is used so a single client covers both proxying (ProxyAgent) and
 * multipart uploads (FormData) without the node-fetch/agent gymnastics the
 * Telegram side needs.
 */
export class TrelloClient {
  private readonly apiKey: string
  private readonly token: string
  private readonly dispatcher?: Dispatcher

  constructor(opts: TrelloClientOptions) {
    this.apiKey = opts.apiKey
    this.token = opts.token
    this.dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(BASE + path)
    url.searchParams.set('key', this.apiKey)
    url.searchParams.set('token', this.token)
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }

    const init: FetchInit = { method }
    // `dispatcher` (proxy) is an undici extension on global fetch; the undici vs
    // undici-types Dispatcher copies differ structurally, so assign through a cast.
    if (this.dispatcher) (init as { dispatcher?: unknown }).dispatcher = this.dispatcher
    if (opts.form) {
      init.body = opts.form
    } else if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body)
      init.headers = { 'content-type': 'application/json' }
    }

    const res = await fetch(url, init)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Trello ${method} ${path} → HTTP ${res.status} ${text.slice(0, 300)}`)
    }
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      return (await res.json()) as T
    }
    return (await res.text()) as unknown as T
  }

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, { query })
  }

  post<T>(path: string, query?: RequestOptions['query'], body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { query, body })
  }

  put<T>(path: string, query?: RequestOptions['query'], body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { query, body })
  }

  delete<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('DELETE', path, { query })
  }

  /** Multipart POST (used for card attachments). */
  postForm<T>(path: string, form: FormData, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('POST', path, { query, form })
  }
}
