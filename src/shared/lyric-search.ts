export type SearchSource = { name: string; base_url: string; enabled: number }
export function host(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null
    return url.hostname.replace(/^www\./, '').toLowerCase()
  } catch { return null }
}
function words(value: string) { return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() }
export function searchCandidates(title: string, results: Array<{ title: string; url: string }>, source: SearchSource) {
  const wanted = words(title)
  const seen = new Set<string>()
  return results.flatMap(result => {
    if (!source.enabled || !host(source.base_url) || host(result.url) !== host(source.base_url)) return []
    const url = new URL(result.url); url.hash = ''
    if (seen.has(url.href)) return []
    seen.add(url.href)
    const label = result.title.replace(/<[^>]*>/g, '')
    const normalized = words(label.replace(/^hymn:\s*/i, '').replace(/\s+[-|–—]\s+.*$/, ''))
    const wantedWords = wanted.split(' ').filter(Boolean)
    const overlap = wantedWords.filter(word => normalized.split(' ').includes(word)).length / Math.max(1, wantedWords.length)
    if (!wanted || overlap < 0.7) return []
    return [{ id: url.href, sourceUrl: url.href, title: label, sourceName: source.name, available: true, exact: normalized === wanted, score: normalized === wanted ? 2 : overlap }]
  }).sort((a, b) => b.score - a.score)
}

/** Direct search adapters use each site's public song search. */
export function directSearchUrl(title: string, source: SearchSource): string | null {
  switch (host(source.base_url)) {
    case 'hymnal.net': return `https://www.hymnal.net/en/search/all/all/${encodeURIComponent(title)}`
    case 'hymnary.org': return `https://hymnary.org/search?qu=${encodeURIComponent(`textName:"${title.replace(/"/g, ' ')}" in:texts`)}`
    default: return null
  }
}
function decodeText(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
    const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
  }).replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()
}
export function directSearchResults(html: string, baseUrl: string) {
  if (/bunny-shield|challenge-form|cf-chl-|Establishing a secure connection/i.test(html)) {
    throw new Error('The site requires a browser check')
  }
  const results: Array<{ title: string; url: string }> = []
  for (const anchor of html.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decodeText(anchor[2]), baseUrl)
      if (!/^\/(?:en\/hymn\/|text\/|hymn\/)/.test(url.pathname)) continue
      // Hymnal.net includes the hymn number and category in badges inside the link.
      const title = decodeText(anchor[3].replace(/<span\b[^>]*class=["'][^"']*\blabel\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, ''))
      if (title) results.push({ title, url: url.href })
    } catch { /* Ignore malformed links. */ }
  }
  return results
}
