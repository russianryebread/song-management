export type SongAlias = { title: string; kind: 'alternate' | 'first-line' }
export const alphabet = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '…']
export function indexKey(title: string): string {
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '')
}
export function titleLetter(title: string): string {
  const first = indexKey(title).charAt(0).toUpperCase()
  return /^[A-Z]$/.test(first) ? first : /^\d$/.test(first) ? '#' : '…'
}
export function parseAliases(value: unknown): SongAlias[] | null {
  if (!Array.isArray(value) || value.length > 30) return null
  const aliases: SongAlias[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > 300 || !['alternate', 'first-line'].includes(item.kind)) return null
    const title = item.title.trim()
    const key = indexKey(title)
    if (!seen.has(key)) aliases.push({ title, kind: item.kind })
    seen.add(key)
  }
  return aliases
}
