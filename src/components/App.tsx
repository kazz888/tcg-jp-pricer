// Root of the shop app. Four screens, no router library, no network.
//
// The whole price index is baked into the page at build time, so this mounts
// with everything it will ever need. If the pipeline has not run there is an
// explicit empty state - never a screen of zeroes.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Card } from '../lib/types'
import BookmarksView from './BookmarksView'
import CardView from './CardView'
import CoverageView from './CoverageView'
import GapsView from './GapsView'
import SealedView from './SealedView'
import SearchView from './SearchView'
import { keyOf, readBookmarks, toggleKey, writeBookmarks } from './bookmarks'
import { buildEntries } from './matching'
import { loadIndexFromDom, sealedOf, type LoadedIndex } from './model'

type View =
  | { name: 'search' }
  | { name: 'card'; key: string }
  | { name: 'coverage' }
  | { name: 'gaps' }
  | { name: 'sealed' }
  | { name: 'bookmarks' }

const RECENT_KEY = 'tcgjp.recent.v1'
const RECENT_MAX = 6

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeRecent(keys: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(keys.slice(0, RECENT_MAX)))
  } catch {
    /* private mode / quota - recents are a convenience, never load-bearing */
  }
}

function NoData({ loaded }: { loaded: LoadedIndex }) {
  return (
    <>
      <header className="topbar">
        <div className="topbar__title">One Piece · price check</div>
      </header>
      <div className="scroll pad stack">
        <div className="banner banner--warn">
          <div className="banner__title">No price data in this build</div>
          Nothing has been baked in yet, so there is nothing to compare a shop price against. This is an empty index,
          not a set of zero prices.
        </div>
        <div className="foot" style={{ margin: 0 }}>
          Run the pipeline, then rebuild:
          <br />
          <br />
          <code>pnpm pipeline</code>
          <br />
          <code>pnpm build</code>
          <br />
          <br />
          That writes <code>data/index.json</code>, which this page reads at build time.
          {loaded.loadError ? (
            <>
              <br />
              <br />
              Loader reported: <code>{loaded.loadError}</code>
            </>
          ) : null}
        </div>
      </div>
    </>
  )
}

export default function App() {
  const [loaded] = useState<LoadedIndex>(() => loadIndexFromDom())
  const [view, setView] = useState<View>({ name: 'search' })
  const [query, setQuery] = useState('')
  const [setFilter, setSetFilter] = useState<string | null>(null)
  const [recentKeys, setRecentKeys] = useState<string[]>(() => readRecent())
  const [bookmarkKeys, setBookmarkKeys] = useState<string[]>(() => readBookmarks())
  const [online, setOnline] = useState(true)

  const { index, hasData, isFixture } = loaded

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine)
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  // Android back / iOS back-swipe should leave a card, not leave the app.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = e.state as { view?: View } | null
      setView(s?.view ?? { name: 'search' })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const go = useCallback((next: View) => {
    setView(next)
    try {
      if (next.name === 'search') history.pushState({ view: next }, '')
      else history.pushState({ view: next }, '')
    } catch {
      /* history is a nicety; navigation still works without it */
    }
  }, [])

  const back = useCallback(() => {
    try {
      history.back()
    } catch {
      setView({ name: 'search' })
    }
  }, [])

  const entries = useMemo(() => buildEntries(index.cards), [index.cards])

  // Read through sealedOf() rather than off the index directly: the sealed array
  // may be absent entirely (older index, pipeline not re-run), and an absent
  // array has to become an empty screen with an explanation, not a crash.
  const sealed = useMemo(() => sealedOf(index), [index])

  const byKey = useMemo(() => {
    const m = new Map<string, Card>()
    for (const c of index.cards) m.set(keyOf(c), c)
    return m
  }, [index.cards])

  // Every Yuyu-tei printing sharing a card code. A code is not a printing:
  // OP09-119 is five physical cards from JPY 780 to JPY 248,000, each with its
  // own photo. The detail screen shows them all so you can match the card in
  // your hand before trusting any euro figure.
  const byCode = useMemo(() => {
    const m = new Map<string, Card[]>()
    for (const c of index.cards) {
      if (!c.code || c.code === '-') continue
      const list = m.get(c.code)
      if (list) list.push(c)
      else m.set(c.code, [c])
    }
    for (const list of m.values()) list.sort((a, b) => a.jpySell - b.jpySell)
    return m
  }, [index.cards])

  const recent = useMemo(
    () => recentKeys.map((k) => byKey.get(k)).filter((c): c is Card => !!c),
    [recentKeys, byKey],
  )

  // Saved in the order you added them; the list screen re-sorts by gap. A key
  // that no longer resolves (the card left Yuyu-tei's stock between builds) is
  // dropped from the view but KEPT in storage, so it reappears if it restocks.
  const bookmarked = useMemo(
    () => bookmarkKeys.map((k) => byKey.get(k)).filter((c): c is Card => !!c),
    [bookmarkKeys, byKey],
  )

  const bookmarkSet = useMemo(() => new Set(bookmarkKeys), [bookmarkKeys])

  const toggleBookmark = useCallback((c: Card) => {
    setBookmarkKeys((prev) => {
      const next = toggleKey(prev, keyOf(c))
      writeBookmarks(next)
      return next
    })
  }, [])

  const pick = useCallback(
    (c: Card) => {
      const k = keyOf(c)
      setRecentKeys((prev) => {
        const next = [k, ...prev.filter((x) => x !== k)].slice(0, RECENT_MAX)
        writeRecent(next)
        return next
      })
      go({ name: 'card', key: k })
    },
    [go],
  )

  const active = view.name === 'card' ? byKey.get(view.key) : undefined

  let screen: React.ReactNode
  if (!hasData) {
    screen = <NoData loaded={loaded} />
  } else if (view.name === 'coverage') {
    screen = (
      <CoverageView
        coverage={index.coverage}
        fx={index.fx}
        generatedAt={index.generatedAt}
        onBack={back}
      />
    )
  } else if (view.name === 'gaps') {
    screen = <GapsView cards={index.cards} fx={index.fx} onPick={pick} onBack={back} />
  } else if (view.name === 'sealed') {
    screen = <SealedView sealed={sealed} fx={index.fx} onBack={back} />
  } else if (view.name === 'bookmarks') {
    screen = (
      <BookmarksView
        cards={bookmarked}
        fx={index.fx}
        onPick={pick}
        onRemove={toggleBookmark}
        onBack={back}
      />
    )
  } else if (view.name === 'card' && active) {
    screen = (
      <CardView
        card={active}
        siblings={byCode.get(active.code) ?? [active]}
        fx={index.fx}
        bookmarked={bookmarkSet.has(view.key)}
        onToggleBookmark={toggleBookmark}
        onPick={pick}
        onBack={back}
      />
    )
  } else {
    screen = (
      <SearchView
        entries={entries}
        coverage={index.coverage}
        query={query}
        setQuery={setQuery}
        setFilter={setFilter}
        setSetFilter={setSetFilter}
        recent={recent}
        onPick={pick}
        onOpenCoverage={() => go({ name: 'coverage' })}
      />
    )
  }

  return (
    <div className="app">
      {isFixture ? (
        <div className="pad" style={{ paddingBottom: 0 }}>
          <div className="banner banner--demo">
            <div className="banner__title">Demo fixture — not real prices</div>
            This build was made from a development fixture. Do not use these numbers at a counter.
          </div>
        </div>
      ) : null}
      {!online && hasData ? (
        <div className="pad" style={{ paddingBottom: 0 }}>
          <span className="offline-pill offline-pill--off">Offline · using baked prices</span>
        </div>
      ) : null}
      {screen}
      {/* The watchlist is a plan-ahead screen, so it is not allowed to compete
          with the search field. It docks in the thumb zone of the search
          screen only, the same place the keypad occupies on a card. */}
      {hasData && view.name === 'search' ? (
        <nav className="navdock" aria-label="Other screens">
          {/* Your own list comes first when it exists: the whole point of
              bookmarking is that these matter more to you than the algorithmic
              watchlist below. Hidden when empty so it never sits there as a
              dead entry. */}
          {bookmarkKeys.length > 0 ? (
          <button type="button" className="navdock__btn" onClick={() => go({ name: 'bookmarks' })}>
            <span className="navdock__glyph" aria-hidden="true">
              ★
            </span>
            <span className="navdock__text">
              <span className="navdock__title">Bookmarks · {bookmarked.length}</span>
              <span className="navdock__sub">Your hunting list, ranked by what you would gain</span>
            </span>
            <span className="navdock__chev" aria-hidden="true">
              ›
            </span>
          </button>
          ) : null}
          <button type="button" className="navdock__btn" onClick={() => go({ name: 'gaps' })}>
            <span className="navdock__glyph" aria-hidden="true">
              ▲
            </span>
            <span className="navdock__text">
              <span className="navdock__title">Watchlist</span>
              <span className="navdock__sub">Biggest Japan → Europe gaps · plan before you land</span>
            </span>
            <span className="navdock__chev" aria-hidden="true">
              ›
            </span>
          </button>
          {/* Sealed is a separate catalogue judged a different way (against
              Europe, not Yuyu-tei), so it gets its own entry rather than being
              mixed into the singles search. The subtitle says which, before the
              user has tapped anything. Hidden entirely when there are no rows -
              SealedItem in ../lib/types requires an absent array to behave
              exactly like an empty one. */}
          {sealed.length > 0 ? (
          <button type="button" className="navdock__btn" onClick={() => go({ name: 'sealed' })}>
            <span className="navdock__glyph" aria-hidden="true">
              ▦
            </span>
            <span className="navdock__text">
              <span className="navdock__title">Sealed · {sealed.length}</span>
              <span className="navdock__sub">Booster boxes &amp; packs · judged against Europe</span>
            </span>
            <span className="navdock__chev" aria-hidden="true">
              ›
            </span>
          </button>
          ) : null}
        </nav>
      ) : null}
    </div>
  )
}
