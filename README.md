# KinoSlon
A parser and Astro frontend for my local cinema, which has very inconvenient UI, which looks like something from 2015s because that is LITERALLY true, I checked it in web.archive.org and 2015 snapshot looks same as it looks today, everything is on the same place, not a single block have been moved, the only thing that has been added is age ratings for movies.

It's made with mobile devices in mind and ability to use site with JavaScript disabled

## Features
- Mobile UI, which renders in a subsecond even on a weak phone
- Accessibility (not a priority, but I try to improve it)
- Dark theme only
- Strong SEO
- Made with Astro, a very fast framework, and TypeScript for strong typing
## Parsers
This project has 2 parsers
- First (`fetch-worker`) is designed to only check whether the schedule changed or not, then sends a dispatch event to GitHub actions to start second parser, very lightweight, takes around 6 ms CPU time
- Second (`tools/parse.ts`) does fetch every movies' data from TMDB, parse age ratings, star ratings, length, companies that did produce movie and make a JSON file from that data
## Commands
- `npm run build` - builds a production build of project in `dist/`
- `npm run dev` - runs an Astro development local server
- `npm run astro` - run Astro CLI
