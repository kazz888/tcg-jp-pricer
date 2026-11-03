// Root of the shop app. Four screens, no router library, no network.
//
// The whole price index is baked into the page at build time, so this mounts
// with everything it will ever need. If the pipeline has not run there is an
// explicit empty state - never a screen of zeroes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Card } from '../lib/types'
import BookmarksView from './BookmarksView'
import CardView from './CardView'
import CollectionView from './CollectionView'
import CoverageView from './CoverageView'
import GapsView from './GapsView'
import Menu, { type MenuItem } from './Menu'
import SealedView from './SealedView'
import SearchView from './SearchView'
import { keyOf, readBookmarks, toggleKey, writeBookmarks } from './bookmarks'
import { readCollection, withQty, writeCollection, type Owned } from './collection'
import {
  isDirty,
  mergeStates,
  pull,
  push,
  readSyncKey,
  setDirty,
  SyncError,
  writeSyncKey,
  type SyncState,
  type SyncStatus,
} from './sync'
import { buildEntries } from './matching'
import { hasArt, loadIndexFromDom, sealedOf, type LoadedIndex } from './model'

type View =
  | { name: 'search' }
  | { name: 'card'; key: string }
  | { name: 'coverage' }
  | { name: 'gaps' }
  | { name: 'sealed' }
  | { name: 'bookmarks' }
  | { name: 'collection' }

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

// Slides between screens where the browser supports view transitions; an
// instant swap everywhere else, and always when reduced motion is asked for.
function withTransition(update: () => void, dir: 'forward' | 'back') {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return update()
  document.documentElement.dataset.nav = dir
  document.startViewTransition(() => flushSync(update))
}

function NoData({ loaded }: { loaded: LoadedIndex }) {
  return (
    <>
      <header className="topbar">
        <div className="topbar__title">Price check</div>
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
  const [owned, setOwned] = useState<Owned[]>(() => readCollection())
  const [online, setOnline] = useState(true)
  const [backupStatus, setBackupStatus] = useState<SyncStatus>(() => (readSyncKey() ? 'saving' : 'off'))

  const { index, hasData, isFixture } = loaded

  // Pull on open, push after changes. `link` is the moment a key is entered on
  // this device: both sides are merged instead of the server replacing local.
  const backup = useCallback(async (link = false) => {
    const key = readSyncKey()
    if (!key) return setBackupStatus('off')
    setBackupStatus('saving')
    try {
      let state: SyncState = { bookmarks: readBookmarks(), collection: readCollection() }
      if (!isDirty() || link) {
        const server = await pull(key)
        // A tap during the pull made this device dirty: keep that, push it.
        if (server && !isDirty()) {
          state = link ? mergeStates(server, state) : server
          writeBookmarks(state.bookmarks)
          writeCollection(state.collection)
          setBookmarkKeys(readBookmarks())
          setOwned(readCollection())
          if (!link) return setBackupStatus('saved')
        }
      }
      await push(key, state)
      setDirty(false)
      setBackupStatus('saved')
    } catch (e) {
      setBackupStatus(e instanceof SyncError ? e.status : 'failed')
    }
  }, [])

  const backupTimer = useRef<number | undefined>(undefined)
  const queueBackup = useCallback(() => {
    setDirty(true)
    if (!readSyncKey()) return
    clearTimeout(backupTimer.current)
    // Batches a run of +/+/+ taps into one upload.
    backupTimer.current = window.setTimeout(() => void backup(), 1500)
  }, [backup])

  useEffect(() => {
    void backup()
    const retry = () => void backup()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [backup])

  const setBackupKey = () => {
    const key = prompt(
      'Backup key: the SYNC_KEY you set on Cloudflare. Leave empty to turn backup off on this device.',
      readSyncKey(),
    )
    if (key === null) return
    writeSyncKey(key.trim())
    void backup(true)
  }

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
      const update = () => setView(s?.view ?? { name: 'search' })
      // iOS already animated its own back-swipe; a second slide would stutter.
      if (e.hasUAVisualTransition) update()
      else withTransition(update, 'back')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const go = useCallback((next: View) => {
    withTransition(() => setView(next), 'forward')
    try {
      history.pushState({ view: next }, '')
    } catch {
      /* history is a nicety; navigation still works without it */
    }
  }, [])

  const menuRef = useRef<HTMLDialogElement>(null)

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
    queueBackup()
  }, [queueBackup])

  // Never drops a card silently: going to zero asks first (a photo cannot be
  // recovered), and a failed write leaves the screen showing what is stored.
  const setOwnedQty = (item: Owned, qty: number): boolean => {
    if (qty <= 0 && !confirm(`Remove ${item.name} from your collection?`)) return false
    const next = withQty(owned, item, qty)
    if (!writeCollection(next)) {
      alert('Could not save: storage on this device is full or blocked. Nothing was changed.')
      return false
    }
    setOwned(next)
    queueBackup()
    return true
  }

  const setCardQty = (c: Card, qty: number) =>
    setOwnedQty({ id: keyOf(c), game: 'onepiece', name: c.name, code: c.code, img: hasArt(c.img) ? c.img : '', qty }, qty)

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
  } else if (view.name === 'collection') {
    screen = <CollectionView items={owned} onQty={setOwnedQty} onBack={back} />
  } else if (view.name === 'card' && active) {
    screen = (
      <CardView
        card={active}
        siblings={byCode.get(active.code) ?? [active]}
        fx={index.fx}
        bookmarked={bookmarkSet.has(view.key)}
        onToggleBookmark={toggleBookmark}
        ownedQty={owned.find((x) => x.id === view.key)?.qty ?? 0}
        onOwnedQty={setCardQty}
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
        onOpenMenu={() => menuRef.current?.showModal()}
        menuAlert={backupStatus === 'failed' || backupStatus === 'bad-key'}
      />
    )
  }

  // Sealed is hidden when there are no rows - SealedItem in ../lib/types
  // requires an absent array to behave exactly like an empty one. Collection is
  // always shown: it is the only way in to add a Pokemon card.
  const menuItems: MenuItem[] = [
    { glyph: '★', label: 'Bookmarks', count: bookmarked.length, onSelect: () => go({ name: 'bookmarks' }) },
    { glyph: '▲', label: 'Cheaper in Japan', onSelect: () => go({ name: 'gaps' }) },
    ...(sealed.length > 0
      ? [{ glyph: '▦', label: 'Boxes & packs', count: sealed.length, onSelect: () => go({ name: 'sealed' }) }]
      : []),
    { glyph: '▤', label: 'My collection', count: owned.length, onSelect: () => go({ name: 'collection' }) },
    { glyph: '◷', label: 'Price data', onSelect: () => go({ name: 'coverage' }) },
  ]

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
          <span className="offline-pill offline-pill--off">Offline, prices still work</span>
        </div>
      ) : null}
      {screen}
      {hasData ? <Menu dialogRef={menuRef} items={menuItems} backupStatus={backupStatus} onBackup={setBackupKey} /> : null}
    </div>
  )
}
