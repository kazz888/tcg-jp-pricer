// Bookmarks: the cards you decided to hunt, kept on this device.
//
// Why a PRINTING and not a card code. You think in codes - "bookmark OP08-057" -
// but a code is not a printing: OP09-119 is five physical cards from JPY 780 to
// JPY 248,000. Bookmarking the code would mean the list could not tell you what
// any of them is worth. So a bookmark pins one printing, exactly the one you
// picked off the printings strip, and the list groups them by code so a code
// with three bookmarked printings still reads as one heading.
//
// Storage is localStorage: per device, survives rebuilds, never leaves the
// phone. Every read and write is wrapped, because private mode and a full quota
// both throw, and a bookmark list is a convenience that must never break the app.

import type { Card } from '../lib/types'

const KEY = 'tcgjp.bookmarks.v1'

/** Hard ceiling. Not a real limit for a trip list, just a guard against a runaway write. */
const MAX = 500

/**
 * Identity of one printing. Same shape App.tsx uses for "recently checked", so
 * the two features address cards identically.
 */
export function keyOf(c: Card): string {
  return `${c.setBucket}|${c.cardId}|${c.code}`
}

export function readBookmarks(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX)
  } catch {
    return []
  }
}

export function writeBookmarks(keys: readonly string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(keys.slice(0, MAX)))
  } catch {
    /* private mode / quota - bookmarks are a convenience, never load-bearing */
  }
}

/** Newest first, so the thing you just added is at the top of the list. */
export function toggleKey(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [key, ...keys].slice(0, MAX)
}
