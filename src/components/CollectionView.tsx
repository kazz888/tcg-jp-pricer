// Collection: every card you bought, as a picture and a count.
//
// One Piece cards are added from their card screen, so they carry the index's
// scan. Pokemon cards are picked from Yuyu-tei's Pokemon list (same pictures).
// Anything on neither list can still be added with a photo, shrunk on the
// device before it is stored.

import { useEffect, useMemo, useState } from 'react'
import { searchCards, type Game, type Owned, type Searchable } from './collection'
import { foldRomaji, kanaToRomaji } from './matching'

const GAMES: { game: Game; label: string }[] = [
  { game: 'pokemon', label: 'Pokémon' },
  { game: 'onepiece', label: 'One Piece' },
]

// shortcut: photos live in localStorage (~5 MB, so a few hundred cards at this
// size); move them to IndexedDB if the "storage full" alert ever shows up.
const PHOTO_MAX_SIDE = 400

async function shrinkPhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.75)
}

export function Stepper({ qty, name, onQty }: { qty: number; name: string; onQty: (qty: number) => void }) {
  return (
    <div className="stepper">
      <button
        type="button"
        className="stepper__btn"
        onClick={() => onQty(qty - 1)}
        disabled={qty === 0}
        aria-label={`One fewer ${name}`}
      >
        −
      </button>
      <span className="stepper__n mono" aria-live="polite">
        {qty}
      </span>
      <button type="button" className="stepper__btn" onClick={() => onQty(qty + 1)} aria-label={`One more ${name}`}>
        +
      </button>
    </div>
  )
}

function PokemonSearch({ items, onQty }: { items: readonly Owned[]; onQty: (item: Owned, qty: number) => boolean }) {
  const [cards, setCards] = useState<Searchable[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [q, setQ] = useState('')

  // A lazy chunk (~400 KB for 23k cards): only downloaded once you open this
  // screen, then kept by the service worker like every other asset.
  useEffect(() => {
    import('../../data/pokemon.json').then(
      (m) =>
        setCards(
          m.default.cards.map((c) => ({
            ...c,
            hay: `${c.name} ${c.set} ${c.code} ${c.rarity}`.toLowerCase(),
            romaji: foldRomaji(kanaToRomaji(c.name)),
          })),
        ),
      () => setFailed(true),
    )
  }, [])

  const hits = useMemo(() => (cards ? searchCards(cards, q, foldRomaji(kanaToRomaji(q))) : []), [cards, q])
  const qtyOf = useMemo(() => new Map(items.map((x) => [x.id, x.qty])), [items])

  return (
    <>
      <div className="searchbar">
        <input
          className="searchbar__input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="SV8a 205"
          aria-label="Search Pokémon cards by set and number, or name"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          type="search"
        />
        <div className="searchbar__hint">
          {failed
            ? 'The Pokémon card list did not load. It needs signal the first time.'
            : !cards
              ? 'Loading the Pokémon card list…'
              : 'Type the set and number printed bottom-left of the card. Japanese names and rough romaji also match. Tap a card to add one.'}
        </div>
      </div>
      <ul className="results">
        {hits.map((c) => {
          const id = `pokemon|${c.id}`
          const qty = qtyOf.get(id) ?? 0
          const item: Owned = { id, game: 'pokemon', name: c.name, code: `${c.set} ${c.code}`, img: c.img, qty }
          return (
            <li key={c.id}>
              <button
                type="button"
                className={c.img ? 'row row--thumb' : 'row'}
                onClick={() => onQty(item, qty + 1)}
                aria-label={`Add ${c.name} ${c.set} ${c.code}${qty ? `, you have ${qty}` : ''}`}
              >
                {c.img ? (
                  <img className="row__thumb" src={c.img} alt="" aria-hidden="true" loading="lazy" decoding="async" width={56} height={78} />
                ) : null}
                <span className="row__code mono">
                  {c.set} {c.code}
                </span>
                <span className="row__price mono">{qty ? `×${qty}` : '+'}</span>
                <span className="row__name">{c.name}</span>
                <span className="row__meta">{c.rarity ? <span className="tag">{c.rarity}</span> : null}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function AddForm({ onAdd }: { onAdd: (item: Owned) => boolean }) {
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    const photo = data.get('photo')
    const game = data.get('game') as Game
    setBusy(true)
    try {
      const img = photo instanceof File && photo.size > 0 ? await shrinkPhoto(photo) : ''
      const ok = onAdd({
        id: `${game}|${Date.now()}`,
        game,
        name: String(data.get('name')).trim(),
        code: String(data.get('code')).trim(),
        img,
        qty: 1,
      })
      if (ok) form.reset()
    } catch {
      alert('Could not read that photo. Try another one.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="own-form pad" onSubmit={submit}>
      <label>
        Game
        <select name="game" defaultValue="pokemon">
          {GAMES.map((g) => (
            <option key={g.game} value={g.game}>
              {g.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input name="name" required autoComplete="off" placeholder="Pikachu ex" />
      </label>
      <label>
        Card number (optional)
        <input name="code" autoComplete="off" placeholder="SV8a 205/187" />
      </label>
      <label>
        Photo
        <input name="photo" type="file" accept="image/*" />
      </label>
      <button type="submit" className="btn btn--wide" disabled={busy}>
        {busy ? 'Saving…' : 'Add card'}
      </button>
      <div className="foot" style={{ margin: 0 }}>
        One Piece cards from the price index are quicker: open the card and tap + there.
      </div>
    </form>
  )
}

export default function CollectionView({
  items,
  onQty,
  onBack,
}: {
  items: readonly Owned[]
  /** Returns false when the change could not be saved. */
  onQty: (item: Owned, qty: number) => boolean
  onBack: () => void
}) {
  const [adding, setAdding] = useState(items.length === 0)
  const copies = items.reduce((n, x) => n + x.qty, 0)

  return (
    <>
      <header className="topbar">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Back to search">
          ←
        </button>
        <div className="topbar__title">Collection</div>
        <button type="button" className="btn btn--ghost btn--icon" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
          {adding ? 'Done' : '+ Add'}
        </button>
      </header>

      <div className="scroll">
        {adding ? (
          <>
            <PokemonSearch items={items} onQty={onQty} />
            <details className="own-photo">
              <summary>Card not listed? Add it with a photo</summary>
              <AddForm onAdd={(item) => onQty(item, 1)} />
            </details>
          </>
        ) : null}

        {items.length === 0 ? (
          <div className="empty">
            <strong>No cards yet</strong>
            Search for a Pokémon card above, or open any One Piece card and tap +.
          </div>
        ) : (
          <>
            <div className="foot">
              {items.length} cards · {copies} copies · saved on this device only
            </div>
            {GAMES.map(({ game, label }) => {
              const list = items.filter((x) => x.game === game)
              return list.length ? (
                <section key={game} aria-label={label}>
                  <div className="section-label">
                    {label} · {list.length}
                  </div>
                  <ul className="own-grid">
                    {list.map((x) => (
                      <li key={x.id} className="own-tile">
                        {x.img ? (
                          // Yuyu-tei's 100x140 thumbnails blur at tile size; 200x280 exists for every card.
                          <img className="own-tile__art" src={x.img.replace('/100_140/', '/200_280/')} alt={x.name} loading="lazy" decoding="async" />
                        ) : (
                          <span className="own-tile__art" aria-hidden="true">
                            no picture
                          </span>
                        )}
                        <span className="own-tile__name">{x.name}</span>
                        {x.code ? <span className="own-tile__code mono">{x.code}</span> : null}
                        <Stepper qty={x.qty} name={x.name} onQty={(q) => onQty(x, q)} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null
            })}
          </>
        )}
      </div>
    </>
  )
}
