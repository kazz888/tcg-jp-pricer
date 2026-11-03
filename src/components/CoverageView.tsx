// What this build can and cannot price. Meant to be read on the plane, not at
// the counter: if a set is listed as having no verified European mapping, the
// user knows in advance that he will be judging it on Yuyu-tei alone.

import type { Coverage, Fx } from '../lib/types'

function when(iso: string): string {
  if (!iso) return 'unknown'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export default function CoverageView({
  coverage,
  fx,
  generatedAt,
  onBack,
}: {
  coverage: Coverage
  fx: Fx
  generatedAt: string
  onBack: () => void
}) {
  const mapped = new Set(coverage.mappedSets)
  const missing = new Set(coverage.missingSets)
  const all = [...new Set([...coverage.yuyuteiSets, ...coverage.mappedSets, ...coverage.missingSets])].sort()
  const withoutEu = Math.max(coverage.cardsTotal - coverage.cardsWithEu, 0)

  return (
    <>
      <header className="topbar">
        <button type="button" className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Back to search">
          ←
        </button>
        <div className="topbar__title">Price data</div>
      </header>

      <div className="scroll">
        <div className="cov-grid">
          <div className="cov-stat">
            <div className="cov-stat__n mono">{coverage.cardsTotal.toLocaleString()}</div>
            <div className="cov-stat__l">Cards priced in yen</div>
          </div>
          <div className="cov-stat">
            <div className="cov-stat__n mono">{coverage.cardsWithEu.toLocaleString()}</div>
            <div className="cov-stat__l">With a European match</div>
          </div>
          <div className="cov-stat">
            <div className="cov-stat__n mono">{coverage.cardsAmbiguous.toLocaleString()}</div>
            <div className="cov-stat__l">Several EU printings</div>
          </div>
          <div className={withoutEu ? 'cov-stat cov-stat--none' : 'cov-stat'}>
            <div className="cov-stat__n mono">{withoutEu.toLocaleString()}</div>
            <div className="cov-stat__l">No European reference</div>
          </div>
        </div>

        {missing.size > 0 ? (
          <div className="pad">
            <div className="banner banner--warn">
              <div className="banner__title">
                {missing.size >= all.length ? 'No set has a verified European price' : `No European price for ${[...missing].sort().join(', ')}`}
              </div>
              Cardmarket has no confirmed Japanese expansion for {missing.size >= all.length ? 'any of them' : 'these'}.
              Those cards are <strong>not</strong> worthless: judge them on the Yuyu-tei prices.
            </div>
          </div>
        ) : null}

        {coverage.cardsWithEu === 0 && coverage.cardsTotal > 0 ? (
          <div className="pad" style={{ paddingTop: 0 }}>
            <div className="banner banner--info">
              <div className="banner__title">No Cardmarket data in this build</div>
              The yen prices are real and complete; only the European half is missing.
            </div>
          </div>
        ) : null}

        <div className="section-label">Sets</div>
        {all.length ? (
          <ul className="setlist">
            {all.map((s) => (
              <li key={s} className={missing.has(s) ? 'is-missing' : mapped.has(s) ? 'is-mapped' : ''}>
                <span className="mono">{s}</span>
                <span>{missing.has(s) ? 'no EU' : mapped.has(s) ? 'EU ok' : 'unknown'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">No set list in this build.</div>
        )}

        <div className="foot">
          Built {when(generatedAt)}. Rate{' '}
          {fx.jpyPerEur > 0 ? `€1 = ¥${Math.round(fx.jpyPerEur)}` : 'not baked in'}
          {fx.date ? ` on ${fx.date}` : ''} ({fx.source || 'unknown source'}).
          <br />
          Every price is inside the app, so it all works in aeroplane mode.
        </div>
      </div>
    </>
  )
}
