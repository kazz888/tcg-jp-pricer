# Refreshing the Cardmarket expansion map

## Why this is manual

Cardmarket serves HTTP 403 (Cloudflare) to every automated client we tried: plain curl, a
browser User-Agent, and a proxy. It does **not** block a real human in a real browser.

The automated fallback is an Internet Archive capture, which is dated **2026-01-04**. Its
newest Japanese expansion is **OP13**. Yuyu-tei is currently selling **OP16 and OP17**, so
the 2026 sets — the ones most likely to be in a shop display case — have no mapping.

There is no way to infer language from the data. Every shortcut was tested and rejected:
`productId` ordering (85% accurate = worthless), name suffixes (Cardmarket creates a
placeholder literally named `OP17` with no suffix), and every field in the Apify price row
(identical across both printings). One Piece card codes are the same in every language, so
the card code proves nothing either.

So: a human with a browser beats the machine here. It takes about a minute.

## How to refresh (one paste)

1. Open <https://www.cardmarket.com/en/OnePiece/Products/Singles> in your normal browser.
2. Open DevTools -> Console.
3. Paste this and press Enter. It copies the full expansion list to your clipboard:

```js
copy(JSON.stringify(
  [...document.querySelectorAll('option')]
    .map(o => ({ expansionId: +o.value, name: o.textContent.trim() }))
    .filter(x => Number.isInteger(x.expansionId) && x.expansionId > 1700 && x.name)
, null, 2))
```

4. Paste the result back into the project (or hand it to Claude) to regenerate
   `data/expansions.json` with fresh, positively-evidenced names.

If `copy()` is unavailable, drop the `copy(...)` wrapper and copy the printed output.

## Manual override format

For anything the dropdown still cannot settle, edit `data/expansion-overrides.json`:

```json
{
  "verifiedBy": "kasper",
  "verifiedOn": "2026-09-15",
  "overrides": {
    "6457": { "language": "japanese",          "name": "The Time of Battle (JP)", "why": "checked on Cardmarket, listings are Japanese" },
    "6606": { "language": "unknown",           "name": "The Time of Battle (Asia Region Legal)", "why": "Asia-region print, not JP domestic" },
    "6379": { "language": "unknown",           "name": "Heroines Edition (Asia Region Legal)", "why": "unclear" }
  }
}
```

`language` must be one of: `japanese`, `english_confirmed`, `unknown`.

**Only `japanese` is ever priced against Cardmarket.** `unknown` fails closed — the app shows
"no verified European reference" rather than a number that might be from the wrong printing.

## Currently unresolved (blocking EUR prices)

| expansionId | name | why it matters |
|---|---|---|
| 6457 | The Time of Battle (slug OP16) | OP16 is on Yuyu-tei now |
| 6606 | The Time of Battle (Asia Region Legal) | ditto |
| 6379 | Heroines Edition (Asia Region Legal) | Asia-region third category |
| 6411 | The Azure Sea's Seven (Asia Region Legal) | ditto |

OP14, OP15 and OP17 have **no row at all** in the January snapshot — the paste above is the
fix for those.
