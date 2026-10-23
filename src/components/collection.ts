// Collection: the cards you actually bought, and how many of each.
//
// Unlike bookmarks this stores a SNAPSHOT (name, code, picture), not just a
// key into the index. You own the card whether or not Yuyu-tei still lists it
// next build, and Pokemon cards are not in the index at all - their picture is
// a photo you took, stored inline as a small JPEG data URL.
//
// Same storage as bookmarks (localStorage, per device), but a failed write is
// reported to the caller instead of swallowed: losing a bookmark is a shrug,
// losing a card you own is not.

export type Game = 'onepiece' | 'pokemon'

export interface Owned {
  /** keyOf(card) for index cards; generated for cards added by photo. */
  id: string
  game: Game
  name: string
  /** Card code if known, else ''. */
  code: string
  /** Image URL or data: URL, '' when there is no picture. */
  img: string
  qty: number
}

const KEY = 'tcgjp.collection.v1'

function isOwned(x: unknown): x is Owned {
  const o = x as Owned
  return (
    !!o &&
    typeof o.id === 'string' &&
    (o.game === 'onepiece' || o.game === 'pokemon') &&
    typeof o.name === 'string' &&
    typeof o.code === 'string' &&
    typeof o.img === 'string' &&
    Number.isInteger(o.qty) &&
    o.qty > 0
  )
}

export function readCollection(): Owned[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isOwned) : []
  } catch {
    return []
  }
}

/** false when the write failed (private mode, or storage full of photos). */
export function writeCollection(items: readonly Owned[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
    return true
  } catch {
    return false
  }
}

/** qty <= 0 removes the card; a card not yet owned is added at the top. */
export function withQty(items: readonly Owned[], item: Owned, qty: number): Owned[] {
  if (qty <= 0) return items.filter((x) => x.id !== item.id)
  if (!items.some((x) => x.id === item.id)) return [{ ...item, qty }, ...items]
  return items.map((x) => (x.id === item.id ? { ...x, qty } : x))
}

/** One row of data/pokemon.json (Yuyu-tei's Pokemon list, scripts/pull-pokemon.mjs). */
export interface PokeCard {
  id: string
  name: string
  code: string
  /** Set mark as printed on the card, e.g. "SV8a". */
  set: string
  rarity: string
  img: string
}

/** hay: lower-cased name, set, number and rarity. romaji: the name folded like matching.tsx does. */
export type Searchable = PokeCard & { hay: string; romaji: string }

/**
 * Every word must appear in hay ("sv8a 205", "ピカチュウ sar"). Failing that,
 * the whole query as folded romaji ("pikachu") is tried against the name -
 * best-effort, like the One Piece search.
 */
export function searchCards(cards: readonly Searchable[], query: string, romaji: string, limit = 60): Searchable[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const out: Searchable[] = []
  for (const c of cards) {
    if (words.every((w) => c.hay.includes(w)) || (romaji.length >= 3 && c.romaji.includes(romaji))) {
      out.push(c)
      if (out.length === limit) break
    }
  }
  return out
}
