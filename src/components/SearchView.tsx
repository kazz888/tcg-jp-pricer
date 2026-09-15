// Search screen. The default and fastest path is the card code the user is
// literally reading off the card in his hand, so the field is code-shaped:
// monospace, uppercase, wide letter spacing, no autocorrect, no autocapitalise
// surprises. Filtering is synchronous over the whole baked index.

import { useEffect, useMemo, useRef } from 'react'
import type { Card, Coverage } from '../lib/types'
import { search, type SearchEntry } from './matching'
import { baseName, hasArt, hasRarity, setOf, yen } from './model'

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

function euBadge(card: Card) {
  switch (card.euStatus) {
    case 'ok':
      return card.eu.length > 1
        ? { cls: 'tag tag--ambiguous', text: `EU ${card.eu.length}×` }
        : { cls: 'tag tag--ok', text: 'EU ✓' }
    case 'ambiguous':
      return { cls: 'tag tag--ambiguous', text: `EU ${card.eu.length}×` }
    case 'unmapped_set':
      return { cls: 'tag tag--none', text: 'EU unmapped' }
    case 'no_match':
      return { cls: 'tag tag--none', text: 'EU none' }
    default:
      return { cls: 'tag tag--none', text: 'EU n/a' }
  }
}

function Row({ card, onPick, showThumb }: { card: Card; onPick: (c: Card) => void; showThumb?: boolean }) {
  const badge = euBadge(card)
  const withThumb = Boolean(showThumb && hasArt(card.img))
  return (
    <li>
      <button
        type="button"
        className={withThumb ? 'row row--thumb' : 'row'}
        onClick={() => onPick(card)}
      >
        {withThumb ? (
          <img
            className="row__thumb"
            src={card.img}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            width={56}
            height={78}
          />
        ) : null}
        <span className="row__code mono">{card.code}</span>
        <span className="row__price mono">{card.jpySell > 0 ? yen(card.jpySell) : 'no price'}</span>
        <span className="row__name">{card.name ? baseName(card.name) : 'no name'}</span>
        <span className="row__meta">
          {card.variant ? <span className="tag tag--variant">{card.variant}</span> : null}
          {hasRarity(card.rarity) ? <span className="tag">{card.rarity}</span> : null}
          {!card.inStock ? <span className="tag tag--oos">OOS</span> : null}
          <span className={badge.cls}>{badge.text}</span>
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
  onOpenCoverage,
}: {
  entries: SearchEntry[]
  coverage: Coverage
  query: string
  setQuery: (q: string) => void
  setFilter: string | null
  setSetFilter: (s: string | null) => void
  recent: Card[]
  onPick: (c: Card) => void
  onOpenCoverage: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const result = useMemo(() => search(entries, query, setFilter), [entries, query, setFilter])
  const missing = useMemo(() => new Set(coverage.missingSets), [coverage.missingSets])

  // A card code is not unique: OP09-119 ships as base, parallel, super-parallel
  // and more, 318x apart in price. When a code has several printings the text
  // alone cannot tell them apart, so those rows get the art to match against
  // the card actually in your hand.
  const dupeCodes = useMemo(() => {
    const seen = new Map<string, number>()
    for (const e of entries) {
      const code = e.card.code
      if (!code || code === '-') continue
      seen.set(code, (seen.get(code) ?? 0) + 1)
    }
    const dupes = new Set<string>()
    for (const [code, n] of seen) if (n > 1) dupes.add(code)
    return dupes
  }, [entries])

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
        <div className="topbar__title">One Piece · price check</div>
        <button type="button" className="btn btn--ghost btn--icon" onClick={onOpenCoverage}>
          Coverage
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
          <div className="searchbar__hint">
            Type the code off the card. Digits alone work too — <span className="mono">09119</span> finds{' '}
            <span className="mono">OP09-119</span>. Japanese names and rough romaji also match.
          </div>
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
            <div className="section-label">Recently checked</div>
            <ul className="results">
              {recent.map((c) => (
                <Row key={`recent-${c.setBucket}-${c.cardId}-${c.code}`} card={c} onPick={onPick} showThumb={dupeCodes.has(c.code)} />
              ))}
            </ul>
          </>
        ) : null}

        <div className="section-label">
          {query || setFilter
            ? `${result.total} match${result.total === 1 ? '' : 'es'}`
            : `All cards · ${entries.length}`}
          {result.truncated ? ` · showing first ${result.entries.length}` : ''}
        </div>

        {result.entries.length === 0 ? (
          <div className="empty">
            <strong>Nothing matches “{query}”</strong>
            Check the code on the card, or try only the digits. Cards Yuyu-tei does not stock are not in this index at
            all — that is not a price of zero. Starter-deck (ST) singles are excluded on purpose.
          </div>
        ) : (
          <ul className="results">
            {result.entries.map((e) => (
              <Row key={`${e.card.setBucket}-${e.card.cardId}-${e.i}`} card={e.card} onPick={onPick} showThumb={dupeCodes.has(e.card.code)} />
            ))}
          </ul>
        )}

        {result.truncated ? (
          <div className="foot">Keep typing to narrow this down — only the first {result.entries.length} are drawn.</div>
        ) : null}
      </div>
    </>
  )
}
