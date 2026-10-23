// @ts-ignore - no @types/node in this project (see verdict.test.ts)
import { test } from 'node:test'
// @ts-ignore - no @types/node in this project
import assert from 'node:assert/strict'
import type { Owned } from './collection.ts'
import { mergeStates } from './sync.ts'

const card = (id: string, qty: number): Owned => ({ id, game: 'pokemon', name: id, code: '', img: '', qty })

test('linking keeps everything from both sides, server first', () => {
  const merged = mergeStates(
    { bookmarks: ['a', 'b'], collection: [card('x', 2)] },
    { bookmarks: ['b', 'c'], collection: [card('x', 5), card('y', 1)] },
  )
  assert.deepEqual(merged.bookmarks, ['a', 'b', 'c'])
  assert.deepEqual(merged.collection, [card('x', 2), card('y', 1)])
})
