// scripts/lib/printing-match.test.mjs
//
// The safety-critical question every test here asks is the same one:
// does this change turn "safely vague" into "confidently wrong"?
//
// So the assertions are mostly about what must NOT happen - no candidate lost,
// no reordering, no euStatus promotion, no guess emitted when the evidence is
// thin, and never a pairing across two different expansions.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  matchCode,
  applyPrintingMatch,
  learnSetBucketMap,
  blockJp,
  blockEu,
  likelihoodOf,
  PROMO_BLOCK,
  DEFAULT_JPY_PER_EUR,
} from './printing-match.mjs'
import { joinCards, indexCardmarketRows, buildExpansionIndex } from './join.mjs'

/* ------------------------------------------------------------------ *
 * Fixture helpers
 * ------------------------------------------------------------------ */

let cardId = 0
function jp(setBucket, jpySell, extra = {}) {
  return { code: 'OP01-001', setBucket, jpySell, cardId: String(++cardId), euStatus: 'ambiguous', eu: [], ...extra }
}
function eu(productId, expansionId, trendEur, extra = {}) {
  return { productId, expansionId, expansionName: `Expansion ${expansionId}`, name: 'X (OP01-001)', trendEur, lowEur: null, avg7Eur: null, ...extra }
}
const MAP = new Map([
  ['op01', 5484],
  ['op02', 5483],
  ['op03', 5482],
  ['op09', 5887],
  ['op13', 6277],
  ['st11', 5591],
  ['st16', 5969],
  ['st17', 5970],
  ['st19', 5972],
  ['st20', 5973],
  ['st23', 6229],
  ['prb01', 5804],
])

const run = (printings, candidates, opts = {}) =>
  matchCode({ printings, candidates, setBucketMap: MAP, jpyPerEur: DEFAULT_JPY_PER_EUR, ...opts })

/* ------------------------------------------------------------------ *
 * 1. Blocking
 * ------------------------------------------------------------------ */

test('blockJp maps a known bucket, pools promos, and refuses an unknown bucket', () => {
  assert.equal(blockJp({ setBucket: 'op01' }, MAP), 5484)
  assert.equal(blockJp({ setBucket: 'promo-op10' }, MAP), PROMO_BLOCK)
  assert.equal(blockJp({ setBucket: 'promo-200' }, MAP), PROMO_BLOCK)
  // Never guess an expansion for a bucket we have not established.
  assert.equal(blockJp({ setBucket: 'st99' }, MAP), null)
  assert.equal(blockJp({ setBucket: 'op01' }, new Map()), null)
})

test('blockEu pools exactly the three promo expansions and nothing else', () => {
  assert.equal(blockEu({ expansionId: 5484 }), 5484)
  for (const id of [5510, 5511, 5598]) assert.equal(blockEu({ expansionId: id }), PROMO_BLOCK)
  assert.equal(blockEu({ expansionId: 5509 }), 5509)
  assert.equal(blockEu({ expansionId: 'nonsense' }), null)
})

/* ------------------------------------------------------------------ *
 * 2. Equal-count rank pairing - the core positive case
 * ------------------------------------------------------------------ */

test('equal counts in one block pair by price rank, cheapest to cheapest', () => {
  const printings = [jp('op01', 12000), jp('op01', 120), jp('op01', 1200)]
  const candidates = [eu(1, 5484, 30), eu(2, 5484, 0.9), eu(3, 5484, 4.5)]
  const results = run(printings, candidates)

  assert.equal(results.filter((r) => r.match).length, 3)
  assert.equal(results[1].match.productId, 2) // JPY 120   -> EUR 0.90
  assert.equal(results[2].match.productId, 3) // JPY 1200  -> EUR 4.50
  assert.equal(results[0].match.productId, 1) // JPY 12000 -> EUR 30.00
  assert.deepEqual(results.map((r) => r.match.rank), [3, 1, 2])
  for (const r of results) {
    assert.equal(r.match.basis, 'rank')
    assert.equal(r.match.ofM, 3)
    assert.equal(r.match.block, 5484)
  }
})

test('well-separated ladders earn strong, and the copy never claims certainty', () => {
  const printings = [jp('op01', 120), jp('op01', 12000)]
  const candidates = [eu(1, 5484, 0.9), eu(2, 5484, 90)]
  const [a] = run(printings, candidates)

  assert.equal(a.match.level, 'strong')
  assert.equal(likelihoodOf(a.match.level), 'strong')
  assert.ok(a.match.separation >= 1)
  assert.match(a.match.reason, /Matched by price order/)
  for (const forbidden of [/verified/i, /confirmed/i, /\bis definitely\b/i, /=/]) {
    assert.doesNotMatch(a.match.reason, forbidden)
  }
})

test('separation is the minimum over BOTH ladders, not the Japanese side alone', () => {
  // JP gaps are huge; the EU ladder has one tight step. The tight step must win,
  // because one ambiguous rung makes the whole block's ordering a coin flip.
  const printings = [jp('op01', 100), jp('op01', 10000), jp('op01', 1000000)]
  const candidates = [eu(1, 5484, 1), eu(2, 5484, 1.1), eu(3, 5484, 500)]
  const results = run(printings, candidates)
  for (const r of results) {
    assert.equal(r.match, null)
    assert.equal(r.refusal.reasonCode, 'low_separation')
  }
})

/* ------------------------------------------------------------------ *
 * 3. Unequal counts - must refuse the whole block
 * ------------------------------------------------------------------ */

test('unequal counts inside a block refuse EVERY printing in it', () => {
  const printings = [jp('op01', 120), jp('op01', 12000)]
  const candidates = [eu(1, 5484, 0.9), eu(2, 5484, 90), eu(3, 5484, 900)]
  const results = run(printings, candidates)

  assert.equal(results.length, 2)
  for (const r of results) {
    assert.equal(r.match, null, 'no guess may survive a count mismatch')
    assert.equal(r.refusal.reasonCode, 'block_count_mismatch')
    assert.equal(r.refusal.jpInBlock, 2)
    assert.equal(r.refusal.euInBlock, 3)
    assert.match(r.refusal.reason, /Yuyu-tei lists 2 printings, Cardmarket lists 3\./)
  }
})

test('a mismatched block refuses without poisoning a healthy block on the same code', () => {
  const printings = [jp('op01', 120), jp('op01', 12000), jp('st19', 50)]
  const candidates = [eu(1, 5484, 0.9), eu(2, 5484, 90), eu(3, 5484, 900), eu(4, 5972, 3.02)]
  const results = run(printings, candidates)

  assert.equal(results[0].refusal.reasonCode, 'block_count_mismatch')
  assert.equal(results[1].refusal.reasonCode, 'block_count_mismatch')
  assert.equal(results[2].match.productId, 4, 'the sound block still resolves')
  assert.equal(results[2].match.level, 'exact')
})

test('a leftover printing and a leftover candidate in DIFFERENT blocks are never joined up', () => {
  // One unpaired JP printing, one unpaired EU candidate, and the arithmetic is
  // tempting. Pairing them across expansions is exactly how you ship a lie.
  const printings = [jp('op01', 120)]
  const candidates = [eu(1, 5482, 0.9)]
  const [r] = run(printings, candidates)
  assert.equal(r.match, null)
  assert.equal(r.refusal.reasonCode, 'no_candidate_in_block')
})

/* ------------------------------------------------------------------ *
 * 4. Clustered prices - must refuse
 * ------------------------------------------------------------------ */

test('clustered prices refuse: below a 1.65x adjacent step there is no signal at all', () => {
  const printings = [jp('op01', 100), jp('op01', 140)]
  const candidates = [eu(1, 5484, 2.0), eu(2, 5484, 2.6)]
  const results = run(printings, candidates)
  for (const r of results) {
    assert.equal(r.match, null)
    assert.equal(r.refusal.reasonCode, 'low_separation')
    assert.match(r.refusal.reason, /too close in price/)
  }
})

test('an exact Japanese tie has separation 0 and must never be decided by price', () => {
  // Real shape of ST11-001: two L printings both at JPY 120. Rank order between
  // them is arbitrary, so a guess here would be a coin flip dressed as evidence.
  const printings = [jp('op01', 120), jp('op01', 120)]
  const candidates = [eu(1, 5484, 1.66), eu(2, 5484, 3.61)]
  const results = run(printings, candidates)
  for (const r of results) {
    assert.equal(r.match, null)
    assert.equal(r.refusal.reasonCode, 'low_separation')
    assert.equal(r.refusal.separation, 0)
  }
})

test('the moderate band sits strictly between the two gates', () => {
  const printings = [jp('op01', 100), jp('op01', 200)] // log 0.693
  const candidates = [eu(1, 5484, 1.0), eu(2, 5484, 2.0)]
  const results = run(printings, candidates)
  assert.equal(results[0].match.level, 'moderate')
  assert.equal(likelihoodOf('moderate'), 'weak')
  assert.match(results[0].match.reason, /close in price/)
  assert.match(results[0].match.reason, /Could be the wrong one/)
})

test('a wide ladder touching the sub-EUR 0.20 floor is downgraded, never strong', () => {
  // OP06-104 / OP05-106 shape: nominal gaps look wide, but Cardmarket quantises
  // trend prices below EUR 0.20 to 0.02/0.03/0.04/0.05, which encode no order.
  const printings = [jp('op01', 100), jp('op01', 10000)]
  const candidates = [eu(1, 5484, 0.05), eu(2, 5484, 5.0)]
  const results = run(printings, candidates)
  assert.equal(results[0].match.level, 'moderate', 'floored ladders cannot earn strong')
})

test('a floored ladder that is also poorly separated refuses outright', () => {
  const printings = [jp('op01', 50), jp('op01', 120)]
  const candidates = [eu(1, 5484, 0.04), eu(2, 5484, 0.05)]
  const results = run(printings, candidates)
  for (const r of results) {
    assert.equal(r.match, null)
    assert.equal(r.refusal.reasonCode, 'low_separation')
  }
})

/* ------------------------------------------------------------------ *
 * 5. Single candidate
 * ------------------------------------------------------------------ */

test('a lone printing against a lone candidate in its expansion is exact, and price is never consulted', () => {
  const printings = [jp('op01', 120)]
  const candidates = [eu(1, 5484, 0.9)]
  const [r] = run(printings, candidates)

  assert.equal(r.match.level, 'exact')
  assert.equal(r.match.basis, 'expansion')
  assert.equal(r.match.separation, null, 'expansion-determined pairings have no separation')
  assert.equal(r.match.stepX, null)
  assert.equal(r.match.rank, 1)
  assert.equal(r.match.ofM, 1)
  assert.match(r.match.reason, /Only one Cardmarket printing of this card is listed in Expansion 5484/)
})

test('a lone PROMO-pool pairing is only strong, never exact - the pool is a coarse merge', () => {
  const printings = [jp('promo-op10', 1780)]
  const candidates = [eu(1, 5510, 15.32)]
  const [r] = run(printings, candidates)
  assert.equal(r.match.level, 'strong')
  assert.equal(r.match.reasonCode, 'promo_sole')
  assert.match(r.match.reason, /pooled/)
})

test('the plausibility guard rejects a lone pairing ~20x off the central ratio', () => {
  // OP01-006's promo row: JPY 980 against EUR 600 is a ~110x departure. Certainly
  // a tournament printing Yuyu-tei does not stock, so it is not this card.
  const printings = [jp('promo-op10', 980)]
  const candidates = [eu(1, 5598, 600)]
  const [r] = run(printings, candidates)
  assert.equal(r.match, null)
  assert.equal(r.refusal.reasonCode, 'implausible_ratio')
})

test('the plausibility guard leaves an ordinary lone pairing alone', () => {
  const printings = [jp('op01', 120)] // ~EUR 0.67 against EUR 0.76: entirely normal
  const candidates = [eu(1, 5484, 0.76)]
  const [r] = run(printings, candidates)
  assert.equal(r.match.level, 'exact')
})

test('an unmapped bucket refuses instead of borrowing a neighbouring block', () => {
  const printings = [jp('st99', 120)]
  const candidates = [eu(1, 5484, 0.9)]
  const [r] = run(printings, candidates)
  assert.equal(r.match, null)
  assert.equal(r.refusal.reasonCode, 'unmapped_bucket')
})

/* ------------------------------------------------------------------ *
 * 6. Zero / null prices
 * ------------------------------------------------------------------ */

test('a null or non-positive EU trend price makes the ladder unorderable - refuse', () => {
  for (const bad of [null, 0, -1, undefined, NaN]) {
    const printings = [jp('op01', 120), jp('op01', 12000)]
    const candidates = [eu(1, 5484, bad), eu(2, 5484, 90)]
    const results = run(printings, candidates)
    for (const r of results) {
      assert.equal(r.match, null, `trendEur=${String(bad)} must not produce a guess`)
      assert.equal(r.refusal.reasonCode, 'eu_price_missing')
    }
  }
})

test('a missing Japanese price refuses too - log(0) is not an ordering', () => {
  const printings = [jp('op01', 0), jp('op01', 12000)]
  const candidates = [eu(1, 5484, 0.9), eu(2, 5484, 90)]
  const results = run(printings, candidates)
  for (const r of results) {
    assert.equal(r.match, null)
    assert.equal(r.refusal.reasonCode, 'jp_price_missing')
  }
  for (const r of results) assert.ok(Number.isFinite(r.refusal.jpInBlock))
})

test('a lone pairing with no usable price still resolves on expansion membership alone', () => {
  // m === 1 never needs a price: the block itself is the evidence. The guard
  // simply has nothing to check.
  const printings = [jp('op01', 120)]
  const candidates = [eu(1, 5484, null)]
  const [r] = run(printings, candidates)
  assert.equal(r.match.level, 'exact')
})

test('no candidates at all produces refusals, never an empty-array crash', () => {
  const results = run([jp('op01', 120)], [])
  assert.equal(results[0].match, null)
  assert.equal(results[0].refusal.reasonCode, 'no_candidate_in_block')
  assert.deepEqual(matchCode({ printings: [], candidates: [], setBucketMap: MAP }), [])
})

/* ------------------------------------------------------------------ *
 * 7. REAL codes, REAL numbers, taken from data/index.json
 * ------------------------------------------------------------------ */

test('REAL OP02-093: the starter-deck inversion resolves by expansion, not by global rank', () => {
  // Yuyu-tei: st19 reprint JPY 50, op02 base JPY 120, op02 parallel JPY 2,980.
  // Cardmarket: 768511 EUR 1.21 and 768512 EUR 18.31 in 5483, 802128 EUR 3.02 in 5972.
  // The ST reprint is the CHEAPEST in Japan but the DEAREST-but-one in Europe,
  // so a naive global rank pairing gets it exactly backwards.
  const base = jp('op02', 120, { code: 'OP02-093' })
  const parallel = jp('op02', 2980, { code: 'OP02-093' })
  const reprint = jp('st19', 50, { code: 'OP02-093' })
  const candidates = [eu(768511, 5483, 1.21), eu(768512, 5483, 18.31), eu(802128, 5972, 3.02)]

  const [rBase, rParallel, rReprint] = run([base, parallel, reprint], candidates)

  assert.equal(rReprint.match.productId, 802128, 'the JPY 50 reprint is the EUR 3.02 ST printing')
  assert.equal(rReprint.match.level, 'exact')
  assert.equal(rBase.match.productId, 768511, 'JPY 120 base -> EUR 1.21')
  assert.equal(rParallel.match.productId, 768512, 'JPY 2,980 parallel -> EUR 18.31')
  assert.equal(rBase.match.level, 'strong')

  // The lie this test exists to prevent: global rank would give the JPY 50
  // reprint the cheapest EUR row (1.21) instead of its own set's 3.02.
  assert.notEqual(rReprint.match.productId, 768511)
})

test('REAL OP13-118: five printings, every one paired in order, honestly labelled moderate', () => {
  // JP  980 / 12,800 / 29,800 / 178,000 / 1,480,000
  // EU  2.99 / 44.60 / 215.58 / 1,421.56 / 6,144.59   (all expansion 6277)
  const printings = [
    jp('op13', 12800, { code: 'OP13-118' }),
    jp('op13', 178000, { code: 'OP13-118' }),
    jp('op13', 1480000, { code: 'OP13-118' }),
    jp('op13', 980, { code: 'OP13-118' }),
    jp('op13', 29800, { code: 'OP13-118' }),
  ]
  const candidates = [
    eu(845671, 6277, 2.99),
    eu(845672, 6277, 44.6),
    eu(845673, 6277, 6144.59),
    eu(845674, 6277, 215.58),
    eu(845675, 6277, 1421.56),
  ]
  const results = run(printings, candidates)

  assert.deepEqual(results.map((r) => r.match.productId), [845672, 845675, 845673, 845671, 845674])
  // The JP ladder's tightest step is 12,800 -> 29,800 = 2.33x, i.e. log 0.845.
  // That is below the 1.0 strong gate, so the whole block is moderate even though
  // the pairing is in fact correct. Understating confidence is the safe direction.
  for (const r of results) {
    assert.equal(r.match.level, 'moderate')
    assert.equal(r.match.ofM, 5)
  }
  assert.ok(Math.abs(results[0].match.separation - 0.845) < 0.005, `separation was ${results[0].match.separation}`)
})

test('REAL ST11-001: two printings tied at JPY 120 are separated by expansion alone', () => {
  const a = jp('st16', 120, { code: 'ST11-001' })
  const b = jp('st11', 120, { code: 'ST11-001' })
  const candidates = [eu(750527, 5591, 1.66), eu(802103, 5969, 3.61)]
  const [rA, rB] = run([a, b], candidates)

  assert.equal(rA.match.productId, 802103) // st16 -> 5969
  assert.equal(rB.match.productId, 750527) // st11 -> 5591
  for (const r of [rA, rB]) {
    assert.equal(r.match.level, 'exact')
    assert.equal(r.match.basis, 'expansion')
    assert.equal(r.match.separation, null, 'the JPY tie was never used to decide anything')
  }
})

test('REAL OP01-006: the EUR 600 promo row is refused while the ordinary base still resolves', () => {
  const printings = [
    jp('prb01', 580, { code: 'OP01-006' }),
    jp('prb01', 1780, { code: 'OP01-006' }),
    jp('prb01', 220, { code: 'OP01-006' }),
    jp('op01', 120, { code: 'OP01-006' }),
    jp('promo-op10', 980, { code: 'OP01-006' }),
  ]
  const candidates = [
    eu(768244, 5484, 0.11),
    eu(780995, 5804, 0.09),
    eu(780996, 5804, 2.82),
    eu(780997, 5804, 3.08),
    eu(896363, 5598, 600),
  ]
  const results = run(printings, candidates)

  assert.equal(results[4].match, null, 'JPY 980 vs EUR 600 is ~110x off the central ratio')
  assert.equal(results[4].refusal.reasonCode, 'implausible_ratio')
  // The three prb01 printings cluster at EUR 0.09 / 2.82 / 3.08 - the 2.82 -> 3.08
  // step is 1.09x, far below the gate.
  for (const i of [0, 1, 2]) {
    assert.equal(results[i].match, null)
    assert.equal(results[i].refusal.reasonCode, 'low_separation')
  }
  assert.equal(results[3].match.productId, 768244, 'the op01 base is alone in 5484 and still resolves')
})

/* ------------------------------------------------------------------ *
 * 8. Learning the map
 * ------------------------------------------------------------------ */

const okCard = (setBucket, expansionId, code) => ({
  code,
  setBucket,
  jpySell: 100,
  euStatus: 'ok',
  eu: [eu(1, expansionId, 1)],
})

test('L1 accepts a high-volume bucket and a unanimous low-volume one', () => {
  const cards = []
  for (let i = 0; i < 6; i++) cards.push(okCard('op01', 5484, `OP01-00${i}`))
  cards.push(okCard('st17', 5970, 'ST17-001')) // n=1, unanimous
  const { map, stats } = learnSetBucketMap(cards)
  assert.equal(map.get('op01'), 5484)
  assert.equal(map.get('st17'), 5970)
  assert.equal(stats.l1Volume, 1)
  assert.equal(stats.l1Unanimous, 1)
})

test('L1 rejects a low-volume bucket whose observations disagree', () => {
  const cards = [okCard('op01', 5484, 'OP01-001'), okCard('op01', 9999, 'OP01-002')]
  const { map } = learnSetBucketMap(cards)
  assert.equal(map.has('op01'), false, 'a split bucket must stay unmapped, not take a majority of 2')
})

test('the injectivity guard drops BOTH buckets when two claim one expansion', () => {
  const cards = []
  for (let i = 0; i < 6; i++) {
    cards.push(okCard('op01', 5484, `OP01-00${i}`))
    cards.push(okCard('op02', 5484, `OP02-00${i}`))
  }
  const { map, stats } = learnSetBucketMap(cards)
  assert.equal(map.has('op01'), false)
  assert.equal(map.has('op02'), false)
  assert.equal(stats.collisions.length, 1)
})

test('L2 attributes a pure-reprint bucket from the residual expansion, at volume', () => {
  const cards = []
  for (let i = 0; i < 6; i++) cards.push(okCard('op01', 5484, `OP01-10${i}`))
  // Six codes, each with an op01 printing (mapped) plus a prb01 printing whose
  // expansion 5804 is the single unexplained residual.
  for (let i = 0; i < 6; i++) {
    const code = `OP01-20${i}`
    const candidates = [eu(1, 5484, 1), eu(2, 5804, 2)]
    cards.push({ code, setBucket: 'op01', jpySell: 100, euStatus: 'ambiguous', eu: candidates })
    cards.push({ code, setBucket: 'prb01', jpySell: 200, euStatus: 'ambiguous', eu: candidates })
  }
  const { map, stats } = learnSetBucketMap(cards)
  assert.equal(map.get('prb01'), 5804)
  assert.equal(stats.l2, 1)
})

test('L2 refuses to attribute on thin residual evidence (n < 5)', () => {
  const cards = []
  for (let i = 0; i < 6; i++) cards.push(okCard('op01', 5484, `OP01-10${i}`))
  for (let i = 0; i < 2; i++) {
    const code = `OP01-20${i}`
    const candidates = [eu(1, 5484, 1), eu(2, 5804, 2)]
    cards.push({ code, setBucket: 'op01', jpySell: 100, euStatus: 'ambiguous', eu: candidates })
    cards.push({ code, setBucket: 'prb01', jpySell: 200, euStatus: 'ambiguous', eu: candidates })
  }
  const { map } = learnSetBucketMap(cards)
  assert.equal(map.has('prb01'), false)
})

test('promo buckets never enter the learned map - L3 pools them instead', () => {
  const cards = []
  for (let i = 0; i < 9; i++) cards.push(okCard('promo-100', 5511, `P-00${i}`))
  const { map } = learnSetBucketMap(cards)
  assert.equal(map.has('promo-100'), false)
  assert.equal(blockJp({ setBucket: 'promo-100' }, map), PROMO_BLOCK)
})

/* ------------------------------------------------------------------ *
 * 9. THE INVARIANTS. These are the tests that matter most.
 * ------------------------------------------------------------------ */

test('applyPrintingMatch never changes euStatus, and never touches a non-ambiguous card', () => {
  const candidates = [eu(1, 5484, 0.9), eu(2, 5484, 90)]
  const cards = [
    { code: 'OP01-001', setBucket: 'op01', jpySell: 120, euStatus: 'ambiguous', eu: candidates.map((c) => ({ ...c })) },
    { code: 'OP01-001', setBucket: 'op01', jpySell: 12000, euStatus: 'ambiguous', eu: candidates.map((c) => ({ ...c })) },
    { code: 'OP01-002', setBucket: 'op01', jpySell: 100, euStatus: 'ok', eu: [eu(3, 5484, 1)] },
    { code: 'OP01-003', setBucket: 'op01', jpySell: 100, euStatus: 'no_match', eu: [] },
    { code: 'OP01-004', setBucket: 'op01', jpySell: 100, euStatus: 'unmapped_set', eu: [] },
  ]
  const before = cards.map((c) => c.euStatus)
  applyPrintingMatch(cards, { setBucketMap: MAP })

  assert.deepEqual(cards.map((c) => c.euStatus), before, 'euStatus is never a matcher output')
  assert.equal(cards[0].euStatus, 'ambiguous', 'a narrowed card is STILL ambiguous')
  assert.ok(cards[0].euMatch, 'and it did get narrowed')
  for (const i of [2, 3, 4]) {
    assert.equal(cards[i].euMatch, undefined, 'non-ambiguous cards get no match metadata at all')
    assert.equal(cards[i].euBestGuess, undefined)
    assert.equal(cards[i].euRefusal, undefined)
  }
})

test('every candidate survives, in the same order, with its numbers untouched', () => {
  const candidates = [eu(9, 5484, 90), eu(1, 5484, 0.9), eu(5, 5484, 9)]
  const cards = [
    { code: 'OP01-001', setBucket: 'op01', jpySell: 120, euStatus: 'ambiguous', eu: candidates.map((c) => ({ ...c })) },
    { code: 'OP01-001', setBucket: 'op01', jpySell: 1200, euStatus: 'ambiguous', eu: candidates.map((c) => ({ ...c })) },
    { code: 'OP01-001', setBucket: 'op01', jpySell: 12000, euStatus: 'ambiguous', eu: candidates.map((c) => ({ ...c })) },
  ]
  applyPrintingMatch(cards, { setBucketMap: MAP })

  for (const card of cards) {
    assert.equal(card.eu.length, 3, 'nothing is ever deleted from eu[]')
    assert.deepEqual(card.eu.map((c) => c.productId), [9, 1, 5], 'eu[] order is preserved exactly')
    assert.deepEqual(card.eu.map((c) => c.trendEur), [90, 0.9, 9])
  }
})

test('each printing of a code gets its OWN best guess - no cross-contamination', () => {
  // joinCards hands every printing of a code the same candidate objects. If the
  // matcher annotated those shared objects, printing A's guess would silently
  // appear on printing B.
  const candidates = [eu(1, 5484, 0.9), eu(2, 5484, 90)]
  const cards = [
    { code: 'OP01-001', setBucket: 'op01', jpySell: 120, euStatus: 'ambiguous', eu: candidates },
    { code: 'OP01-001', setBucket: 'op01', jpySell: 12000, euStatus: 'ambiguous', eu: candidates },
  ]
  applyPrintingMatch(cards, { setBucketMap: MAP })

  assert.equal(cards[0].euBestGuess, 1)
  assert.equal(cards[1].euBestGuess, 2)
  assert.equal(cards[0].eu.filter((c) => c.match).length, 1, 'exactly one marked candidate per card')
  assert.equal(cards[1].eu.filter((c) => c.match).length, 1)
  assert.equal(cards[0].eu.find((c) => c.match).productId, 1)
  assert.equal(cards[1].eu.find((c) => c.match).productId, 2)
  assert.equal(cards[0].eu[0].match.reason, 'best guess')
})

test('a refused card carries NO match metadata of any kind, only an explanation', () => {
  const candidates = [eu(1, 5484, 2.0), eu(2, 5484, 2.6)]
  const cards = [
    { code: 'OP01-001', setBucket: 'op01', jpySell: 100, euStatus: 'ambiguous', eu: candidates.map((c) => ({ ...c })) },
    { code: 'OP01-001', setBucket: 'op01', jpySell: 140, euStatus: 'ambiguous', eu: candidates.map((c) => ({ ...c })) },
  ]
  applyPrintingMatch(cards, { setBucketMap: MAP })

  for (const card of cards) {
    assert.equal(card.euMatch, undefined, 'no low-confidence guess may leak through')
    assert.equal(card.euBestGuess, undefined)
    assert.equal(card.eu.filter((c) => c.match).length, 0, 'no candidate may be marked')
    assert.equal(card.euRefusal.reasonCode, 'low_separation')
    assert.equal(card.euRefusal.jpPrintings, 2)
    assert.equal(card.euRefusal.euCandidates, 2)
  }
})

test('joinCards wires the matcher in without disturbing the join it already did', () => {
  const expansions = {
    expansions: [
      { expansionId: 5484, name: 'Romance Dawn', language: 'japanese' },
      { expansionId: 5972, name: 'ST-19', language: 'japanese' },
      { expansionId: 4000, name: 'English Set', language: 'english_confirmed' },
    ],
  }
  const { index } = buildExpansionIndex(expansions, null)
  const cmRows = [
    { productId: 11, expansionId: 5484, name: 'Luffy (OP01-060)', priceTrendEur: 0.76 },
    { productId: 12, expansionId: 5484, name: 'Luffy (OP01-060)', priceTrendEur: 35.99 },
    { productId: 13, expansionId: 5972, name: 'Luffy (OP01-060)', priceTrendEur: 2.64 },
    { productId: 14, expansionId: 4000, name: 'Luffy (OP01-060)', priceTrendEur: 99 },
    { productId: 20, expansionId: 5484, name: 'Zoro (OP01-025)', priceTrendEur: 1.5 },
  ]
  const cardmarketIndex = indexCardmarketRows(cmRows, index)
  const yuyuteiRows = [
    { code: 'OP01-060', setBucket: 'op01', jpySell: 120, name: 'a' },
    { code: 'OP01-060', setBucket: 'op01', jpySell: 7980, name: 'b' },
    { code: 'OP01-060', setBucket: 'st17', jpySell: 50, name: 'c' },
    { code: 'OP01-025', setBucket: 'op01', jpySell: 200, name: 'd' },
  ]
  // st17 is learnable only from an 'ok' card; here it is not, so it must refuse.
  const cards = joinCards({ yuyuteiRows, cardmarketIndex })

  assert.equal(cards.length, 4)
  assert.equal(cards[3].euStatus, 'ok', 'the single-printing card is untouched')
  assert.equal(cards[3].euMatch, undefined)

  for (const i of [0, 1, 2]) assert.equal(cards[i].euStatus, 'ambiguous')
  assert.equal(cards[0].eu.length, 3, 'the english row is still excluded, the other three still travel')
  assert.equal(cards[2].euRefusal.reasonCode, 'unmapped_bucket', 'st17 was never learned, so no guess')

  // op01 has 2 JP printings against 2 candidates in 5484 -> rank pairs.
  assert.equal(cards[0].euBestGuess, 11)
  assert.equal(cards[1].euBestGuess, 12)
  assert.equal(cards[0].euStatus, 'ambiguous', 'STILL ambiguous after narrowing')
})

test('the fallback FX cannot move a pairing across the plausibility band', () => {
  // The guard's band is ~20x. A 10% FX error is nowhere near it, which is why the
  // matcher can safely run before build-index.mjs resolves the real rate.
  const printings = [jp('op01', 120)]
  const candidates = [eu(1, 5484, 0.76)]
  for (const rate of [DEFAULT_JPY_PER_EUR, DEFAULT_JPY_PER_EUR * 1.1, DEFAULT_JPY_PER_EUR * 0.9]) {
    const [r] = run(printings, candidates, { jpyPerEur: rate })
    assert.equal(r.match.level, 'exact')
  }
})
