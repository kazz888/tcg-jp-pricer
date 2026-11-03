// The European context. Deliberately SUBORDINATE to the Yuyu-tei headline.
//
// This component is where the governing safety rule lives. One card code maps
// to several Cardmarket printings (base / parallel / manga art) whose prices
// differ by 10x-50x, and the bulk rows carry no rarity field. So:
//   - more than one candidate  -> every candidate is listed, never blended
//   - no verified mapping      -> plain words, never a 0 and never a dash
// A missing price is always spelled out in text. Nothing here may be mistaken
// for "this card is worth nothing".

import type { Card, EuCandidate, Fx } from '../lib/types'
import { eur, eurToJpy, setOf, yen } from './model'

function Money({ label, value }: { label: string; value: number | null }) {
  if (value === null || value <= 0) {
    return (
      <span className="cand__price cand__price--na">
        {label}
        <b>not listed</b>
      </span>
    )
  }
  return (
    <span className="cand__price">
      {label}
      <b>{eur(value)}</b>
    </span>
  )
}

function Candidate({ c, fx }: { c: EuCandidate; fx: Fx }) {
  const jpy = c.trendEur !== null && c.trendEur > 0 ? eurToJpy(c.trendEur, fx) : null
  return (
    <li className="cand">
      <span className="cand__exp">{c.expansionName}</span>
      {c.trendEur !== null && c.trendEur > 0 ? (
        <span className="cand__trend">
          {eur(c.trendEur)}
          {jpy !== null ? <span className="cand__jpy">≈ {yen(jpy)}</span> : null}
        </span>
      ) : (
        <span className="cand__trend cand__trend--na">No trend price</span>
      )}
      {c.name ? <span className="cand__name">{c.name}</span> : null}
      <span className="cand__prices">
        <Money label="Low" value={c.lowEur} />
        <Money label="7-day" value={c.avg7Eur} />
      </span>
    </li>
  )
}

export default function EuPanel({ card, fx }: { card: Card; fx: Fx }) {
  const set = setOf(card.code)
  const candidates = card.eu

  // The euro sign appears on this screen ONLY when a euro figure for THIS card
  // is actually on it. Otherwise the FX label is the single "€..." on a card we
  // cannot price, which is exactly the misread this app must not cause.
  const showsEuros =
    (card.euStatus === 'ok' || card.euStatus === 'ambiguous') &&
    candidates.some((c) => c.trendEur !== null || c.lowEur !== null || c.avg7Eur !== null)
  const fxNote = showsEuros && fx.jpyPerEur > 0 ? `€1 = ¥${Math.round(fx.jpyPerEur)}` : ''

  let body: React.ReactNode

  if (card.euStatus === 'unmapped_set') {
    body = (
      <>
        <p className="eu__msg eu__msg--warn">No verified European price for {set ?? 'this set'}.</p>
        <p className="eu__msg">
          Cardmarket only lists it as &ldquo;Asia Region Legal&rdquo;, which is not confirmed Japanese. A gap in the
          data, not in the card&rsquo;s value.
        </p>
      </>
    )
  } else if (card.euStatus === 'no_match') {
    body = (
      <p className="eu__msg">
        No Cardmarket listing carries <strong className="mono">{card.code}</strong>.
      </p>
    )
  } else if (card.euStatus === 'not_pulled') {
    body = <p className="eu__msg">Cardmarket prices are not in this build. A missing fetch, not a missing value.</p>
  } else if (candidates.length === 0) {
    // Status claims data but none arrived. Fail closed rather than render blanks.
    body = <p className="eu__msg">No European printings in the index for this card.</p>
  } else if (candidates.length === 1 && card.euStatus === 'ok') {
    body = (
      <ul className="cand-list">
        <Candidate c={candidates[0]!} fx={fx} />
      </ul>
    )
  } else {
    // Two or more printings share this code. NEVER collapse them.
    body = (
      <>
        <p className="eu__msg eu__msg--warn">
          {candidates.length} printings share {card.code} and can differ 10x to 50x. Match yours by name; nothing is
          averaged.
        </p>
        <ul className="cand-list">
          {candidates.map((c) => (
            <Candidate key={`${c.productId}-${c.expansionId}`} c={c} fx={fx} />
          ))}
        </ul>
      </>
    )
  }

  return (
    <section className="eu" id="eu" aria-label="European price context">
      <div className="eu__head">
        <h2 className="eu__title">Europe</h2>
        {fxNote ? <span className="eu__sub">{fxNote}</span> : null}
      </div>
      {body}
      {/* Cardmarket publishes the price guide once a day. Trend is a computed
          statistic and matches the site exactly; "From" on the live page is
          the cheapest ACTIVE listing and drifts within the day as copies sell
          or get undercut. Verified 2026-09-15 on OP09-119: trend 1854.76 to
          the cent, while the live "From" had moved 1900 -> 1750. */}
      {showsEuros ? <div className="cand__stale">Cardmarket trend. Low is from the daily guide, not live.</div> : null}
    </section>
  )
}
