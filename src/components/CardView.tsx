// One card, one asking price, one verdict.
//
// Reading order is deliberate: the card itself, big enough to match against
// the one in your hand -> what the Japanese market does (Yuyu-tei) -> Europe,
// smaller and visibly subordinate. The shop's price and the verdict live in the
// dock at the bottom, so the answer is always above your thumb.

import { useEffect, useState } from 'react'
import type { Card, Fx } from '../lib/types'
import { Stepper } from './CollectionView'
import EuPanel from './EuPanel'
import { AskDock } from './Keypad'
import { baseName, bigArt, eur, eurToJpy, hasArt, hasRarity, signedYen, yen } from './model'
import { judge, parseAsk } from './verdict'

/** Europe in one line, for the facts beside the card. Never a 0 or a dash. */
function EuFact({ card, fx }: { card: Card; fx: Fx }) {
  const only = card.eu.length === 1 && card.euStatus === 'ok' ? card.eu[0] : null
  if (only && only.trendEur !== null && only.trendEur > 0) {
    const jpy = eurToJpy(only.trendEur, fx)
    return (
      <dd className="mono">
        {eur(only.trendEur)}
        {jpy !== null ? <span className="facts__sub">≈ {yen(jpy)}</span> : null}
      </dd>
    )
  }
  if (card.eu.length > 1) {
    return (
      <dd>
        <button
          type="button"
          className="facts__more"
          onClick={() => document.getElementById('eu')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          {card.eu.length} printings
        </button>
      </dd>
    )
  }
  const words =
    card.euStatus === 'unmapped_set'
      ? 'Not verified'
      : card.euStatus === 'no_match'
        ? 'No listing'
        : card.euStatus === 'not_pulled'
          ? 'Not fetched'
          : 'No trend price'
  return <dd className="facts__none">{words}</dd>
}

export default function CardView({
  card,
  siblings,
  fx,
  bookmarked,
  onToggleBookmark,
  ownedQty,
  onOwnedQty,
  onPick,
  onBack,
}: {
  card: Card
  /** Every Yuyu-tei printing with this card code, cheapest first. */
  siblings: Card[]
  fx: Fx
  /** Whether THIS printing is bookmarked - not the code. */
  bookmarked: boolean
  onToggleBookmark: (c: Card) => void
  /** Copies of THIS printing in your collection. */
  ownedQty: number
  onOwnedQty: (c: Card, qty: number) => void
  onPick: (c: Card) => void
  onBack: () => void
}) {
  const [ask, setAsk] = useState('')

  // A new card must never inherit the previous card's asking price.
  useEffect(() => {
    setAsk('')
  }, [card.cardId, card.code])

  const v = judge(card, parseAsk(ask))
  const hasBuy = card.jpyBuy !== null && card.jpyBuy > 0

  return (
    <>
      <header className="topbar">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Back to search">
          ←
        </button>
        <div className="topbar__title mono">{card.code}</div>
        {/* Bookmarks THIS printing, not the code. A code can be five physical
            cards 318x apart in price, so "save OP09-119" would be meaningless -
            the strip below is where you pick which one. */}
        <button
          type="button"
          className={bookmarked ? 'btn btn--ghost btn--icon bm-star bm-star--on' : 'btn btn--ghost btn--icon bm-star'}
          onClick={() => onToggleBookmark(card)}
          aria-pressed={bookmarked}
          aria-label={bookmarked ? 'Remove this printing from bookmarks' : 'Bookmark this printing'}
        >
          {bookmarked ? '★' : '☆'}
        </button>
      </header>

      <div className="scroll">
        <div className="hero">
          {hasArt(card.img) ? (
            <img
              className="hero__art"
              src={bigArt(card.img)}
              alt={`Card art for ${card.code}`}
              decoding="async"
              width={200}
              height={280}
            />
          ) : (
            <div className="hero__art hero__art--none">No scan</div>
          )}

          <div className="hero__info">
            <div className="hero__name">{card.name ? baseName(card.name) : 'No name in index'}</div>
            <div className="hero__meta">
              {hasRarity(card.rarity) ? <span>{card.rarity}</span> : null}
              {card.variant ? <span className="row__variant">{card.variant}</span> : null}
              {!card.inStock ? <span className="row__oos">Sold out at Yuyu-tei</span> : null}
            </div>

            <div className="price-tag">
              <span className="price-tag__label">Yuyu-tei</span>
              {card.jpySell > 0 ? (
                <span className={card.jpySell >= 1_000_000 ? 'price-tag__value price-tag__value--long mono' : 'price-tag__value mono'}>
                  {yen(card.jpySell)}
                </span>
              ) : (
                <span className="price-tag__none">No price listed</span>
              )}
            </div>

            <dl className="facts">
              <div className="facts__row">
                <dt>Buyback</dt>
                {hasBuy ? (
                  <dd className="mono">
                    {yen(card.jpyBuy!)}
                    {card.jpyBuyPrev !== null && card.jpyBuyPrev !== card.jpyBuy ? (
                      <span className="facts__sub">was {yen(card.jpyBuyPrev)}</span>
                    ) : null}
                  </dd>
                ) : (
                  <dd className="facts__none">Not bought</dd>
                )}
              </div>
              <div className="facts__row">
                <dt>Europe</dt>
                <EuFact card={card} fx={fx} />
              </div>
            </dl>
          </div>
        </div>

        {siblings.length > 1 ? (
          <section className="printings" aria-label={`All printings of ${card.code}`}>
            <div className="printings__head">
              {siblings.length} printings. Tap the one you are holding.
            </div>
            <ul className="printings__strip">
              {siblings.map((s) => {
                const isCurrent = s.cardId === card.cardId && s.setBucket === card.setBucket
                return (
                  <li key={`${s.setBucket}-${s.cardId}`}>
                    <button
                      type="button"
                      className={isCurrent ? 'printing printing--current' : 'printing'}
                      aria-current={isCurrent ? 'true' : undefined}
                      onClick={() => (isCurrent ? undefined : onPick(s))}
                    >
                      {hasArt(s.img) ? (
                        <img
                          className="printing__art"
                          src={s.img}
                          alt={`${s.rarity} ${s.variant ?? 'base'} printing`}
                          loading="lazy"
                          decoding="async"
                          width={80}
                          height={112}
                        />
                      ) : (
                        <span className="printing__art printing__art--none" aria-hidden="true">
                          No scan
                        </span>
                      )}
                      <span className="printing__price mono">{yen(s.jpySell)}</span>
                      <span className="printing__meta">
                        {hasRarity(s.rarity) ? s.rarity : ''} {s.variant ?? ''}
                      </span>
                      {!s.inStock ? <span className="printing__oos">Sold out</span> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}

        <EuPanel card={card} fx={fx} />

        <div className="own">
          <span className="own__label">In my collection</span>
          <Stepper qty={ownedQty} name={card.code} onQty={(q) => onOwnedQty(card, q)} />
        </div>

        <div className="foot">
          {card.inStock ? `${card.stock} in stock at Yuyu-tei.` : 'The Yuyu-tei price is its last listing, so treat it as softer.'}
          {card.detailUrl ? (
            <>
              {' '}
              <a href={card.detailUrl} rel="noreferrer noopener" target="_blank">
                Open on Yuyu-tei
              </a>
            </>
          ) : null}
        </div>
      </div>

      <AskDock ask={ask} onAsk={setAsk}>
        <div className={v.kind === 'judged' ? `verdict verdict--${v.band}` : 'verdict verdict--idle'} role="status" aria-live="polite">
          {v.kind === 'judged' ? (
            <>
              <span className="verdict__glyph" aria-hidden="true">
                {v.glyph}
              </span>
              <span className="verdict__label">{v.label}</span>
              <span className="verdict__amount mono">{signedYen(v.deltaJpy)}</span>
              <span className="verdict__delta">{v.explain}</span>
              {v.underFloor ? (
                <span className="verdict__floor">Below Yuyu-tei&rsquo;s buyback of {yen(card.jpyBuy ?? 0)}</span>
              ) : null}
            </>
          ) : (
            <span className="verdict__idle">{v.reason}</span>
          )}
        </div>
      </AskDock>
    </>
  )
}
