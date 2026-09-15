// scripts/lib/sealed.mjs
//
// Sealed-product classification and selection. Pure functions only: no I/O, no
// network, no process.env. scripts/pull-sealed.mjs does the reading and writing.
//
// SCOPE: booster boxes and booster packs, and nothing else. Cases, starter/
// ultimate/demo decks, promo packs, tins, binders and bulk lots are all
// classified so they can be COUNTED and reported, then excluded.
//
// THE GOVERNING SAFETY RULE APPLIES HERE UNCHANGED: never surface a euro figure
// we are not certain of. Two consequences run through this whole file:
//   1. A product is priceable only when its expansion resolves to 'japanese'.
//      'unknown' is not japanese. There is no fallback, no guess, no "probably".
//   2. When classification is not obvious we bucket to 'other' (out of scope)
//      AND record the name in `unconfident` so it is reported, never swallowed.
//
// THE ONE REAL TRAP is box-vs-case. Cardmarket writes a case three ways:
//      "<Set> Booster Box Case (12x Booster Box)"   the usual form
//      "<Set> Booster Box Case"                     no multiplier at all
//      "<Set> (12x Booster Box)"                    NO the word "case" anywhere
//   The third form is why a "does the name say case?" test is not enough, and a
//   naive `name.includes('booster box')` test matches all three plus the real
//   box. Measured on data/cardmarket-sealed-raw.json: 22 real Japanese boxes vs
//   22 Japanese cases, and a case costs ~12x a box (EUR 750 vs EUR 88 for
//   500 Years into the Future). Getting this backwards at a shop counter is a
//   four-figure mistake.

/** Every bucket kindOf() can return. */
export const SEALED_KINDS = Object.freeze(['booster_box', 'booster_pack', 'case', 'deck', 'other'])

/** The only kinds this feature prices. Everything else is excluded by design. */
export const IN_SCOPE_KINDS = Object.freeze(['booster_box', 'booster_pack'])

/** The only expansion language that may ever carry a price. Mirrors cardmarket.mjs. */
export const PRICED_LANGUAGE = 'japanese'

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

/**
 * Fold the cosmetic noise Cardmarket product names carry, so the rules below can
 * be written once. Curly apostrophes are real in this data ("Adventure on Kami’s
 * Island Booster Box" and "Adventure on Kami's Island Booster Box" are two
 * separate products), as are the doubled quotes in `Starter Deck EX: ""Gear 5""`.
 */
export function normalizeName(name) {
  if (typeof name !== 'string') return ''
  return name
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/"+/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// Trailing parentheticals that say something about the PRINTING, not the
// product. Whitelisted rather than "strip any trailing (...)" on purpose: a
// blanket strip would also eat "(12x Booster Box)", which is the entire
// difference between a box and a case.
const QUALIFIER_TAIL =
  /\s*\((?:non-english|asia region lega(?:l)?(?: version)?|english version|french version|japanese|pre-errata|pre-errate map)\)\s*$/

/** Drop trailing printing qualifiers: "Foo Booster (Non-English)" -> "foo booster". */
export function stripQualifiers(normalized) {
  let out = normalized
  // Repeat: "... Booster Box Case (12x Booster Box) (Non-English)" has two tails,
  // and only the language one is a qualifier.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(QUALIFIER_TAIL, '')
    if (next === out) break
    out = next.trim()
  }
  return out
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

// A case, form 1 and 2: the word "case" anywhere.
const CASE_WORD = /\bcases?\b/

// A case, form 3: a parenthetical that is EXACTLY a multiplier of boxes or packs.
//   "(12x booster box)"  "(10x booster box)"  "(24x packs)"  "(20x packs)"
// Deliberately anchored to the whole parenthetical so that
// "(Incl. 1x Promotion Pack 2023 Vol.1)" - a Demo Deck freebie - does NOT match.
const CASE_MULTIPLIER = /\(\s*\d+\s*x\s*(?:booster\s+box(?:es)?|boxes?|packs?)\s*\)/

const DECK_WORD = /\bdecks?\b/

const BOOSTER_BOX = /\bbooster\s+box(?:es)?\b/

// A single sealed pack. Every genuine one in the 699-row snapshot ends with
// "booster" or "sleeved booster" after qualifiers are stripped. Names ending
// "booster pack" are NOT included: the only such product is
// "Special Card Set Vol.1 Booster Pack" at EUR 243.75, which is plainly not one pack.
const BOOSTER_PACK_TAIL = /(?:^|\s)(?:sleeved\s+)?booster$/

// A name ending in "booster" that is still not the set's retail pack: a deck
// bonus pack, a box-purchase promo, or a gift set.
const PACK_DISQUALIFIER = /\b(?:deck|promotion|bonus|gift)\b/

/**
 * Classify one Cardmarket sealed product name, with the reasoning attached.
 *
 * @param {string} name raw Cardmarket product name
 * @returns {{kind: 'booster_box'|'booster_pack'|'case'|'deck'|'other',
 *            confident: boolean, rule: string, normalized: string}}
 *   `confident:false` means "we bucketed this, but a human should look at it".
 *   It never applies to an in-scope kind: anything we are unsure about is put
 *   out of scope first and flagged second.
 */
export function classifyName(name) {
  const normalized = normalizeName(name)
  if (!normalized) return { kind: 'other', confident: false, rule: 'empty_name', normalized }

  const stripped = stripQualifiers(normalized)

  // 1. CASE FIRST, ALWAYS. Every later rule would misfire on a case name.
  if (CASE_WORD.test(stripped)) {
    return { kind: 'case', confident: true, rule: 'case_word', normalized }
  }
  if (CASE_MULTIPLIER.test(stripped)) {
    return { kind: 'case', confident: true, rule: 'case_multiplier', normalized }
  }

  // 2. Deck products. Checked before the box/pack rules so that
  //    "Starter Deck EX: "Gear 5" Bonus Pack Booster" cannot be sold as a pack.
  if (DECK_WORD.test(stripped)) {
    // A deck name that also says "booster" is a deck bonus item, not a deck and
    // not a pack. Out of scope either way, but say so rather than pretend.
    const odd = /\bbooster\b/.test(stripped)
    return { kind: 'deck', confident: !odd, rule: odd ? 'deck_word_with_booster' : 'deck_word', normalized }
  }

  // 3. Booster box. Safe now that both case forms are gone.
  if (BOOSTER_BOX.test(stripped)) {
    return { kind: 'booster_box', confident: true, rule: 'booster_box', normalized }
  }

  // 4. Single booster pack.
  if (BOOSTER_PACK_TAIL.test(stripped)) {
    if (PACK_DISQUALIFIER.test(stripped)) {
      return { kind: 'other', confident: false, rule: 'booster_tail_but_disqualified', normalized }
    }
    return { kind: 'booster_pack', confident: true, rule: 'booster_pack_tail', normalized }
  }

  // 5. Everything else. Flag it only when the name mentions "booster" at all -
  //    those are the ones where a missed in-scope product would hide.
  const mentionsBooster = /\bbooster/.test(stripped)
  return {
    kind: 'other',
    confident: !mentionsBooster,
    rule: mentionsBooster ? 'other_mentions_booster' : 'other',
    normalized,
  }
}

/**
 * The required entry point. "Emperors in the New World Booster Box (Non-English)"
 * -> 'booster_box'; "Emperors in the New World Booster Box Case (12x Booster Box)"
 * -> 'case'.
 */
export function kindOf(name) {
  return classifyName(name).kind
}

/** Count every row by kind, and collect the names we were not sure about. */
export function kindDistribution(rows) {
  const counts = Object.fromEntries(SEALED_KINDS.map((k) => [k, 0]))
  const unconfident = []
  for (const row of rows ?? []) {
    const verdict = classifyName(row?.name)
    counts[verdict.kind] += 1
    if (!verdict.confident) {
      unconfident.push({
        productId: Number(row?.productId),
        name: String(row?.name ?? ''),
        kind: verdict.kind,
        rule: verdict.rule,
      })
    }
  }
  return { counts, unconfident, total: (rows ?? []).length }
}

// ---------------------------------------------------------------------------
// Set code derivation
// ---------------------------------------------------------------------------

/**
 * Sealed product names carry no card code, so the set code has to come from the
 * singles. Every row in data/cardmarket.json carries BOTH expansionId and
 * cardCode, so the modal set code within an expansion is the derivation.
 *
 * `minShare` is a real guard, not decoration: a promo expansion legitimately
 * mixes OP01/OP05/P codes, and a 40%-plurality "set code" there would be a
 * fabrication. Below the threshold we return no code rather than a wrong one.
 *
 * @param {Array<{expansionId:number, cardCode:string|null, name?:string}>} singlesRows
 * @param {{minShare?:number, setCodeOf?:(code:string)=>string|null}} options
 * @returns {Map<number, {setCode:string|null, count:number, coded:number,
 *          share:number, runnerUp:string|null, reason:string}>}
 */
export function deriveSetCodes(singlesRows, { minShare = 0.6, setCodeOf = defaultSetCodeOf } = {}) {
  const tally = new Map()
  for (const row of singlesRows ?? []) {
    const expansionId = Number(row?.expansionId)
    if (!Number.isInteger(expansionId)) continue
    const setCode = setCodeOf(row?.cardCode)
    let bucket = tally.get(expansionId)
    if (!bucket) {
      bucket = { counts: new Map(), coded: 0, total: 0 }
      tally.set(expansionId, bucket)
    }
    bucket.total += 1
    if (!setCode) continue
    bucket.coded += 1
    bucket.counts.set(setCode, (bucket.counts.get(setCode) ?? 0) + 1)
  }

  const out = new Map()
  for (const [expansionId, bucket] of tally) {
    const ranked = [...bucket.counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    if (ranked.length === 0) {
      out.set(expansionId, {
        setCode: null, count: 0, coded: 0, share: 0, runnerUp: null,
        reason: 'no_coded_singles',
      })
      continue
    }
    const [setCode, count] = ranked[0]
    const share = bucket.coded === 0 ? 0 : count / bucket.coded
    const runnerUp = ranked[1]?.[0] ?? null
    out.set(expansionId, {
      setCode: share >= minShare ? setCode : null,
      count,
      coded: bucket.coded,
      share,
      runnerUp,
      reason: share >= minShare ? 'modal' : `below_min_share:${share.toFixed(2)}`,
    })
  }
  return out
}

/** "OP09-119" -> "OP09"; "P-001" -> "P"; anything else -> null. */
function defaultSetCodeOf(cardCode) {
  if (typeof cardCode !== 'string') return null
  const dash = cardCode.indexOf('-')
  return dash > 0 ? cardCode.slice(0, dash) : null
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function num(value) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/**
 * Pick the sealed products we are willing to price.
 *
 * Exclusions are COUNTED, never hidden - the caller prints every bucket. Order
 * of the gates matters for the report (a row is attributed to the first gate it
 * fails), not for the outcome.
 *
 * @param {object} args
 * @param {Array<object>} args.rows          raw Cardmarket sealed rows
 * @param {Map<number,{name:string,language:string}>} args.expansions from loadExpansions()
 * @param {Map<number,{setCode:string|null}>} [args.setCodes] from deriveSetCodes()
 * @returns {{items: Array<object>, excluded: object, collisions: Array<object>,
 *            unconfident: Array<object>, setCodeStats: object}}
 */
export function selectSealed({ rows, expansions, setCodes = new Map() }) {
  const excluded = {
    bad_row: 0,
    out_of_scope_kind: 0,
    unknown_expansion: 0,
    language_not_japanese: 0,
    non_eur_currency: 0,
    no_price: 0,
    duplicate_product_id: 0,
  }
  const byKindExcluded = Object.fromEntries(SEALED_KINDS.map((k) => [k, 0]))
  const byLanguageExcluded = {}
  const items = []
  const unconfident = []
  const seen = new Set()

  for (const raw of rows ?? []) {
    const productId = Number(raw?.productId)
    const name = typeof raw?.name === 'string' ? raw.name : ''
    if (!Number.isInteger(productId) || !name) {
      excluded.bad_row += 1
      continue
    }

    const verdict = classifyName(name)
    if (!verdict.confident) {
      unconfident.push({ productId, name, kind: verdict.kind, rule: verdict.rule })
    }
    if (!IN_SCOPE_KINDS.includes(verdict.kind)) {
      excluded.out_of_scope_kind += 1
      byKindExcluded[verdict.kind] += 1
      continue
    }

    const expansionId = Number(raw?.expansionId)
    const expansion = Number.isInteger(expansionId) ? expansions?.get?.(expansionId) : null
    if (!expansion) {
      // An expansion we have never mapped is 'unknown' by definition, and
      // 'unknown' fails closed. Same rule the singles pipeline uses.
      excluded.unknown_expansion += 1
      continue
    }
    if (expansion.language !== PRICED_LANGUAGE) {
      excluded.language_not_japanese += 1
      byLanguageExcluded[expansion.language] = (byLanguageExcluded[expansion.language] ?? 0) + 1
      continue
    }

    if (raw?.currency != null && String(raw.currency).toUpperCase() !== 'EUR') {
      excluded.non_eur_currency += 1
      continue
    }

    const trendEur = num(raw?.priceTrendEur)
    const lowEur = num(raw?.priceLowEur)
    const avg7Eur = num(raw?.avg7DayEur)
    if (trendEur == null && lowEur == null && avg7Eur == null) {
      // Nothing to show. A sealed entry with no number is worse than no entry.
      excluded.no_price += 1
      continue
    }

    if (seen.has(productId)) {
      excluded.duplicate_product_id += 1
      continue
    }
    seen.add(productId)

    items.push({
      productId,
      name,
      kind: verdict.kind,
      expansionId,
      expansionName: expansion.name ?? null,
      setCode: setCodes.get(expansionId)?.setCode ?? null,
      trendEur,
      lowEur,
      avg7Eur,
      productUrl: typeof raw?.productUrl === 'string' ? raw.productUrl : null,
    })
  }

  items.sort((a, b) =>
    (a.setCode ?? '~').localeCompare(b.setCode ?? '~') ||
    a.kind.localeCompare(b.kind) ||
    a.productId - b.productId,
  )

  const withSetCode = items.filter((i) => i.setCode != null).length
  const unresolvedExpansions = [
    ...new Map(
      items.filter((i) => i.setCode == null).map((i) => [i.expansionId, { expansionId: i.expansionId, expansionName: i.expansionName }]),
    ).values(),
  ]

  return {
    items,
    excluded: { ...excluded, byKind: byKindExcluded, byLanguage: byLanguageExcluded },
    collisions: findCollisions(items),
    unconfident,
    setCodeStats: {
      total: items.length,
      withSetCode,
      withoutSetCode: items.length - withSetCode,
      rate: items.length === 0 ? null : withSetCode / items.length,
      pct: items.length === 0 ? 'n/a' : `${((withSetCode / items.length) * 100).toFixed(1)}%`,
      unresolvedExpansions,
    },
  }
}

/**
 * Two in-scope products sharing a set code AND a kind. We do NOT pick one - the
 * caller reports them and the UI shows both, exactly as it does for ambiguous
 * singles. Items with no set code cannot collide (there is nothing to collide on).
 */
export function findCollisions(items) {
  const groups = new Map()
  for (const item of items ?? []) {
    if (item.setCode == null) continue
    const key = `${item.setCode}|${item.kind}`
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => {
      const [setCode, kind] = key.split('|')
      return { setCode, kind, items: list }
    })
}

// ---------------------------------------------------------------------------
// File shape
// ---------------------------------------------------------------------------

/** Build the data/sealed.json payload. */
export function buildSealedFile({ items, priceGuideDate = null, source, generatedAt = new Date().toISOString() }) {
  return {
    generatedAt,
    priceGuideDate,
    source,
    items: items ?? [],
  }
}

/**
 * Normalise a data/sealed.json document into index items, adding the nullable
 * `jpyRef` the contract carries.
 *
 * jpyRef is ALWAYS null today and that is deliberate, not a stub: there is no
 * Japanese sealed price source. Yuyu-tei sells no sealed product (/sell/opc/box
 * 404s), Hareruya2's unopened collection is Pokemon-only, and Rakuten's API needs
 * an applicationId we do not have. The field exists so that adding one later is a
 * data change, not a contract change. The UI must read null as "no Japanese
 * reference exists", never as "the reference is zero".
 */
export function sealedIndexItems(file) {
  if (!file || !Array.isArray(file.items)) return []
  return file.items.map((item) => ({
    productId: Number(item.productId),
    name: String(item.name ?? ''),
    kind: item.kind,
    expansionId: Number(item.expansionId),
    expansionName: item.expansionName ?? null,
    setCode: item.setCode ?? null,
    trendEur: num(item.trendEur),
    lowEur: num(item.lowEur),
    avg7Eur: num(item.avg7Eur),
    productUrl: item.productUrl ?? null,
    jpyRef: null,
  }))
}

/** True when a sealed document is safe to fold into the index. */
export function isUsableSealedFile(file) {
  return Boolean(file) && Array.isArray(file.items) && file.items.length > 0
}
