// A dedicated numeric pad docked at the bottom of the screen.
//
// Why not just the OS keyboard: it covers the bottom two thirds of the phone,
// which is exactly where the verdict would be. This pad lives in the thumb
// zone, never moves, and cannot autocorrect "1500" into something else. The
// real <input inputmode="numeric"> is still there and still tappable.

import { useState } from 'react'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0'] as const

/** Digits only, no leading zeros, at most 9 digits - no decimals exist in yen. */
const clean = (raw: string) => raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 9)

export default function Keypad({
  onDigits,
  onBackspace,
  onClear,
  disabled,
}: {
  onDigits: (d: string) => void
  onBackspace: () => void
  onClear: () => void
  disabled?: boolean
}) {
  return (
    <div className="keypad" role="group" aria-label="Asking price keypad">
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          className="key"
          disabled={disabled}
          onClick={() => onDigits(k)}
          aria-label={k === '00' ? 'double zero' : k}
        >
          {k}
        </button>
      ))}
      <button
        type="button"
        className="key key--fn"
        disabled={disabled}
        onClick={onBackspace}
        onDoubleClick={onClear}
        aria-label="Delete last digit"
      >
        ⌫
      </button>
    </div>
  )
}

/**
 * The bottom of every "is this shop price good?" screen: the shop's price, the
 * verdict (passed in as children) and the keypad, together in the thumb zone.
 * `ask` is raw digits; it is shown as "¥12,800" but never stored that way.
 */
export function AskDock({
  ask,
  onAsk,
  children,
}: {
  ask: string
  /** A state setter: keys update from the previous value, so fast taps never read a stale one. */
  onAsk: React.Dispatch<React.SetStateAction<string>>
  children: React.ReactNode
}) {
  const [padOpen, setPadOpen] = useState(true)

  return (
    <div className="dock">
      <div className="dock__ask">
        <label className="dock__label" htmlFor="ask">
          Shop price
        </label>
        <input
          id="ask"
          className={ask.length > 6 ? 'dock__input dock__input--long' : 'dock__input'}
          inputMode="numeric"
          type="text"
          autoComplete="off"
          enterKeyHint="done"
          placeholder="¥0"
          value={ask ? `¥${Number(ask).toLocaleString('ja-JP')}` : ''}
          onChange={(e) => onAsk(clean(e.target.value))}
        />
        {ask ? (
          <button type="button" className="dock__clear" onClick={() => onAsk('')} aria-label="Clear shop price">
            ×
          </button>
        ) : null}
        <button
          type="button"
          className="dock__toggle"
          onClick={() => setPadOpen((p) => !p)}
          aria-expanded={padOpen}
          aria-label={padOpen ? 'Hide keypad' : 'Show keypad'}
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {children}
      {padOpen ? (
        <Keypad
          onDigits={(d) => onAsk((prev) => clean(prev + d))}
          onBackspace={() => onAsk((prev) => prev.slice(0, -1))}
          onClear={() => onAsk('')}
        />
      ) : null}
    </div>
  )
}
