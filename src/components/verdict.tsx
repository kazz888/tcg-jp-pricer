// The headline judgement: shop asking price vs the Japanese market.
//
// Yuyu-tei's SELL price is the reference - it is what a Japanese buyer would
// actually pay today. Yuyu-tei's BUYBACK is the realistic floor: what a dealer
// hands over in cash, so anything at or under it is close to free money.
// Europe is deliberately NOT part of this calculation.

import type { Card } from '../lib/types'

export type Band = 'steal' | 'good' | 'fair' | 'high' | 'over'

export interface Verdict {
  kind: 'judged'
  band: Band
  /** Big word. Never the only signal - glyph and numbers repeat it. */
  label: string
  /** Redundant non-colour cue for dim light / colourblindness. */
  glyph: string
  ratio: number
  deltaJpy: number
  ask: number
  sell: number
  explain: string
  /** True when the shop wants less than Yuyu-tei themselves pay in cash. */
  underFloor: boolean
}

export interface NoVerdict {
  kind: 'no-reference'
  reason: string
}

export type VerdictResult = Verdict | NoVerdict

const BANDS: Array<{ max: number; band: Band; label: string; glyph: string }> = [
  { max: 0.7, band: 'steal', label: 'STEAL', glyph: '▼▼' },
  { max: 0.92, band: 'good', label: 'GOOD PRICE', glyph: '▼' },
  { max: 1.08, band: 'fair', label: 'FAIR / MARKET', glyph: '●' },
  { max: 1.35, band: 'high', label: 'HIGH', glyph: '▲' },
  { max: Infinity, band: 'over', label: 'OVERPRICED', glyph: '▲▲' },
]

export function judge(card: Card, ask: number): VerdictResult {
  if (!Number.isFinite(ask) || ask <= 0) {
    return { kind: 'no-reference', reason: 'Enter the shop’s asking price to get a verdict.' }
  }
  if (!card.jpySell || card.jpySell <= 0) {
    return {
      kind: 'no-reference',
      reason:
        'Yuyu-tei has no sell price for this card, so there is no Japanese reference to compare against. Do not treat that as cheap or expensive — it is unknown.',
    }
  }

  const sell = card.jpySell
  const ratio = ask / sell
  const hit = BANDS.find((b) => ratio <= b.max)!
  const deltaJpy = ask - sell

  const cmp =
    ratio < 0.995
      ? `${Math.round((1 - ratio) * 100)}% under Yuyu-tei`
      : ratio > 1.005
        ? `${Math.round((ratio - 1) * 100)}% over Yuyu-tei`
        : 'level with Yuyu-tei'

  return {
    kind: 'judged',
    band: hit.band,
    label: hit.label,
    glyph: hit.glyph,
    ratio,
    deltaJpy,
    ask,
    sell,
    explain: `Shop asks ${cmp}.`,
    underFloor: card.jpyBuy !== null && card.jpyBuy > 0 && ask <= card.jpyBuy,
  }
}

/** Parses the on-screen amount. Digits only - no decimals exist in yen. */
export function parseAsk(raw: string): number {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return 0
  const n = Number(digits)
  return Number.isFinite(n) ? n : 0
}
