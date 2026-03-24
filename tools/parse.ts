import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import "dotenv/config"
import { TMDB, type ProductionCompany } from 'tmdb-ts';

type MovieSchedule = {
  name: string;
  times: Record<string, string[]>;
  description: string;
  age: string;
  poster_link: string;
  backdrop_link: string;
  studio: ProductionCompany[];
  rating: number;
};

type ScheduleOutput = {
  updated_at: string;
  movies: MovieSchedule[];
};

type MovieAccumulator = {
  name: string;
  age: string;
  description: string;
  times: Map<string, Set<string>>;
};

const tmdbToken = process.env["TMDB_TOKEN"]
if (!tmdbToken) throw new Error("tmdb token is not specified")
const tmdb = new TMDB(tmdbToken);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const INPUT_PATH = join(__dirname, "page.html");
const OUTPUT_PATH = join(__dirname, "schedule.json");

const MONTH_NAME_TO_MM: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
  // Russian month names
  январь: "01", января: "01",
  февраль: "02", февраля: "02",
  март: "03", марта: "03",
  апрель: "04", апреля: "04",
  май: "05", мая: "05",
  июнь: "06", июня: "06",
  июль: "07", июля: "07",
  август: "08", августа: "08",
  сентябрь: "09", сентября: "09",
  октябрь: "10", октября: "10",
  ноябрь: "11", ноября: "11",
  декабрь: "12", декабря: "12",
};

const normalizeText = (value: string): string =>
  value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();


const parseTitleAndAge = (
  rawTitle: string,
): {
  parsedName: string;
  parsedAge: string;
} => {
  const withoutTrailingId = normalizeText(rawTitle).replace(/\s+\d{5,}$/, "");
  const ageMatch = withoutTrailingId.match(/\(?\b\d{1,2}\+\)?/);

  if (!ageMatch || ageMatch.index === undefined) {
    return { parsedName: withoutTrailingId, parsedAge: "" };
  }

  const parsedName = normalizeText(withoutTrailingId.slice(0, ageMatch.index)).replace(
    /[.,;:\-]+$/,
    "",
  );

  return {
    parsedName,
    parsedAge: ageMatch[0].replace(/[()]/g, ""),
  };
};

const parseDateFromLabel = (text: string): string | null => {
  // Try both English and Russian month patterns
  const englishMatch = normalizeText(text).match(/^(\d{1,2})\s+([A-Za-z]+)/);
  const russianMatch = normalizeText(text).match(/^(\d{1,2})\s+([А-Яа-я]+)/);

  const match = englishMatch || russianMatch;
  if (!match) return null;

  const [, dayRaw, monthRaw] = match;
  const month = MONTH_NAME_TO_MM[monthRaw.toLowerCase()];
  if (!month) return null;

  return `${dayRaw.padStart(2, "0")}.${month}`;
};

const ensureMovie = (
  map: Map<string, MovieAccumulator>,
  movieName: string,
): MovieAccumulator => {
  const existing = map.get(movieName);
  if (existing) return existing;

  const created: MovieAccumulator = {
    name: movieName,
    age: "",
    description: "",
    times: new Map(),
  };

  map.set(movieName, created);
  return created;
};

const addTimes = (movie: MovieAccumulator, dateKey: string, times: string[]): void => {
  if (!movie.times.has(dateKey)) {
    movie.times.set(dateKey, new Set<string>());
  }

  const bucket = movie.times.get(dateKey);
  if (!bucket) return;

  for (const time of times) {
    bucket.add(time);
  }
};

const parseEventBlocks = (html: string, moviesMap: Map<string, MovieAccumulator>): void => {
  const $ = cheerio.load(html);

  $('td.eventsHeading a[name^="event_"]').each((_, element) => {
    const $anchor = $(element);
    const title = normalizeText($anchor.text());
    if (!title) return;

    const { parsedName, parsedAge } = parseTitleAndAge(title);
    if (!parsedName) return;

    const movie = ensureMovie(moviesMap, parsedName);
    if (parsedAge && !movie.age) {
      movie.age = parsedAge;
    }

    // Navigate up to find the top-level <tr> that contains this event
    // Structure: <tr><td><table><tr><td class="eventsHeading">
    const $topLevelTr = $anchor.closest('tr').parent().closest('tr');

    // Find the next <tr> sibling which contains the description
    let $current = $topLevelTr.next('tr');

    // Look for description in eventsContents
    const $descriptionCell = $current.find('td.eventsContents[valign="top"]');
    if ($descriptionCell.length > 0) {
      const description = normalizeText($descriptionCell.text());
      if (description.length > movie.description.length) {
        movie.description = description;
      }
      $current = $current.next('tr');
    }

    // Continue through the next sibling <tr> elements to find schedule data
    while ($current.length > 0) {
      // Check if we've hit the next event (contains eventsHeading)
      if ($current.find('td.eventsHeading').length > 0) {
        break;
      }

      // Look for date/time rows in nested tables
      $current.find('td.main[width="195"]').each((_, dateCell) => {
        const $dateCell = $(dateCell);
        const dateKey = parseDateFromLabel($dateCell.text());
        if (!dateKey) return;

        // Get the parent row to find all times in this row
        const $row = $dateCell.parent();
        const rowHtml = $row.html() || '';
        const times = rowHtml.match(/\b\d{2}:\d{2}\b/g) ?? [];
        if (times.length === 0) return;

        addTimes(movie, dateKey, times);
      });

      $current = $current.next('tr');
    }
  });
};

const fetchMovieMetadata = async (movieName: string): Promise<{ poster: string; backdrop: string, studio: ProductionCompany[], rating: number }> => {
  try {
    const searchResults = await tmdb.search.movies({
      query: movieName,
      language: "ru-RU"
    });

    if (searchResults.results && searchResults.results.length > 0) {
      const movie = searchResults.results[0];
      const baseUrl = 'https://image.tmdb.org/t/p/original';
      const details = await tmdb.movies.details(movie.id)

      return {
        poster: movie.poster_path ? `${baseUrl}${movie.poster_path}` : '',
        backdrop: movie.backdrop_path ? `${baseUrl}${movie.backdrop_path}` : '',
        studio: details.production_companies || [],
        rating: details.vote_average,
      };
    }
  } catch (error) {
    console.error(`Failed to fetch images for "${movieName}":`, error);
  }

  return { poster: '', backdrop: '', studio: [], rating: 0 };
};

const main = async (): Promise<void> => {
  const html = await readFile(INPUT_PATH, "utf-8");
  const moviesMap = new Map<string, MovieAccumulator>();

  parseEventBlocks(html, moviesMap);

  const movies: MovieSchedule[] = [];

  for (const movie of [...moviesMap.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const times: Record<string, string[]> = Object.fromEntries(
      [...movie.times.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, values]) => [date, [...values].sort()]),
    );

    console.log(`Fetching metadata for "${movie.name}"...`);
    const { poster, backdrop, studio, rating } = await fetchMovieMetadata(movie.name);

    movies.push({
      name: movie.name,
      times,
      description: movie.description,
      age: movie.age,
      poster_link: poster,
      backdrop_link: backdrop,
      studio,
      rating
    });
  }

  const result: ScheduleOutput = {
    updated_at: new Date().toISOString(),
    movies,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  console.log(`Schedule written to ${OUTPUT_PATH}`);
};

main().catch((error) => {
  console.error("Failed to parse schedule:", error);
  process.exitCode = 1;
});
