// Search screen. The default and fastest path is the card code the user is
// literally reading off the card in his hand, so the field is code-shaped:
// uppercase, no autocorrect, no autocapitalise surprises. Filtering is
// synchronous over the whole baked index.

import { useEffect, useMemo, useRef } from 'react'
import type { Card, Coverage } from '../lib/types'
import { search, type SearchEntry } from './matching'
import { baseName, eur, hasArt, hasRarity, setOf, yen } from './model'

// Set codes hidden from the filter row at the top of the search screen.
// ST = starter decks: 28 chips for products whose singles are rarely bought
// loose, which buried the sets you actually browse.
//
// This hides CHIPS ONLY. The cards stay in the index and stay searchable by
// code, because 208 ST-coded cards are sold as promo and Premium Booster
// singles (buckets promo-st10, prb01, prb02) and are perfectly ordinary buys.
// Dropping them from the data instead would make the app answer "nothing
// matches" for a card sitting in the display case in front of you.
const HIDDEN_SET_PREFIXES = ['ST']

function isHiddenSet(setCode: string): boolean {
  const prefix = setCode.replace(/[0-9]+$/, '').toUpperCase()
  return HIDDEN_SET_PREFIXES.includes(prefix)
}

/**
 * Europe under the yen price. Several printings are listed side by side in
 * gold, never averaged; past three they no longer fit a row, so the row shows
 * the spread and the count, and the card screen lists every one.
 */
function euShort(card: Card): { cls: string; text: string; priced: boolean } {
  const prices = card.eu
    .map((c) => c.trendEur)
    .filter((t): t is number => t !== null && t > 0)
    .sort((a, b) => a - b)
  if (prices.length === 0) return { cls: 'row__eu row__eu--none', text: 'No EU price', priced: false }
  if (card.euStatus === 'ok' && card.eu.length === 1) return { cls: 'row__eu', text: eur(prices[0]!), priced: true }
  const text =
    prices.length <= 3
      ? prices.map(eur).join(' / ')
      : `${eur(prices[0]!)} – ${eur(prices[prices.length - 1]!)} (${prices.length})`
  return { cls: 'row__eu row__eu--warn', text, priced: true }
}

function Row({ card, onPick }: { card: Card; onPick: (c: Card) => void }) {
  const eu = euShort(card)
  return (
    <li>
      <button type="button" className="row" onClick={() => onPick(card)}>
        {/* Every row carries the art: a code is several printings, and the text
            is identical between a 780 yen base card and a 248,000 yen one. */}
        {hasArt(card.img) ? (
          <img className="row__thumb" src={card.img} alt="" aria-hidden="true" loading="lazy" decoding="async" width={52} height={73} />
        ) : (
          <span className="row__thumb row__thumb--none" aria-hidden="true" />
        )}
        <span className="row__main">
          <span className="row__code mono">{card.code}</span>
          <span className="row__name">{card.name ? baseName(card.name) : 'no name'}</span>
          <span className="row__meta">
            {hasRarity(card.rarity) ? <span>{card.rarity}</span> : null}
            {card.variant ? <span className="row__variant">{card.variant}</span> : null}
            {!card.inStock ? <span className="row__oos">Yuyu-tei sold out</span> : null}
          </span>
        </span>
        <span className="row__side">
          <span className="row__price mono">{card.jpySell > 0 ? yen(card.jpySell) : 'No price'}</span>
          <span className={`${eu.cls} mono`}>
            {eu.priced ? (
              <>
                <span className="row__src" aria-hidden="true">
                  CM
                </span>
                <span className="sr-only">Cardmarket </span>
              </>
            ) : null}
            {eu.text}
          </span>
        </span>
      </button>
    </li>
  )
}

export default function SearchView({
  entries,
  coverage,
  query,
  setQuery,
  setFilter,
  setSetFilter,
  recent,
  onPick,
  onOpenMenu,
  menuAlert,
}: {
  entries: SearchEntry[]
  coverage: Coverage
  query: string
  setQuery: (q: string) => void
  setFilter: string | null
  setSetFilter: (s: string | null) => void
  recent: Card[]
  onPick: (c: Card) => void
  onOpenMenu: () => void
  /** Something in the menu needs you (the backup is failing). */
  menuAlert: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const result = useMemo(() => search(entries, query, setFilter), [entries, query, setFilter])
  const missing = useMemo(() => new Set(coverage.missingSets), [coverage.missingSets])

  const sets = useMemo(() => {
    const fromCoverage = coverage.yuyuteiSets.length
      ? coverage.yuyuteiSets
      : Array.from(new Set(entries.map((e) => setOf(e.card.code)).filter((s): s is string => !!s)))
    return [...fromCoverage].filter((s) => !isHiddenSet(s)).sort()
  }, [coverage.yuyuteiSets, entries])

  const showRecent = !query && !setFilter && recent.length > 0

  return (
    <>
      <header className="topbar">
        <div className="topbar__title">Price check</div>
        <button type="button" className="btn btn--ghost menu-btn" onClick={onOpenMenu} aria-haspopup="dialog">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
          Menu
          {menuAlert ? (
            <span className="menu-btn__dot">
              <span className="sr-only">, backup needs attention</span>
            </span>
          ) : null}
        </button>
      </header>

      <div className="scroll">
        <div className="searchbar">
          <div className="searchbar__field">
            <input
              ref={inputRef}
              className="searchbar__input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="OP09-119"
              aria-label="Search by card code or Japanese name"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="search"
              type="search"
            />
            {query ? (
              <button type="button" className="searchbar__clear" onClick={() => setQuery('')} aria-label="Clear search">
                ×
              </button>
            ) : null}
          </div>
          {!query ? (
            <div className="searchbar__hint">
              Card code, just the digits (<span className="mono">09119</span>), or the name
            </div>
          ) : null}
        </div>

        {sets.length ? (
          <div className="chips" role="group" aria-label="Filter by set">
            <button
              type="button"
              className="chip"
              aria-pressed={setFilter === null}
              onClick={() => setSetFilter(null)}
            >
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
                {missing.has(s) ? <span className="chip__flag">no EU</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        {showRecent ? (
          <>
            <div className="section-label">Recent</div>
            <ul className="results">
              {recent.map((c) => (
                <Row key={`recent-${c.setBucket}-${c.cardId}-${c.code}`} card={c} onPick={onPick} />
              ))}
            </ul>
          </>
        ) : null}

        <div className="section-label mono">
          {query || setFilter
            ? `${result.total.toLocaleString()} ${result.total === 1 ? 'match' : 'matches'}`
            : `${entries.length.toLocaleString()} cards`}
          {result.truncated ? `, first ${result.entries.length} shown` : ''}
        </div>

        {result.entries.length === 0 ? (
          <div className="empty">
            <strong>Nothing matches “{query}”</strong>
            Check the code on the card, or type only the digits. Cards Yuyu-tei does not sell are not listed, which is
            not the same as worthless.
          </div>
        ) : (
          <ul className="results">
            {result.entries.map((e) => (
              <Row key={`${e.card.setBucket}-${e.card.cardId}-${e.i}`} card={e.card} onPick={onPick} />
            ))}
          </ul>
        )}

        {result.truncated ? <div className="foot">Keep typing to narrow this down.</div> : null}
      </div>
    </>
  )
}
