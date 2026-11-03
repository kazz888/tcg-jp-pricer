// Every screen that is not the search: a sheet that rises from the bottom, so
// it opens in the thumb zone and never competes with the search field.
//
// A native <dialog>: focus is trapped, Escape closes it, and the backdrop is
// the browser's. Tapping the backdrop closes it too - the content sits in an
// inner wrapper, so a tap on the dialog element itself can only be outside it.

import type { SyncStatus } from './sync'

const BACKUP_LABEL: Record<SyncStatus, string> = {
  off: 'Off',
  saving: 'Saving…',
  saved: 'Backed up',
  failed: 'Not saved',
  'bad-key': 'Wrong key',
}

export interface MenuItem {
  glyph: string
  label: string
  count?: number
  onSelect: () => void
}

export default function Menu({
  dialogRef,
  items,
  backupStatus,
  onBackup,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>
  items: MenuItem[]
  backupStatus: SyncStatus
  onBackup: () => void
}) {
  const close = () => dialogRef.current?.close()
  const pick = (fn: () => void) => () => {
    close()
    fn()
  }
  const backupWarn = backupStatus === 'failed' || backupStatus === 'bad-key'

  return (
    <dialog
      ref={dialogRef}
      className="sheet"
      aria-label="Menu"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="sheet__body">
        <div className="sheet__grip" aria-hidden="true" />
        <nav aria-label="Screens">
          {items.map((it) => (
            <button key={it.label} type="button" className="sheet__item" onClick={pick(it.onSelect)}>
              <span className="sheet__glyph" aria-hidden="true">
                {it.glyph}
              </span>
              {it.label}
              {it.count !== undefined ? <span className="sheet__count mono">{it.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className="sheet__sep" />
        <button type="button" className="sheet__item" onClick={pick(onBackup)}>
          <span className="sheet__glyph" aria-hidden="true">
            ⇅
          </span>
          Backup
          <span className={backupWarn ? 'sheet__count sheet__count--warn' : 'sheet__count'}>
            {BACKUP_LABEL[backupStatus]}
          </span>
        </button>
      </div>
    </dialog>
  )
}
