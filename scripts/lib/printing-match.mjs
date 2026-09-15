// scripts/lib/printing-match.mjs
//
// PRINTING-MATCH v1 - expansion-blocked rank pairing.
//
// WHAT THIS IS FOR
//   A card CODE is not a PRINTING. OP09-119 exists as base, parallel, super
//   parallel, signed, anniversary. Yuyu-tei is printing-level; Cardmarket's bulk
//   price-guide rows are not (no rarity field, no variant field). So joinCards()
//   attaches every candidate and marks the card 'ambiguous'. That is SAFE but
//   nearly useless at a shop counter, where OP09-033 offers five candidates
//   spanning EUR 0.02 to EUR 1,383.33.
//
// THE ONE RULE
//   Today the app is SAFELY VAGUE. The failure mode this file must not introduce
//   is CONFIDENTLY WRONG. Everything here produces a LIKELIHOOD, never a
//   verification:
//     - no candidate is ever removed from card.eu, and the order never changes
//     - euStatus is never touched; a narrowed card stays 'ambiguous'
//     - every pairing carries its own reasoning and its own confidence level
//     - when the evidence is weak we emit NO match metadata at all, and the card
//       falls back to today's show-everything behaviour
//
// THE SIGNAL
//   Within one card code the cheapest Japanese printing is almost certainly the
//   cheapest Cardmarket printing, and the dearest the dearest: both markets price
//   the same physical scarcity. Rank correlation is therefore real evidence - but
//   only once the ladders have been cut into blocks that actually correspond
//   (see the starter-deck inversion in matchCode's notes), and only when the
//   rungs are far enough apart that the ordering is not noise.
//
// Pure module: no I/O, no globals, no clock. Everything is unit-testable.

/* ------------------------------------------------------------------ *
 * 0. Constants
 * ------------------------------------------------------------------ */

/**
 * L3 PROMO POOL. Yuyu-tei lumps promos into seven listing buckets; Cardmarket
 * splits the same cards across three expansions. The correspondence is genuinely
 * many-to-many (a per-bucket residual vote reaches only 86.5-92.5% purity), so we
 * do NOT pick one. All seven buckets and all three expansions merge into a single
 * pseudo-block. A coarse block is honest; a wrong block is not.
 */
export const PROMO_BUCKETS = new Set([
  'promo-op10',
  'promo-op20',
  'promo-st10',
  'promo-eb10',
  'promo-prb10',
  'promo-100',
  'promo-200',
])
export const PROMO_EXPANSIONS = new Set([5510, 5511, 5598])
export const PROMO_BLOCK = 'PROMO'

/** Learning thresholds. See learnSetBucketMap for why there are two tiers. */
export const L1_MIN_PURITY = 0.95
export const L1_MIN_N = 5
export const L1_UNANIMOUS_MIN_N = 1
export const L2_MIN_PURITY = 0.8
export const L2_MIN_N = 5

/**
 * Separation gates, in natural-log units of adjacent price ratio.
 * Calibrated, not guessed: measured pairing accuracy runs 84.8% below 0.5,
 * 89.5% at 0.5-1.0, 88.2% at 1.0-1.6 and 100.0% (40/40 codes) above 1.6.
 * Below 0.5 (a 1.65x adjacent step) the signal is not weak, it is ABSENT:
 * 28% strictly-best permutation against a 35.5% chance baseline.
 */
export const SEPARATION_STRONG = 1.0
export const SEPARATION_MODERATE = 0.5

/**
 * Cardmarket's bulk trend prices below this are quantised to 0.02/0.03/0.04/0.05
 * and carry no ordering information at all.
 */
export const EUR_FLOOR = 0.2

/**
 * Plausibility guard for expansion-determined pairings. 0.62 is the measured
 * central log ratio of (jpySell converted to EUR) / trendEur; 3.0 log units is
 * ~20x either side of it.
 */
export const CENTRAL_LOG_RATIO = 0.62
export const PLAUSIBILITY_TOLERANCE = 3.0

/**
 * Fallback FX, used ONLY by the plausibility guard. build-index.mjs resolves the
 * real rate after the join, so the matcher cannot see it. This is safe because
 * the guard's band is +/-3 log units (~20x): a few percent of FX drift cannot
 * move a pairing across a 20x threshold. Never use this constant to show a price.
 */
export const DEFAULT_JPY_PER_EUR = 178.3369

/* ------------------------------------------------------------------ *
 * 1. Blocking
 * ------------------------------------------------------------------ */

/** Block key for a Yuyu-tei printing: 'PROMO', an expansionId, or null. */
export function blockJp(card, setBucketMap) {
  const bucket = String(card?.setBucket ?? '')
  if (PROMO_BUCKETS.has(bucket)) return PROMO_BLOCK
  if (!setBucketMap) return null
  const mapped = setBucketMap instanceof Map ? setBucketMap.get(bucket) : setBucketMap[bucket]
  return mapped === undefined || mapped === null ? null : mapped
}

/** Block key for a Cardmarket candidate: 'PROMO' or its expansionId. */
export function blockEu(candidate) {
  const expansionId = Number(candidate?.expansionId)
  if (!Number.isInteger(expansionId)) return null
  return PROMO_EXPANSIONS.has(expansionId) ? PROMO_BLOCK : expansionId
}

/* ------------------------------------------------------------------ *
 * 2. Learning the setBucket -> expansionId table
 * ------------------------------------------------------------------ */

function topEntry(counts) {
  let bestKey = null
  let bestN = -1
  let total = 0
  let distinct = 0
  for (const [key, n] of counts) {
    total += n
    distinct++
    if (n > bestN) {
      bestN = n
      bestKey = key
    }
  }
  return { key: bestKey, n: bestN, total, purity: total === 0 ? 0 : bestN / total, distinct }
}

/**
 * Learn SETBUCKET_MAP from the joined cards themselves. This is a build artefact
 * derived from data, never a hand-written table - a hand-written table silently
 * rots when a set is added.
 *
 * L1  Every euStatus 'ok' card is a KNOWN-TRUE pair by construction: exactly one
 *     Yuyu-tei printing of that code and exactly one Cardmarket candidate. Tally
 *     setBucket x expansionId over those and accept a bucket when its top
 *     expansion is clean enough.
 *
 *     Two accept tiers, because the spec's single n>=5 rule and the data disagree
 *     and the disagreement matters:
 *       'volume'    purity >= 0.95 and n >= 5.
 *       'unanimous' every observation of the bucket agrees (purity 1.0) but n < 5.
 *     Thirteen real buckets sit in the second tier, including st17 (n=1),
 *     st19 (n=4) and st20 (n=3) - which are exactly the buckets the starter-deck
 *     inversion (OP02-093, OP01-060, OP03-099) needs in order to resolve at all.
 *     Dropping them would not be conservative, it would refuse the cases blocking
 *     was invented to fix. The tier is recorded per bucket so the build report can
 *     show which mappings rest on thin evidence.
 *
 *     INJECTIVITY GUARD: a set bucket and a Cardmarket expansion are a structural
 *     one-to-one correspondence. If two non-PROMO buckets claim the same
 *     expansion, at most one can be right and we cannot tell which, so BOTH are
 *     dropped. (Measured on real data: zero collisions outside the PROMO pool,
 *     which is precisely why merging the promo buckets is the right call.)
 *
 * L2  Residual pass for pure-reprint buckets, which never produce an 'ok' card and
 *     so are invisible to L1. For each code, EXPLAINED = the block keys of its
 *     already-mapped printings. If the code has exactly ONE unmapped bucket and
 *     exactly ONE unexplained candidate block, that bucket must account for it.
 *
 * A bucket that fails its threshold stays UNMAPPED and all of its cards refuse.
 * That is the fail-closed direction: purity regression narrows the map, it never
 * silently widens it.
 *
 * @param {Array} cards joined Card[] (the whole set, not just the ambiguous ones)
 * @returns {{map: Map<string, number|'PROMO'>, entries: Array, stats: object}}
 */
export function learnSetBucketMap(cards) {
  const list = Array.isArray(cards) ? cards : []

  /* --- L1 ------------------------------------------------------- */
  const l1Counts = new Map()
  for (const card of list) {
    if (card?.euStatus !== 'ok') continue
    const candidate = Array.isArray(card.eu) ? card.eu[0] : null
    if (!candidate) continue
    const bucket = String(card.setBucket ?? '')
    if (!bucket || PROMO_BUCKETS.has(bucket)) continue // PROMO is decided by L3
    const key = blockEu(candidate)
    if (key === null) continue
    let counts = l1Counts.get(bucket)
    if (!counts) l1Counts.set(bucket, (counts = new Map()))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const entries = []
  const rejected = []
  const accepted = new Map()
  for (const [bucket, counts] of l1Counts) {
    const top = topEntry(counts)
    const unanimous = top.purity === 1
    let tier = null
    if (top.purity >= L1_MIN_PURITY && top.n >= L1_MIN_N) tier = 'volume'
    else if (unanimous && top.n >= L1_UNANIMOUS_MIN_N) tier = 'unanimous'
    if (tier === null) {
      rejected.push({ bucket, pass: 'L1', n: top.total, purity: top.purity, why: 'below purity/volume thresholds' })
      continue
    }
    accepted.set(bucket, { bucket, expansionId: top.key, pass: 'L1', tier, n: top.total, purity: top.purity })
  }

  // Injectivity guard (PROMO excluded: L3 merges it on purpose).
  const byExpansion = new Map()
  for (const entry of accepted.values()) {
    if (entry.expansionId === PROMO_BLOCK) continue
    const bucketList = byExpansion.get(entry.expansionId)
    if (bucketList) bucketList.push(entry)
    else byExpansion.set(entry.expansionId, [entry])
  }
  const collisions = []
  for (const [expansionId, bucketList] of byExpansion) {
    if (bucketList.length < 2) continue
    collisions.push({ expansionId, buckets: bucketList.map((e) => e.bucket) })
    for (const entry of bucketList) {
      accepted.delete(entry.bucket)
      rejected.push({
        bucket: entry.bucket,
        pass: 'L1',
        n: entry.n,
        purity: entry.purity,
        why: `expansion ${expansionId} is also claimed by ${bucketList.filter((e) => e !== entry).map((e) => e.bucket).join(', ')}`,
      })
    }
  }

  const map = new Map()
  for (const [bucket, entry] of accepted) map.set(bucket, entry.expansionId)

  /* --- L2 residual ---------------------------------------------- */
  const byCode = new Map()
  for (const card of list) {
    const code = String(card?.code ?? '')
    if (!code || code === '-') continue
    const bucketList = byCode.get(code)
    if (bucketList) bucketList.push(card)
    else byCode.set(code, [card])
  }

  const l2Counts = new Map()
  for (const group of byCode.values()) {
    const candidates = Array.isArray(group[0]?.eu) ? group[0].eu : []
    if (candidates.length === 0) continue

    const explained = new Set()
    const unmappedBuckets = new Set()
    for (const card of group) {
      const key = blockJp(card, map)
      if (key === null) unmappedBuckets.add(String(card.setBucket ?? ''))
      else explained.add(key)
    }
    if (unmappedBuckets.size !== 1) continue

    const residual = new Set()
    for (const candidate of candidates) {
      const key = blockEu(candidate)
      if (key !== null && !explained.has(key)) residual.add(key)
    }
    if (residual.size !== 1) continue

    const bucket = [...unmappedBuckets][0]
    if (!bucket || PROMO_BUCKETS.has(bucket)) continue
    const key = [...residual][0]
    let counts = l2Counts.get(bucket)
    if (!counts) l2Counts.set(bucket, (counts = new Map()))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  for (const [bucket, counts] of l2Counts) {
    const top = topEntry(counts)
    if (top.purity < L2_MIN_PURITY || top.n < L2_MIN_N) {
      rejected.push({ bucket, pass: 'L2', n: top.total, purity: top.purity, why: 'below residual thresholds' })
      continue
    }
    if (top.key === PROMO_BLOCK) {
      // A residual that lands in the promo pool tells us nothing a bucket can own.
      rejected.push({ bucket, pass: 'L2', n: top.total, purity: top.purity, why: 'residual is the PROMO pool' })
      continue
    }
    if (byExpansion.has(top.key)) {
      rejected.push({ bucket, pass: 'L2', n: top.total, purity: top.purity, why: `expansion ${top.key} already owned by an L1 bucket` })
      continue
    }
    map.set(bucket, top.key)
    accepted.set(bucket, { bucket, expansionId: top.key, pass: 'L2', tier: 'residual', n: top.total, purity: top.purity })
  }

  for (const entry of accepted.values()) entries.push(entry)
  entries.sort((a, b) => a.bucket.localeCompare(b.bucket))

  return {
    map,
    entries,
    stats: {
      buckets: map.size,
      l1: entries.filter((e) => e.pass === 'L1').length,
      l1Volume: entries.filter((e) => e.tier === 'volume').length,
      l1Unanimous: entries.filter((e) => e.tier === 'unanimous').length,
      l2: entries.filter((e) => e.pass === 'L2').length,
      rejected,
      collisions,
    },
  }
}

/* ------------------------------------------------------------------ *
 * 3. Copy
 * ------------------------------------------------------------------ */

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']

export function ordinal(n) {
  return ORDINALS[n] ?? `${n}th`
}

/** exp(separation), i.e. the smallest adjacent price step, as a display number. */
function stepMultiple(separation) {
  return Math.round(Math.exp(separation) * 10) / 10
}

/**
 * UI copy. The words "verified", "match", "confirmed" and "is" are deliberately
 * absent, and no string here ever stands alone as a price.
 */
function reasonText(reasonCode, context) {
  switch (reasonCode) {
    case 'expansion_sole':
      return `Only one Cardmarket printing of this card is listed in ${context.expansionName}, which is where this Yuyu-tei printing sits.`
    case 'promo_sole':
      return 'Only one Cardmarket promo printing of this card is listed, and this Yuyu-tei printing is a promo too. Promo sets are pooled, so this is a coarser grouping than a normal set.'
    case 'rank_separated':
      return `Matched by price order: this is the ${ordinal(context.rank)} of ${context.ofM} printings on both sites, and they are far enough apart (${context.stepX}x steps) to line up.`
    case 'rank_close':
      return `Matched by price order, but the printings are close in price (${context.stepX}x steps). Could be the wrong one.`
    default:
      return ''
  }
}

function refusalText(reasonCode, context) {
  switch (reasonCode) {
    case 'block_count_mismatch':
      return `Yuyu-tei lists ${context.jpInBlock} printings, Cardmarket lists ${context.euInBlock}.`
    case 'low_separation':
      return 'These printings are too close in price to tell apart.'
    case 'eur_floor':
      return 'Cardmarket prices these printings too low to put them in a reliable order.'
    case 'eu_price_missing':
      return 'Cardmarket has no trend price for at least one of these printings.'
    case 'jp_price_missing':
      return 'Yuyu-tei has no usable price for at least one of these printings.'
    case 'no_candidate_in_block':
      return 'No Cardmarket printing of this card is listed in the set this Yuyu-tei printing comes from.'
    case 'unmapped_bucket':
      return 'We have not established which Cardmarket set this Yuyu-tei printing belongs to.'
    case 'implausible_ratio':
      return 'The only Cardmarket printing in this set is priced far too differently from the Japanese price to be the same printing.'
    default:
      return ''
  }
}

/* ------------------------------------------------------------------ *
 * 4. The matcher, one card code at a time
 * ------------------------------------------------------------------ */

function refusal(reasonCode, context = {}) {
  return {
    match: null,
    refusal: { reasonCode, reason: refusalText(reasonCode, context), ...context },
  }
}

/**
 * Pair the Yuyu-tei printings of ONE card code against its Cardmarket candidates.
 *
 * Returns an array aligned 1:1 with `printings`. Each entry is either
 *   { match: {...}, refusal: null }   a LIKELIHOOD, with its reasoning attached
 * or
 *   { match: null, refusal: {...} }   no guess at all, plus why, for the copy
 *
 * WHY BLOCKING COMES FIRST, AND WHY WE NEVER PAIR ACROSS BLOCKS
 *   The starter-deck inversion: OP02-093 is sold in Japan as an ST reprint at
 *   JPY 50, a booster base at JPY 120 and a parallel at JPY 2,980-7,980, while
 *   Europe prices them 1.21 / 3.02 / ... The ST reprint is the CHEAPEST in Japan
 *   and the DEAREST-but-one in Europe, so a naive global rank pairing gets it
 *   exactly backwards. Cutting the ladders by expansion first fixes all three
 *   known instances. A leftover unpaired printing and a leftover unpaired
 *   candidate in DIFFERENT blocks are never joined up, however tempting the
 *   arithmetic - that is the exact move that produces a confident lie.
 *
 * @param {{printings: Array, candidates: Array, setBucketMap: Map, jpyPerEur?: number}} args
 */
export function matchCode({ printings = [], candidates = [], setBucketMap = new Map(), jpyPerEur = DEFAULT_JPY_PER_EUR }) {
  const results = printings.map(() => null)

  // 1. Block both sides.
  const jpBlocks = new Map()
  printings.forEach((card, index) => {
    const key = blockJp(card, setBucketMap)
    if (key === null) {
      // Never guess an expansion. A printing whose bucket we have not established
      // is refused outright, not folded into some neighbouring block.
      results[index] = refusal('unmapped_bucket', { setBucket: String(card?.setBucket ?? '') })
      return
    }
    const bucketList = jpBlocks.get(key)
    if (bucketList) bucketList.push(index)
    else jpBlocks.set(key, [index])
  })

  const euBlocks = new Map()
  for (const candidate of candidates) {
    const key = blockEu(candidate)
    if (key === null) continue
    const bucketList = euBlocks.get(key)
    if (bucketList) bucketList.push(candidate)
    else euBlocks.set(key, [candidate])
  }

  for (const [key, indices] of jpBlocks) {
    const euBlock = euBlocks.get(key) ?? []
    const m = indices.length

    // 2. Preconditions. Both are all-or-nothing for the whole block.
    if (euBlock.length === 0) {
      for (const index of indices) results[index] = refusal('no_candidate_in_block', { block: key, jpInBlock: m, euInBlock: 0 })
      continue
    }
    if (euBlock.length !== m) {
      // The single largest refusal class. One side lists a printing the other does
      // not, so SOME pairing in this block is guaranteed wrong and we cannot tell
      // which. Refuse all of them.
      for (const index of indices) results[index] = refusal('block_count_mismatch', { block: key, jpInBlock: m, euInBlock: euBlock.length })
      continue
    }

    const isPromo = key === PROMO_BLOCK

    // 3. Sole printing in a sole-candidate block: decided by expansion membership.
    //    PRICE IS NEVER CONSULTED here, which is what makes this the strongest
    //    evidence we have. The residual risk is not mis-ranking but mis-population
    //    (Yuyu-tei stocking the base while Cardmarket lists only the parallel),
    //    which is what the plausibility guard below is for.
    if (m === 1) {
      const index = indices[0]
      const card = printings[index]
      const candidate = euBlock[0]
      const trendEur = Number(candidate?.trendEur)
      const jpySell = Number(card?.jpySell)

      if (Number.isFinite(trendEur) && trendEur > 0 && Number.isFinite(jpySell) && jpySell > 0) {
        const logRatio = Math.log(jpySell / jpyPerEur / trendEur)
        if (Math.abs(logRatio - CENTRAL_LOG_RATIO) > PLAUSIBILITY_TOLERANCE) {
          results[index] = refusal('implausible_ratio', {
            block: key,
            jpInBlock: 1,
            euInBlock: 1,
            logRatio: Math.round(logRatio * 1000) / 1000,
          })
          continue
        }
      }

      const reasonCode = isPromo ? 'promo_sole' : 'expansion_sole'
      results[index] = {
        refusal: null,
        match: {
          productId: Number(candidate?.productId),
          // A pooled promo block is a coarse merge, so it can never earn 'exact'.
          level: isPromo ? 'strong' : 'exact',
          basis: 'expansion',
          block: key,
          rank: 1,
          ofM: 1,
          separation: null,
          stepX: null,
          reasonCode,
          reason: reasonText(reasonCode, { expansionName: String(candidate?.expansionName ?? '') }),
        },
      }
      continue
    }

    // 4. m >= 2: rank pairing inside the block.
    const euSorted = euBlock.slice()
    const euPrices = euSorted.map((candidate) => Number(candidate?.trendEur))
    if (euPrices.some((price) => !Number.isFinite(price) || price <= 0)) {
      // The EU ladder cannot be ordered at all.
      for (const index of indices) results[index] = refusal('eu_price_missing', { block: key, jpInBlock: m, euInBlock: euBlock.length })
      continue
    }
    const jpPrices = indices.map((index) => Number(printings[index]?.jpySell))
    if (jpPrices.some((price) => !Number.isFinite(price) || price <= 0)) {
      for (const index of indices) results[index] = refusal('jp_price_missing', { block: key, jpInBlock: m, euInBlock: euBlock.length })
      continue
    }

    const jpSorted = indices.slice().sort((a, b) => Number(printings[a].jpySell) - Number(printings[b].jpySell))
    euSorted.sort((a, b) => Number(a.trendEur) - Number(b.trendEur))

    // separation = the SMALLEST adjacent step on EITHER ladder. Min over both
    // sides, not the JP side alone: one tight pair anywhere is enough to make the
    // whole block's ordering a coin flip.
    let separation = Infinity
    for (let i = 0; i + 1 < m; i++) {
      separation = Math.min(
        separation,
        Math.log(Number(printings[jpSorted[i + 1]].jpySell) / Number(printings[jpSorted[i]].jpySell)),
        Math.log(Number(euSorted[i + 1].trendEur) / Number(euSorted[i].trendEur)),
      )
    }
    const floored = euSorted.some((candidate) => Number(candidate.trendEur) < EUR_FLOOR)

    let level = null
    let reasonCode = null
    if (separation >= SEPARATION_STRONG && !floored) {
      level = isPromo ? 'moderate' : 'strong'
      reasonCode = isPromo ? 'rank_close' : 'rank_separated'
    } else if (separation >= SEPARATION_MODERATE && !floored) {
      level = 'moderate'
      reasonCode = 'rank_close'
    } else if (separation >= SEPARATION_STRONG && floored) {
      // Wide nominal gaps, but a candidate sits in the quantisation region where
      // Cardmarket's trend price is 0.02/0.03/0.04/0.05 and encodes no order.
      // OP06-104 and OP05-106 clear the bar this way and are both still wrong.
      level = 'moderate'
      reasonCode = 'rank_close'
    }

    if (level === null) {
      const reasonCodeOut = separation < SEPARATION_MODERATE ? 'low_separation' : 'eur_floor'
      for (const index of indices) {
        results[index] = refusal(reasonCodeOut, {
          block: key,
          jpInBlock: m,
          euInBlock: euBlock.length,
          separation: Math.round(separation * 1000) / 1000,
          floored,
        })
      }
      continue
    }

    const stepX = stepMultiple(separation)
    jpSorted.forEach((index, i) => {
      const candidate = euSorted[i]
      results[index] = {
        refusal: null,
        match: {
          productId: Number(candidate?.productId),
          level,
          basis: 'rank',
          block: key,
          rank: i + 1,
          ofM: m,
          separation: Math.round(separation * 1000) / 1000,
          stepX,
          reasonCode,
          reason: reasonText(reasonCode, { rank: i + 1, ofM: m, stepX }),
        },
      }
    })
  }

  return results.map((entry) => entry ?? refusal('unmapped_bucket'))
}

/* ------------------------------------------------------------------ *
 * 5. Applying it to a whole joined card list
 * ------------------------------------------------------------------ */

/** exact|strong -> 'strong', moderate -> 'weak'. Refusals get nothing at all. */
export function likelihoodOf(level) {
  return level === 'exact' || level === 'strong' ? 'strong' : 'weak'
}

/**
 * Annotate a joined Card[] in place with euMatch / euBestGuess / euRefusal.
 *
 * INVARIANTS, all asserted by the tests:
 *   - card.euStatus is never written. A narrowed card stays 'ambiguous'.
 *   - card.eu keeps every candidate, in the same order.
 *   - only euStatus 'ambiguous' cards are considered. 'ok' cards are the
 *     known-true training data and need no guess; the rest have no candidates.
 *
 * card.eu is deep-copied per card first, because joinCards hands every printing
 * of a code the SAME candidate objects. Annotating shared objects would leak one
 * printing's best guess onto its siblings - a silent cross-contamination bug.
 */
export function applyPrintingMatch(cards, { setBucketMap = null, jpyPerEur = DEFAULT_JPY_PER_EUR } = {}) {
  const list = Array.isArray(cards) ? cards : []
  const learned = setBucketMap ? { map: setBucketMap, entries: [], stats: null } : learnSetBucketMap(list)
  const map = learned.map

  const byCode = new Map()
  for (const card of list) {
    if (card?.euStatus !== 'ambiguous') continue
    const code = String(card.code ?? '')
    if (!code || code === '-') continue
    const group = byCode.get(code)
    if (group) group.push(card)
    else byCode.set(code, [card])
  }

  const stats = {
    cardsConsidered: 0,
    matched: 0,
    refused: 0,
    byLevel: { exact: 0, strong: 0, moderate: 0 },
    byLikelihood: { strong: 0, weak: 0 },
    byRefusal: {},
    codesConsidered: byCode.size,
  }

  for (const group of byCode.values()) {
    const candidates = Array.isArray(group[0].eu) ? group[0].eu : []
    const results = matchCode({ printings: group, candidates, setBucketMap: map, jpyPerEur })

    group.forEach((card, index) => {
      stats.cardsConsidered++
      // Own copy of every candidate: same objects' data, same order, never fewer.
      card.eu = (Array.isArray(card.eu) ? card.eu : []).map((candidate) => ({ ...candidate }))

      const { match, refusal: why } = results[index]
      if (!match) {
        stats.refused++
        stats.byRefusal[why.reasonCode] = (stats.byRefusal[why.reasonCode] ?? 0) + 1
        // No guess of any kind - only the explanation the refusal copy needs.
        // The card falls straight back to today's show-everything behaviour.
        card.euRefusal = { reasonCode: why.reasonCode, reason: why.reason, jpPrintings: group.length, euCandidates: candidates.length }
        return
      }

      const likelihood = likelihoodOf(match.level)
      stats.matched++
      stats.byLevel[match.level]++
      stats.byLikelihood[likelihood]++

      card.euMatch = { ...match, likelihood }
      card.euBestGuess = match.productId

      // The candidate-level marker is deliberately just the two words the spec
      // allows inside the expanded list. The full sentence lives once, on
      // card.euMatch.reason - repeating it on the candidate would put the same
      // ~150 characters into the index 2,115 times for an offline phone app.
      const chosen = card.eu.find((candidate) => Number(candidate.productId) === match.productId)
      if (chosen) chosen.match = { likelihood, reason: 'best guess', rank: match.rank }
    })
  }

  return { setBucketMap: map, learned, stats }
}
