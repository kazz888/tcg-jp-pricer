// A dedicated numeric pad docked at the bottom of the screen.
//
// Why not just the OS keyboard: it covers the bottom two thirds of the phone,
// which is exactly where the verdict would be. This pad lives in the thumb
// zone, never moves, and cannot autocorrect "1500" into something else. The
// real <input inputmode="numeric"> is still there and still tappable.

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0'] as const

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
        ⌫ Del
      </button>
    </div>
  )
}
