// scripts/lib/join.mjs
//
// Pure join + verdict + coverage logic for tcg-jp-pricer. NO I/O lives in this
// file on purpose: every export takes plain objects, so join.test.mjs can drive
// the safety-critical paths with fixtures.
//
// THE RULE THIS FILE EXISTS TO ENFORCE:
//   One card code maps to MULTIPLE Cardmarket printings (base / parallel / manga
//   art) whose prices differ 10x-50x. Cardmarket's bulk rows carry no rarity or
//   variant field, so we frequently cannot tell which printing a row is.
//   When more than one eligible printing carries a code we attach ALL of them and
//   mark the card 'ambiguous'. We never average, never take min/max, never
//   sort-and-pick. A wrong number makes a real person overpay real cash.
//
// Only expansions whose language resolves to 'japanese' are ever priced.
// 'unknown' means "no positive evidence" and fails closed - it is NOT english,
// and it is NOT a licence to show a price.

import { applyPrintingMatch } from './printing-match.mjs'

/* ------------------------------------------------------------------ *
 * 1. Code normalization
 * ------------------------------------------------------------------ */

// Zero-width / soft-hyphen junk that survives copy-paste. Deleted outright.
const INVISIBLE = /[­​-‍⁠﻿]/g

// Every dash-ish codepoint we have seen in scraped Japanese pages, unified to
// ASCII '-'. NFKC already folds U+FF0D (fullwidth hyphen-minus) and halfwidth
// katakana prolonged marks, but it does NOT fold U+2010..U+2015 or U+2212.
const DASHLIKE = /[‐-―⁃−➖ー─━﹘﹣－]/g

/** Canonical form for free text (names). Whitespace is collapsed, not removed. */
export function normalizeText(raw) {
  if (raw === null || raw === undefined) return ''
  return String(raw)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(DASHLIKE, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/**
 * Canonical form for a card code. NFKC (fullwidth -> ASCII), dashes unified,
 * ALL whitespace removed, uppercased. Leading zeros are never touched:
 * "OP09-007" stays "OP09-007" and is never collapsed to "OP9-7".
 */
export function normalizeCode(raw) {
  if (raw === null || raw === undefined) return ''
  return String(raw)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(DASHLIKE, '-')
    .replace(/\s+/g, '')
    .toUpperCase()
}

/** Shape of a One Piece code: OP09-119, ST01-001, EB01-061, PRB01-002, P-001. */
export const CARD_CODE_RE = /^[A-Z][A-Z0-9]{0,5}-[0-9]{2,4}$/

export function isCardCode(value) {
  return CARD_CODE_RE.test(value)
}

/** The contract's sentinel for a card that has no code at all (DON!! cards). */
export const NO_CODE = '-'

/** Normalize to a joinable code, or NO_CODE when the input is not a code. */
export function canonicalCode(raw) {
  const code = normalizeCode(raw)
  return isCardCode(code) ? code : NO_CODE
}

const PAREN_GROUP = /\(([^()]{1,40})\)/g
const LOOSE_CODE = /(?:^|[^A-Z0-9])([A-Z][A-Z0-9]{0,5}-[0-9]{2,4})(?![A-Z0-9])/

/**
 * Cardmarket gives us no code field; the code lives in the product name as
 * "Monkey.D.Luffy (OP09-119)". A name can carry several parenthesised groups
 * ("(V.2)", "(Parallel)"), so every group is tested and the first that is
 * actually code-shaped wins.
 *
 * The bare-word fallback only runs for names with NO parentheses at all. Names
 * that follow the convention must not be able to produce a false join off some
 * unrelated substring - a false join is a wrong price.
 */
export function extractCodeFromName(name) {
  const text = normalizeText(name)
  if (!text) return NO_CODE

  let sawParens = false
  for (const match of text.matchAll(PAREN_GROUP)) {
    sawParens = true
    const code = normalizeCode(match[1])
    if (isCardCode(code)) return code
  }
  if (sawParens) return NO_CODE

  const loose = text.match(LOOSE_CODE)
  if (loose) {
    const code = normalizeCode(loose[1])
    if (isCardCode(code)) return code
  }
  return NO_CODE
}

/** "OP09-119" -> "OP09". Returns '' for uncoded cards. */
export function setCodeOf(code) {
  const normalized = normalizeCode(code)
  if (!isCardCode(normalized)) return ''
  return normalized.slice(0, normalized.indexOf('-'))
}

/* ------------------------------------------------------------------ *
 * 2. Expansion language resolution (overrides WIN)
 * ------------------------------------------------------------------ */

export const LANGUAGES = new Set(['japanese', 'english_confirmed', 'unknown'])

/**
 * Merge data/expansions.json with data/expansion-overrides.json.
 *
 * Overrides win unconditionally, and may introduce expansion ids that are not
 * in expansions.json at all - that is how OP14..OP17 will arrive once a human
 * has verified them in a browser. This function simply honours the file.
 *
 * A malformed override FAILS CLOSED: the expansion is forced to 'unknown'
 * rather than keeping whatever expansions.json guessed. Losing a price is
 * cheap; showing the wrong one is not.
 *
 * @returns {{index: Map<number, {expansionId:number,name:string,language:string,source:string,why:string|null}>, applied: Array, rejected: Array}}
 */
export function buildExpansionIndex(expansionsDoc, overridesDoc) {
  const index = new Map()
  const list = Array.isArray(expansionsDoc?.expansions) ? expansionsDoc.expansions : []

  for (const entry of list) {
    const expansionId = Number(entry?.expansionId)
    if (!Number.isInteger(expansionId)) continue
    const language = LANGUAGES.has(entry?.language) ? entry.language : 'unknown'
    index.set(expansionId, {
      expansionId,
      name: String(entry?.name ?? ''),
      language,
      source: 'expansions.json',
      why: null,
    })
  }

  const applied = []
  const rejected = []
  const overrides =
    overridesDoc?.overrides && typeof overridesDoc.overrides === 'object' ? overridesDoc.overrides : {}

  for (const [key, value] of Object.entries(overrides)) {
    const expansionId = Number(key)
    if (!Number.isInteger(expansionId)) {
      rejected.push({ key, why: 'key is not an integer expansionId' })
      continue
    }
    const previous = index.get(expansionId)
    const failClosed = (why) => {
      rejected.push({ key, why })
      index.set(expansionId, {
        expansionId,
        name: String(value?.name ?? previous?.name ?? ''),
        language: 'unknown',
        source: 'expansion-overrides.json (malformed -> forced unknown)',
        why: why,
      })
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      failClosed('override value is not an object')
      continue
    }
    if (!LANGUAGES.has(value.language)) {
      failClosed(`language ${JSON.stringify(value.language)} is not one of japanese|english_confirmed|unknown`)
      continue
    }
    index.set(expansionId, {
      expansionId,
      name: String(value.name ?? previous?.name ?? ''),
      language: value.language,
      source: 'expansion-overrides.json',
      why: value.why == null ? null : String(value.why),
    })
    applied.push({
      expansionId,
      name: String(value.name ?? previous?.name ?? ''),
      from: previous ? previous.language : '(not in expansions.json)',
      to: value.language,
      why: value.why == null ? null : String(value.why),
    })
  }

  return { index, applied, rejected }
}

/**
 * Intersect two language indexes. 'japanese' survives only where the second
 * source explicitly agrees; where it has no entry at all it has expressed no
 * opinion and the primary stands. Absence is not evidence, in either direction.
 */
export function intersectJapanese(primary, secondary) {
  const merged = new Map()
  const disagreements = []
  for (const [expansionId, meta] of primary) {
    const other = secondary.get(expansionId)
    if (!other) {
      merged.set(expansionId, meta)
      continue
    }
    const otherLanguage = other.language ?? 'unknown'
    if (meta.language === 'japanese' && otherLanguage !== 'japanese') {
      disagreements.push({ expansionId, name: meta.name, primary: meta.language, secondary: otherLanguage })
      merged.set(expansionId, { ...meta, language: 'unknown', source: `${meta.source} (downgraded: sources disagree)` })
      continue
    }
    if (meta.language !== 'japanese' && otherLanguage === 'japanese') {
      disagreements.push({ expansionId, name: meta.name, primary: meta.language, secondary: otherLanguage })
    }
    merged.set(expansionId, meta)
  }
  for (const [expansionId, meta] of secondary) {
    if (merged.has(expansionId)) continue
    // Only the secondary knows this expansion: keep it, but never as japanese.
    if (meta?.language === 'japanese') {
      disagreements.push({ expansionId, name: meta?.name ?? '', primary: '(absent)', secondary: 'japanese' })
    }
    merged.set(expansionId, {
      expansionId,
      name: String(meta?.name ?? ''),
      language: 'unknown',
      source: 'cardmarket.mjs only (downgraded: unverified locally)',
      why: null,
    })
  }
  return { index: merged, disagreements }
}

/* ------------------------------------------------------------------ *
 * 3. Cardmarket indexing - japanese-only, variant-preserving
 * ------------------------------------------------------------------ */

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Bucket Cardmarket rows by card code, keeping ONLY rows whose expansion
 * resolves to language 'japanese'.
 *
 * @returns {{byCode: Map<string, Array>, eligibleSets: Set<string>, stats: object}}
 */
export function indexCardmarketRows(rows, expansionIndex) {
  const byCode = new Map()
  const eligibleSets = new Set()
  const seenProducts = new Set()
  const stats = {
    rowsIn: 0,
    eligible: 0,
    rejectedLanguage: 0,
    rejectedNoCode: 0,
    duplicateProductRows: 0,
    unknownExpansionId: 0,
    byLanguage: {},
    eligibleExpansions: new Set(),
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    stats.rowsIn++
    const expansionId = Number(row?.expansionId)
    const meta = Number.isInteger(expansionId) ? expansionIndex.get(expansionId) : undefined
    const language = meta?.language ?? 'unknown'
    stats.byLanguage[language] = (stats.byLanguage[language] ?? 0) + 1
    if (!meta) stats.unknownExpansionId++

    if (language !== 'japanese') {
      stats.rejectedLanguage++
      continue
    }

    const code = extractCodeFromName(row?.name)
    if (code === NO_CODE) {
      stats.rejectedNoCode++
      continue
    }

    const productId = Number(row?.productId)
    const dedupeKey = `${code}#${Number.isInteger(productId) ? productId : `anon:${String(row?.name ?? '')}`}`
    if (seenProducts.has(dedupeKey)) {
      // The same productId twice is a pull artefact, not a second printing.
      // Counting it would manufacture a fake 'ambiguous'.
      stats.duplicateProductRows++
      continue
    }
    seenProducts.add(dedupeKey)

    stats.eligible++
    eligibleSets.add(setCodeOf(code))
    stats.eligibleExpansions.add(expansionId)

    const candidate = {
      productId: Number.isInteger(productId) ? productId : -1,
      expansionId,
      expansionName: meta.name,
      name: String(row?.name ?? ''),
      trendEur: toNumberOrNull(row?.priceTrendEur),
      lowEur: toNumberOrNull(row?.priceLowEur),
      avg7Eur: toNumberOrNull(row?.avg7DayEur),
    }
    const bucket = byCode.get(code)
    if (bucket) bucket.push(candidate)
    else byCode.set(code, [candidate])
  }

  // Stable output order only. Order carries no meaning: the UI shows them all.
  for (const bucket of byCode.values()) bucket.sort((a, b) => a.productId - b.productId)

  return { byCode, eligibleSets, stats }
}

/* ------------------------------------------------------------------ *
 * 4. The join
 * ------------------------------------------------------------------ */

function boolOf(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return false
}

function intOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback
}

/**
 * Join Yuyu-tei rows to Cardmarket candidates on canonical card code.
 *
 * After the code-level join, PRINTING-MATCH runs over the ambiguous cards and
 * ADDS a best-guess pairing (card.euMatch / card.euBestGuess) where the evidence
 * supports one. It is strictly additive: no candidate is removed, card.eu keeps
 * its order, and euStatus is NOT touched - a narrowed card stays 'ambiguous',
 * because a likelihood is not a verification. See scripts/lib/printing-match.mjs.
 *
 * @param {{yuyuteiRows: Array, cardmarketIndex: ({byCode: Map, eligibleSets: Set}|null), fx?: {jpyPerEur:number}}} args
 *   cardmarketIndex === null means data/cardmarket.json was absent -> 'not_pulled'.
 * @returns {Array} Card[] per src/lib/types.ts
 */
export function joinCards({ yuyuteiRows = [], cardmarketIndex = null, fx = null }) {
  const pulled = cardmarketIndex !== null && cardmarketIndex !== undefined
  const cards = []

  // How many Yuyu-tei SKUs share each card code. A code is NOT a printing:
  // OP17-118 ships as base (JPY 2,980), parallel (4,980) and super-parallel
  // (498,000). Cardmarket's bulk rows carry no rarity or variant field, so when
  // several Japanese printings exist we cannot say which one a lone Cardmarket
  // row describes - and a single candidate is then evidence that only ONE
  // printing was pulled, never that only one exists.
  const skusPerCode = new Map()
  for (const row of Array.isArray(yuyuteiRows) ? yuyuteiRows : []) {
    const c = canonicalCode(row?.code)
    if (c === NO_CODE) continue
    skusPerCode.set(c, (skusPerCode.get(c) ?? 0) + 1)
  }

  for (const row of Array.isArray(yuyuteiRows) ? yuyuteiRows : []) {
    const code = canonicalCode(row?.code)
    const setCode = setCodeOf(code)

    let euStatus
    let eu = []

    if (!pulled) {
      euStatus = 'not_pulled'
    } else if (code === NO_CODE) {
      // DON!! and other uncoded SKUs have no join key at all. The set is not
      // "unmapped" - there is simply nothing to match on, so: no_match.
      euStatus = 'no_match'
    } else {
      const candidates = cardmarketIndex.byCode.get(code) ?? []
      // A lone candidate only means "one verified printing" when this code has
      // exactly one Yuyu-tei printing too. Otherwise the match is unattributable
      // and must not be rendered as a confident headline price.
      const jpPrintings = skusPerCode.get(code) ?? 1
      if (candidates.length === 1 && jpPrintings === 1) {
        euStatus = 'ok'
        eu = candidates.slice()
      } else if (candidates.length === 1 && jpPrintings > 1) {
        euStatus = 'ambiguous'
        eu = candidates.slice()
      } else if (candidates.length > 1) {
        // The safety-critical branch. Every candidate travels to the UI.
        euStatus = 'ambiguous'
        eu = candidates.slice()
      } else {
        euStatus = cardmarketIndex.eligibleSets.has(setCode) ? 'no_match' : 'unmapped_set'
      }
    }

    const jpyBuy = toNumberOrNull(row?.jpyBuy)
    const jpyBuyPrev = toNumberOrNull(row?.jpyBuyPrev)

    cards.push({
      code,
      name: String(row?.name ?? ''),
      variant: row?.variant == null || row.variant === '' ? null : String(row.variant),
      rarity: String(row?.rarity ?? ''),
      setBucket: String(row?.setBucket ?? ''),
      cardId: String(row?.cardId ?? ''),
      img: String(row?.img ?? ''),
      detailUrl: String(row?.detailUrl ?? ''),
      jpySell: intOr(row?.jpySell, 0),
      jpyBuy: jpyBuy === null ? null : Math.round(jpyBuy),
      jpyBuyPrev: jpyBuyPrev === null ? null : Math.round(jpyBuyPrev),
      inStock: boolOf(row?.inStock),
      stock: intOr(row?.stock, 0),
      euStatus,
      eu,
    })
  }

  // Additive narrowing pass. Mutates the cards it can explain and leaves every
  // other card byte-for-byte as it was.
  const jpyPerEur = Number(fx?.jpyPerEur)
  applyPrintingMatch(cards, Number.isFinite(jpyPerEur) && jpyPerEur > 0 ? { jpyPerEur } : {})

  return cards
}

/* ------------------------------------------------------------------ *
 * 5. Coverage
 * ------------------------------------------------------------------ */

/**
 * Coverage per src/lib/types.ts. Yuyu-tei's live sets are derived from the
 * scraped rows, priceable sets from the japanese-eligible Cardmarket rows, and
 * missingSets is the diff the user MUST see.
 *
 * With cardmarketIndex === null nothing is priceable, so every Yuyu-tei set is
 * reported missing. That is the honest reading of "sets we can price".
 */
export function computeCoverage(cards, cardmarketIndex = null) {
  const yuyutei = new Set()
  for (const card of cards) {
    const setCode = setCodeOf(card.code)
    if (setCode) yuyutei.add(setCode)
  }
  const mapped = cardmarketIndex ? new Set(cardmarketIndex.eligibleSets) : new Set()

  const yuyuteiSets = [...yuyutei].sort()
  const mappedSets = [...mapped].sort()
  const missingSets = yuyuteiSets.filter((setCode) => !mapped.has(setCode))

  return {
    yuyuteiSets,
    mappedSets,
    missingSets,
    cardsTotal: cards.length,
    cardsWithEu: cards.filter((card) => card.eu.length > 0).length,
    cardsAmbiguous: cards.filter((card) => card.euStatus === 'ambiguous').length,
  }
}

/** Count cards per euStatus, for the build report. */
export function statusBreakdown(cards) {
  const counts = { ok: 0, ambiguous: 0, unmapped_set: 0, no_match: 0, not_pulled: 0 }
  for (const card of cards) {
    if (counts[card.euStatus] === undefined) counts[card.euStatus] = 0
    counts[card.euStatus]++
  }
  return counts
}

/** Yuyu-tei sets that are missing, with how many live SKUs each one costs us. */
export function missingSetDetail(cards, coverage) {
  const missing = new Set(coverage.missingSets)
  const detail = new Map()
  for (const card of cards) {
    const setCode = setCodeOf(card.code)
    if (!setCode || !missing.has(setCode)) continue
    const entry = detail.get(setCode) ?? { setCode, cards: 0, inStock: 0 }
    entry.cards++
    if (card.inStock) entry.inStock++
    detail.set(setCode, entry)
  }
  return [...detail.values()].sort((a, b) => b.cards - a.cards || a.setCode.localeCompare(b.setCode))
}

/* ------------------------------------------------------------------ *
 * 6. Verdicts - pure, the UI calls these directly
 * ------------------------------------------------------------------ */

export function round1(value) {
  return Math.round(value * 10) / 10
}
export function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * Bands read as "how the asking price compares to the reference price".
 * Negative percentage = the shop is cheaper than the reference.
 * Thresholds are inclusive upper bounds, evaluated in order.
 */
export const VERDICT_BANDS = [
  { band: 'great', maxPct: -25, label: 'Well below market' },
  { band: 'good', maxPct: -10, label: 'Below market' },
  { band: 'fair', maxPct: 10, label: 'Around market' },
  { band: 'high', maxPct: 30, label: 'Above market' },
  { band: 'bad', maxPct: Infinity, label: 'Well above market' },
]

export function bandForDiffPct(diffPct) {
  if (!Number.isFinite(diffPct)) return null
  for (const entry of VERDICT_BANDS) {
    if (diffPct <= entry.maxPct) return entry.band
  }
  return 'bad'
}

/**
 * PRIMARY verdict: the shop's yen price vs the Yuyu-tei yen price.
 * Same market, same currency, same condition - no conversion, no modelling,
 * just the raw percentage gap.
 *
 * @param {number} askYen  price on the shop's tag
 * @param {number} jpySell Yuyu-tei's selling price for this exact SKU
 * @returns {{band:string,diffPct:number,askYen:number,refYen:number,deltaYen:number,source:string,primary:true}|null}
 */
export function jpVerdict(askYen, jpySell) {
  const ask = Number(askYen)
  const reference = Number(jpySell)
  if (!Number.isFinite(ask) || ask <= 0) return null
  if (!Number.isFinite(reference) || reference <= 0) return null

  // Band is derived from the rounded number so the badge can never contradict
  // the percentage printed next to it.
  const diffPct = round1(((ask - reference) / reference) * 100)
  return {
    band: bandForDiffPct(diffPct),
    diffPct,
    askYen: ask,
    refYen: reference,
    deltaYen: Math.round(ask - reference),
    source: 'yuyu-tei',
    primary: true,
  }
}

/**
 * SECONDARY context: the same asking price against European Cardmarket trend
 * prices. Explicitly not the verdict - different market, different shipping,
 * different buyer pool.
 *
 * Headline field is priceTrendEur, never priceLowEur: the lowest listing is
 * typically the most damaged copy or a mispricing, and it excludes EUR 1-5
 * shipping.
 *
 * Returns null when there is nothing trustworthy to compare against, which is
 * exactly the euStatus values 'unmapped_set' / 'no_match' / 'not_pulled' (they
 * all carry an empty candidate list). With several candidates every one is
 * returned separately - never a blend, never a pick.
 *
 * @param {number} askYen
 * @param {Array} candidates card.eu
 * @param {{jpyPerEur:number,source?:string,date?:string}} fx
 */
export function euContext(askYen, candidates, fx) {
  const ask = Number(askYen)
  const jpyPerEur = Number(fx?.jpyPerEur)
  if (!Number.isFinite(ask) || ask <= 0) return null
  if (!Number.isFinite(jpyPerEur) || jpyPerEur <= 0) return null
  if (!Array.isArray(candidates) || candidates.length === 0) return null

  const askEur = round2(ask / jpyPerEur)

  const results = candidates.map((candidate) => {
    const trendEur = toNumberOrNull(candidate?.trendEur)
    const comparable = trendEur !== null && trendEur > 0
    const diffPct = comparable ? round1(((askEur - trendEur) / trendEur) * 100) : null
    return {
      productId: Number.isFinite(Number(candidate?.productId)) ? Number(candidate.productId) : -1,
      expansionId: Number.isFinite(Number(candidate?.expansionId)) ? Number(candidate.expansionId) : -1,
      expansionName: String(candidate?.expansionName ?? ''),
      name: String(candidate?.name ?? ''),
      trendEur,
      lowEur: toNumberOrNull(candidate?.lowEur),
      avg7Eur: toNumberOrNull(candidate?.avg7Eur),
      diffPct,
      band: comparable ? bandForDiffPct(diffPct) : null,
      comparable,
      reason: comparable ? null : 'no_trend_price',
    }
  })

  return {
    askYen: ask,
    askEur,
    jpyPerEur,
    fxSource: fx?.source ? String(fx.source) : null,
    fxDate: fx?.date ? String(fx.date) : null,
    basis: 'priceTrendEur',
    secondary: true,
    ambiguous: results.length > 1,
    // Exactly one candidate -> one number may be shown. Otherwise the UI must
    // render `candidates` in full; there is deliberately nothing to shortcut to.
    headline: results.length === 1 ? results[0] : null,
    candidates: results,
  }
}
