// @ts-check
import { defineConfig } from 'astro/config';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://kinoslon.netlify.app',

  image: {
      domains: ["image.tmdb.org"]
  },

  integrations: [sitemap()]
});