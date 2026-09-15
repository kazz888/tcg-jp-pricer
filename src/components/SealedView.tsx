// Sealed product: Japanese booster boxes and booster packs.
//
// WHY THIS SCREEN IS NOT THE CARD SCREEN
// The card screen answers "is this shop price good?" by comparing yen against
// YEN - Yuyu-tei's own Japanese sell price. Sealed has no such anchor. Yuyu-tei
// sells no sealed product at all, and no other Japanese sealed price source was
// reachable, so every row here has a European price and NO Japanese one. The
// contract carries `jpyRef` for the day that changes; it is null in every row
// today.
//
// That asymmetry is the whole design problem of this file. The screen must not
// borrow the card screen's confidence, and it must never put a blank, a dash or
// a zero where a Japanese price would go - a dash reads as "cheap", and on a
// EUR 217 booster box that misread costs real money. So the Japanese side is
// spelled out in a sentence, in the same slot a number would have occupied.
//
// SCOPE: booster boxes and booster packs only. A "... Booster Box Case (12x
// Booster Box)" is roughly twelve times the price and contains the substring
// "booster box"; it must never reach this screen. The kind filter that keeps it
// out lives at the data boundary in model.tsx (toSealed fails closed on an
// unrecognised kind), not here.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Fx } from '../lib/types'
import Keypad from './Keypad'
import {
  eur,
  sealedGroupKey,
  sealedKindLabel,
  sealedKindShort,
  sealedName,
  sharePct,
  signedYen,
  yen,
  type SealedKind,
  type SealedProduct,
} from './model'
import { parseAsk } from './verdict'

// ---------------------------------------------------------------- verdict
//
// The card screen's bands are calibrated against Yuyu-tei, i.e. against the
// SAME market in the SAME currency, where paying 1.0x is by definition the
// market price. These bands cannot be those bands: a Japanese shop price is
// routinely a third of the European trend price, so reusing 0.92/1.08 here
// would paint "STEAL" on every ordinary box in the shop and the word would stop
// meaning anything.
//
// So these thresholds are a RULE OF THUMB about the European spread, not a
// measurement of the Japanese market - and because they are a rule of thumb,
// the rule for whichever band you land in is printed next to the verdict. The
// user can then disagree with it on the spot. Cardmarket trend is a gross sale
// price: commission, postage on a 2kg box, and the wait for a buyer all come
// out of it, which is why the top band starts well below 1.0 rather than at it.
const BANDS: Array<{
  max: number
  band: 'steal' | 'good' | 'fair' | 'high' | 'over'
  label: string
  glyph: string
  rule: string
}> = [
  // Every label names EUROPE, because that is the only thing being compared.
  // A bare "STEAL" would read as an absolute judgement, and nothing on this
  // screen knows the Japanese market price. See SealedItem in ../lib/types.
  { max: 0.35, band: 'steal', label: 'WELL UNDER EU', glyph: '▼▼', rule: 'under 35% of the European trend price' },
  { max: 0.55, band: 'good', label: 'UNDER EU', glyph: '▼', rule: '35–55% of the European trend price' },
  { max: 0.75, band: 'fair', label: 'THIN VS EU', glyph: '●', rule: '55–75% of the European trend price' },
  { max: 1.0, band: 'high', label: 'NO ROOM VS EU', glyph: '▲', rule: '75–100% of the European trend price' },
  { max: Infinity, band: 'over', label: 'OVER EU VALUE', glyph: '▲▲', rule: 'above the European trend price' },
]

const BAND_CLASS: Record<string, string> = {
  steal: 'verdict verdict--steal',
  good: 'verdict verdict--good',
  fair: 'verdict verdict--fair',
  high: 'verdict verdict--high',
  over: 'verdict verdict--over',
}

export interface SealedJudged {
  kind: 'judged'
  band: string
  label: string
  glyph: string
  rule: string
  /** ask / European trend, both in yen. 0.46 = paying 46% of European value. */
  ratio: number
  askJpy: number
  askEur: number
  trendEur: number
  trendJpy: number
  /** ask - European trend. Negative = the shop wants less than Europe pays. */
  deltaJpy: number
  deltaEur: number
}

export interface SealedNoVerdict {
  kind: 'no-reference'
  reason: string
}

export type SealedVerdict = SealedJudged | SealedNoVerdict

/** Pure, so every number on the panel can be reproduced from the JSON. */
export function judgeSealed(p: SealedProduct, askJpy: number, fx: Fx): SealedVerdict {
  if (!Number.isFinite(askJpy) || askJpy <= 0) {
    return { kind: 'no-reference', reason: 'Enter the shop’s asking price to get a verdict.' }
  }
  if (!fx.jpyPerEur || fx.jpyPerEur <= 0) {
    return {
      kind: 'no-reference',
      reason:
        'This build has no exchange rate baked in, so a yen price cannot be put next to a euro one. That is missing data, not a judgement.',
    }
  }
  const trendEur = p.trendEur
  if (trendEur === null || trendEur <= 0) {
    return {
      kind: 'no-reference',
      reason:
        'Cardmarket has no trend price for this product, so there is nothing to compare the shop against. Treat that as unknown — not as cheap.',
    }
  }

  const trendJpy = trendEur * fx.jpyPerEur
  const ratio = askJpy / trendJpy
  const hit = BANDS.find((b) => ratio <= b.max)!

  return {
    kind: 'judged',
    band: hit.band,
    label: hit.label,
    glyph: hit.glyph,
    rule: hit.rule,
    ratio,
    askJpy,
    askEur: askJpy / fx.jpyPerEur,
    trendEur,
    trendJpy,
    deltaJpy: askJpy - trendJpy,
    deltaEur: askJpy / fx.jpyPerEur - trendEur,
  }
}

// ------------------------------------------------------------------- sort

export type SealedSort = 'price' | 'name'

/** Rows with no European price sort last under either order: they have no price
 *  to rank, and pretending they are worth 0 would put them at the wrong end. */
export function sortSealed(rows: readonly SealedProduct[], sort: SealedSort): SealedProduct[] {
  const out = [...rows]
  out.sort((a, b) => {
    const at = a.trendEur
    const bt = b.trendEur
    if (sort === 'price') {
      if (at === null && bt === null) return sealedName(a.name).display.localeCompare(sealedName(b.name).display)
      if (at === null) return 1
      if (bt === null) return -1
      if (bt !== at) return bt - at
      return sealedName(a.name).display.localeCompare(sealedName(b.name).display)
    }
    const as = a.setCode ?? '￿'
    const bs = b.setCode ?? '￿'
    if (as !== bs) return as.localeCompare(bs)
    return sealedName(a.name).display.localeCompare(sealedName(b.name).display)
  })
  return out
}

// ------------------------------------------------------------------- money

/**
 * A euro figure that may legitimately be absent. Copied in spirit from
 * EuPanel's Money: a missing price is always words, never "€0.00" and never a
 * dash, because both of those read as "worthless".
 */
function Money({ label, value, note }: { label: string; value: number | null; note?: string }) {
  if (value === null || value <= 0) {
    return (
      <div className="cand__price cand__price--na">
        {label}
        <b>not listed</b>
        {note ? <span className="sealed-money__note">{note}</span> : null}
      </div>
    )
  }
  return (
    <div className="cand__price">
      {label}
      <b>{eur(value)}</b>
      {note ? <span className="sealed-money__note">{note}</span> : null}
    </div>
  )
}

/**
 * The Japanese side. This component exists so there is exactly ONE place in the
 * app that decides how "we do not know the Japanese price" is rendered, and so
 * that it can never degrade into an empty element. When a jpyRef finally
 * arrives it shows up here and nowhere else needs touching.
 */
function JapaneseReference({ p, askJpy }: { p: SealedProduct; askJpy: number }) {
  if (p.jpyRef !== null && p.jpyRef > 0) {
    const share = askJpy > 0 ? sharePct(askJpy / p.jpyRef) : null
    return (
      <section className="panel" aria-label="Japanese reference price">
        <div className="panel__label">Japan · reference price</div>
        <div className="jp-price__value mono">{yen(p.jpyRef)}</div>
        <div className="jp-price__note">
          {share ? `The shop is asking ${share} of this.` : 'A Japanese reference price for this product.'}
        </div>
      </section>
    )
  }
  return (
    <section className="panel sealed-nojp" aria-label="How sealed is priced">
      <div className="panel__label">How this is judged</div>
      <p className="sealed-nojp__msg">
        Sealed is measured against <strong>Europe only</strong>, on purpose. A Japanese booster box costs about the
        same yen everywhere, so a Japanese average adds little against a gap this wide.
      </p>
    </section>
  )
}

// -------------------------------------------------------------------- row

function SealedRow({
  p,
  collides,
  onOpen,
}: {
  p: SealedProduct
  collides: number
  onOpen: (p: SealedProduct) => void
}) {
  const n = sealedName(p.name)
  return (
    <li>
      <button type="button" className="sealed-row" onClick={() => onOpen(p)}>
        <span className={`sealed-kind sealed-kind--${p.kind === 'booster_box' ? 'box' : 'pack'}`}>
          {sealedKindShort(p.kind)}
        </span>
        <span className="sealed-row__name">{n.display}</span>
        {p.trendEur !== null && p.trendEur > 0 ? (
          <span className="sealed-row__price mono">{eur(p.trendEur)}</span>
        ) : (
          <span className="sealed-row__price sealed-row__price--na">no EU price</span>
        )}
        <span className="sealed-row__meta">
          {p.setCode ? <span className="tag">{p.setCode}</span> : null}
          {n.region ? <span className="tag tag--none">{n.region}</span> : null}
          {collides > 1 ? <span className="tag tag--ambiguous">{collides} products · same set &amp; kind</span> : null}
        </span>
        <span className="sr-only">
          {sealedKindLabel(p.kind)}.
          {p.trendEur !== null && p.trendEur > 0
            ? ` European trend price ${eur(p.trendEur)}.`
            : ' No European price for this product.'}
          {' Judged against Europe.'}
        </span>
      </button>
    </li>
  )
}

// ----------------------------------------------------------------- detail

function SealedDetail({
  p,
  siblings,
  fx,
  onBack,
}: {
  p: SealedProduct
  /** Everything sharing this set + kind, including p. More than one = decide. */
  siblings: SealedProduct[]
  fx: Fx
  onBack: () => void
}) {
  const [ask, setAsk] = useState('')
  const [padOpen, setPadOpen] = useState(true)
  const verdictRef = useRef<HTMLDivElement>(null)

  // A new product must never inherit the previous product's asking price.
  useEffect(() => {
    setAsk('')
  }, [p.productId])

  useEffect(() => {
    if (ask.length === 1) verdictRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [ask])

  const askJpy = parseAsk(ask)
  const v = judgeSealed(p, askJpy, fx)
  const n = sealedName(p.name)

  const pushDigits = (d: string) => setAsk((prev) => (prev + d).replace(/^0+(?=\d)/, '').slice(0, 9))
  const backspace = () => setAsk((prev) => prev.slice(0, -1))
  const clear = () => setAsk('')

  return (
    <>
      <header className="topbar">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Back to the sealed list">
          ←
        </button>
        <div className="topbar__title">{sealedKindLabel(p.kind)}</div>
      </header>

      <div className="scroll">
        <div className="card-head">
          {/* On a card the big line is the code and the name is secondary. A box
              has no code, so the name IS the identity and carries that weight. */}
          <div className="sealed-detail__title">{n.display}</div>
          <div className="card-head__tags">
            <span className={`sealed-kind sealed-kind--${p.kind === 'booster_box' ? 'box' : 'pack'}`}>
              {sealedKindShort(p.kind)}
            </span>
            {p.setCode ? <span className="tag">{p.setCode}</span> : null}
            {n.region ? <span className="tag tag--none">{n.region}</span> : null}
          </div>
          <div className="sealed-detail__exp">{p.expansionName}</div>
        </div>

        {siblings.length > 1 ? (
          <div className="pad" style={{ paddingBottom: 0 }}>
            <div className="banner banner--warn">
              <div className="banner__title">
                {siblings.length} sealed products share this set and kind
              </div>
              Their prices are not interchangeable. Read the box in your hand against these names before you trust any
              figure — we will not pick one for you:
              <ul className="sealed-siblings">
                {siblings.map((s) => (
                  <li key={s.productId}>
                    <span className="mono">{s.trendEur !== null && s.trendEur > 0 ? eur(s.trendEur) : 'no price'}</span>{' '}
                    {sealedName(s.name).full}
                    {s.productId === p.productId ? <strong> — this one</strong> : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        <section className="ask" aria-label="Shop asking price">
          <div className="ask__label">Shop is asking</div>
          <div className="ask__field">
            <span className="ask__yen" aria-hidden="true">
              ¥
            </span>
            <input
              className="ask__input"
              inputMode="numeric"
              pattern="[0-9]*"
              type="text"
              autoComplete="off"
              enterKeyHint="done"
              placeholder="0"
              aria-label="Shop asking price in yen"
              value={ask}
              onChange={(e) =>
                setAsk(e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 9))
              }
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
              <span className="verdict__glyph" aria-hidden="true">
                ?
              </span>
              <span>No verdict yet</span>
            </div>
            {p.trendEur !== null && p.trendEur > 0 ? (
              <div className="verdict__delta mono">Europe · trend {eur(p.trendEur)}</div>
            ) : null}
            <div className="verdict__explain">{v.reason}</div>
          </div>
        ) : (
          <div className={BAND_CLASS[v.band]} role="status" aria-live="polite" ref={verdictRef}>
            <div className="verdict__headline">
              <span className="verdict__glyph" aria-hidden="true">
                {v.glyph}
              </span>
              <span>{v.label}</span>
            </div>
            {/* Both directions, because the two currencies are the whole point:
                what the shop wants, in euro; what Europe pays, in yen. */}
            <div className="verdict__delta mono">
              {yen(v.askJpy)} ≈ {eur(v.askEur)}
            </div>
            <div className="verdict__delta mono">
              Europe {eur(v.trendEur)} ≈ {yen(v.trendJpy)}
            </div>
            <div className="verdict__delta mono">
              {sharePct(v.ratio)} of European value · {signedYen(v.deltaJpy)}
            </div>
            <div className="verdict__explain">
              Measured against <strong>Europe</strong>. “{v.label}” means {v.rule}.
            </div>
            <div className="verdict__floor">
              Cardmarket trend is a <strong>gross</strong> sale price. Commission, postage on a heavy box and the wait
              for a buyer all come out of it, so the usable ceiling is well under 100%.
            </div>
          </div>
        )}

        <JapaneseReference p={p} askJpy={askJpy} />

        <section className="panel" aria-label="European prices">
          <div className="panel__label">Europe · Cardmarket</div>
          {p.trendEur !== null && p.trendEur > 0 ? (
            <>
              <div className="eu__single-value">{eur(p.trendEur)}</div>
              <div className="eu__sub">
                Cardmarket trend — the headline figure
                {fx.jpyPerEur > 0 ? ` · ≈ ${yen(p.trendEur * fx.jpyPerEur)}` : ''}
              </div>
            </>
          ) : (
            <p className="eu__msg">
              <strong>No trend price on Cardmarket for this product.</strong> That is a hole in the data, not a
              worthless product.
            </p>
          )}
          <div className="cand__prices" style={{ marginTop: 12 }}>
            <Money label="Trend" value={p.trendEur} />
            <Money label="Low @ snapshot" value={p.lowEur} />
            <Money label="7-day avg" value={p.avg7Eur} />
          </div>
          {/* Same provenance caveat the card screen carries: the price guide is
              published once a day, and "From" on the live Cardmarket page is the
              cheapest ACTIVE listing, which drifts as copies sell or undercut. */}
          <div className="cand__stale">
            Trend is the headline. <strong>Low</strong> is a once-a-day snapshot from the price guide, not live —
            Cardmarket’s “From” moves during the day.
          </div>
          {fx.jpyPerEur > 0 ? (
            <div className="jp-price__note" style={{ marginTop: 8 }}>
              Converted at the baked rate €1 = ¥{Math.round(fx.jpyPerEur)} ({fx.source}
              {fx.date ? `, ${fx.date}` : ''}).
            </div>
          ) : null}
        </section>

        <div className="foot">
          Cardmarket expansion <code>{p.expansionName}</code> · id <code>{p.expansionId}</code>
          {p.setCode ? (
            <>
              {' '}
              · set <code>{p.setCode}</code>
            </>
          ) : (
            <>
              {' '}
              · no set code is mapped to this expansion, so the box name is the only identity we have for it.
            </>
          )}
          <br />
          <br />
          Full Cardmarket name: <code>{n.full}</code>
          {p.productUrl ? (
            <>
              <br />
              <a href={p.productUrl} rel="noreferrer noopener" target="_blank" style={{ color: 'var(--blue)' }}>
                Cardmarket page
              </a>{' '}
              (needs signal)
            </>
          ) : null}
        </div>
      </div>

      <div className="keypad-dock">
        <div className="keypad-dock__bar">
          <span>Asking price · yen</span>
          <button type="button" className="keypad-dock__toggle" onClick={() => setPadOpen((x) => !x)}>
            {padOpen ? 'Hide pad' : 'Show pad'}
          </button>
        </div>
        {padOpen ? <Keypad onDigits={pushDigits} onBackspace={backspace} onClear={clear} /> : null}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ screen

export default function SealedView({
  sealed,
  fx,
  onBack,
}: {
  sealed: readonly SealedProduct[]
  fx: Fx
  onBack: () => void
}) {
  const [sort, setSort] = useState<SealedSort>('price')
  const [kindFilter, setKindFilter] = useState<SealedKind | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)

  // Same set + same kind = two products you must tell apart yourself.
  const groups = useMemo(() => {
    const m = new Map<string, SealedProduct[]>()
    for (const s of sealed) {
      const k = sealedGroupKey(s)
      const list = m.get(k)
      if (list) list.push(s)
      else m.set(k, [s])
    }
    return m
  }, [sealed])

  const rows = useMemo(() => {
    const filtered = kindFilter ? sealed.filter((s) => s.kind === kindFilter) : [...sealed]
    return sortSealed(filtered, sort)
  }, [sealed, kindFilter, sort])

  const open = useMemo(
    () => (openId === null ? null : (sealed.find((s) => s.productId === openId) ?? null)),
    [openId, sealed],
  )

  const boxes = useMemo(() => sealed.filter((s) => s.kind === 'booster_box').length, [sealed])
  const packs = useMemo(() => sealed.filter((s) => s.kind === 'booster_pack').length, [sealed])
  const withSetCode = useMemo(() => sealed.filter((s) => s.setCode).length, [sealed])
  const priced = useMemo(() => sealed.filter((s) => s.trendEur !== null && s.trendEur > 0).length, [sealed])
  // Derived, never hardcoded to 0. The day a Japanese sealed source lands, this
  // tile and the banner below it start telling the truth on their own instead of
  // quietly going stale.
  const sets = useMemo(
    () => new Set(sealed.map((s) => s.setCode).filter((c): c is string => !!c)).size,
    [sealed],
  )

  if (open) {
    return (
      <SealedDetail
        p={open}
        siblings={groups.get(sealedGroupKey(open)) ?? [open]}
        fx={fx}
        onBack={() => setOpenId(null)}
      />
    )
  }

  return (
    <>
      <header className="topbar">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Back to search">
          ←
        </button>
        <div className="topbar__title">Sealed · boxes &amp; packs</div>
      </header>

      <div className="scroll">
        {/* Neutral, not apologetic: Europe-only is the chosen design for sealed,
            not a hole. Still stated up front, because the card screen judges
            against Japan and the two screens must not be confused. */}
        {sealed.length > 0 ? (
        <div className="pad" style={{ paddingBottom: 0 }}>
          <div className="banner">
            <div className="banner__title">Judged against Europe</div>
            Cards are judged against <strong>Yuyu-tei</strong>, a Japanese shop. Sealed is judged against{' '}
            <strong>Cardmarket</strong> instead: a Japanese booster box costs much the same yen anywhere, while
            Europe pays several times that, so the European price is the number that decides it.
          </div>
        </div>
        ) : null}

        {sealed.length === 0 ? (
          <div className="empty">
            <strong>No sealed product in this build</strong>
            The index carries no sealed rows. That is a pipeline that has not run, not a shop with nothing in it —
            there is nothing here to price against, so nothing is shown.
          </div>
        ) : (
          <>
            <div className="cov-grid">
              <div className="cov-stat">
                <div className="cov-stat__n mono">{boxes}</div>
                <div className="cov-stat__l">Booster boxes</div>
              </div>
              <div className="cov-stat">
                <div className="cov-stat__n mono">{packs}</div>
                <div className="cov-stat__l">Booster packs</div>
              </div>
              <div className="cov-stat">
                <div className="cov-stat__n mono">{priced}</div>
                <div className="cov-stat__l">With a European price</div>
              </div>
              <div className="cov-stat">
                <div className="cov-stat__n mono">{sets}</div>
                <div className="cov-stat__l">Sets covered</div>
              </div>
            </div>

            <div className="section-label">Sort</div>
            <div className="chips" role="group" aria-label="Sort order">
              <button type="button" className="chip" aria-pressed={sort === 'price'} onClick={() => setSort('price')}>
                European price
              </button>
              <button type="button" className="chip" aria-pressed={sort === 'name'} onClick={() => setSort('name')}>
                Set &amp; name
              </button>
            </div>

            <div className="section-label">Show</div>
            <div className="chips" role="group" aria-label="Filter by kind">
              <button type="button" className="chip" aria-pressed={kindFilter === null} onClick={() => setKindFilter(null)}>
                Everything
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={kindFilter === 'booster_box'}
                onClick={() => setKindFilter('booster_box')}
              >
                Boxes ({boxes})
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={kindFilter === 'booster_pack'}
                onClick={() => setKindFilter('booster_pack')}
              >
                Packs ({packs})
              </button>
            </div>

            <div className="section-label">
              {rows.length} product{rows.length === 1 ? '' : 's'}
              {sort === 'price' ? ' · dearest in Europe first' : ' · by set'}
            </div>

            <ul className="results">
              {rows.map((p) => (
                <SealedRow
                  key={p.productId}
                  p={p}
                  collides={groups.get(sealedGroupKey(p))?.length ?? 1}
                  onOpen={(x) => setOpenId(x.productId)}
                />
              ))}
            </ul>

            <div className="foot">
              Boxes and packs only — no cases, no starter decks, no accessories. A “Booster Box Case” holds twelve
              boxes and costs accordingly, so it is excluded rather than shown next to a single box.
              <br />
              <br />
              {withSetCode} of {sealed.length} rows carry a mapped set code; the rest are identified by the box name
              alone, which is what is printed on the box anyway.
            </div>
          </>
        )}
      </div>
    </>
  )
}
