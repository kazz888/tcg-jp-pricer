// One card, one asking price, one verdict.
//
// Reading order is deliberate: what the Japanese market does (Yuyu-tei) ->
// what the shop wants -> the verdict -> Europe last and visibly subordinate.

import { useEffect, useRef, useState } from 'react'
import type { Card, Fx } from '../lib/types'
import EuPanel from './EuPanel'
import Keypad from './Keypad'
import { hasArt, hasRarity, pct, setOf, signedYen, yen } from './model'
import { judge, parseAsk } from './verdict'

const BAND_CLASS: Record<string, string> = {
  steal: 'verdict verdict--steal',
  good: 'verdict verdict--good',
  fair: 'verdict verdict--fair',
  high: 'verdict verdict--high',
  over: 'verdict verdict--over',
}

function euTag(card: Card) {
  switch (card.euStatus) {
    case 'ok':
      return card.eu.length > 1
        ? { cls: 'tag tag--ambiguous', text: `EU: ${card.eu.length} printings` }
        : { cls: 'tag tag--ok', text: 'EU: 1 printing' }
    case 'ambiguous':
      return { cls: 'tag tag--ambiguous', text: `EU: ${card.eu.length} printings` }
    case 'unmapped_set':
      return { cls: 'tag tag--none', text: 'EU: set unmapped' }
    case 'no_match':
      return { cls: 'tag tag--none', text: 'EU: no listing' }
    default:
      return { cls: 'tag tag--none', text: 'EU: not fetched' }
  }
}

export default function CardView({
  card,
  siblings,
  fx,
  bookmarked,
  onToggleBookmark,
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
  onPick: (c: Card) => void
  onBack: () => void
}) {
  const [ask, setAsk] = useState('')
  const [padOpen, setPadOpen] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const verdictRef = useRef<HTMLDivElement>(null)

  // A new card must never inherit the previous card's asking price.
  useEffect(() => {
    setAsk('')
  }, [card.cardId, card.code])

  // The verdict is the point of the screen: never let the docked keypad push
  // it below the fold once the user starts typing.
  useEffect(() => {
    if (ask.length === 1) verdictRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [ask])

  const askJpy = parseAsk(ask)
  const v = judge(card, askJpy)
  const set = setOf(card.code)
  const tag = euTag(card)

  const pushDigits = (d: string) => setAsk((prev) => (prev + d).replace(/^0+(?=\d)/, '').slice(0, 9))
  const backspace = () => setAsk((prev) => prev.slice(0, -1))
  const clear = () => setAsk('')

  return (
    <>
      <header className="topbar">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Back to search">
          ←
        </button>
        <div className="topbar__title">{card.code}</div>
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
        {hasArt(card.img) ? (
          <img
            className="card-art"
            src={card.img}
            alt={`Card art for ${card.code}`}
            loading="lazy"
            decoding="async"
            width={132}
            height={184}
          />
        ) : null}
        <div className="card-head">
          <div className="card-head__code mono">{card.code}</div>
          <div className="card-head__name">{card.name || 'No name in index'}</div>
          <div className="card-head__tags">
            {set ? <span className="tag">{set}</span> : null}
            {hasRarity(card.rarity) ? <span className="tag">{card.rarity}</span> : null}
            {card.variant ? <span className="tag tag--variant">{card.variant}</span> : null}
            {!card.inStock ? <span className="tag tag--oos">Out of stock at Yuyu-tei</span> : null}
            <span className={tag.cls}>{tag.text}</span>
          </div>
        </div>

        {siblings.length > 1 ? (
          <section className="printings" aria-label={`All printings of ${card.code}`}>
            <div className="printings__head">
              <strong>{siblings.length} printings share {card.code}</strong>
              <span>Tap the one you are holding — the art is the only reliable tell.</span>
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
                          width={72}
                          height={100}
                        />
                      ) : (
                        <span className="printing__art printing__art--none" aria-hidden="true">
                          no scan
                        </span>
                      )}
                      <span className="printing__price mono">{yen(s.jpySell)}</span>
                      <span className="printing__meta">
                        {hasRarity(s.rarity) ? s.rarity : '—'}
                        {s.variant ? ` · ${s.variant}` : ''}
                      </span>
                      {isCurrent ? <span className="printing__flag">this one</span> : null}
                      {!s.inStock ? <span className="printing__oos">OOS</span> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}

        <section className="ask" aria-label="Shop asking price">
          <div className="ask__label">Shop is asking</div>
          <div className="ask__field">
            <span className="ask__yen" aria-hidden="true">¥</span>
            <input
              ref={inputRef}
              className="ask__input"
              inputMode="numeric"
              pattern="[0-9]*"
              type="text"
              autoComplete="off"
              enterKeyHint="done"
              placeholder="0"
              aria-label="Shop asking price in yen"
              value={ask}
              onChange={(e) => setAsk(e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 9))}
            />
            {ask ? (
              <button type="button" className="ask__clear" onClick={clear} aria-label="Clear asking price">
                ×
              </button>
            ) : null}
          </div>
        </section>

        {v.kind === 'no-reference' ? (
          <div className="verdict verdict--idle" role="status" ref={verdictRef}>
            <div className="verdict__headline">
              <span className="verdict__glyph" aria-hidden="true">?</span>
              <span>No verdict yet</span>
            </div>
            {card.jpySell > 0 ? (
              <div className="verdict__delta mono">
                Yuyu-tei {yen(card.jpySell)}
                {card.jpyBuy !== null && card.jpyBuy > 0 ? ` \u00b7 floor ${yen(card.jpyBuy)}` : ''}
              </div>
            ) : null}
            <div className="verdict__explain">{v.reason}</div>
          </div>
        ) : (
          <div className={BAND_CLASS[v.band]} role="status" aria-live="polite" ref={verdictRef}>
            <div className="verdict__headline">
              <span className="verdict__glyph" aria-hidden="true">{v.glyph}</span>
              <span>{v.label}</span>
            </div>
            <div className="verdict__delta mono">
              {yen(v.ask)} vs {yen(v.sell)} · {pct(v.ratio)} · {signedYen(v.deltaJpy)}
            </div>
            <div className="verdict__explain">
              {v.explain} Yuyu-tei is the Japanese market reference, not a European one.
            </div>
            {!v.underFloor && card.jpyBuy !== null && card.jpyBuy > 0 ? (
              <div className="verdict__floor">
                Yuyu-tei buyback floor: {yen(card.jpyBuy)} &mdash; what a dealer pays you in cash.
              </div>
            ) : null}
            {v.underFloor ? (
              <div className="verdict__floor">
                ▼ Below Yuyu-tei&rsquo;s own buyback ({yen(card.jpyBuy ?? 0)}). They would pay you more than this shop
                is charging.
              </div>
            ) : null}
          </div>
        )}

        <section className="panel" aria-label="Yuyu-tei prices">
          <div className="panel__label">Yuyu-tei · Japanese market</div>
          <div className="jp-prices">
            <div>
              <div className="jp-price__label">Sell price</div>
              {card.jpySell > 0 ? (
                <div className="jp-price__value mono">{yen(card.jpySell)}</div>
              ) : (
                <div className="jp-price__value--none">No sell price listed</div>
              )}
              <div className="jp-price__note">What a shop in Japan asks</div>
            </div>
            <div>
              <div className="jp-price__label">Buyback · floor</div>
              {card.jpyBuy !== null && card.jpyBuy > 0 ? (
                <div className="jp-price__value jp-price__value--floor mono">{yen(card.jpyBuy)}</div>
              ) : (
                <div className="jp-price__value--none">Not bought back</div>
              )}
              <div className="jp-price__note">
                {card.jpyBuy !== null && card.jpyBuy > 0
                  ? 'Cash Yuyu-tei pays you — realistic floor'
                  : 'No floor signal for this card'}
              </div>
            </div>
          </div>
          {card.jpyBuyPrev !== null && card.jpyBuy !== null && card.jpyBuyPrev !== card.jpyBuy ? (
            <div className="jp-price__note" style={{ marginTop: 10 }}>
              Buyback recently moved from {yen(card.jpyBuyPrev)} to {yen(card.jpyBuy)}.
            </div>
          ) : null}
          {!card.inStock ? (
            <div className="jp-price__note" style={{ marginTop: 10 }}>
              Yuyu-tei is sold out, so the sell price is their last listed price — treat it as softer than usual.
            </div>
          ) : null}
        </section>

        <EuPanel card={card} fx={fx} />

        <div className="foot">
          Yuyu-tei stock: {card.inStock ? `${card.stock} listed` : 'none'} · bucket{' '}
          <code>{card.setBucket || 'unknown'}</code>
          {card.detailUrl ? (
            <>
              <br />
              <a href={card.detailUrl} rel="noreferrer noopener" target="_blank" style={{ color: 'var(--blue)' }}>
                Yuyu-tei page
              </a>{' '}
              (needs signal)
            </>
          ) : null}
        </div>
      </div>

      <div className="keypad-dock">
        <div className="keypad-dock__bar">
          <span>Asking price · yen</span>
          <button type="button" className="keypad-dock__toggle" onClick={() => setPadOpen((p) => !p)}>
            {padOpen ? 'Hide pad' : 'Show pad'}
          </button>
        </div>
        {padOpen ? (
          <Keypad onDigits={pushDigits} onBackspace={backspace} onClear={clear} />
        ) : null}
      </div>
    </>
  )
}
