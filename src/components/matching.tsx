// Local search over the whole index. No network, no fuzzy library.
//
// The fastest path in a shop is the card code printed on the card: the user
// reads "OP09-119". So the code is matched four ways, from strict to loose:
//   1. exact          "OP09-119" / "op09119"
//   2. code prefix    "OP09"
//   3. digits         "09119", "09-119", or even "119"
//   4. zero-stripped  "OP9-119" (people drop the leading zero)
// Japanese name matching is a plain substring. Romaji is a best-effort extra
// channel - it never outranks a code hit.

import type { Card } from '../lib/types'

export interface SearchEntry {
  card: Card
  i: number
  /** "OP09119" - empty for DON!! rows, whose code is literally "-". */
  code: string
  /** "OP09". null for DON!! rows. */
  set: string | null
  /** "09119" */
  digits: string
  /** "OP9119" - each digit run stripped of leading zeros */
  loose: string
  name: string
  romaji: string
}

export function normCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '')
}

function stripLeadingZeros(s: string): string {
  return s.replace(/\d+/g, (run) => {
    const t = run.replace(/^0+/, '')
    return t === '' ? '0' : t
  })
}

// ------------------------------------------------------------------ romaji

const KANA: Record<string, string> = {
  'ア': 'a', 'イ': 'i', 'ウ': 'u', 'エ': 'e', 'オ': 'o',
  'カ': 'ka', 'キ': 'ki', 'ク': 'ku', 'ケ': 'ke', 'コ': 'ko',
  'ガ': 'ga', 'ギ': 'gi', 'グ': 'gu', 'ゲ': 'ge', 'ゴ': 'go',
  'サ': 'sa', 'シ': 'shi', 'ス': 'su', 'セ': 'se', 'ソ': 'so',
  'ザ': 'za', 'ジ': 'ji', 'ズ': 'zu', 'ゼ': 'ze', 'ゾ': 'zo',
  'タ': 'ta', 'チ': 'chi', 'ツ': 'tsu', 'テ': 'te', 'ト': 'to',
  'ダ': 'da', 'ヂ': 'ji', 'ヅ': 'zu', 'デ': 'de', 'ド': 'do',
  'ナ': 'na', 'ニ': 'ni', 'ヌ': 'nu', 'ネ': 'ne', 'ノ': 'no',
  'ハ': 'ha', 'ヒ': 'hi', 'フ': 'fu', 'ヘ': 'he', 'ホ': 'ho',
  'バ': 'ba', 'ビ': 'bi', 'ブ': 'bu', 'ベ': 'be', 'ボ': 'bo',
  'パ': 'pa', 'ピ': 'pi', 'プ': 'pu', 'ペ': 'pe', 'ポ': 'po',
  'マ': 'ma', 'ミ': 'mi', 'ム': 'mu', 'メ': 'me', 'モ': 'mo',
  'ヤ': 'ya', 'ユ': 'yu', 'ヨ': 'yo',
  'ラ': 'ra', 'リ': 'ri', 'ル': 'ru', 'レ': 're', 'ロ': 'ro',
  'ワ': 'wa', 'ヰ': 'i', 'ヱ': 'e', 'ヲ': 'o', 'ン': 'n',
  'ヴ': 'vu',
}

const SMALL_Y: Record<string, string> = { 'ャ': 'ya', 'ュ': 'yu', 'ョ': 'yo' }
const SMALL_V: Record<string, string> = {
  'ァ': 'a', 'ィ': 'i', 'ゥ': 'u', 'ェ': 'e', 'ォ': 'o',
}

/** Hiragana -> katakana, so one table covers both. */
function toKatakana(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    out += c >= 0x3041 && c <= 0x3096 ? String.fromCodePoint(c + 0x60) : ch
  }
  return out
}

export function kanaToRomaji(input: string): string {
  const s = toKatakana(input)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch === 'ー' || ch === 'ッ') continue // long vowel mark, sokuon
    const base = KANA[ch]
    if (!base) {
      out += /[A-Za-z0-9]/.test(ch) ? ch : ' '
      continue
    }
    const next = s[i + 1]
    if (next && SMALL_Y[next] && base.endsWith('i') && base !== 'i') {
      const stem = base.slice(0, -1)
      const y = SMALL_Y[next]!
      out += /(?:sh|ch|j)$/.test(stem) ? stem + y.slice(1) : stem + y
      i++
      continue
    }
    if (next && SMALL_V[next] && base.length > 1) {
      out += base.slice(0, -1) + SMALL_V[next]
      i++
      continue
    }
    out += base
  }
  return out
}

/**
 * Collapses the differences between a transliteration and how a European
 * actually spells a One Piece name: l/r, doubled letters, dropped vowels.
 * "luffy" and kana "ルフィ" (rufi) both fold to "rfi";
 * "shanks" and "shankusu" both fold to "shanks".
 */
export function foldRomaji(input: string): string {
  let s = input.toLowerCase().replace(/[^a-z0-9]/g, '')
  s = s.replace(/l/g, 'r').replace(/v/g, 'b').replace(/c(?=[^h])/g, 'k')
  s = s.replace(/([a-z])\1+/g, '$1')
  // Japanese echo vowels that English spelling drops.
  let prev = ''
  while (prev !== s) {
    prev = s
    s = s.replace(/([kstnhfmrgzdbp])[u](?=[bcdfghjkmnpqrstvwxyz]|$)/g, '$1')
  }
  s = s.replace(/y$/, 'i')
  return s
}

export function buildEntries(cards: Card[]): SearchEntry[] {
  return cards.map((card, i) => {
    const code = normCode(card.code)
    const dash = card.code.indexOf('-')
    return {
      card,
      i,
      code,
      set: dash > 0 ? card.code.slice(0, dash).toUpperCase() : null,
      digits: digitsOnly(code),
      loose: stripLeadingZeros(code),
      name: card.name,
      romaji: foldRomaji(kanaToRomaji(card.name)),
    }
  })
}

export interface MatchResult {
  entries: SearchEntry[]
  total: number
  truncated: boolean
}

const LIMIT = 80

/**
 * Rank: lower is better. Code beats name, and an anchored match beats a loose
 * one - otherwise a DON!! card called "ドン!!カード(ルフィ)" outranks the actual
 * Luffy leader when the user types a name.
 *  0 exact code | 1 code prefix | 2 digit-run exact | 3 loose prefix
 *  4 code contains | 5 digits contain
 *  6 name prefix  | 7 name contains | 8 romaji prefix | 9 romaji contains
 * Returns -1 for no match.
 */
function rank(e: SearchEntry, qCode: string, qDigits: string, qLoose: string, qRaw: string, qRomaji: string): number {
  if (qCode) {
    if (e.code === qCode) return 0
    if (e.code.startsWith(qCode)) return 1
    if (qDigits && qDigits.length >= 2 && e.digits === qDigits) return 2
    if (e.loose.startsWith(qLoose)) return 3
    if (e.code.includes(qCode)) return 4
    if (qDigits && qDigits.length >= 2 && e.digits.includes(qDigits)) return 5
  }
  if (qRaw) {
    if (e.name.startsWith(qRaw)) return 6
    if (e.name.includes(qRaw)) return 7
  }
  if (qRomaji.length >= 2) {
    if (e.romaji.startsWith(qRomaji)) return 8
    if (e.romaji.includes(qRomaji)) return 9
  }
  return -1
}

export function search(entries: SearchEntry[], rawQuery: string, setFilter: string | null): MatchResult {
  const q = rawQuery.trim()
  // Exact set equality, not a prefix: filtering on "P" must not drag in PRB01.
  const wanted = setFilter ? setFilter.toUpperCase() : null
  const scoped = wanted ? entries.filter((e) => e.set === wanted) : entries

  if (!q) {
    const head = scoped.slice(0, LIMIT)
    return { entries: head, total: scoped.length, truncated: scoped.length > head.length }
  }

  const qCode = normCode(q)
  const qDigits = digitsOnly(qCode)
  const qLoose = stripLeadingZeros(qCode)
  const qRomaji = foldRomaji(kanaToRomaji(q))

  const hits: Array<{ e: SearchEntry; r: number }> = []
  for (const e of scoped) {
    const r = rank(e, qCode, qDigits, qLoose, q, qRomaji)
    if (r >= 0) hits.push({ e, r })
  }

  hits.sort((a, b) => {
    if (a.r !== b.r) return a.r - b.r
    // Codeless DON!! rows last: they match a lot of names and are never what
    // someone standing at a counter with a numbered card is looking for.
    const ac = a.e.code ? 0 : 1
    const bc = b.e.code ? 0 : 1
    if (ac !== bc) return ac - bc
    if (a.e.code !== b.e.code) return a.e.code < b.e.code ? -1 : 1
    return b.e.card.jpySell - a.e.card.jpySell
  })

  const head = hits.slice(0, LIMIT).map((h) => h.e)
  return { entries: head, total: hits.length, truncated: hits.length > head.length }
}
