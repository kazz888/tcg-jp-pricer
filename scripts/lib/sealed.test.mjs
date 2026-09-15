// scripts/lib/sealed.test.mjs
//
// Every product name in here is a REAL name copied out of
// data/cardmarket-sealed-raw.json (699 rows, priceGuideDate 2026-09-15),
// including the typos ("Asia Region Lega", "A FIst of Divine Speed"), the curly
// apostrophes and the doubled quotes. Invented names would only prove the regex
// matches itself.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SEALED_KINDS,
  IN_SCOPE_KINDS,
  kindOf,
  classifyName,
  kindDistribution,
  normalizeName,
  stripQualifiers,
  deriveSetCodes,
  selectSealed,
  findCollisions,
  buildSealedFile,
  sealedIndexItems,
  isUsableSealedFile,
} from './sealed.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const RAW = resolve(ROOT, 'data', 'cardmarket-sealed-raw.json')

const rawRows = existsSync(RAW) ? JSON.parse(readFileSync(RAW, 'utf8')) : null

/* ------------------------------------------------------------------ *
 * 1. THE TRAP: box vs case
 * ------------------------------------------------------------------ */

test('box vs case: the named pair from the brief', () => {
  assert.equal(kindOf('Emperors in the New World Booster Box (Non-English)'), 'booster_box')
  assert.equal(kindOf('Emperors in the New World Booster Box Case (12x Booster Box)'), 'case')
})

test('box vs case: a naive substring test would have matched both', () => {
  // This is the bug the classifier exists to avoid. Assert the naive test really
  // is ambiguous, so the test above is proving something.
  const box = 'Emperors in the New World Booster Box (Non-English)'
  const kase = 'Emperors in the New World Booster Box Case (12x Booster Box)'
  assert.ok(box.toLowerCase().includes('booster box'))
  assert.ok(kase.toLowerCase().includes('booster box'))
  assert.notEqual(kindOf(box), kindOf(kase))
})

test('case form 1: "Case" plus a multiplier', () => {
  for (const name of [
    'Awakening of the New Era Booster Box Case (12x Booster Box) (Non-English)',
    'Romance Dawn Booster Box Case (12x Booster Box) (Pre-Errata)',
    'The Azure Sea’s Seven Booster Box Case (12x Booster Box) (Asia Region Legal)',
    'The Best Booster Box Case (10x Booster Box)',
  ]) {
    assert.equal(kindOf(name), 'case', name)
  }
})

test('case form 2: "Case" with NO multiplier at all', () => {
  for (const name of [
    'EB05 Booster Box Case',
    'OP17 Booster Box Case',
    'Adventure on Kami’s Island Booster Box Case',
    "Adventure on Kami's Island Booster Box Case (Asia Region Legal)",
    'Egghead Crisis Booster Box Case (Asia Region Legal)',
    'The Best Vol.2 Booster Box Case (Asia Region Legal)',
  ]) {
    assert.equal(kindOf(name), 'case', name)
  }
})

test('case form 3: a multiplier and NO the word "case" anywhere', () => {
  // The form that defeats a "does it say case?" test. Both are real rows, and
  // both sit in confirmed-Japanese expansions, so getting this wrong would put a
  // EUR 750 case on screen as if it were an EUR 88 box.
  for (const name of [
    '500 Years into the Future (12x Booster Box) (Non-English)',
    'Memorial Collection (12x Booster Box) (Non-English)',
  ]) {
    assert.ok(!/case/i.test(name), `${name} must not contain the word "case"`)
    assert.equal(kindOf(name), 'case', name)
  }
})

test('sleeved pack cases are cases, not packs', () => {
  for (const name of [
    'A Fist of Divine Speed Sleeved Booster Pack Case (24x Packs)',
    'The Best Vol.2 Sleeved Booster Pack Case (20x Packs)',
    "The Azure's Sea Seven Sleeved Booster Pack Case (24x Packs)",
  ]) {
    assert.equal(kindOf(name), 'case', name)
  }
})

test('a "1x" parenthetical inside a deck name is NOT a case multiplier', () => {
  // Real row. A loose /\d+x/ test would have called this a case.
  assert.equal(
    kindOf('Demo Deck: Roronoa Zoro (OP01-001) (Incl. 1x Promotion Pack 2023 Vol.1)'),
    'deck',
  )
})

/* ------------------------------------------------------------------ *
 * 2. Boxes, packs, decks, other
 * ------------------------------------------------------------------ */

test('booster boxes, including the Cardmarket typo row', () => {
  for (const name of [
    'Awakening of the New Era Booster Box (Non-English)',
    'Carrying on his Will Booster Box (Non-English)',
    "The World's Strongest Warriors Booster Box (Asia Region Legal)",
    'Heroines Edition Booster Box (Asia Region Legal)',
    'EB05 Booster Box',
    'Egghead Crisis Booster Box (Asia Region Lega)', // sic - truncated "Legal"
    'Romance Dawn Booster Box (Pre-Errata)',
  ]) {
    assert.equal(kindOf(name), 'booster_box', name)
  }
})

test('single booster packs, plain and sleeved', () => {
  for (const name of [
    '500 Years into the Future Booster (Non-English)',
    'Emperors in the New World Booster (Non-English)',
    'A FIst of Divine Speed Sleeved Booster', // sic - "FIst"
    'Adventure on Kami’s Island Booster',
    'The Time of Battle Booster (Asia Region Legal)',
  ]) {
    assert.equal(kindOf(name), 'booster_pack', name)
  }
})

test('a EUR 243 "Booster Pack" is not one pack, and is not silently kept', () => {
  // "Special Card Set Vol.1 Booster Pack" trends at EUR 243.75. The pack rule
  // requires the name to END in "booster"; this one ends in "pack".
  const verdict = classifyName('Special Card Set Vol.1 Booster Pack')
  assert.equal(verdict.kind, 'other')
  assert.equal(verdict.confident, false) // must surface in the report
})

test('box-purchase promos and deck bonus packs are excluded, and flagged', () => {
  for (const name of [
    'Romance Dawn Box Promotion Booster (Non-English)',
    'Paramount War Box Promotion Booster',
    'Gift Collection 2023 Booster',
  ]) {
    const verdict = classifyName(name)
    assert.equal(verdict.kind, 'other', name)
    assert.equal(verdict.confident, false, name)
  }
  const bonus = classifyName('Starter Deck EX: ""Gear 5"" Bonus Pack Booster')
  assert.equal(bonus.kind, 'deck')
  assert.equal(bonus.confident, false)
})

test('decks are decks', () => {
  for (const name of [
    'Starter Deck: 3D2Y (Non-English)',
    'Ultimate Deck: The Three Brothers (Japanese)',
    'Starter Deck: Purple Black Monkey.D.Luffy (Non-English)',
    'Demo Deck: Monkey.D.Luffy (OP01-003)',
  ]) {
    assert.equal(kindOf(name), 'deck', name)
  }
})

test('boxes that are not booster boxes stay out', () => {
  for (const name of [
    'Illustration Box Vol.1',
    'The Best Premium Storage Box Set',
    '2nd Chinese Anniversary Boa Hancock Gift Box',
    'Tin Pack Set Vol.2 (Sabo) - Empty Box',
    'OP02 Box Topper Pack (Non-English)',
  ]) {
    assert.equal(kindOf(name), 'other', name)
  }
})

test('kindOf always returns a known kind, never throws', () => {
  for (const input of [undefined, null, '', 42, {}, [], '   ']) {
    assert.ok(SEALED_KINDS.includes(kindOf(input)), String(input))
  }
})

test('normalisation folds curly quotes but not the box/case distinction', () => {
  assert.equal(
    normalizeName('Adventure on Kami’s Island Booster Box'),
    "adventure on kami's island booster box",
  )
  assert.equal(stripQualifiers('emperors in the new world booster (non-english)'), 'emperors in the new world booster')
  // The multiplier tail is NOT a qualifier - stripping it would erase a case.
  assert.equal(
    stripQualifiers('memorial collection (12x booster box)'),
    'memorial collection (12x booster box)',
  )
})

/* ------------------------------------------------------------------ *
 * 3. Language gating
 * ------------------------------------------------------------------ */

const EXPANSIONS = new Map([
  [5887, { expansionId: 5887, name: 'Emperors in the New World (Non-English)', language: 'japanese' }],
  [5481, { expansionId: 5481, name: 'Awakening of the New Era (Non-English)', language: 'japanese' }],
  [1111, { expansionId: 1111, name: 'Emperors in the New World', language: 'english_confirmed' }],
  [2222, { expansionId: 2222, name: 'Some Expansion Nobody Checked', language: 'unknown' }],
])

const row = (over) => ({
  productId: 1,
  name: 'Emperors in the New World Booster Box (Non-English)',
  expansionId: 5887,
  priceTrendEur: 120.13,
  priceLowEur: 99,
  avg7DayEur: null,
  currency: 'EUR',
  productUrl: 'https://www.cardmarket.com/en/OnePiece/Products?idProduct=1',
  ...over,
})

test('only "japanese" expansions are priced', () => {
  const { items, excluded } = selectSealed({
    rows: [
      row({ productId: 1, expansionId: 5887 }),
      row({ productId: 2, expansionId: 1111 }),
      row({ productId: 3, expansionId: 2222 }),
    ],
    expansions: EXPANSIONS,
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].productId, 1)
  assert.equal(excluded.language_not_japanese, 2)
  assert.equal(excluded.byLanguage.english_confirmed, 1)
  assert.equal(excluded.byLanguage.unknown, 1)
})

test('"unknown" is NOT japanese - the whole point of failing closed', () => {
  const { items, excluded } = selectSealed({
    rows: [row({ productId: 9, expansionId: 2222 })],
    expansions: EXPANSIONS,
  })
  assert.deepEqual(items, [])
  assert.equal(excluded.language_not_japanese, 1)
})

test('an expansion we have never mapped is dropped, not defaulted', () => {
  const { items, excluded } = selectSealed({
    rows: [row({ productId: 9, expansionId: 999999 })],
    expansions: EXPANSIONS,
  })
  assert.deepEqual(items, [])
  assert.equal(excluded.unknown_expansion, 1)
})

test('a Japanese CASE is still excluded - language does not rescue a wrong kind', () => {
  const { items, excluded } = selectSealed({
    rows: [
      row({
        productId: 7,
        expansionId: 5887,
        name: 'Emperors in the New World Booster Box Case (12x Booster Box) (Non-English)',
        priceTrendEur: 1400,
      }),
    ],
    expansions: EXPANSIONS,
  })
  assert.deepEqual(items, [])
  assert.equal(excluded.byKind.case, 1)
})

test('non-EUR rows and priceless rows are dropped and counted', () => {
  const { items, excluded } = selectSealed({
    rows: [
      row({ productId: 11, currency: 'GBP' }),
      row({ productId: 12, priceTrendEur: null, priceLowEur: null, avg7DayEur: null }),
      row({ productId: 13 }),
      row({ productId: 13 }), // same id twice
    ],
    expansions: EXPANSIONS,
  })
  assert.equal(items.length, 1)
  assert.equal(excluded.non_eur_currency, 1)
  assert.equal(excluded.no_price, 1)
  assert.equal(excluded.duplicate_product_id, 1)
})

test('selection reports unconfident names even when they are excluded', () => {
  const { unconfident } = selectSealed({
    rows: [row({ productId: 21, name: 'Romance Dawn Box Promotion Booster (Non-English)', expansionId: 5481 })],
    expansions: EXPANSIONS,
  })
  assert.equal(unconfident.length, 1)
  assert.equal(unconfident[0].productId, 21)
})

/* ------------------------------------------------------------------ *
 * 4. Set code derivation
 * ------------------------------------------------------------------ */

test('modal card code gives the expansion its set code', () => {
  const map = deriveSetCodes([
    { expansionId: 5887, cardCode: 'OP09-001' },
    { expansionId: 5887, cardCode: 'OP09-002' },
    { expansionId: 5887, cardCode: 'OP09-003' },
    { expansionId: 5887, cardCode: null },
    { expansionId: 5887, cardCode: 'P-001' }, // one stray promo reprint
  ])
  assert.equal(map.get(5887).setCode, 'OP09')
  assert.equal(map.get(5887).reason, 'modal')
})

test('a reprint set with no dominant code resolves to null, not to a plurality', () => {
  // This is the real shape of expansion 5804 "The Best": its singles carry their
  // ORIGINAL set codes, so the modal code is OP06 at 19% - calling the box
  // "OP06 Booster Box" would be a fabrication.
  const rows = [
    ...Array.from({ length: 41 }, () => ({ expansionId: 5804, cardCode: 'OP06-001' })),
    ...Array.from({ length: 38 }, () => ({ expansionId: 5804, cardCode: 'OP05-001' })),
    ...Array.from({ length: 32 }, () => ({ expansionId: 5804, cardCode: 'OP03-001' })),
    ...Array.from({ length: 25 }, () => ({ expansionId: 5804, cardCode: 'OP01-001' })),
    ...Array.from({ length: 2 }, () => ({ expansionId: 5804, cardCode: 'PRB01-001' })),
  ]
  const entry = deriveSetCodes(rows).get(5804)
  assert.equal(entry.setCode, null)
  assert.match(entry.reason, /^below_min_share:/)
  assert.equal(entry.runnerUp, 'OP05')
})

test('an expansion whose singles carry no code at all resolves to null', () => {
  const entry = deriveSetCodes([
    { expansionId: 4242, cardCode: null },
    { expansionId: 4242, cardCode: null },
  ]).get(4242)
  assert.equal(entry.setCode, null)
  assert.equal(entry.reason, 'no_coded_singles')
})

test('the derived set code reaches the emitted item', () => {
  const setCodes = deriveSetCodes([
    { expansionId: 5887, cardCode: 'OP09-001' },
    { expansionId: 5887, cardCode: 'OP09-002' },
  ])
  const { items } = selectSealed({ rows: [row({})], expansions: EXPANSIONS, setCodes })
  assert.equal(items[0].setCode, 'OP09')
})

test('an unresolved set code ships as null and is reported, never guessed', () => {
  const { items, setCodeStats } = selectSealed({ rows: [row({})], expansions: EXPANSIONS })
  assert.equal(items[0].setCode, null)
  assert.equal(setCodeStats.withoutSetCode, 1)
  assert.deepEqual(setCodeStats.unresolvedExpansions, [
    { expansionId: 5887, expansionName: 'Emperors in the New World (Non-English)' },
  ])
})

/* ------------------------------------------------------------------ *
 * 5. Collisions - show both, never pick one
 * ------------------------------------------------------------------ */

test('two boxes for the same set collide and BOTH survive', () => {
  const items = [
    { productId: 1, setCode: 'OP09', kind: 'booster_box' },
    { productId: 2, setCode: 'OP09', kind: 'booster_box' },
    { productId: 3, setCode: 'OP09', kind: 'booster_pack' },
  ]
  const collisions = findCollisions(items)
  assert.equal(collisions.length, 1)
  assert.equal(collisions[0].setCode, 'OP09')
  assert.equal(collisions[0].kind, 'booster_box')
  assert.equal(collisions[0].items.length, 2)
})

test('items with no set code cannot collide', () => {
  assert.deepEqual(
    findCollisions([
      { productId: 1, setCode: null, kind: 'booster_box' },
      { productId: 2, setCode: null, kind: 'booster_box' },
    ]),
    [],
  )
})

/* ------------------------------------------------------------------ *
 * 6. The file shape and the empty / missing path
 * ------------------------------------------------------------------ */

test('sealedIndexItems adds jpyRef: null to every item', () => {
  const file = buildSealedFile({
    items: [
      {
        productId: 1, name: 'Emperors in the New World Booster Box (Non-English)',
        kind: 'booster_box', expansionId: 5887, expansionName: 'Emperors in the New World (Non-English)',
        setCode: 'OP09', trendEur: 120.13, lowEur: 99, avg7Eur: null,
        productUrl: 'https://example.invalid/1',
      },
    ],
    priceGuideDate: '2026-09-15',
    source: { provider: 'test' },
    generatedAt: '2026-09-15T00:00:00.000Z',
  })
  const items = sealedIndexItems(file)
  assert.equal(items.length, 1)
  assert.equal(items[0].jpyRef, null)
  assert.ok('jpyRef' in items[0], 'jpyRef must be present, not merely undefined')
  assert.equal(items[0].setCode, 'OP09')
})

test('the missing-file path: null in, empty array out, no throw', () => {
  // This is exactly what build-index.mjs does when data/sealed.json is absent.
  assert.equal(isUsableSealedFile(null), false)
  assert.equal(isUsableSealedFile(undefined), false)
  assert.deepEqual(sealedIndexItems(null), [])
  assert.deepEqual(sealedIndexItems(undefined), [])
})

test('the empty-file path: a present but empty document is not usable', () => {
  const empty = buildSealedFile({ items: [], source: { provider: 'test' } })
  assert.equal(isUsableSealedFile(empty), false)
  assert.deepEqual(sealedIndexItems(empty), [])
  assert.deepEqual(sealedIndexItems({}), [])
  assert.deepEqual(sealedIndexItems({ items: 'nope' }), [])
})

test('selectSealed on no input at all returns empty, not undefined', () => {
  const result = selectSealed({ rows: [], expansions: new Map() })
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.collisions, [])
  assert.equal(result.setCodeStats.rate, null)
  assert.deepEqual(selectSealed({ rows: undefined, expansions: undefined }).items, [])
})

/* ------------------------------------------------------------------ *
 * 7. Against the real 699-row snapshot
 * ------------------------------------------------------------------ */

test('every one of the 699 real names classifies into a known kind', { skip: !rawRows }, () => {
  const distribution = kindDistribution(rawRows)
  assert.equal(distribution.total, 699)
  const summed = SEALED_KINDS.reduce((n, kind) => n + distribution.counts[kind], 0)
  assert.equal(summed, 699, 'every row must land in exactly one bucket')
})

test('measured distribution over the real snapshot', { skip: !rawRows }, () => {
  // Locked to the measured numbers. If a future pull changes them this test
  // fails loudly, which is the point: a silent shift in what counts as a box is
  // exactly the failure mode this file guards.
  assert.deepEqual(kindDistribution(rawRows).counts, {
    booster_box: 47,
    booster_pack: 64,
    case: 55,
    deck: 117,
    other: 416,
  })
})

test('no real name is classified in-scope while also containing "case"', { skip: !rawRows }, () => {
  const leaked = rawRows
    .filter((r) => IN_SCOPE_KINDS.includes(kindOf(r.name)))
    .filter((r) => /\bcase\b/i.test(r.name) || /\(\s*\d+\s*x/i.test(r.name))
  assert.deepEqual(leaked.map((r) => r.name), [])
})

test('every in-scope real name mentions "booster"', { skip: !rawRows }, () => {
  const odd = rawRows
    .filter((r) => IN_SCOPE_KINDS.includes(kindOf(r.name)))
    .filter((r) => !/booster/i.test(r.name))
  assert.deepEqual(odd.map((r) => r.name), [])
})
