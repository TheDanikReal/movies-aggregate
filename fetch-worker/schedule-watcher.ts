/**
 * made by claude and verified by me, possibly i'll rewrite this code in future
 * 
 * Cloudflare Worker: cinema schedule change detector.
 *
 * Lightweight change detector: it fetches the MegaMag API and the baseline
 * schedule.json, then compares only movie/date/time entries.
 *
 * Change semantics:
 *  - New or modified showtimes (a new movie, a new date, or a new time on an
 *    existing date) are always reported.
 *  - Removed showtimes are reported ONLY if they haven't happened yet — i.e.
 *    their date+hour (cinema-local, UTC+3) is still in the future relative
 *    to "now". The site itself auto-drops each showtime once its hour
 *    passes, so a removed showtime that's already in the past is expected
 *    housekeeping and is ignored; only a still-upcoming removal (later
 *    today, or any future date) is reported.
 *
 * When anything qualifies, `onScheduleChanged` dispatches the GitHub Actions
 * workflow that reruns the heavy TMDB-enriching script.
 */

export interface Env {
  /** URL of the live MegaMag schedule API to poll. */
  SCHEDULE_API_URL: string;
  /** GitHub repo of project, like TheDanikReal/movies-aggregate. */
  REPO: string;
  /** GitHub workflow id to dispatch. */
  WORKFLOW_ID: string | number;
  /** GitHub token for dispatching workflow. */
  GITHUB_TOKEN: string;
  /** Optional override for the baseline schedule.json URL. */
  BASELINE_SCHEDULE_URL?: string;
  /** kv storage for storing last updated time */
  kinoslon: KVNamespace;
}

const DEFAULT_BASELINE_URL =
  "https://github.com/TheDanikReal/movies-aggregate/raw/refs/heads/main/tools/schedule.json";

const CINEMA_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Cinema-local (UTC+3) calendar date for a given instant, as plain numbers. */
const getCinemaLocalDateParts = (instant: Date): { year: number; month: number; day: number } => {
  const shifted = new Date(instant.getTime() + CINEMA_UTC_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

/** A bare "DD.MM" key has no year — infer it relative to today, handling the Dec/Jan wrap. */
const resolveYearForMonth = (month: number, todayMonth: number, todayYear: number): number => {
  if (month === 1 && todayMonth === 12) return todayYear + 1;
  if (month === 12 && todayMonth === 1) return todayYear - 1;
  return todayYear;
};

/**
 * Resolves a "DD.MM" + "HH:MM" pair (as shown on the cinema's site, always
 * cinema-local UTC+3) to the actual UTC instant it refers to, inferring the
 * year relative to `now` (handles the Dec/Jan wrap).
 */
const resolveShowtimeInstant = (dateKey: string, timeKey: string, now: Date): Date => {
  const [day, month] = dateKey.split(".").map(Number);
  const [hour, minute] = timeKey.split(":").map(Number);

  const today = getCinemaLocalDateParts(now);
  const year = resolveYearForMonth(month, today.month, today.year);

  // Treat (year, month, day, hour, minute) as cinema-local wall-clock time,
  // then shift by the UTC+3 offset to get the real UTC instant.
  const localAsIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  return new Date(localAsIfUtc - CINEMA_UTC_OFFSET_MS);
};

/**
 * True if the given showtime ("DD.MM" + "HH:MM", cinema-local UTC+3) is
 * already in the past relative to `now`. The site itself auto-removes a
 * showtime once its hour passes, so a "removed" showtime that's already
 * past is expected housekeeping, not a real schedule change.
 */
const isPastShowtime = (dateKey: string, timeKey: string, now: Date = new Date()): boolean => {
  const [day, month] = dateKey.split(".").map(Number);
  const [hour, minute] = timeKey.split(":").map(Number);
  if (!day || !month || Number.isNaN(hour) || Number.isNaN(minute)) return false; // malformed: don't suppress

  return resolveShowtimeInstant(dateKey, timeKey, now).getTime() < now.getTime();
};

type ScheduleMap = Map<string, Map<string, Set<string>>>;

type ApiSession = {
  movieName: string;
  date: string;
  time: string;
};

type ApiResponse = { sessions: ApiSession[] };

const extractMovieName = (movieName: string): string => {
  const withoutFormat = movieName.replace(/\b[23]\s*[dд]\b/gi, "").trim();
  const ageIndex = withoutFormat.search(/\(?\b\d{1,2}\+\)?/);
  return (ageIndex === -1 ? withoutFormat : withoutFormat.slice(0, ageIndex))
    .replace(/[.,;:\-]+$/, "")
    .trim();
};

const parseApiDate = (date: string): string => {
  const match = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid API session date: "${date}"`);
  return `${match[2]}.${match[1]}`;
};

async function fetchLiveSchedule(url: string): Promise<ScheduleMap> {
  const response = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`Failed to fetch live schedule API: ${response.status}`);

  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { sessions?: unknown }).sessions)
  ) {
    throw new Error("Live schedule API response does not contain a sessions array");
  }

  const schedule: ScheduleMap = new Map();
  for (const session of (data as ApiResponse).sessions) {
    if (!session || typeof session !== "object") continue;
    if (
      typeof session.movieName !== "string" ||
      typeof session.date !== "string" ||
      typeof session.time !== "string" ||
      !session.movieName ||
      !session.date ||
      !session.time
    ) continue;
    const movieName = extractMovieName(session.movieName);
    if (!movieName) continue;

    const dateKey = parseApiDate(session.date);
    const dateMap = schedule.get(movieName) ?? new Map<string, Set<string>>();
    const times = dateMap.get(dateKey) ?? new Set<string>();
    times.add(session.time);
    dateMap.set(dateKey, times);
    schedule.set(movieName, dateMap);
  }

  if (schedule.size === 0) throw new Error("Live schedule API returned no usable sessions");
  return schedule;
}

// ---------------------------------------------------------------------------
// Baseline (schedule.json) parsing
// ---------------------------------------------------------------------------

type BaselineShowtime = { time: string; timestamp: string };
type BaselineMovie = { name: string; times: Record<string, BaselineShowtime[]> };
type BaselineSchedule = { updated_at: string; movies: BaselineMovie[] };

async function fetchBaselineSchedule(url: string): Promise<ScheduleMap> {
  const res = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`Failed to fetch baseline schedule.json: ${res.status}`);

  const data = (await res.json()) as BaselineSchedule;
  const schedule: ScheduleMap = new Map();

  for (const movie of data.movies) {
    const dateMap = new Map<string, Set<string>>();
    for (const [date, showtimes] of Object.entries(movie.times)) {
      dateMap.set(date, new Set(showtimes.map((s) => s.time)));
    }
    schedule.set(movie.name, dateMap);
  }

  return schedule;
}

// ---------------------------------------------------------------------------
// Diffing — additions always reported; removals only for not-yet-happened showtimes
// ---------------------------------------------------------------------------

// is this REALLY needed???? we're going to remove this endpoint fully and replace it with
// cron job status and latest job timestamp so...
// TODO: remove this

export type ScheduleChange = {
  type: "new-movie" | "new-date" | "new-time" | "removed-movie" | "removed-date" | "removed-time";
  movie: string;
  date: string;
  time: string;
};

function diffSchedules(live: ScheduleMap, baseline: ScheduleMap, now: Date = new Date()): ScheduleChange[] {
  const changes: ScheduleChange[] = [];

  // --- Additions / modifications: anything new in live vs. baseline. -------
  for (const [movieName, liveDates] of live) {
    const baselineDates = baseline.get(movieName);

    if (!baselineDates) {
      for (const [date, times] of liveDates) {
        for (const time of times) changes.push({ type: "new-movie", movie: movieName, date, time });
      }
      continue;
    }

    for (const [date, liveTimes] of liveDates) {
      const baselineTimes = baselineDates.get(date);

      if (!baselineTimes) {
        for (const time of liveTimes) changes.push({ type: "new-date", movie: movieName, date, time });
        continue;
      }

      for (const time of liveTimes) {
        if (!baselineTimes.has(time)) {
          changes.push({ type: "new-time", movie: movieName, date, time });
        }
      }
    }
  }

  // --- Removals: only report showtimes that haven't happened yet. ----------
  // The site itself auto-drops a showtime once its hour passes, so a missing
  // showtime that's already in the past is expected housekeeping and is
  // ignored; only still-upcoming removals (later today or a future date) are
  // reported.
  for (const [movieName, baselineDates] of baseline) {
    const liveDates = live.get(movieName);

    for (const [date, baselineTimes] of baselineDates) {
      const liveTimes = liveDates?.get(date);

      for (const time of baselineTimes) {
        if (liveTimes?.has(time)) continue; // still present, not removed
        if (isPastShowtime(date, time, now)) continue; // already played out, ignore

        const type = !liveDates ? "removed-movie" : !liveTimes ? "removed-date" : "removed-time";
        changes.push({ type, movie: movieName, date, time });
      }
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function onScheduleChanged(changes: ScheduleChange[], env: Env): Promise<void> {
  if (!env.REPO) {
    throw new Error("Missing REPO environment variable");
  }

  if (!env.WORKFLOW_ID) {
    throw new Error("Missing WORKFLOW_ID environment variable");
  }

  if (!env.GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN environment variable");
  }

  const result = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/${String(env.WORKFLOW_ID)}/dispatches`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "movies-aggregate aggregator"
    },
    method: "POST",
    body: JSON.stringify({
      ref: "main",
    }),
  });
  if (result.ok) {
    await env.kinoslon.put("updated", new Date().toISOString())
  }
}

async function checkForScheduleUpdates(
  env: Env,
): Promise<{ changed: boolean; changes: ScheduleChange[] }> {
  if (!env.SCHEDULE_API_URL) {
    throw new Error("Missing SCHEDULE_API_URL environment variable");
  }

  const [live, baseline] = await Promise.all([
    fetchLiveSchedule(env.SCHEDULE_API_URL),
    fetchBaselineSchedule(env.BASELINE_SCHEDULE_URL ?? DEFAULT_BASELINE_URL),
  ]);

  const changes = diffSchedules(live, baseline, new Date());

  if (changes.length > 0) {
    await onScheduleChanged(changes, env);
  }

  return { changed: changes.length > 0, changes };
}

// todo: rename this function probably
async function handleUpdateRoute(env: Env) {
  try {
    const result = await checkForScheduleUpdates(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
}

// todo: safety, but i think it's not very important for a simple last updated path
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
}

function handleOptions(request: Request): Response {
  let headers = request.headers
  if (
    headers.get("Origin") !== null &&
    headers.get("Access-Control-Request-Method") !== null &&
    headers.get("Access-Control-Request-Headers") !== null
  ) {
    let respHeaders = {
      ...corsHeaders,
      "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers")!,
    }
    return new Response(null, {
      headers: respHeaders,
    })
  }
  else {
    return new Response(null, {
      headers: {
        Allow: "GET, HEAD, POST, OPTIONS",
      },
    })
  }
}

export default {
  // Manual/testing trigger: hit the worker's URL to see the diff as JSON.
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return handleOptions(request)
    }
    const path = new URL(request.url).pathname
    if (path === "/updated-at") {
      const time = await env.kinoslon.get("updated", "text")
      return new Response(JSON.stringify({
        time
      }, null, 2), { headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" } })
    } else if (path === "/update") {
      // todo: secret so that we won't get spammed by someone
      return handleUpdateRoute(env)
    } else {
      return new Response(undefined, { status: 404 });
    }
  },

  // Cron trigger: schedule this in wrangler.toml to poll periodically.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkForScheduleUpdates(env));
  },
};
