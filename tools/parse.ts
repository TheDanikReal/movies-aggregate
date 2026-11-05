import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { TMDB, type ProductionCompany } from "tmdb-ts";

type Showtime = {
  time: string;
  timestamp: string;
};

type MovieSchedule = {
  id: string;
  name: string;
  times: Record<string, Showtime[]>;
  description: string;
  age: string;
  format: string;
  poster_link: string;
  backdrop_link: string;
  studio: ProductionCompany[];
  rating: number;
  length: number;
  price?: string;
  year: string;
};

type ScheduleOutput = {
  updated_at: string;
  movies: MovieSchedule[];
};

type ApiSession = {
  movieName: string;
  posterUrl: string | null;
  description: string | null;
  duration: string | null;
  date: string;
  time: string;
  price: number | string | null;
  in3D: boolean;
};

type ApiResponse = {
  sessions: ApiSession[];
};

type MovieAccumulator = {
  name: string;
  age: string;
  format: string;
  description: string;
  length: number;
  prices: Set<string>;
  times: Map<string, Map<string, Showtime>>;
};

const API_URL =
  process.env["SCHEDULE_API_URL"] ??
  "https://new.megamag.by/api/schedule?region=%D0%A1%D0%BB%D0%BE%D0%BD%D0%B8%D0%BC";
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "response.json");
const OUTPUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "schedule.json");
const CINEMA_OFFSET_MINUTES = 3 * 60;

const tmdbToken = process.env["TMDB_TOKEN"];
if (!tmdbToken) throw new Error("tmdb token is not specified");
const tmdb = new TMDB(tmdbToken);

const normalizeText = (value: string): string =>
  value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

const parseMainData = (
  rawTitle: string,
): { parsedName: string; parsedAge: string; parsedFormat: string } => {
  const title = normalizeText(rawTitle);
  const formatMatch = title.match(/\b([23])\s*[dд]\b/i);
  const parsedFormat = formatMatch ? `${formatMatch[1]}D` : "";
  const withoutFormat = normalizeText(title.replace(/\b[23]\s*[dд]\b/gi, ""));
  const ageMatch = withoutFormat.match(/\(?\b\d{1,2}\+\)?/);

  if (!ageMatch || ageMatch.index === undefined) {
    return { parsedName: withoutFormat, parsedAge: "", parsedFormat };
  }

  return {
    parsedName: normalizeText(withoutFormat.slice(0, ageMatch.index)).replace(
      /[.,;:\-]+$/,
      "",
    ),
    parsedAge: ageMatch[0].replace(/[()]/g, ""),
    parsedFormat,
  };
};

const parseDateKey = (date: string): string => {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid session date: "${date}"`);
  return `${match[3]}.${match[2]}`;
};

const generateTimestamp = (date: string, time: string): string => {
  const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = time.match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) {
    throw new Error(`Invalid session datetime: "${date} ${time}"`);
  }

  const [, year, month, day] = dateMatch;
  const [, hour, minute] = timeMatch;
  const utcMillis =
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) -
    CINEMA_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMillis).toISOString();
};

const parseDuration = (duration: string | null): number => {
  if (!duration) return 0;
  const match = duration.match(/(\d+)\s*мин\./i);
  return match ? Number(match[1]) : 0;
};

const ensureMovie = (
  movies: Map<string, MovieAccumulator>,
  session: ApiSession,
): MovieAccumulator => {
  const { parsedName, parsedAge, parsedFormat } = parseMainData(session.movieName);
  if (!parsedName) throw new Error(`Session has an empty movie name: "${session.movieName}"`);

  const existing = movies.get(parsedName);
  if (existing) {
    if (parsedAge && !existing.age) existing.age = parsedAge;
    if (parsedFormat && !existing.format) existing.format = parsedFormat;
    if (!existing.length) existing.length = parseDuration(session.duration);
    return existing;
  }

  const created: MovieAccumulator = {
    name: parsedName,
    age: parsedAge,
    format: parsedFormat,
    description: normalizeText(session.description ?? ""),
    length: parseDuration(session.duration),
    prices: new Set(),
    times: new Map(),
  };
  movies.set(parsedName, created);
  return created;
};

const addSession = (movies: Map<string, MovieAccumulator>, session: ApiSession): void => {
  const movie = ensureMovie(movies, session);
  const dateKey = parseDateKey(session.date);
  const dateTimes = movie.times.get(dateKey) ?? new Map<string, Showtime>();
  dateTimes.set(session.time, {
    time: session.time,
    timestamp: generateTimestamp(session.date, session.time),
  });
  movie.times.set(dateKey, dateTimes);

  const price = String(session.price ?? "").trim();
  if (price) movie.prices.add(price);
  if (session.description && session.description.length > movie.description.length) {
    movie.description = normalizeText(session.description);
  }
};

const fetchSchedule = async (): Promise<ApiResponse> => {
  const fixturePath = process.env["SCHEDULE_FIXTURE"];
  const responseText = fixturePath
    ? await readFile(fixturePath === "default" ? FIXTURE_PATH : fixturePath, "utf-8")
    : await (async () => {
        const response = await fetch(API_URL, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; KinoSlonBot/1.0)" },
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch schedule: ${response.status} ${response.statusText}`);
        }
        return response.text();
      })();

  const data: unknown = JSON.parse(responseText);
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { sessions?: unknown }).sessions)
  ) {
    throw new Error("Schedule API response does not contain a sessions array");
  }
  return data as ApiResponse;
};

const fetchMovieMetadata = async (
  movieName: string,
): Promise<{
  id: string;
  poster: string;
  backdrop: string;
  studio: ProductionCompany[];
  rating: number;
  length: number;
  year: string;
}> => {
  try {
    const searchResults = await tmdb.search.movies({ query: movieName, language: "ru-RU" });
    if (searchResults.results?.length) {
      const movie = [...searchResults.results].sort((left, right) => {
        const leftYear = Number((left.release_date ?? "").slice(0, 4)) || 0;
        const rightYear = Number((right.release_date ?? "").slice(0, 4)) || 0;
        return rightYear - leftYear;
      })[0];
      const details = await tmdb.movies.details(movie.id);
      const baseUrl = "https://image.tmdb.org/t/p/w500";
      return {
        id: details.imdb_id ?? "",
        poster: movie.poster_path ? `${baseUrl}${movie.poster_path}` : "",
        backdrop: movie.backdrop_path ? `${baseUrl}${movie.backdrop_path}` : "",
        studio: details.production_companies || [],
        rating: details.vote_average,
        length: details.runtime,
        year: details.release_date.slice(0, 4),
      };
    }
  } catch (error) {
    console.error(`Failed to fetch metadata for "${movieName}":`, error);
  }

  return { id: "", poster: "", backdrop: "", studio: [], rating: 0, length: 0, year: "" };
};

const main = async (): Promise<void> => {
  const schedule = await fetchSchedule();
  if (schedule.sessions.length === 0) {
    throw new Error("Schedule API returned no sessions");
  }

  const moviesMap = new Map<string, MovieAccumulator>();
  for (const session of schedule.sessions) addSession(moviesMap, session);

  const movies: MovieSchedule[] = [];
  for (const movie of [...moviesMap.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    console.log(`Fetching metadata for "${movie.name}"...`);
    const metadata = await fetchMovieMetadata(movie.name);
    const times = Object.fromEntries(
      [...movie.times.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, showtimes]) => [date, [...showtimes.values()].sort((a, b) => a.time.localeCompare(b.time))]),
    );
    const price = movie.prices.size === 1 ? [...movie.prices][0] : undefined;

    movies.push({
      id: metadata.id,
      name: movie.name,
      times,
      description: movie.description,
      age: movie.age,
      format: movie.format,
      poster_link: metadata.poster,
      backdrop_link: metadata.backdrop,
      studio: metadata.studio,
      rating: metadata.rating,
      length: movie.length || metadata.length,
      ...(price ? { price } : {}),
      year: metadata.year,
    });
  }

  const result: ScheduleOutput = { updated_at: new Date().toISOString(), movies };
  await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  console.log(`Schedule written to ${OUTPUT_PATH}`);
};

main().catch((error) => {
  console.error("Failed to parse schedule:", error);
  process.exitCode = 1;
});
