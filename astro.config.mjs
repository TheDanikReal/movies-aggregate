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
        "image.tmdb.org",
        "kinoteatr.megamag.by"
      ]
  },

  integrations: [
    sitemap({
      lastmod: new Date("2026-05-13T17:41:49.953Z")
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
