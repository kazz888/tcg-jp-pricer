// Backup of bookmarks + collection to the Cloudflare Worker (worker.js), so
// they survive the phone clearing website data. localStorage stays the working
// copy: the app still runs offline and catches up when it has signal.
//
// "Dirty" means this device changed something the server has not got yet. A
// dirty device pushes; a clean one pulls - so a wiped phone (clean, empty)
// gets everything back instead of uploading its emptiness.
//
// shortcut: last write wins on the whole state. Fine for one person on one or
// two phones; editing offline on two phones at once loses one side's edits.

import type { Owned } from './collection'

export interface SyncState {
  bookmarks: string[]
  collection: Owned[]
}

export type SyncStatus = 'off' | 'saving' | 'saved' | 'failed' | 'bad-key'

const KEY = 'tcgjp.syncKey.v1'
const DIRTY = 'tcgjp.syncDirty.v1'

export function readSyncKey(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function writeSyncKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY, key)
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode - backup just stays off */
  }
}

export function isDirty(): boolean {
  try {
    return localStorage.getItem(DIRTY) === '1'
  } catch {
    return false
  }
}

export function setDirty(dirty: boolean): void {
  try {
    if (dirty) localStorage.setItem(DIRTY, '1')
    else localStorage.removeItem(DIRTY)
  } catch {
    /* private mode */
  }
}

export class SyncError extends Error {
  status: SyncStatus
  constructor(status: SyncStatus) {
    super(status)
    this.status = status
  }
}

async function call(key: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch('/api/state', { ...init, cache: 'no-store', headers: { 'x-sync-key': key, 'content-type': 'application/json' } })
  } catch {
    throw new SyncError('failed')
  }
  if (res.status === 401) throw new SyncError('bad-key')
  if (!res.ok) throw new SyncError('failed')
  return res
}

/** null when nothing has been backed up yet. */
export async function pull(key: string): Promise<SyncState | null> {
  return (await call(key)).json()
}

export async function push(key: string, state: SyncState): Promise<void> {
  await call(key, { method: 'PUT', body: JSON.stringify(state) })
}

/**
 * Only for the moment a key is entered on a device: keep both sides, so linking
 * a second phone never wipes what either one had. Server wins on a card both own.
 */
export function mergeStates(server: SyncState, local: SyncState): SyncState {
  const have = new Set(server.collection.map((x) => x.id))
  return {
    bookmarks: [...new Set([...server.bookmarks, ...local.bookmarks])],
    collection: [...server.collection, ...local.collection.filter((x) => !have.has(x.id))],
  }
}
