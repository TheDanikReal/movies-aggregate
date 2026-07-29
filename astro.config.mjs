// @ts-check
import { defineConfig } from 'astro/config';

import sitemap from '@astrojs/sitemap';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// https://astro.build/config
export default defineConfig({
  site: 'https://kinoslon.netlify.app',

  build: {
    inlineStylesheets: "always"
  },

  image: {
      domains: [
        "image.tmdb.org"
      ]
  },

  integrations: [
    sitemap({
      lastmod: new Date("2026-07-29T16:09:49.953Z"),
      filter: (page) => {
        return page !== "https://kinoslon.netlify.app/thanks/"
      }
    }),
    {
      name: "add indexnow file",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          if (process.env.INDEXNOW) {
            await writeFile(join(dir.pathname, process.env.INDEXNOW + ".txt"), process.env.INDEXNOW)
          }
        }
      }
    }
  ]
});
