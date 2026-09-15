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

function Money({ label, value, fx }: { label: string; value: number | null; fx: Fx }) {
  if (value === null || value <= 0) {
    return (
      <div className="cand__price cand__price--na">
        {label}
        <b>not listed</b>
      </div>
    )
  }
  const jpy = eurToJpy(value, fx)
  return (
    <div className="cand__price">
      {label}
      <b>{eur(value)}</b>
      {jpy !== null ? <span className="sr-only">{` (about ${yen(jpy)})`}</span> : null}
    </div>
  )
}

function Candidate({ c, fx }: { c: EuCandidate; fx: Fx }) {
  const jpy = c.trendEur !== null ? eurToJpy(c.trendEur, fx) : null
  return (
    <li>
      <div className="cand">
        <div className="cand__exp">{c.expansionName}</div>
        {c.name ? <div className="cand__name">{c.name}</div> : null}
        <div className="cand__prices">
          <Money label="Trend" value={c.trendEur} fx={fx} />
          <Money label="Low @ snapshot" value={c.lowEur} fx={fx} />
          <Money label="7-day avg" value={c.avg7Eur} fx={fx} />
        </div>
        {jpy !== null ? (
          <div className="cand__jpy">Trend ≈ {yen(jpy)} at the baked rate</div>
        ) : null}
        {/* Cardmarket publishes the price guide once a day. Trend is a computed
            statistic and matches the site exactly; "From" on the live page is
            the cheapest ACTIVE listing and drifts within the day as copies sell
            or get undercut. Verified 2026-09-15 on OP09-119: trend 1854.76 to
            the cent, while the live "From" had moved 1900 -> 1750. */}
        <div className="cand__stale">
          Low is from the daily guide, not live — Cardmarket’s “From” moves during the day.
        </div>
      </div>
    </li>
  )
}

function Box({
  tone,
  status,
  children,
}: {
  tone: 'ok' | 'warn' | 'none'
  status: string
  children: React.ReactNode
}) {
  const boxClass = tone === 'warn' ? 'eu__box eu__box--warn' : tone === 'none' ? 'eu__box eu__box--none' : 'eu__box'
  const statusClass =
    tone === 'warn' ? 'eu__status eu__status--ambiguous' : tone === 'none' ? 'eu__status eu__status--none' : 'eu__status eu__status--ok'
  return (
    <div className={boxClass}>
      <span className={statusClass}>{status}</span>
      {children}
    </div>
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
      <Box tone="none" status="No verified European price">
        <p className="eu__msg">
          <strong>
            This set{set ? ` (${set})` : ''} is not mapped to a confirmed Japanese Cardmarket expansion.
          </strong>{' '}
          That is a gap in our data, <strong>not</strong> a statement about the card&rsquo;s value — the card may
          well be valuable.
        </p>
        <p className="eu__msg" style={{ marginTop: 8 }}>
          Cardmarket lists this set only under &ldquo;Asia Region Legal&rdquo;, which has not been confirmed to mean
          Japanese-language. Using it could show you a price for the wrong printing, so we show nothing. Judge on the
          Yuyu-tei numbers above.
        </p>
      </Box>
    )
  } else if (card.euStatus === 'no_match') {
    body = (
      <Box tone="none" status="No European listing found">
        <p className="eu__msg">
          The set <strong>is</strong> mapped, but no Cardmarket row carries the code{' '}
          <strong className="mono">{card.code}</strong>. No European reference for this card.
        </p>
      </Box>
    )
  } else if (card.euStatus === 'not_pulled') {
    body = (
      <Box tone="none" status="European data not fetched">
        <p className="eu__msg">
          Cardmarket prices have not been pulled for this build. Nothing to compare against — this is a missing
          fetch, not a missing value.
        </p>
      </Box>
    )
  } else if (candidates.length === 0) {
    // Status claims data but none arrived. Fail closed rather than render blanks.
    body = (
      <Box tone="none" status="No European candidates">
        <p className="eu__msg">
          The index reports status <strong className="mono">{card.euStatus}</strong> but contains no printings. Treat
          this as no European reference.
        </p>
      </Box>
    )
  } else if (candidates.length === 1 && card.euStatus === 'ok') {
    const c = candidates[0]!
    const jpy = c.trendEur !== null ? eurToJpy(c.trendEur, fx) : null
    body = (
      <Box tone="ok" status="One verified Japanese printing">
        <div className="cand__exp">{c.expansionName}</div>
        {c.trendEur !== null && c.trendEur > 0 ? (
          <>
            <div className="eu__single-value">{eur(c.trendEur)}</div>
            <div className="eu__sub">
              Cardmarket trend{jpy !== null ? ` · ≈ ${yen(jpy)}` : ''}
            </div>
          </>
        ) : (
          <p className="eu__msg" style={{ marginTop: 6 }}>
            <strong>No trend price on Cardmarket for this printing.</strong>
          </p>
        )}
        <ul className="cand-list">
          <Candidate c={c} fx={fx} />
        </ul>
      </Box>
    )
  } else {
    // Two or more printings share this code. NEVER collapse them.
    body = (
      <Box tone="warn" status={`Ambiguous · ${candidates.length} printings`}>
        <p className="eu__msg">
          <strong>{candidates.length} different Cardmarket printings share the code {card.code}.</strong> Base, parallel
          and alternate-art prints can differ 10x–50x, and the price rows carry no rarity field — so we cannot
          tell which one you are holding.
        </p>
        <p className="eu__msg" style={{ marginTop: 8 }}>
          <strong>You must decide which printing is in your hand.</strong> No average or &ldquo;best guess&rdquo; is
          shown, because a wrong one would cost you real money.
        </p>
        <ul className="cand-list">
          {candidates.map((c) => (
            <Candidate key={`${c.productId}-${c.expansionId}`} c={c} fx={fx} />
          ))}
        </ul>
      </Box>
    )
  }

  return (
    <section className="eu" aria-label="European price context">
      <div className="eu__head">
        <h2 className="eu__title">Europe (secondary)</h2>
        {fxNote ? <span className="eu__sub">{fxNote}</span> : null}
      </div>
      {body}
    </section>
  )
}
