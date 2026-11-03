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

import { useEffect, useMemo, useState } from 'react'
import type { Fx } from '../lib/types'
import { AskDock } from './Keypad'
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
  // A bare "Steal" would read as an absolute judgement, and nothing on this
  // screen knows the Japanese market price. See SealedItem in ../lib/types.
  { max: 0.35, band: 'steal', label: 'Well under Europe', glyph: '▼▼', rule: 'under 35% of the European trend price' },
  { max: 0.55, band: 'good', label: 'Under Europe', glyph: '▼', rule: '35–55% of the European trend price' },
  { max: 0.75, band: 'fair', label: 'Thin vs Europe', glyph: '●', rule: '55–75% of the European trend price' },
  { max: 1.0, band: 'high', label: 'No room vs Europe', glyph: '▲', rule: '75–100% of the European trend price' },
  { max: Infinity, band: 'over', label: 'Over Europe', glyph: '▲▲', rule: 'above the European trend price' },
]

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
    <section className="panel" aria-label="How sealed is priced">
      <div className="panel__label">Japan</div>
      <p className="sealed-nojp__msg">
        No Japanese reference, on purpose: a box costs about the same yen everywhere, so sealed is judged against{' '}
        <strong>Europe only</strong>.
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
          {collides > 1 ? <span className="tag tag--ambiguous">{collides} look alike</span> : null}
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

  // A new product must never inherit the previous product's asking price.
  useEffect(() => {
    setAsk('')
  }, [p.productId])

  const v = judgeSealed(p, parseAsk(ask), fx)
  const n = sealedName(p.name)

  return (
    <>
      <header className="topbar">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Back to boxes and packs">
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

        <section className="panel" aria-label="European prices">
          <div className="panel__label">Europe</div>
          {p.trendEur !== null && p.trendEur > 0 ? (
            <>
              <div className="eu__single-value">{eur(p.trendEur)}</div>
              <div className="eu__sub">
                Cardmarket trend{fx.jpyPerEur > 0 ? `, about ${yen(p.trendEur * fx.jpyPerEur)}` : ''}
              </div>
            </>
          ) : (
            <p className="eu__msg eu__msg--warn">
              No Cardmarket trend price for this product. A hole in the data, not a worthless box.
            </p>
          )}
          <div className="cand__prices" style={{ marginTop: 10 }}>
            <Money label="Low" value={p.lowEur} />
            <Money label="7-day" value={p.avg7Eur} />
          </div>
          {/* Same provenance caveat the card screen carries: the price guide is
              published once a day, and "From" on the live Cardmarket page is the
              cheapest ACTIVE listing, which drifts as copies sell or undercut.
              Trend is a GROSS sale price: commission, postage on a heavy box and
              the wait for a buyer all come out of it. */}
          <div className="cand__stale">
            Before fees and postage. Low is from the daily guide, not live
            {fx.jpyPerEur > 0 ? `. €1 = ¥${Math.round(fx.jpyPerEur)}` : ''}.
          </div>
        </section>

        {siblings.length > 1 ? (
          <section className="panel" aria-label="Products that share this set and kind">
            <div className="panel__label">{siblings.length} products share this set and kind</div>
            <p className="eu__msg eu__msg--warn">Read the box in your hand against these names.</p>
            <ul className="sealed-siblings">
              {siblings.map((s) => (
                <li key={s.productId}>
                  <span className="mono">{s.trendEur !== null && s.trendEur > 0 ? eur(s.trendEur) : 'no price'}</span>{' '}
                  {sealedName(s.name).full}
                  {s.productId === p.productId ? <strong> (this one)</strong> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <JapaneseReference p={p} askJpy={parseAsk(ask)} />

        <div className="foot">
          {p.setCode ? null : 'No set code is mapped to this expansion, so the box name is its only identity. '}
          {p.productUrl ? (
            <a href={p.productUrl} rel="noreferrer noopener" target="_blank">
              Open on Cardmarket
            </a>
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
              <span className="verdict__amount mono">{sharePct(v.ratio)}</span>
              {/* Both directions, because the two currencies are the whole point:
                  what the shop wants, in euro; what Europe pays, in yen. */}
              <span className="verdict__delta mono">
                Shop ≈ {eur(v.askEur)}, Europe {eur(v.trendEur)} ({signedYen(v.deltaJpy)})
              </span>
              <span className="verdict__delta">Means {v.rule}.</span>
            </>
          ) : (
            <span className="verdict__idle">{v.reason}</span>
          )}
        </div>
      </AskDock>
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
        <div className="topbar__title">Boxes &amp; packs</div>
      </header>

      <div className="scroll">
        {sealed.length === 0 ? (
          <div className="empty">
            <strong>No boxes or packs in this build</strong>
            The sealed pipeline has not run, so there is nothing to price against. That is missing data, not a shop
            with nothing in it.
          </div>
        ) : (
          <>
            {/* Neutral, not apologetic: Europe-only is the chosen design for
                sealed, not a hole. Still stated up front, because the card
                screen judges against Japan and the two must not be confused. */}
            <div className="pad" style={{ paddingBottom: 4 }}>
              <div className="banner banner--info">
                Judged against <strong>Cardmarket</strong>, not Yuyu-tei: a box costs much the same yen anywhere in
                Japan, and Europe pays several times that.
              </div>
            </div>

            <div className="chips" role="group" aria-label="Sort order">
              <button type="button" className="chip" aria-pressed={sort === 'price'} onClick={() => setSort('price')}>
                Dearest first
              </button>
              <button type="button" className="chip" aria-pressed={sort === 'name'} onClick={() => setSort('name')}>
                By set
              </button>
            </div>
            <div className="chips" role="group" aria-label="Filter by kind">
              <button type="button" className="chip" aria-pressed={kindFilter === null} onClick={() => setKindFilter(null)}>
                All
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={kindFilter === 'booster_box'}
                onClick={() => setKindFilter('booster_box')}
              >
                Boxes <span className="mono">{boxes}</span>
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={kindFilter === 'booster_pack'}
                onClick={() => setKindFilter('booster_pack')}
              >
                Packs <span className="mono">{packs}</span>
              </button>
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
              Boxes and packs only. A booster box case holds twelve boxes and costs accordingly, so cases are left
              out rather than shown next to a single box.
            </div>
          </>
        )}
      </div>
    </>
  )
}
