/**
 * YouGile stores task descriptions and chat messages as HTML, while everything
 * arriving from Telegram is plain text. These helpers convert both ways so the
 * creator line survives a round trip and user text can't inject markup.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/** Plain text → HTML, preserving line breaks. */
export function textToHtml(text: string): string {
  if (!text) return ''
  return escapeHtml(text).replace(/\r?\n/g, '<br>')
}

/**
 * HTML → plain text. Block-level tags become newlines so a description written
 * in the YouGile UI still parses (the creator line has to sit on its own line).
 */
export function htmlToText(html: string | undefined): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const IMAGE_RE = /^image\//i

/** One chat message carrying a whole album: images inline, everything else as links. */
export function attachmentsHtml(
  files: { name: string; contentType: string; url: string }[],
  caption = '',
): string {
  const parts: string[] = []
  if (caption.trim()) parts.push(textToHtml(caption.trim()))
  for (const f of files) {
    parts.push(
      IMAGE_RE.test(f.contentType)
        ? `<img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.name)}">`
        : `<a href="${escapeHtml(f.url)}">📎 ${escapeHtml(f.name)}</a>`,
    )
  }
  return parts.join('<br>')
}
