// scripts/lib/join.test.mjs
//   node --test scripts/lib/join.test.mjs
//
// These are not smoke tests. Every assertion here guards a way the app could
// put a wrong euro figure in front of someone holding cash at a shop counter.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeCode,
  normalizeText,
  canonicalCode,
  isCardCode,
  extractCodeFromName,
  setCodeOf,
  NO_CODE,
  buildExpansionIndex,
  intersectJapanese,
  indexCardmarketRows,
  joinCards,
  computeCoverage,
  statusBreakdown,
  missingSetDetail,
  jpVerdict,
  euContext,
  bandForDiffPct,
} from './join.mjs'

/* ------------------------------------------------------------------ *
 * Fixtures modelled on the real data
 * ------------------------------------------------------------------ */

// 5887 = "Emperors in the New World (Non-English)" -> OP09, Japanese.
// 5755 = "Emperors in the New World"               -> OP09, English.
// 6606 = "The Time of Battle (Asia Region Legal)"  -> OP16/OP17, UNRESOLVED.
const EXPANSIONS = {
  game: 'one-piece',
  expansions: [
    { expansionId: 5887, name: 'Emperors in the New World (Non-English)', language: 'japanese', basis: 'name_suffix' },
    { expansionId: 5755, name: 'Emperors in the New World', language: 'english_confirmed', basis: 'has_japanese_twin' },
    { expansionId: 6606, name: 'The Time of Battle (Asia Region Legal)', language: 'unknown', basis: 'UNRESOLVED' },
    { expansionId: 5482, name: 'Pillars of Strength (Japanese)', language: 'japanese', basis: 'name_suffix' },
  ],
}

const NO_OVERRIDES = { overrides: {} }

// GROUND TRUTH: OP09-119 exists twice inside ONE Japanese expansion.
const CM_ROWS = [
  { productId: 786553, name: 'Monkey.D.Luffy (OP09-119)', expansionId: 5887, priceTrendEur: 18.5, priceLowEur: 12.0, avg7DayEur: 19.1 },
  { productId: 786554, name: 'Monkey.D.Luffy (OP09-119) (V.2)', expansionId: 5887, priceTrendEur: 240.0, priceLowEur: 180.0, avg7DayEur: 233.4 },
  { productId: 786500, name: 'Shanks (OP09-001)', expansionId: 5887, priceTrendEur: 3.2, priceLowEur: 1.1, avg7DayEur: 3.4 },
  // English twin carrying the SAME code - must never become a candidate.
  { productId: 700001, name: 'Monkey.D.Luffy (OP09-119)', expansionId: 5755, priceTrendEur: 9.0, priceLowEur: 6.0, avg7DayEur: 9.2 },
  // Asia Region Legal, language unknown -> fails closed.
  { productId: 900017, name: 'Loki (OP17-118)', expansionId: 6606, priceTrendEur: 55.0, priceLowEur: 41.0, avg7DayEur: 57.0 },
  { productId: 550004, name: 'Trafalgar Law (OP03-047)', expansionId: 5482, priceTrendEur: 2.0, priceLowEur: 0.9, avg7DayEur: 2.1 },
]

const yuyu = (over) => ({
  code: 'OP09-119',
  name: 'モンキー・D・ルフィ',
  variant: null,
  rarity: 'L',
  setBucket: 'op09',
  cardId: '1',
  img: 'https://img/1.jpg',
  detailUrl: 'https://yuyu-tei.jp/card/1',
  jpySell: 2500,
  jpyBuy: 1800,
  jpyBuyPrev: null,
  inStock: true,
  stock: 3,
  ...over,
})

const YT_ROWS = [
  yuyu({}),
  yuyu({ code: 'OP09-001', cardId: '2', name: 'シャンクス', jpySell: 400 }),
  // set is priceable, this code is not in the pull -> no_match
  yuyu({ code: 'OP09-777', cardId: '3', name: '存在しないカード', jpySell: 100 }),
  // no verified Japanese expansion for OP17 -> unmapped_set
  yuyu({ code: 'OP17-118', cardId: '4', setBucket: 'op17', name: 'ロキ', jpySell: 9800 }),
  // DON!! carries no code at all
  yuyu({ code: '-', cardId: '5', setBucket: 'don', name: 'ドン!!カード', rarity: 'DON', jpySell: 300 }),
]

function indexFor(expansionsDoc = EXPANSIONS, overridesDoc = NO_OVERRIDES, rows = CM_ROWS) {
  const { index } = buildExpansionIndex(expansionsDoc, overridesDoc)
  return indexCardmarketRows(rows, index)
}

const byCardId = (cards, cardId) => cards.find((card) => card.cardId === cardId)

/* ------------------------------------------------------------------ *
 * 1. Code normalization
 * ------------------------------------------------------------------ */

test('normalizeCode folds fullwidth characters to ASCII', () => {
  assert.equal(normalizeCode('ＯＰ０９－１１９'), 'OP09-119')
})

test('normalizeCode unifies every dash variant', () => {
  for (const dash of ['-', '‐', '‑', '‒', '–', '—', '―', '−', '－', 'ー']) {
    assert.equal(normalizeCode(`OP09${dash}119`), 'OP09-119', `dash U+${dash.codePointAt(0).toString(16)}`)
  }
})

test('normalizeCode strips whitespace, invisibles and case', () => {
  assert.equal(normalizeCode('  op09 - 119\n'), 'OP09-119')
  assert.equal(normalizeCode('OP09　-­119'), 'OP09-119')
  assert.equal(normalizeCode('op09-119'), 'OP09-119')
})

test('normalizeCode PRESERVES leading zeros in the number', () => {
  assert.equal(normalizeCode('OP09-007'), 'OP09-007')
  assert.equal(normalizeCode('op01-001'), 'OP01-001')
  // and never pads or trims the set part
  assert.equal(normalizeCode('OP9-119'), 'OP9-119')
  assert.notEqual(normalizeCode('OP09-007'), 'OP09-7')
})

test('isCardCode accepts real One Piece shapes and rejects junk', () => {
  for (const code of ['OP09-119', 'ST01-001', 'EB01-061', 'PRB01-002', 'P-001']) {
    assert.ok(isCardCode(code), `${code} should be a code`)
  }
  for (const code of ['-', '', 'DON!!', 'OP09', '119', 'OP09-', 'OPTIONAL-001']) {
    assert.ok(!isCardCode(code), `${code} should not be a code`)
  }
})

test('canonicalCode maps uncoded SKUs to the contract sentinel "-"', () => {
  assert.equal(canonicalCode('-'), NO_CODE)
  assert.equal(canonicalCode('ー'), NO_CODE)
  assert.equal(canonicalCode(''), NO_CODE)
  assert.equal(canonicalCode(null), NO_CODE)
  assert.equal(canonicalCode('DON!!'), NO_CODE)
  assert.equal(canonicalCode('op09-119'), 'OP09-119')
})

test('normalizeText collapses whitespace but keeps words apart', () => {
  assert.equal(normalizeText('  Monkey.D.Luffy   (OP09-119) '), 'MONKEY.D.LUFFY (OP09-119)')
})

test('extractCodeFromName pulls the code out of a Cardmarket product name', () => {
  assert.equal(extractCodeFromName('Monkey.D.Luffy (OP09-119)'), 'OP09-119')
  assert.equal(extractCodeFromName('Monkey.D.Luffy (OP09-119) (V.2)'), 'OP09-119')
  assert.equal(extractCodeFromName('Monkey.D.Luffy (Parallel) (OP09-119)'), 'OP09-119')
  assert.equal(extractCodeFromName('Ｍｏｎｋｅｙ (ＯＰ０９－１１９)'), 'OP09-119')
  assert.equal(extractCodeFromName('Uta (P-001)'), 'P-001')
})

test('extractCodeFromName returns "-" rather than guessing', () => {
  assert.equal(extractCodeFromName('Don!! Card'), NO_CODE)
  assert.equal(extractCodeFromName('OP17'), NO_CODE)
  assert.equal(extractCodeFromName('Starter Deck: 3D2Y (Display)'), NO_CODE)
  assert.equal(extractCodeFromName(''), NO_CODE)
  assert.equal(extractCodeFromName(null), NO_CODE)
})

test('extractCodeFromName does not fall back to a bare match when the name uses parentheses', () => {
  // A name that follows the convention but whose parens hold no code must not
  // be rescued by scanning the rest of the string - that is how false joins happen.
  assert.equal(extractCodeFromName('Something OP09-119 Promo (Display)'), NO_CODE)
  // With no parentheses at all, the bare code is accepted.
  assert.equal(extractCodeFromName('Monkey.D.Luffy OP09-119'), 'OP09-119')
})

test('setCodeOf takes the set prefix and nothing else', () => {
  assert.equal(setCodeOf('OP09-119'), 'OP09')
  assert.equal(setCodeOf('op09-119'), 'OP09')
  assert.equal(setCodeOf('ST01-001'), 'ST01')
  assert.equal(setCodeOf('P-001'), 'P')
  assert.equal(setCodeOf('-'), '')
  assert.equal(setCodeOf('DON!!'), '')
})

/* ------------------------------------------------------------------ *
 * 2. Expansion language resolution
 * ------------------------------------------------------------------ */

test('buildExpansionIndex reads expansions.json languages', () => {
  const { index } = buildExpansionIndex(EXPANSIONS, NO_OVERRIDES)
  assert.equal(index.get(5887).language, 'japanese')
  assert.equal(index.get(5755).language, 'english_confirmed')
  assert.equal(index.get(6606).language, 'unknown')
})

test('overrides WIN over expansions.json, in both directions', () => {
  const { index, applied } = buildExpansionIndex(EXPANSIONS, {
    overrides: {
      6606: { language: 'japanese', name: 'The Time of Battle (JP)', why: 'listings verified Japanese in browser' },
      5887: { language: 'unknown', name: 'Emperors (disputed)', why: 'suffix turned out to be wrong' },
    },
  })
  assert.equal(index.get(6606).language, 'japanese')
  assert.equal(index.get(6606).name, 'The Time of Battle (JP)')
  assert.equal(index.get(5887).language, 'unknown')
  assert.equal(applied.length, 2)
})

test('an override may introduce an expansion that expansions.json has never seen', () => {
  // This is exactly how OP14-OP17 will arrive. No code change must be needed.
  const { index } = buildExpansionIndex(EXPANSIONS, {
    overrides: { 6789: { language: 'japanese', name: 'OP17 (Japanese)', why: 'verified' } },
  })
  assert.equal(index.get(6789).language, 'japanese')
  assert.equal(index.get(6789).source, 'expansion-overrides.json')
})

test('a malformed override FAILS CLOSED to unknown instead of keeping japanese', () => {
  const { index, rejected } = buildExpansionIndex(EXPANSIONS, {
    overrides: {
      5887: { language: 'japanse', name: 'typo' }, // misspelled language
      5482: 'japanese', // not an object
      notanid: { language: 'japanese' },
    },
  })
  assert.equal(index.get(5887).language, 'unknown')
  assert.equal(index.get(5482).language, 'unknown')
  assert.equal(rejected.length, 3)
})

test('intersectJapanese keeps japanese only where both sources agree', () => {
  const mine = buildExpansionIndex(EXPANSIONS, NO_OVERRIDES).index
  const theirs = new Map([
    [5887, { expansionId: 5887, name: 'x', language: 'english_confirmed' }],
    [6606, { expansionId: 6606, name: 'y', language: 'japanese' }],
  ])
  const { index, disagreements } = intersectJapanese(mine, theirs)
  assert.equal(index.get(5887).language, 'unknown', 'downgraded because the sibling disagrees')
  assert.equal(index.get(6606).language, 'unknown', 'the sibling alone cannot promote to japanese')
  assert.equal(disagreements.length, 2)
})

test('intersectJapanese treats an absent entry as no opinion, not as a denial', () => {
  const mine = buildExpansionIndex(EXPANSIONS, NO_OVERRIDES).index
  const partial = new Map([[5887, { expansionId: 5887, name: 'x', language: 'japanese' }]])
  const { index, disagreements } = intersectJapanese(mine, partial)
  assert.equal(index.get(5887).language, 'japanese')
  assert.equal(index.get(5482).language, 'japanese', 'a partial sibling index must not silently wipe coverage')
  assert.equal(disagreements.length, 0)
})

/* ------------------------------------------------------------------ *
 * 3. Japanese-only filtering
 * ------------------------------------------------------------------ */

test('only japanese expansions produce candidates', () => {
  const cm = indexFor()
  const candidates = cm.byCode.get('OP09-119')
  assert.equal(candidates.length, 2)
  assert.ok(
    candidates.every((candidate) => candidate.expansionId === 5887),
    'the English twin 5755 carries the same code and must be excluded',
  )
  assert.ok(!candidates.some((candidate) => candidate.productId === 700001))
})

test('language "unknown" is NOT eligible', () => {
  const cm = indexFor()
  assert.equal(cm.byCode.has('OP17-118'), false)
  assert.equal(cm.eligibleSets.has('OP17'), false)
})

test('a duplicated productId row does not manufacture an ambiguity', () => {
  const rows = [CM_ROWS[2], { ...CM_ROWS[2] }]
  const cm = indexFor(EXPANSIONS, NO_OVERRIDES, rows)
  assert.equal(cm.byCode.get('OP09-001').length, 1)
  assert.equal(cm.stats.duplicateProductRows, 1)
})

/* ------------------------------------------------------------------ *
 * 4. The join - the safety-critical cases
 * ------------------------------------------------------------------ */

test('OP09-119: TWO eligible printings -> ambiguous, BOTH attached, nothing collapsed', () => {
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: indexFor() })
  const card = byCardId(cards, '1')

  assert.equal(card.euStatus, 'ambiguous')
  assert.equal(card.eu.length, 2)
  assert.deepEqual(
    card.eu.map((candidate) => candidate.productId).sort(),
    [786553, 786554],
    'ground truth: both Cardmarket printings survive the join',
  )

  const trends = card.eu.map((candidate) => candidate.trendEur)
  assert.ok(trends.includes(18.5) && trends.includes(240), 'a 13x spread is preserved, not averaged')
  // No averaging / min / max / first-pick may have leaked into the card itself.
  assert.ok(!('trendEur' in card) && !('priceEur' in card) && !('eur' in card))
})

test('exactly one eligible printing -> ok', () => {
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: indexFor() })
  const card = byCardId(cards, '2')
  assert.equal(card.euStatus, 'ok')
  assert.equal(card.eu.length, 1)
  assert.equal(card.eu[0].productId, 786500)
  assert.equal(card.eu[0].expansionName, 'Emperors in the New World (Non-English)')
})

test('OP17 has no verified Japanese expansion -> unmapped_set with NO candidates', () => {
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: indexFor() })
  const card = byCardId(cards, '4')
  assert.equal(card.code, 'OP17-118')
  assert.equal(card.euStatus, 'unmapped_set')
  assert.deepEqual(card.eu, [], 'must never fall back to the Asia Region Legal printing')
})

test('OP17 becomes priceable the moment a human verifies it in expansion-overrides.json', () => {
  const cm = indexFor(EXPANSIONS, {
    overrides: { 6606: { language: 'japanese', name: 'The Time of Battle (JP)', why: 'verified in browser' } },
  })
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: cm })
  const card = byCardId(cards, '4')
  assert.equal(card.euStatus, 'ok')
  assert.equal(card.eu.length, 1)
  assert.equal(card.eu[0].productId, 900017)
})

test('a DON!! card with code "-" gets no_match and no candidates', () => {
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: indexFor() })
  const card = byCardId(cards, '5')
  assert.equal(card.code, '-')
  assert.deepEqual(card.eu, [])
  assert.equal(card.euStatus, 'no_match', 'no join key exists, so nothing can be matched')
  assert.equal(euContext(300, card.eu, { jpyPerEur: 170 }), null)
})

test('a code inside a priceable set that Cardmarket does not carry -> no_match', () => {
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: indexFor() })
  const card = byCardId(cards, '3')
  assert.equal(card.euStatus, 'no_match')
  assert.deepEqual(card.eu, [])
})

test('no cardmarket.json -> every card is not_pulled, never a guess', () => {
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: null })
  assert.equal(cards.length, YT_ROWS.length)
  assert.ok(cards.every((card) => card.euStatus === 'not_pulled'))
  assert.ok(cards.every((card) => card.eu.length === 0))
})

test('joined cards keep the Yuyu-tei fields the contract requires', () => {
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: indexFor() })
  const card = byCardId(cards, '1')
  assert.equal(card.jpySell, 2500)
  assert.equal(card.jpyBuy, 1800)
  assert.equal(card.jpyBuyPrev, null)
  assert.equal(card.inStock, true)
  assert.equal(card.stock, 3)
  assert.equal(card.rarity, 'L')
  assert.equal(card.setBucket, 'op09')
  assert.equal(card.variant, null)
})

test('malformed Yuyu-tei rows degrade instead of throwing', () => {
  const cards = joinCards({
    yuyuteiRows: [{ code: 'OP09-119' }, {}, { code: 'OP09-001', jpySell: '400', stock: '2', inStock: 'true' }],
    cardmarketIndex: indexFor(),
  })
  assert.equal(cards.length, 3)
  assert.equal(cards[0].jpySell, 0)
  assert.equal(cards[1].code, '-')
  assert.equal(cards[2].jpySell, 400)
  assert.equal(cards[2].stock, 2)
  assert.equal(cards[2].inStock, true)
})

/* ------------------------------------------------------------------ *
 * 5. Coverage
 * ------------------------------------------------------------------ */

test('computeCoverage diffs Yuyu-tei live sets against priceable sets', () => {
  const cm = indexFor()
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: cm })
  const coverage = computeCoverage(cards, cm)

  assert.deepEqual(coverage.yuyuteiSets, ['OP09', 'OP17'], 'the uncoded DON!! row contributes no set')
  assert.deepEqual(coverage.mappedSets, ['OP03', 'OP09'])
  assert.deepEqual(coverage.missingSets, ['OP17'])
  assert.equal(coverage.cardsTotal, 5)
  assert.equal(coverage.cardsWithEu, 2)
  assert.equal(coverage.cardsAmbiguous, 1)
})

test('with no cardmarket data every Yuyu-tei set counts as missing', () => {
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: null })
  const coverage = computeCoverage(cards, null)
  assert.deepEqual(coverage.mappedSets, [])
  assert.deepEqual(coverage.missingSets, ['OP09', 'OP17'])
  assert.equal(coverage.cardsWithEu, 0)
})

test('statusBreakdown and missingSetDetail report the hole in full', () => {
  const cm = indexFor()
  const cards = joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: cm })
  const coverage = computeCoverage(cards, cm)
  assert.deepEqual(statusBreakdown(cards), { ok: 1, ambiguous: 1, unmapped_set: 1, no_match: 2, not_pulled: 0 })
  assert.deepEqual(missingSetDetail(cards, coverage), [{ setCode: 'OP17', cards: 1, inStock: 1 }])
})

/* ------------------------------------------------------------------ *
 * 6. Verdict bands
 * ------------------------------------------------------------------ */

test('bandForDiffPct thresholds are inclusive upper bounds', () => {
  assert.equal(bandForDiffPct(-60), 'great')
  assert.equal(bandForDiffPct(-25), 'great')
  assert.equal(bandForDiffPct(-24.9), 'good')
  assert.equal(bandForDiffPct(-10), 'good')
  assert.equal(bandForDiffPct(-9.9), 'fair')
  assert.equal(bandForDiffPct(0), 'fair')
  assert.equal(bandForDiffPct(10), 'fair')
  assert.equal(bandForDiffPct(10.1), 'high')
  assert.equal(bandForDiffPct(30), 'high')
  assert.equal(bandForDiffPct(30.1), 'bad')
  assert.equal(bandForDiffPct(NaN), null)
})

test('jpVerdict compares yen to yen, no conversion, and bands the raw gap', () => {
  assert.deepEqual(jpVerdict(700, 1000), {
    band: 'great',
    diffPct: -30,
    askYen: 700,
    refYen: 1000,
    deltaYen: -300,
    source: 'yuyu-tei',
    primary: true,
  })
  assert.equal(jpVerdict(750, 1000).band, 'great')
  assert.equal(jpVerdict(850, 1000).band, 'good')
  assert.equal(jpVerdict(1000, 1000).band, 'fair')
  assert.equal(jpVerdict(1100, 1000).band, 'fair')
  assert.equal(jpVerdict(1200, 1000).band, 'high')
  assert.equal(jpVerdict(1300, 1000).band, 'high')
  assert.equal(jpVerdict(1301, 1000).band, 'bad')
  assert.equal(jpVerdict(5000, 1000).diffPct, 400)
})

test('jpVerdict returns null instead of dividing by a missing reference', () => {
  assert.equal(jpVerdict(1000, 0), null)
  assert.equal(jpVerdict(1000, null), null)
  assert.equal(jpVerdict(1000, undefined), null)
  assert.equal(jpVerdict(0, 1000), null)
  assert.equal(jpVerdict('abc', 1000), null)
})

/* ------------------------------------------------------------------ *
 * 7. euContext - secondary, trend-based, never blended
 * ------------------------------------------------------------------ */

const FX = { jpyPerEur: 170, source: 'open.er-api.com', date: '2026-09-15' }

test('euContext returns null whenever there is no trustworthy candidate', () => {
  assert.equal(euContext(2000, [], FX), null, 'unmapped_set / no_match / not_pulled all carry an empty list')
  assert.equal(euContext(2000, null, FX), null)
  assert.equal(euContext(2000, [{ trendEur: 10 }], { jpyPerEur: 0 }), null)
  assert.equal(euContext(2000, [{ trendEur: 10 }], undefined), null)
  assert.equal(euContext(0, [{ trendEur: 10 }], FX), null)
})

test('euContext uses priceTrendEur as the headline, NOT priceLowEur', () => {
  const result = euContext(2000, [{ productId: 1, trendEur: 10, lowEur: 1, avg7Eur: 11 }], { jpyPerEur: 200 })
  assert.equal(result.askEur, 10)
  assert.equal(result.basis, 'priceTrendEur')
  assert.equal(result.headline.diffPct, 0, 'trend (10) drives the gap; low (1) would have said +900%')
  assert.equal(result.headline.band, 'fair')
  assert.equal(result.headline.lowEur, 1, 'low is still carried for display, just not used for the verdict')
})

test('euContext marks itself secondary and single-candidate results get a headline', () => {
  const cm = indexFor()
  const card = byCardId(joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: cm }), '2')
  const result = euContext(800, card.eu, FX)
  assert.equal(result.secondary, true)
  assert.equal(result.ambiguous, false)
  assert.equal(result.candidates.length, 1)
  assert.ok(result.headline !== null)
  assert.equal(result.fxSource, 'open.er-api.com')
  assert.equal(result.fxDate, '2026-09-15')
  // 800 JPY / 170 = EUR 4.71 vs trend EUR 3.20 -> +47.2%
  assert.equal(result.askEur, 4.71)
  assert.equal(result.headline.diffPct, 47.2)
  assert.equal(result.headline.band, 'bad')
})

test('euContext on an ambiguous card returns EVERY candidate and no headline', () => {
  const cm = indexFor()
  const card = byCardId(joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: cm }), '1')
  const result = euContext(3400, card.eu, FX)

  assert.equal(result.ambiguous, true)
  assert.equal(result.headline, null, 'there is deliberately nothing to shortcut to')
  assert.equal(result.candidates.length, 2)
  assert.deepEqual(result.candidates.map((candidate) => candidate.productId), [786553, 786554])

  // EUR 20 ask: +8.1% against the base printing, -91.7% against the parallel.
  assert.equal(result.askEur, 20)
  assert.equal(result.candidates[0].diffPct, 8.1)
  assert.equal(result.candidates[0].band, 'fair')
  assert.equal(result.candidates[1].diffPct, -91.7)
  assert.equal(result.candidates[1].band, 'great')

  // The two verdicts contradict each other. That contradiction is the point:
  // any blend would have produced a number describing neither printing.
  const blended = (result.candidates[0].diffPct + result.candidates[1].diffPct) / 2
  assert.ok(!result.candidates.some((candidate) => candidate.diffPct === blended))
})

test('euContext handles a candidate with no trend price without inventing one', () => {
  const result = euContext(2000, [{ productId: 7, trendEur: null, lowEur: 4, avg7Eur: null }], FX)
  assert.equal(result.candidates[0].comparable, false)
  assert.equal(result.candidates[0].diffPct, null)
  assert.equal(result.candidates[0].band, null)
  assert.equal(result.candidates[0].reason, 'no_trend_price')
})

test('euContext never mutates the candidates it was given', () => {
  const cm = indexFor()
  const card = byCardId(joinCards({ yuyuteiRows: YT_ROWS, cardmarketIndex: cm }), '1')
  const snapshot = JSON.stringify(card.eu)
  euContext(3400, card.eu, FX)
  assert.equal(JSON.stringify(card.eu), snapshot)
})
