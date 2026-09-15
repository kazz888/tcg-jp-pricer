import { defineConfig } from 'astro/config'
import react from '@astrojs/react'

// Static output -> Cloudflare Pages. No runtime secrets: every price is
// baked into data/ at build time so the app works offline in a Japanese shop.
export default defineConfig({
  integrations: [react()],
  output: 'static',
  build: { inlineStylesheets: 'always' },
})
