// Bookmarks: the printings you decided to hunt, ranked the same way the Gaps
// screen ranks everything else.
//
// Deliberately NOT a second opinion. Gap rows come from buildGapPool(), the same
// function the Gaps screen uses, so a card cannot look like a better deal here
// than it does there. The only difference is the input: your list instead of all
// 4,784 cards.
//
// Bookmarks you chose that have no trustworthy European price are still shown -
// in their own section, with the reason. You picked them on purpose; dropping
// them silently because the data is thin would be the app second-guessing you.

import { useMemo } from 'react'
import type { Card, Fx } from '../lib/types'
import { buildGapPool, type GapRow } from './GapsView'
import { baseName, eur, hasArt, hasRarity, pct, signedYen, yen } from './model'

function statusNote(card: Card): string {
  switch (card.euStatus) {
    case 'ambiguous':
      return `${card.eu.length} Cardmarket printings share this code — open it to pick yours`
    case 'unmapped_set':
      return 'no verified Japanese expansion for this set'
    case 'no_match':
      return card.code === '-' ? 'DON!! card — no code to match on' : 'no Cardmarket row carries this code'
    case 'not_pulled':
      return 'European data not fetched for this build'
    default:
      return 'no European price'
  }
}

function Ranked({ row, onPick, onRemove }: { row: GapRow; onPick: (c: Card) => void; onRemove: (c: Card) => void }) {
  const card = row.card
  const art = hasArt(card.img)
  const up = row.gapJpy > 0
  return (
    <li className="bm-item">
      <button
        type="button"
        className={['gap-row', art ? 'gap-row--thumb' : '', row.guess ? 'gap-row--guess' : ''].filter(Boolean).join(' ')}
        onClick={() => onPick(card)}
      >
        {art ? (
          <img className="gap-row__thumb" src={card.img} alt="" aria-hidden="true" loading="lazy" decoding="async" width={56} height={78} />
        ) : null}
        <span className="gap-row__code mono">{card.code}</span>
        <span className={up ? 'gap-row__gap gap-row__gap--up' : 'gap-row__gap gap-row__gap--down'}>
          <span className="gap-row__gap-n mono">{signedYen(row.gapJpy)}</span>
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
        <span className="gap-row__meta">
          {hasRarity(card.rarity) ? <span className="tag">{card.rarity}</span> : null}
          {card.variant ? <span className="tag tag--variant">{card.variant}</span> : null}
          {!card.inStock ? <span className="tag tag--oos">Yuyu-tei OOS</span> : null}
          {row.guess ? <span className="tag tag--ambiguous">{row.guessNote}</span> : null}
        </span>
      </button>
      <button type="button" className="bm-remove" onClick={() => onRemove(card)} aria-label={`Remove ${card.code} from bookmarks`}>
        ★
      </button>
    </li>
  )
}

function Unranked({ card, onPick, onRemove }: { card: Card; onPick: (c: Card) => void; onRemove: (c: Card) => void }) {
  const art = hasArt(card.img)
  return (
    <li className="bm-item">
      <button
        type="button"
        className={art ? 'gap-row gap-row--thumb' : 'gap-row'}
        onClick={() => onPick(card)}
      >
        {art ? (
          <img className="gap-row__thumb" src={card.img} alt="" aria-hidden="true" loading="lazy" decoding="async" width={56} height={78} />
        ) : null}
        <span className="gap-row__code mono">{card.code}</span>
        <span className="gap-row__gap gap-row__gap--none">
          <span className="gap-row__gap-n mono">{yen(card.jpySell)}</span>
          <span className="gap-row__gap-p">Japan</span>
        </span>
        <span className="gap-row__name">{card.name ? baseName(card.name) : 'no name'}</span>
        <span className="bm-why">{statusNote(card)}</span>
        <span className="gap-row__meta">
          {hasRarity(card.rarity) ? <span className="tag">{card.rarity}</span> : null}
          {card.variant ? <span className="tag tag--variant">{card.variant}</span> : null}
          {!card.inStock ? <span className="tag tag--oos">Yuyu-tei OOS</span> : null}
        </span>
      </button>
      <button type="button" className="bm-remove" onClick={() => onRemove(card)} aria-label={`Remove ${card.code} from bookmarks`}>
        ★
      </button>
    </li>
  )
}

export default function BookmarksView({
  cards,
  fx,
  onPick,
  onRemove,
  onBack,
}: {
  /** Only the bookmarked cards, in the order they were saved. */
  cards: readonly Card[]
  fx: Fx
  onPick: (c: Card) => void
  onRemove: (c: Card) => void
  onBack: () => void
}) {
  // Same ranking function as the Gaps screen. Guessed rows are INCLUDED here
  // (unlike the Gaps default) because you chose these cards deliberately - but
  // every guessed row still carries its hedge tag.
  const { ranked, unranked } = useMemo(() => {
    const pool = buildGapPool(cards, fx)
    const rows = [...pool.verified, ...pool.guessed].sort((a, b) => b.gapJpy - a.gapJpy)
    const seen = new Set(rows.map((r) => `${r.card.setBucket}|${r.card.cardId}`))
    return {
      ranked: rows,
      unranked: cards.filter((c) => !seen.has(`${c.setBucket}|${c.cardId}`)),
    }
  }, [cards, fx])

  const best = ranked.length ? ranked[0] : null
  const winners = ranked.filter((r) => r.gapJpy > 0).length

  return (
    <>
      <header className="topbar">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Back to search">
          ←
        </button>
        <div className="topbar__title">Bookmarks</div>
      </header>

      <div className="scroll">
        {cards.length === 0 ? (
          <div className="empty">
            <strong>No bookmarks yet</strong>
            Open any card and tap ★ to add it. This is your hunting list: it is ranked by the euro you would gain,
            and it works offline in a shop.
          </div>
        ) : (
          <>
            <div className="pad" style={{ paddingBottom: 0 }}>
              <div className="cov-grid">
                <div className="cov-stat">
                  <div className="cov-stat__n mono">{cards.length}</div>
                  <div className="cov-stat__l">Bookmarked</div>
                </div>
                <div className="cov-stat">
                  <div className="cov-stat__n mono">{winners}</div>
                  <div className="cov-stat__l">Worth more in Europe</div>
                </div>
                <div className={unranked.length ? 'cov-stat cov-stat--none' : 'cov-stat'}>
                  <div className="cov-stat__n mono">{unranked.length}</div>
                  <div className="cov-stat__l">No European price</div>
                </div>
              </div>
              {best ? (
                <div className="foot">
                  Sorted by the yen you would gain. Best on this list is{' '}
                  <span className="mono">{best.card.code}</span> at {signedYen(best.gapJpy)}.
                </div>
              ) : null}
            </div>

            {ranked.length ? (
              <>
                <div className="section-label">Ranked · {ranked.length}</div>
                <ul className="results">
                  {ranked.map((r) => (
                    <Ranked key={`${r.card.setBucket}-${r.card.cardId}`} row={r} onPick={onPick} onRemove={onRemove} />
                  ))}
                </ul>
              </>
            ) : null}

            {unranked.length ? (
              <>
                <div className="section-label">No European price · {unranked.length}</div>
                <ul className="results">
                  {unranked.map((c) => (
                    <Unranked key={`${c.setBucket}-${c.cardId}`} card={c} onPick={onPick} onRemove={onRemove} />
                  ))}
                </ul>
                <div className="foot">
                  These are bookmarked but cannot be ranked — the reason is on each row. They are kept here rather
                  than dropped, because you chose them.
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}
