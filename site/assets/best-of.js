/**
 * Best-of collection helpers — browser and Node safe.
 */

export const BEST_OF_KINDS = new Set(['artist', 'event', 'mixed'])

/** Drop malformed collections/items and make counts authoritative. */
export function normalizeBestOf(raw) {
  const source = Array.isArray(raw?.collections) ? raw.collections : []
  const ids = new Set()
  const collections = []

  for (const [index, candidate] of source.entries()) {
    if (!candidate || typeof candidate !== 'object') continue
    const items = Array.isArray(candidate.items)
      ? candidate.items.filter((item) => item && typeof item.src === 'string' && item.src)
      : []
    if (!items.length) continue

    let id = String(candidate.id || candidate.name || `collection-${index + 1}`)
    while (ids.has(id)) id = `${id}-${index + 1}`
    ids.add(id)

    collections.push({
      ...candidate,
      id,
      name: String(candidate.name || id),
      kind: BEST_OF_KINDS.has(candidate.kind) ? candidate.kind : 'mixed',
      artist: candidate.artist ? String(candidate.artist) : null,
      event: candidate.event ? String(candidate.event) : null,
      count: items.length,
      items
    })
  }

  if (!collections.length) return null

  return {
    collections,
    count: collections.reduce((total, collection) => total + collection.count, 0)
  }
}

/**
 * Infer whether a curated folder is an artist, event or mixed collection.
 * Explicit metadata wins; exact folder matches come next.
 */
export function inferBestOfKind({
  folderName = '',
  metaKind = null,
  artists = [],
  events = [],
  knownArtists = [],
  knownEvents = []
} = {}) {
  if (BEST_OF_KINDS.has(metaKind)) return metaKind

  const lower = String(folderName).toLowerCase()
  const matchedArtist = [...knownArtists, ...artists]
    .find((name) => String(name).toLowerCase() === lower)
  const matchedEvent = [...knownEvents, ...events]
    .find((name) => String(name).toLowerCase() === lower)

  if (matchedArtist) return 'artist'
  if (matchedEvent) return 'event'
  if (events.length === 1 && artists.length > 1) return 'event'
  if (artists.length === 1 && events.length > 1) return 'artist'
  if (events.length === 1) return 'event'
  if (artists.length === 1) return 'artist'
  return 'mixed'
}
