// Reading and sanity-checking the baked price index, plus money formatting.
// Everything here is defensive: the pipeline may not have run yet, and a
// half-written index must degrade into an explicit "no data" state rather
// than into a number the user could mistake for a price.

import type {
  Card,
  Coverage,
  EuCandidate,
  EuCandidateMatch,
  EuMatch,
  EuMatchLevel,
  EuMatchLikelihood,
  EuRefusal,
  EuStatus,
  Fx,
  PriceIndex,
} from '../lib/types'

export interface LoadedIndex {
  index: PriceIndex
  /** false when data/index.json was missing or unusable. */
  hasData: boolean
  /** true when the build was fed a development fixture, never real prices. */
  isFixture: boolean
  loadError: string | null
}

const EMPTY_FX: Fx = { jpyPerEur: 0, source: 'none', date: '' }

const EMPTY_COVERAGE: Coverage = {
  yuyuteiSets: [],
  mappedSets: [],
  missingSets: [],
  cardsTotal: 0,
  cardsWithEu: 0,
  cardsAmbiguous: 0,
}

export const EMPTY_INDEX: PriceIndex = withSealed(
  {
    generatedAt: '',
    game: 'one-piece',
    fx: EMPTY_FX,
    coverage: EMPTY_COVERAGE,
    cards: [],
  },
  [],
)

const EU_STATUSES: EuStatus[] = ['ok', 'ambiguous', 'unmapped_set', 'no_match', 'not_pulled']

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Money that may legitimately be absent. Never coerced to 0 - 0 reads as free. */
function optNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function toCandidate(raw: unknown): EuCandidate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return {
    productId: num(r.productId),
    expansionId: num(r.expansionId),
    expansionName: str(r.expansionName) || 'Unknown expansion',
    name: str(r.name),
    trendEur: optNum(r.trendEur),
    lowEur: optNum(r.lowEur),
    avg7Eur: optNum(r.avg7Eur),
    ...(toCandidateMatch(r.match) ? { match: toCandidateMatch(r.match)! } : {}),
  }
}

const LIKELIHOODS: EuMatchLikelihood[] = ['strong', 'weak', 'none']

/** The matcher's per-candidate marker. Dropped silently before this existed,
 *  which made the whole narrowing feature invisible in the browser. */
function toCandidateMatch(raw: unknown): EuCandidateMatch | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const likelihood = str(r.likelihood) as EuMatchLikelihood
  if (!LIKELIHOODS.includes(likelihood)) return null
  return { likelihood, reason: str(r.reason), rank: num(r.rank) }
}

/** A narrowed guess. NEVER promotes euStatus - the card stays 'ambiguous'. */
function toEuMatch(raw: unknown): EuMatch | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const likelihood = str(r.likelihood) as EuMatchLikelihood
  const level = str(r.level) as EuMatchLevel
  if (!LIKELIHOODS.includes(likelihood)) return null
  if (!['exact', 'strong', 'moderate'].includes(level)) return null
  const block = r.block === 'PROMO' ? ('PROMO' as const) : num(r.block)
  return {
    productId: num(r.productId),
    level,
    likelihood,
    basis: str(r.basis) === 'rank' ? 'rank' : 'expansion',
    block,
    rank: num(r.rank),
    ofM: num(r.ofM),
    separation: optNum(r.separation),
    stepX: optNum(r.stepX),
    reasonCode: str(r.reasonCode) as EuMatch['reasonCode'],
    reason: str(r.reason),
  }
}

function toEuRefusal(raw: unknown): EuRefusal | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const reason = str(r.reason)
  if (!reason) return null
  return {
    reasonCode: str(r.reasonCode) as EuRefusal['reasonCode'],
    reason,
    jpPrintings: num(r.jpPrintings),
    euCandidates: num(r.euCandidates),
  }
}

function toCard(raw: unknown): Card | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const code = str(r.code)
  if (!code) return null

  const rawStatus = str(r.euStatus) as EuStatus
  const eu = Array.isArray(r.eu)
    ? r.eu.map(toCandidate).filter((c): c is EuCandidate => c !== null)
    : []

  // Fail closed: an unrecognised status is treated as "we have nothing".
  const euStatus: EuStatus = EU_STATUSES.includes(rawStatus) ? rawStatus : 'not_pulled'

  // A narrowed guess is only meaningful while the card is genuinely ambiguous.
  // Guarding here means no later edit can turn a guess into a headline price.
  const euMatch = euStatus === 'ambiguous' ? toEuMatch(r.euMatch) : null

  return {
    code,
    name: str(r.name),
    variant: typeof r.variant === 'string' && r.variant ? r.variant : null,
    rarity: str(r.rarity),
    setBucket: str(r.setBucket),
    cardId: str(r.cardId),
    img: str(r.img),
    detailUrl: str(r.detailUrl),
    jpySell: num(r.jpySell),
    jpyBuy: optNum(r.jpyBuy),
    jpyBuyPrev: optNum(r.jpyBuyPrev),
    inStock: r.inStock !== false,
    stock: num(r.stock),
    euStatus,
    eu,
    euMatch,
    euBestGuess: euMatch ? euMatch.productId : null,
    // Mutually exclusive with euMatch, by contract.
    euRefusal: euMatch ? null : toEuRefusal(r.euRefusal),
  }
}

export function sanitizeIndex(raw: unknown): PriceIndex | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.cards)) return null

  const cards = r.cards.map(toCard).filter((c): c is Card => c !== null)
  const fxRaw = (r.fx ?? {}) as Record<string, unknown>
  const covRaw = (r.coverage ?? {}) as Record<string, unknown>

  // NOTE the withSealed() wrapper. sanitizeIndex is the ONLY thing that reaches
  // the browser: index.astro JSON.stringifies exactly what this returns. A field
  // that is not copied through here does not exist at runtime, however carefully
  // the pipeline computed it.
  return withSealed({
    generatedAt: str(r.generatedAt),
    game: 'one-piece',
    fx: {
      jpyPerEur: num(fxRaw.jpyPerEur),
      source: str(fxRaw.source) || 'unknown',
      date: str(fxRaw.date),
    },
    coverage: {
      yuyuteiSets: strArray(covRaw.yuyuteiSets),
      mappedSets: strArray(covRaw.mappedSets),
      missingSets: strArray(covRaw.missingSets),
      cardsTotal: num(covRaw.cardsTotal) || cards.length,
      cardsWithEu: num(covRaw.cardsWithEu),
      cardsAmbiguous: num(covRaw.cardsAmbiguous),
    },
    cards,
  }, sealedFromIndex(r))
}

/** Pulls the build-time payload out of the inline <script type="application/json">. */
export function loadIndexFromDom(): LoadedIndex {
  const fallback: LoadedIndex = {
    index: EMPTY_INDEX,
    hasData: false,
    isFixture: false,
    loadError: null,
  }
  if (typeof document === 'undefined') return fallback

  const el = document.getElementById('price-index')
  if (!el || !el.textContent) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(el.textContent)
  } catch (err) {
    return { ...fallback, loadError: `Baked index is not valid JSON: ${String(err)}` }
  }

  const envelope = parsed as Record<string, unknown>
  const isFixture = envelope?.fixture === true
  const loadError = typeof envelope?.loadError === 'string' ? envelope.loadError : null
  const index = sanitizeIndex(envelope?.index)

  if (!index || index.cards.length === 0) {
    return { index: index ?? EMPTY_INDEX, hasData: false, isFixture, loadError }
  }
  return { index, hasData: true, isFixture, loadError }
}

// -------------------------------------------------------------- formatting

const JPY = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const EUR = new Intl.NumberFormat('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function yen(v: number): string {
  return '¥' + JPY.format(Math.round(v))
}

export function eur(v: number): string {
  return '€' + EUR.format(v)
}

export function signedYen(v: number): string {
  const s = v > 0 ? '+' : v < 0 ? '−' : '±'
  return s + '¥' + JPY.format(Math.abs(Math.round(v)))
}

export function pct(ratio: number): string {
  const d = (ratio - 1) * 100
  const s = d > 0 ? '+' : d < 0 ? '−' : '±'
  return s + Math.abs(d).toFixed(0) + '%'
}

/** Set code carried by a card code, e.g. "OP09-119" -> "OP09". null for DON!! rows. */
export function setOf(code: string): string | null {
  const i = code.indexOf('-')
  if (i <= 0) return null
  return code.slice(0, i).toUpperCase()
}

/** EUR -> JPY using the baked FX rate. null when we have no usable rate. */
export function eurToJpy(amountEur: number, fx: Fx): number | null {
  if (!fx.jpyPerEur || fx.jpyPerEur <= 0) return null
  return amountEur * fx.jpyPerEur
}

/**
 * Yuyu-tei folds the variant into the name: "ロキ(パラレル)". Several rows share
 * one card code and differ ONLY by that suffix, so the suffix is promoted to
 * its own badge rather than being ellipsized away at the end of a long name.
 */
export function baseName(name: string): string {
  const cut = name.search(/[(\uff08]/)
  const head = cut > 0 ? name.slice(0, cut) : name
  return head.trim() || name
}

/** Rarity is "-" for DON!! rows; that is not a rarity worth a badge. */
export function hasRarity(rarity: string): boolean {
  return !!rarity && rarity !== '-'
}


/** Yuyu-tei serves a generic placeholder for cards it has never scanned - 56 of
 *  them, including the JPY 1,480,000 EB04-061. Showing it as "the card" is worse
 *  than showing nothing, because the art is how you tell two same-code printings
 *  apart at a counter. */
export function hasArt(img: string | null | undefined): boolean {
  return Boolean(img) && !String(img).includes('noimage')
}

// ------------------------------------------------------------------- sealed
//
// Sealed product (booster boxes and booster packs) is a second, much smaller
// catalogue than singles, and it is ASYMMETRIC: we have a European price and,
// today, no Japanese reference price at all. Yuyu-tei sells no sealed product
// (/sell/opc/b, /sell/opc/box and /box/opc/s/search are all 404), and the only
// reachable Japanese shop API we found carries zero One Piece sealed. So the
// contract carries a NULLABLE jpyRef that is null in every row right now, and
// the UI is required to say that in words rather than draw a blank, a dash or
// a zero where a Japanese price would otherwise sit.
//
// These types are declared HERE rather than imported from ../lib/types because
// the pipeline side of the contract is landing separately. Everything below
// reads the index through `unknown`, so this screen keeps working whether the
// index has a sealed array, an empty one, or none at all.

/** Deliberately only two. Cases, starter decks and accessories are out of scope. */
export type SealedKind = 'booster_box' | 'booster_pack'

const SEALED_KINDS: SealedKind[] = ['booster_box', 'booster_pack']

export interface SealedProduct {
  productId: number
  /** Cardmarket's raw name, region suffix and all. */
  name: string
  kind: SealedKind
  expansionId: number
  expansionName: string
  /** e.g. "OP17". null when the expansion carries no mapped set code. */
  setCode: string | null
  trendEur: number | null
  lowEur: number | null
  avg7Eur: number | null
  /**
   * A Japanese market reference, in yen. NULL IN EVERY ROW TODAY - no Japanese
   * sealed price source exists yet. The field is here so that one can be added
   * later without changing this shape, and so the UI has a single place to ask
   * "do we know the Japanese side or not?".
   */
  jpyRef: number | null
  productUrl: string
}

/**
 * Fails closed on `kind`. An unrecognised kind is dropped rather than coerced,
 * because the two things a bad coercion would let through - a CASE (12 boxes,
 * ~12x the price) and a STARTER DECK - are exactly the products that must never
 * appear on this screen wearing a booster box's price.
 */
function toSealed(raw: unknown): SealedProduct | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = str(r.kind) as SealedKind
  if (!SEALED_KINDS.includes(kind)) return null
  const name = str(r.name)
  if (!name) return null
  const setCode = str(r.setCode).trim().toUpperCase()
  return {
    productId: num(r.productId),
    name,
    kind,
    expansionId: num(r.expansionId),
    expansionName: str(r.expansionName) || 'Unknown expansion',
    setCode: setCode || null,
    trendEur: optNum(r.trendEur),
    lowEur: optNum(r.lowEur),
    avg7Eur: optNum(r.avg7Eur),
    jpyRef: optNum(r.jpyRef),
    productUrl: str(r.productUrl),
  }
}

/** Tolerates absent / wrong-typed / partly-broken input. Never throws. */
export function sanitizeSealed(raw: unknown): SealedProduct[] {
  if (!Array.isArray(raw)) return []
  return raw.map(toSealed).filter((s): s is SealedProduct => s !== null)
}

function sealedFromIndex(r: Record<string, unknown>): SealedProduct[] {
  return sanitizeSealed(r.sealed)
}

/**
 * Attaches `sealed` to an index whether or not PriceIndex declares the field
 * yet - the pipeline half of this contract is landing in parallel. Reading goes
 * through sealedOf() for the same reason.
 */
// No cast. SealedProduct is deliberately a NARROWER view of SealedItem: the
// contract in ../lib/types describes the JSON on disk, where expansionName and
// productUrl may be null, while this type describes it AFTER parsing, where
// toSealed() has already defaulted them. A narrower type is assignable to the
// wider one, so if the two ever genuinely diverge, tsc says so here instead of
// a cast hiding it.
function withSealed(base: Omit<PriceIndex, 'sealed'>, sealed: SealedProduct[]): PriceIndex {
  return { ...base, sealed }
}

/** The one way the UI reads sealed rows. Absent array -> empty list, not a crash. */
export function sealedOf(index: PriceIndex): SealedProduct[] {
  return sanitizeSealed((index as { sealed?: unknown }).sealed)
}

/**
 * Cardmarket tags the Japanese printings "(Non-English)" or, for the newer
 * sets, "(Asia Region Legal)". On a phone that suffix eats the half of the row
 * that should be carrying the product name, and it is identical on nearly every
 * row - so it comes off the display and is handed back separately. It is not
 * thrown away: it is the evidence for calling the product Japanese at all, and
 * the detail panel shows both it and the untouched original name.
 */
const REGION_SUFFIX = /\s*[([](Non-English|Asia Region Legal)[)\]]\s*$/i

export interface SealedName {
  /** What the row shows. */
  display: string
  /** "Non-English" / "Asia Region Legal", or null when the name carried none. */
  region: string | null
  /** Cardmarket's untouched name. */
  full: string
}

export function sealedName(name: string): SealedName {
  const m = name.match(REGION_SUFFIX)
  if (!m) return { display: name.trim() || name, region: null, full: name }
  const display = name.replace(REGION_SUFFIX, '').trim()
  return { display: display || name.trim(), region: m[1] ?? null, full: name }
}

export function sealedKindLabel(kind: SealedKind): string {
  return kind === 'booster_box' ? 'Booster box' : 'Booster pack'
}

export function sealedKindShort(kind: SealedKind): string {
  return kind === 'booster_box' ? 'BOX' : 'PACK'
}

/**
 * The identity a collision is measured on. Two sealed products that land on the
 * same set and the same kind are shown BOTH, never merged and never picked
 * between - a set can carry a Japanese box, an English box and a case whose
 * names differ by a few words. Falls back to the expansion when no set code is
 * mapped, which is the common case: the expansion IS the set.
 */
export function sealedGroupKey(s: SealedProduct): string {
  return s.setCode ? `set:${s.setCode}|${s.kind}` : `exp:${s.expansionId}|${s.kind}`
}

/** Plain share-of-something percentage, e.g. 0.463 -> "46%". Not signed. */
export function sharePct(ratio: number): string {
  return Math.round(ratio * 100) + '%'
}
