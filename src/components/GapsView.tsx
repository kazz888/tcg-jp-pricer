// The pre-trip watchlist: what to HUNT before you land.
//
// Every other screen in this app is reactive - you must already be holding the
// card. This one is the opposite: it reads the whole baked index on the plane
// and ranks the cards where Japan is cheap and Europe is dear.
//
// THE HONESTY RULE THAT GOVERNS THIS FILE
// A gap is only as good as the European price it is measured against, so this
// screen ranks ONLY euStatus 'ok' cards - one code, one confirmed Japanese
// Cardmarket printing, no variant ambiguity. An 'ambiguous' card must never be
// ranked on an arbitrarily-picked candidate: OP09-033's five candidates span
// EUR 0.02 to EUR 1,383.33, so "the gap" would be whatever candidate the sort
// happened to grab. Those cards are left out, the omission is counted on
// screen, and the dearest omitted card is named by code and price so that what
// is missing is visible rather than silent.
//
// If (and only if) the printing matcher has landed and exposes a STRONG
// euMatch, those cards can be added behind a toggle that is OFF by default,
// that labels every row it adds as a guess, and that draws those rows at lower
// visual weight than a verified one. The toggle does not render at all when no
// card carries that metadata.
//
// Nothing here is profit. Cardmarket trend is a gross sale price before
// commission, postage and the wait for a buyer, and the yen figure is
// Yuyu-tei's asking price, not the price of the shop in front of you. The
// screen says so, at the top, in words.

import { useMemo, useState } from 'react'
import type { Card, EuCandidate, Fx } from '../lib/types'
import { baseName, eur, hasArt, hasRarity, pct, setOf, signedYen, yen } from './model'

/** How many rows we are willing to draw. Beyond this the list is not a list. */
const RENDER_CAP = 120

const MIN_YEN_STEPS = [0, 500, 1000, 5000] as const

export type GapSort = 'abs' | 'pct'

export interface GapRow {
  card: Card
  cand: EuCandidate
  /** The Cardmarket trend price, in euro. */
  eurPrice: number
  /** That trend price converted at the baked FX rate. */
  euJpy: number
  /** euJpy - jpySell. Positive = Europe pays more than Japan asks. */
  gapJpy: number
  /** euJpy / jpySell. 1.2 means Europe is 20% dearer. */
  ratio: number
  set: string | null
  /**
   * True when this row came from a narrowed BEST GUESS rather than from a
   * verified single printing. Guessed rows are opt-in and are labelled.
   */
  guess: boolean
  /** Short hedge shown on a guessed row, e.g. "best guess · rank 2 of 5". */
  guessNote: string
}

/** The narrowing metadata another agent may add. Absent today - never required. */
interface MaybeMatch {
  productId?: unknown
  likelihood?: unknown
  reason?: unknown
  rank?: unknown
  ofM?: unknown
}

function trendOf(c: EuCandidate | undefined): number | null {
  if (!c) return null
  const t = c.trendEur
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null
}

function makeRow(
  card: Card,
  cand: EuCandidate,
  trend: number,
  jpyPerEur: number,
  guess: boolean,
  guessNote: string,
): GapRow {
  const euJpy = trend * jpyPerEur
  return {
    card,
    cand,
    eurPrice: trend,
    euJpy,
    gapJpy: euJpy - card.jpySell,
    ratio: euJpy / card.jpySell,
    set: setOf(card.code),
    guess,
    guessNote,
  }
}

export interface GapPool {
  /** euStatus 'ok', single printing, both prices present. The honest default. */
  verified: GapRow[]
  /** Narrowed best guesses. Empty unless the matcher has landed. */
  guessed: GapRow[]
}

/**
 * Splits the index into what may be ranked and what may not.
 * Pure, so the numbers on screen can be reproduced from the JSON.
 */
export function buildGapPool(cards: readonly Card[], fx: Fx): GapPool {
  const verified: GapRow[] = []
  const guessed: GapRow[] = []

  const rate = fx.jpyPerEur
  if (!rate || rate <= 0) {
    // No FX rate means no comparable number exists. Rank nothing rather than
    // rank against a zero.
    return { verified, guessed }
  }

  for (const card of cards) {
    if (!card.jpySell || card.jpySell <= 0) continue

    // --- the trustworthy case: exactly one confirmed Japanese printing
    if (card.euStatus === 'ok' && card.eu.length === 1) {
      const cand = card.eu[0]
      const trend = trendOf(cand)
      if (cand && trend !== null) verified.push(makeRow(card, cand, trend, rate, false, ''))
      continue
    }

    // --- the opt-in case: a STRONG narrowing, if the matcher ever supplies one
    const match = (card as { euMatch?: MaybeMatch | null }).euMatch
    if (card.euStatus === 'ambiguous' && match && match.likelihood === 'strong') {
      const cand = card.eu.find((c) => c.productId === match.productId)
      const trend = trendOf(cand)
      if (cand && trend !== null) {
        const rank =
          typeof match.rank === 'number' && typeof match.ofM === 'number'
            ? ` · ${match.rank} of ${match.ofM} by price`
            : ''
        const note = typeof match.reason === 'string' && match.reason ? match.reason : 'best guess'
        guessed.push(makeRow(card, cand, trend, rate, true, `${note}${rank}`))
      }
    }
  }

  return { verified, guessed }
}

function compare(a: GapRow, b: GapRow, sort: GapSort): number {
  if (sort === 'pct') {
    if (b.ratio !== a.ratio) return b.ratio - a.ratio
    return b.gapJpy - a.gapJpy
  }
  if (b.gapJpy !== a.gapJpy) return b.gapJpy - a.gapJpy
  return b.ratio - a.ratio
}

function GapRowItem({ row, onPick }: { row: GapRow; onPick: (c: Card) => void }) {
  const { card } = row
  const up = row.gapJpy > 0
  const art = hasArt(card.img)
  // A guessed row never gets the green of a verified gap, and never the solid
  // border either: it is a likelihood wearing a likelihood's clothes.
  const tone = row.guess
    ? 'gap-row__gap gap-row__gap--guess'
    : up
      ? 'gap-row__gap gap-row__gap--up'
      : 'gap-row__gap gap-row__gap--down'
  const cls = ['gap-row', art ? 'gap-row--thumb' : '', row.guess ? 'gap-row--guess' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <li>
      <button type="button" className={cls} onClick={() => onPick(card)}>
        {art ? (
          <img
            className="gap-row__thumb"
            src={card.img}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            width={56}
            height={78}
          />
        ) : null}

        <span className="gap-row__code mono">{card.code}</span>

        <span className={tone}>
          <span className="gap-row__gap-n mono">
            <span aria-hidden="true">{up ? '▲' : '▼'}</span> {signedYen(row.gapJpy)}
          </span>
          <span className="gap-row__gap-p mono">{pct(row.ratio)}</span>
        </span>

        <span className="gap-row__name">{card.name ? baseName(card.name) : 'no name'}</span>

        <span className="gap-row__prices mono">
          <span className="gap-row__jp">{yen(card.jpySell)}</span>
          <span className="gap-row__arrow" aria-hidden="true">
            →
          </span>
          <span className="gap-row__eu">{eur(row.eurPrice)}</span>
          <span className="gap-row__eu-jpy">≈ {yen(row.euJpy)}</span>
        </span>

        {row.guess && row.guessNote ? <span className="gap-row__hedge">{row.guessNote}</span> : null}

        <span className="gap-row__meta">
          {row.guess ? <span className="tag tag--guess">Guess · not verified</span> : null}
          {card.variant ? <span className="tag tag--variant">{card.variant}</span> : null}
          {hasRarity(card.rarity) ? <span className="tag">{card.rarity}</span> : null}
          {!card.inStock ? <span className="tag tag--oos">Yuyu-tei sold out</span> : null}
        </span>

        <span className="sr-only">
          {up
            ? `Europe pays about ${Math.round(row.gapJpy)} yen more than Yuyu-tei asks.`
            : `Europe pays about ${Math.abs(Math.round(row.gapJpy))} yen less than Yuyu-tei asks.`}
          {row.guess ? ' This row is a best guess, not a verified printing.' : ''}
        </span>
      </button>
    </li>
  )
}

export default function GapsView({
  cards,
  fx,
  onPick,
  onBack,
}: {
  cards: readonly Card[]
  fx: Fx
  onPick: (c: Card) => void
  onBack: () => void
}) {
  const [sort, setSort] = useState<GapSort>('abs')
  const [minYen, setMinYen] = useState<number>(0)
  const [inStockOnly, setInStockOnly] = useState(false)
  const [showLosers, setShowLosers] = useState(false)
  const [includeGuesses, setIncludeGuesses] = useState(false)
  const [setFilter, setSetFilter] = useState<string | null>(null)

  const pool = useMemo(() => buildGapPool(cards, fx), [cards, fx])

  // Guessed rows only exist once the printing matcher lands. Until then the
  // toggle is not rendered, so the default list is the only list.
  const hasGuesses = pool.guessed.length > 0
  const base = useMemo(
    () => (includeGuesses && hasGuesses ? [...pool.verified, ...pool.guessed] : pool.verified),
    [pool, includeGuesses, hasGuesses],
  )

  const sets = useMemo(() => {
    const s = new Set<string>()
    for (const r of base) if (r.set) s.add(r.set)
    return [...s].sort()
  }, [base])

  const rows = useMemo(() => {
    const out = base.filter(
      (r) =>
        (showLosers || r.gapJpy > 0) &&
        r.card.jpySell >= minYen &&
        (!inStockOnly || r.card.inStock) &&
        (setFilter === null || r.set === setFilter),
    )
    out.sort((a, b) => compare(a, b, sort))
    return out
  }, [base, showLosers, minYen, inStockOnly, setFilter, sort])

  const shown = rows.slice(0, RENDER_CAP)
  const winners = useMemo(() => base.filter((r) => r.gapJpy > 0).length, [base])
  const bestJpy = useMemo(() => base.reduce((m, r) => Math.max(m, r.gapJpy), 0), [base])

  // What this screen is NOT showing, recounted against whatever the toggle
  // currently admits - so the omission count can never quietly go stale.
  const notRanked = Math.max(cards.length - base.length, 0)
  const dearestUnranked = useMemo(() => {
    const ranked = new Set<Card>(base.map((r) => r.card))
    let worst: Card | null = null
    for (const c of cards) {
      if (ranked.has(c)) continue
      if (!worst || c.jpySell > worst.jpySell) worst = c
    }
    return worst
  }, [cards, base])

  // The caption argues for the default sort using THIS build's own numbers, so
  // it cannot drift into a claim the data does not support.
  const loudest = useMemo(() => {
    let best: GapRow | null = null
    for (const r of base) if (r.gapJpy > 0 && (!best || r.ratio > best.ratio)) best = r
    return best
  }, [base])

  const caption = loudest
    ? `Check the yen too: the biggest percentage, ${pct(loudest.ratio)}, is ${signedYen(loudest.gapJpy)} on a ${yen(
        loudest.card.jpySell,
      )} card.`
    : 'Check the yen too: a big percentage on a cheap card is still small money.'

  return (
    <>
      <header className="topbar">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Back to search">
          ←
        </button>
        <div className="topbar__title">Cheaper in Japan</div>
      </header>

      <div className="scroll">
        <div className="pad" style={{ paddingBottom: 4 }}>
          <div className="banner banner--warn">
            <div className="banner__title">A gap is not profit</div>
            Yuyu-tei&rsquo;s price against the Cardmarket <strong>trend</strong>, before fees, postage and the wait
            for a buyer. Treat each row as a lead to check.
          </div>
        </div>

        <div className="chips" role="group" aria-label="Sort and filter">
          <button type="button" className="chip" aria-pressed={sort === 'abs'} onClick={() => setSort('abs')}>
            Most yen
          </button>
          <button type="button" className="chip" aria-pressed={sort === 'pct'} onClick={() => setSort('pct')}>
            Biggest %
          </button>
          <button type="button" className="chip" aria-pressed={inStockOnly} onClick={() => setInStockOnly((v) => !v)}>
            In stock
          </button>
          <button type="button" className="chip" aria-pressed={showLosers} onClick={() => setShowLosers((v) => !v)}>
            Europe cheaper too
          </button>
          {hasGuesses ? (
            <button
              type="button"
              className="chip chip--guess"
              aria-pressed={includeGuesses}
              onClick={() => setIncludeGuesses((v) => !v)}
            >
              Best guesses <span className="mono">{pool.guessed.length}</span>
            </button>
          ) : null}
        </div>
        {sort === 'pct' ? <div className="gap-caption">{caption}</div> : null}

        <div className="chips" role="group" aria-label="Minimum Yuyu-tei price">
          {MIN_YEN_STEPS.map((v) => (
            <button key={v} type="button" className="chip" aria-pressed={minYen === v} onClick={() => setMinYen(v)}>
              {v === 0 ? 'Any price' : `From ${yen(v)}`}
            </button>
          ))}
        </div>

        {includeGuesses && hasGuesses ? (
          <div className="pad" style={{ paddingTop: 4, paddingBottom: 4 }}>
            <div className="banner banner--warn">
              <div className="banner__title">{pool.guessed.length} guessed rows mixed in</div>
              Their euro price is the printing the matcher thinks most likely, and a wrong one can be 10x to 50x out.
              Each one is marked.
            </div>
          </div>
        ) : null}

        {sets.length > 1 ? (
          <div className="chips" role="group" aria-label="Filter by set">
            <button type="button" className="chip" aria-pressed={setFilter === null} onClick={() => setSetFilter(null)}>
              All sets
            </button>
            {sets.map((s) => (
              <button
                key={s}
                type="button"
                className="chip"
                aria-pressed={setFilter === s}
                onClick={() => setSetFilter(setFilter === s ? null : s)}
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        <div className="section-label mono">
          {rows.length.toLocaleString()} {rows.length === 1 ? 'card' : 'cards'}
          {rows.length > shown.length ? `, first ${shown.length} shown` : ''}
          {bestJpy > 0 && sort === 'abs' ? `, best ${signedYen(bestJpy)}` : ''}
        </div>

        {shown.length === 0 ? (
          <div className="empty">
            <strong>Nothing to hunt with these filters</strong>
            {base.length === 0
              ? 'No card in this build has a single verified European printing, so there is nothing safe to rank. That is missing data, not a market with no gaps.'
              : `${winners.toLocaleString()} cards cost more in Europe, but none match these filters. Lower the minimum price or clear the set.`}
          </div>
        ) : (
          <ul className="results">
            {shown.map((r) => (
              <GapRowItem key={`${r.card.setBucket}-${r.card.cardId}-${r.card.code}`} row={r} onPick={onPick} />
            ))}
          </ul>
        )}

        <div className="foot">
          {notRanked.toLocaleString()} of {cards.length.toLocaleString()} cards are left out: their code covers several
          Cardmarket printings, and the price rows cannot tell them apart.
          {dearestUnranked && dearestUnranked.jpySell > 0 ? (
            <>
              {' '}
              The dearest one missing is <span className="mono">{dearestUnranked.code}</span> at{' '}
              {yen(dearestUnranked.jpySell)}, so read this list as the floor of what is worth hunting.
            </>
          ) : null}{' '}
          Rate {fx.jpyPerEur > 0 ? `€1 = ¥${Math.round(fx.jpyPerEur)}` : 'not baked in'}
          {fx.date ? ` (${fx.date})` : ''}.
        </div>
      </div>
    </>
  )
}
