// @ts-check
import { defineConfig } from 'astro/config';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://kinoslon.netlify.app',

  build: {
    inlineStylesheets: "always"
  },

  image: {
      domains: ["image.tmdb.org"]
  },

  integrations: [
    sitemap({
      lastmod: new Date("2026-04-16T18:27:00.354Z")
    })
  ]
});
