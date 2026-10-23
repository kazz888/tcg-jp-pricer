#!/usr/bin/env node
// Pull Yuyu-tei's Pokemon card list into data/pokemon.json: name, number, set,
// rarity and picture. No prices - it only feeds the collection's "add a Pokemon
// card" search, so you never have to photograph a card yourself.
//
//   node scripts/pull-pokemon.mjs     # ~40 pages at 1 request/second
//
// Same markup as the One Piece catalogue, so it reuses that parser as-is.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sweep } from './lib/yuyutei.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'data', 'pokemon.json')

/** Measured Oct 2026: 40 pages, ~24,000 cards. Far below that means the parser broke. */
const MIN_ROWS = 15000

/** Yuyu-tei bucket -> the set mark printed on the card: "sv08a" -> "SV8a", "m02a" -> "M2a". */
export function setMark(bucket) {
  return bucket.replace(/^[a-z]+/, (s) => s.toUpperCase()).replace(/([A-Z])0+(?=\d)/, '$1')
}

const { rows } = await sweep('sell', { game: 'poc', maxPages: 100, log: console.log })

if (rows.length < MIN_ROWS) {
  console.error(`only ${rows.length} Pokemon rows - refusing to overwrite ${OUT}`)
  process.exit(1)
}

const seen = new Set()
const cards = []
for (const r of rows) {
  const id = `${r.setBucket}|${r.cardId}`
  if (seen.has(id)) continue
  seen.add(id)
  cards.push({
    id,
    name: r.name,
    code: r.code,
    set: setMark(r.setBucket),
    rarity: r.rarity,
    img: r.img && !r.img.includes('noimage') ? r.img : '',
  })
}

await fs.writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), cards }))
console.log(`wrote ${cards.length} Pokemon cards to ${OUT}`)
