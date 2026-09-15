// Tests for the SHIPPED verdict - src/components/verdict.tsx, the module
// CardView.tsx actually imports. (scripts/lib/join.mjs section 6 holds a second,
// DIFFERENT set of verdict helpers that no UI code imports; see the report.)
//
// WHY THE LOADER SHIM BELOW: Node 26 runs .ts natively (type stripping is
// stable) but refuses .tsx with ERR_UNKNOWN_FILE_EXTENSION, and no flag changes
// that. verdict.tsx contains no JSX at all, so stripping its types yields valid
// JS. node:module's public stripTypeScriptTypes + registerHooks let us load the
// real shipped file, unmodified, with zero extra dependencies. We test the
// shipped artifact - never a copy of it.

// The five `node:` imports below are annotated with @ts-ignore on purpose.
// This project deliberately does NOT depend on @types/node (only @types/react
// and @types/react-dom are installed), so `tsc --noEmit` cannot resolve Node
// builtins. Suppressing those five lines keeps `pnpm check` green without
// adding a dependency or editing tsconfig.json, while every domain type in the
// rest of this file (Card, Verdict, Band) is still fully type-checked.

// @ts-ignore - no @types/node in this project
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// @ts-ignore - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-ignore - no @types/node in this project
import { fileURLToPath } from 'node:url'
// @ts-ignore - no @types/node in this project
import test from 'node:test'
// @ts-ignore - no @types/node in this project
import assert from 'node:assert/strict'

import type { Card } from '../lib/types'
import type { Band, Verdict, VerdictResult } from './verdict'

interface ResolveContext { parentURL?: string }
interface LoadResult { format: string; source: string; shortCircuit: boolean }
interface ResolveResult { url: string; format: string; shortCircuit: boolean }

registerHooks({
  resolve(
    spec: string,
    ctx: ResolveContext,
    next: (s: string, c: ResolveContext) => ResolveResult,
  ): ResolveResult {
    if (spec.endsWith('.tsx')) {
      return { url: new URL(spec, ctx.parentURL).href, format: 'module', shortCircuit: true }
    }
    return next(spec, ctx)
  },
  load(
    url: string,
    ctx: unknown,
    next: (u: string, c: unknown) => LoadResult,
  ): LoadResult {
    if (url.endsWith('.tsx')) {
      const source = readFileSync(fileURLToPath(url), 'utf8')
      return {
        format: 'module',
        source: stripTypeScriptTypes(source, { mode: 'strip' }),
        shortCircuit: true,
      }
    }
    return next(url, ctx)
  },
})

// Non-literal specifier: keeps tsc from demanding allowImportingTsExtensions
// while the runtime still loads the real .tsx. Types come from the line above.
const SPECIFIER = './verdict.tsx'
const { judge, parseAsk } = (await import(SPECIFIER)) as typeof import('./verdict')

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function card(jpySell: number, jpyBuy: number | null = null): Card {
  return {
    code: 'OP09-119',
    name: 'モンキー・D・ルフィ',
    variant: null,
    rarity: 'SEC',
    setBucket: 'op09',
    cardId: '1',
    img: '',
    detailUrl: '',
    jpySell,
    jpyBuy,
    jpyBuyPrev: null,
    inStock: true,
    stock: 1,
    euStatus: 'ok',
    eu: [],
  }
}

/** Asserts a judgement was produced and narrows the union. */
function judged(result: VerdictResult): Verdict {
  assert.equal(result.kind, 'judged', `expected a judgement, got: ${JSON.stringify(result)}`)
  return result as Verdict
}

/** Band for an ask/sell pair, via the shipped entry point. */
function bandOf(ask: number, sell: number): Band {
  return judged(judge(card(sell), ask)).band
}

const REFERENCE = 1000

/* ------------------------------------------------------------------ */
/* 1. band boundaries - tested EXACTLY ON each threshold               */
/*                                                                     */
/* BANDS uses `ratio <= b.max` in order, so every threshold is an      */
/* INCLUSIVE UPPER BOUND: a card sitting precisely on 0.92 is GOOD,    */
/* not FAIR. These tests pin that down.                                */
/* ------------------------------------------------------------------ */

test('the four boundary ratios are exactly representable, so ON-threshold tests are meaningful', () => {
  // Guards the tests below: if these divisions were off by one ULP the
  // boundary assertions would silently be testing "just under" instead.
  assert.equal(700 / REFERENCE, 0.7)
  assert.equal(920 / REFERENCE, 0.92)
  assert.equal(1080 / REFERENCE, 1.08)
  assert.equal(1350 / REFERENCE, 1.35)
})

test('ratio exactly 0.70 is STEAL (threshold is an inclusive upper bound)', () => {
  const v = judged(judge(card(REFERENCE), 700))
  assert.equal(v.ratio, 0.7)
  assert.equal(v.band, 'steal')
  assert.equal(v.label, 'STEAL')
})

test('ratio exactly 0.92 is GOOD, not FAIR', () => {
  const v = judged(judge(card(REFERENCE), 920))
  assert.equal(v.ratio, 0.92)
  assert.equal(v.band, 'good')
  assert.equal(v.label, 'GOOD PRICE')
})

test('ratio exactly 1.08 is FAIR, not HIGH', () => {
  const v = judged(judge(card(REFERENCE), 1080))
  assert.equal(v.ratio, 1.08)
  assert.equal(v.band, 'fair')
  assert.equal(v.label, 'FAIR / MARKET')
})

test('ratio exactly 1.35 is HIGH, not OVER', () => {
  const v = judged(judge(card(REFERENCE), 1350))
  assert.equal(v.ratio, 1.35)
  assert.equal(v.band, 'high')
  assert.equal(v.label, 'HIGH')
})

test('one yen above each boundary crosses into the next band', () => {
  assert.equal(bandOf(701, REFERENCE), 'good')
  assert.equal(bandOf(921, REFERENCE), 'fair')
  assert.equal(bandOf(1081, REFERENCE), 'high')
  assert.equal(bandOf(1351, REFERENCE), 'over')
})

test('one yen below each boundary stays in the lower band', () => {
  assert.equal(bandOf(699, REFERENCE), 'steal')
  assert.equal(bandOf(919, REFERENCE), 'good')
  assert.equal(bandOf(1079, REFERENCE), 'fair')
  assert.equal(bandOf(1349, REFERENCE), 'high')
})

test('the shipped thresholds are 0.70 / 0.92 / 1.08 / 1.35 - changing them must fail this test', () => {
  // These numbers are a product decision. This test exists so that an edit to
  // BANDS is a deliberate, visible act rather than a silent drift.
  const smallestStep = 1e-9
  const thresholds: Array<[number, Band, Band]> = [
    [0.7, 'steal', 'good'],
    [0.92, 'good', 'fair'],
    [1.08, 'fair', 'high'],
    [1.35, 'high', 'over'],
  ]
  for (const [ratio, onBand, aboveBand] of thresholds) {
    assert.equal(bandOf(ratio * REFERENCE, REFERENCE), onBand, `ratio ${ratio} should be ${onBand}`)
    assert.equal(
      bandOf((ratio + smallestStep) * REFERENCE, REFERENCE),
      aboveBand,
      `ratio just above ${ratio} should be ${aboveBand}`,
    )
  }
})

test('every band is reachable and carries a distinct label and glyph', () => {
  const seen = new Map<Band, Verdict>()
  for (const ask of [1, 700, 800, 1000, 1200, 100000]) {
    const v = judged(judge(card(REFERENCE), ask))
    seen.set(v.band, v)
  }
  assert.deepEqual([...seen.keys()].sort(), ['fair', 'good', 'high', 'over', 'steal'])
  const labels = [...seen.values()].map((v) => v.label)
  const glyphs = [...seen.values()].map((v) => v.glyph)
  assert.equal(new Set(labels).size, 5, 'labels must be distinct')
  assert.equal(new Set(glyphs).size, 5, 'glyphs must be distinct - the dim-shop colourblind cue')
  for (const v of seen.values()) {
    assert.ok(v.label.length > 0)
    assert.ok(v.glyph.length > 0)
  }
})

test('band never worsens as the asking price falls (monotonic sweep, 1..3000 yen)', () => {
  const order: Band[] = ['steal', 'good', 'fair', 'high', 'over']
  let previous = -1
  for (let ask = 1; ask <= 3000; ask++) {
    const index = order.indexOf(bandOf(ask, REFERENCE))
    assert.notEqual(index, -1, `unknown band at ask=${ask}`)
    assert.ok(index >= previous, `band went backwards at ask=${ask}`)
    previous = index
  }
  assert.equal(previous, 4, 'the sweep should end in the over band')
})

/* ------------------------------------------------------------------ */
/* 2. ratio 1.0 and the wording around it                              */
/* ------------------------------------------------------------------ */

test('ratio exactly 1.0 is FAIR and reads as level with Yuyu-tei', () => {
  const v = judged(judge(card(REFERENCE), REFERENCE))
  assert.equal(v.ratio, 1)
  assert.equal(v.band, 'fair')
  assert.equal(v.deltaJpy, 0)
  assert.equal(v.ask, REFERENCE)
  assert.equal(v.sell, REFERENCE)
  assert.equal(v.explain, 'Shop asks level with Yuyu-tei.')
})

test('the level-with window is 0.995..1.005 inclusive, under/over outside it', () => {
  assert.equal(judged(judge(card(REFERENCE), 995)).explain, 'Shop asks level with Yuyu-tei.')
  assert.equal(judged(judge(card(REFERENCE), 1005)).explain, 'Shop asks level with Yuyu-tei.')
  assert.match(judged(judge(card(REFERENCE), 994)).explain, /under Yuyu-tei/)
  assert.match(judged(judge(card(REFERENCE), 1006)).explain, /over Yuyu-tei/)
})

test('explain reports the percentage gap in the right direction', () => {
  assert.equal(judged(judge(card(REFERENCE), 700)).explain, 'Shop asks 30% under Yuyu-tei.')
  assert.equal(judged(judge(card(REFERENCE), 1500)).explain, 'Shop asks 50% over Yuyu-tei.')
})

test('deltaJpy is the signed yen gap, not an absolute value', () => {
  assert.equal(judged(judge(card(REFERENCE), 700)).deltaJpy, -300)
  assert.equal(judged(judge(card(REFERENCE), 1500)).deltaJpy, 500)
})

/* ------------------------------------------------------------------ */
/* 3. missing or zero Yuyu-tei reference price                         */
/*                                                                     */
/* The product rule: unknown must never be rendered as cheap.          */
/* ------------------------------------------------------------------ */

test('a zero Yuyu-tei sell price yields no verdict, never a band', () => {
  const result = judge(card(0), 1000)
  assert.equal(result.kind, 'no-reference')
  assert.match((result as { reason: string }).reason, /no sell price/)
  assert.ok(!('band' in result), 'a no-reference result must not carry a band')
})

test('a missing Yuyu-tei sell price (null / undefined / NaN) yields no verdict', () => {
  for (const missing of [null, undefined, NaN]) {
    const broken = { ...card(0), jpySell: missing as unknown as number }
    assert.equal(judge(broken, 1000).kind, 'no-reference', `jpySell=${String(missing)}`)
  }
})

test('a negative Yuyu-tei sell price yields no verdict rather than an inverted band', () => {
  // -500 would otherwise give ratio -2 and, since -2 <= 0.7, a false STEAL.
  assert.equal(judge(card(-500), 1000).kind, 'no-reference')
})

test('the no-reference reason explicitly refuses to call an unknown price cheap', () => {
  const result = judge(card(0), 1000)
  assert.match((result as { reason: string }).reason, /Do not treat that as cheap or expensive/)
})

/* ------------------------------------------------------------------ */
/* 4. asking price input                                               */
/* ------------------------------------------------------------------ */

test('a zero asking price asks for input instead of judging', () => {
  const result = judge(card(REFERENCE), 0)
  assert.equal(result.kind, 'no-reference')
  assert.match((result as { reason: string }).reason, /asking price/)
})

test('a negative asking price yields no verdict, never a STEAL', () => {
  const result = judge(card(REFERENCE), -1)
  assert.equal(result.kind, 'no-reference')
  assert.equal(judge(card(REFERENCE), -100000).kind, 'no-reference')
})

test('NaN and Infinity asking prices yield no verdict', () => {
  assert.equal(judge(card(REFERENCE), NaN).kind, 'no-reference')
  assert.equal(judge(card(REFERENCE), Infinity).kind, 'no-reference')
  assert.equal(judge(card(REFERENCE), -Infinity).kind, 'no-reference')
})

test('the ask guard runs before the reference guard, so a blank input never blames the data', () => {
  // Both inputs bad: the user should be told to type a price, not that
  // Yuyu-tei is missing one.
  const result = judge(card(0), 0)
  assert.equal(result.kind, 'no-reference')
  assert.match((result as { reason: string }).reason, /asking price/)
})

/* ------------------------------------------------------------------ */
/* 5. very large numbers                                               */
/* ------------------------------------------------------------------ */

test('a realistically huge asking price lands in over without crashing', () => {
  // 99,999,999 yen is reachable on the keypad; the dearest real card is ~1e6.
  const v = judged(judge(card(100), 99_999_999))
  assert.equal(v.band, 'over')
  assert.ok(Number.isFinite(v.ratio))
  assert.equal(v.deltaJpy, 99_999_899)
})

test('a huge reference price against a small ask lands in steal without underflow', () => {
  const v = judged(judge(card(99_999_999), 100))
  assert.equal(v.band, 'steal')
  assert.ok(v.ratio > 0)
})

test('Number.MAX_VALUE inputs stay finite and land in defined bands', () => {
  const big = judged(judge(card(1), Number.MAX_VALUE))
  assert.equal(big.band, 'over')
  assert.ok(Number.isFinite(big.ratio))

  const small = judged(judge(card(Number.MAX_VALUE), 1))
  assert.equal(small.band, 'steal')
})

test('an overflowing ratio still resolves to over rather than throwing on the non-null assertion', () => {
  // ratio === Infinity. BANDS ends at Infinity, and `ratio <= Infinity` holds,
  // so find() must still return a band.
  const v = judged(judge(card(Number.MIN_VALUE), Number.MAX_VALUE))
  assert.equal(v.ratio, Infinity)
  assert.equal(v.band, 'over')
})

/* ------------------------------------------------------------------ */
/* 6. underFloor - the buyback signal                                  */
/* ------------------------------------------------------------------ */

test('underFloor is true only at or below the Yuyu-tei buyback price', () => {
  assert.equal(judged(judge(card(REFERENCE, 600), 599)).underFloor, true)
  assert.equal(judged(judge(card(REFERENCE, 600), 600)).underFloor, true, 'inclusive at the floor')
  assert.equal(judged(judge(card(REFERENCE, 600), 601)).underFloor, false)
})

test('underFloor is false when Yuyu-tei does not buy the card back', () => {
  assert.equal(judged(judge(card(REFERENCE, null), 1)).underFloor, false)
  assert.equal(judged(judge(card(REFERENCE, 0), 1)).underFloor, false)
})

test('an undefined buyback price does not crash the underFloor check', () => {
  // types.ts says number | null, but index.json is generated - defend anyway.
  const broken = { ...card(REFERENCE), jpyBuy: undefined as unknown as number | null }
  assert.equal(judged(judge(broken, 1)).underFloor, false)
})

test('underFloor is independent of the band', () => {
  // A card can be under the buyback floor and still not be the cheapest band.
  const v = judged(judge(card(REFERENCE, 950), 940))
  assert.equal(v.band, 'fair')
  assert.equal(v.underFloor, true)
})

/* ------------------------------------------------------------------ */
/* 7. parseAsk - what the keypad hands to judge()                      */
/* ------------------------------------------------------------------ */

test('parseAsk keeps digits and drops everything else', () => {
  assert.equal(parseAsk('1234'), 1234)
  assert.equal(parseAsk('¥1,234'), 1234)
  assert.equal(parseAsk(' 1 234 '), 1234)
  assert.equal(parseAsk('1234円'), 1234)
})

test('parseAsk returns 0 for empty and non-numeric input, which judge() then refuses', () => {
  assert.equal(parseAsk(''), 0)
  assert.equal(parseAsk('abc'), 0)
  assert.equal(parseAsk('---'), 0)
  assert.equal(judge(card(REFERENCE), parseAsk('')).kind, 'no-reference')
})

test('parseAsk strips a minus sign, so a negative can never reach judge() from the keypad', () => {
  assert.equal(parseAsk('-500'), 500)
})

test('parseAsk drops the decimal separator because yen has no subunit', () => {
  // Documented intent in verdict.tsx: "Digits only - no decimals exist in yen".
  assert.equal(parseAsk('12.50'), 1250)
})

test('parseAsk handles a long digit run without returning NaN or Infinity', () => {
  const n = parseAsk('9'.repeat(30))
  assert.ok(Number.isFinite(n))
  assert.ok(n > 0)
})

/* ------------------------------------------------------------------ */
/* 8. shape of the result the UI destructures                          */
/* ------------------------------------------------------------------ */

test('a judgement carries every field CardView renders', () => {
  const v = judged(judge(card(REFERENCE, 600), 800))
  for (const key of ['kind', 'band', 'label', 'glyph', 'ratio', 'deltaJpy', 'ask', 'sell', 'explain', 'underFloor']) {
    assert.ok(key in v, `missing ${key}`)
  }
  assert.equal(v.ask, 800)
  assert.equal(v.sell, REFERENCE)
})

test('judge never mutates the card it was handed', () => {
  const original = card(REFERENCE, 600)
  const snapshot = JSON.stringify(original)
  judge(original, 800)
  assert.equal(JSON.stringify(original), snapshot)
})
