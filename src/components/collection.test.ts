// @ts-ignore - no @types/node in this project (see verdict.test.ts)
import { test } from 'node:test'
// @ts-ignore - no @types/node in this project
import assert from 'node:assert/strict'
import { searchCards, withQty, type Owned, type Searchable } from './collection.ts'

const a: Owned = { id: 'a', game: 'pokemon', name: 'Pikachu', code: '', img: '', qty: 1 }
const b: Owned = { id: 'b', game: 'onepiece', name: 'Luffy', code: 'OP09-119', img: '', qty: 2 }

test('adds a new card at the top', () => {
  assert.deepEqual(withQty([b], a, 1), [a, b])
})

test('changes the quantity of an owned card in place', () => {
  assert.deepEqual(withQty([a, b], b, 3), [a, { ...b, qty: 3 }])
})

test('zero removes the card', () => {
  assert.deepEqual(withQty([a, b], a, 0), [b])
})

const card = (set: string, code: string, name: string, romaji: string): Searchable => ({
  id: `${set}|${code}`, name, code, set, rarity: 'SAR', img: '', romaji,
  hay: `${name} ${set} ${code} SAR`.toLowerCase(),
})
const cards = [card('SV8a', '205/187', 'シャワーズex', 'shawazex'), card('SV9', '205/187', 'ピカチュウ', 'pikach')]

test('search needs every word, case-insensitive', () => {
  assert.deepEqual(searchCards(cards, 'sv8a 205', '').map((c) => c.name), ['シャワーズex'])
  assert.deepEqual(searchCards(cards, '205/187', '').length, 2)
})

test('search falls back to romaji, and an empty query finds nothing', () => {
  assert.deepEqual(searchCards(cards, 'pikachu', 'pikach').map((c) => c.name), ['ピカチュウ'])
  assert.deepEqual(searchCards(cards, '  ', ''), [])
})
