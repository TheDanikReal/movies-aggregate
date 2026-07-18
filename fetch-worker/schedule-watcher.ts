/**
 * made by claude and verified by me, possibly i'll rewrite this code in future
 * 
 * Cloudflare Worker: cinema schedule change detector.
 *
 * Lighter replacement for the Node script: no cheerio (heavy DOM parser),
 * no tmdb-ts, no price fetching, no fs. Uses only:
 *  - global `fetch` to grab the live page and the baseline schedule.json
 *  - Cloudflare's built-in `HTMLRewriter` (native to the Workers runtime,
 *    streaming, adds ~0 bytes to your bundle) instead of cheerio, just to
 *    drop lightweight text markers around the elements we care about.
 *  - plain string/regex parsing for everything else (same regex logic the
 *    original script already used internally).
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
  /** URL of the live cinema schedule page (HTML) to poll. */
  SCHEDULE_PAGE_URL: string;
  /** GitHub repo of project, like TheDanikReal/movies-aggregate. */
  REPO: string;
  /** GitHub workflow id to dispatch. */
  WORKFLOW_ID: string | number;
  /** GitHub token for dispatching workflow. */
  GITHUB_TOKEN: string;
  /** Optional override for the baseline schedule.json URL. */
  BASELINE_SCHEDULE_URL?: string;
}

const DEFAULT_BASELINE_URL =
  "https://github.com/TheDanikReal/movies-aggregate/raw/refs/heads/main/tools/schedule.json";

// ---------------------------------------------------------------------------
// Shared helpers (ported from the original script, fs/cheerio-free)
// ---------------------------------------------------------------------------

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

const stripTags = (html: string): string => normalizeText(html.replace(/<[^>]*>/g, " "));

const extractMovieName = (rawTitle: string): string => {
  const withoutTrailingId = normalizeText(rawTitle).replace(/\s+\d{5,}$/, "");
  const withoutFormat = normalizeText(withoutTrailingId.replace(/\b[23]\s*[dд]\b/gi, ""));
  const ageMatch = withoutFormat.match(/\(?\b\d{1,2}\+\)?/);

  if (!ageMatch || ageMatch.index === undefined) return withoutFormat;

  return normalizeText(withoutFormat.slice(0, ageMatch.index)).replace(/[.,;:\-]+$/, "");
};

/** Cinema's local UTC offset (UTC+3), matching the source site's own listed times. */
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

const parseDateFromLabel = (text: string): string | null => {
  const englishMatch = normalizeText(text).match(/^(\d{1,2})\s+([A-Za-z]+)/);
  const russianMatch = normalizeText(text).match(/^(\d{1,2})\s+([А-Яа-я]+)/);
  const match = englishMatch || russianMatch;
  if (!match) return null;

  const [, dayRaw, monthRaw] = match;
  const month = MONTH_NAME_TO_MM[monthRaw.toLowerCase()];
  if (!month) return null;

  return `${dayRaw.padStart(2, "0")}.${month}`;
};

// ---------------------------------------------------------------------------
// Live page parsing via HTMLRewriter markers (no full DOM built anywhere)
// ---------------------------------------------------------------------------

const EVENT_MARK = "\u0001EVENT\u0001";
const EVENT_END_MARK = "\u0001/EVENT\u0001";
const DATE_MARK = "\u0001DATE\u0001";
const DATE_END_MARK = "\u0001/DATE\u0001";
const ROW_MARK = "\u0001TR\u0001";

/**
 * Streams the HTML through HTMLRewriter, injecting cheap text markers
 * around the elements we care about (event title anchors, date cells, and
 * row boundaries). The rest of the markup passes through untouched — we
 * never build a DOM, so this is O(1) memory relative to the page size.
 */
async function annotateHtml(html: string): Promise<string> {

  const rewriter = new HTMLRewriter()
    .on('td.eventsHeading a[name^="event_"]', {
      element(el) {
        el.before(EVENT_MARK, { html: false });
        el.after(EVENT_END_MARK, { html: false });
      },
    })
    .on('td.main[width="195"]', {
      element(el) {
        el.before(DATE_MARK, { html: false });
        el.after(DATE_END_MARK, { html: false });
      },
    })
    .on("tr", {
      element(el) {
        el.before(ROW_MARK, { html: false });
      },
    });

  const response = rewriter.transform(
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );

  return response.text();
}

/** movieName -> date ("DD.MM") -> set of "HH:MM" showtimes */
type ScheduleMap = Map<string, Map<string, Set<string>>>;

function parseAnnotatedSchedule(annotated: string): ScheduleMap {
  const schedule: ScheduleMap = new Map();

  // Everything before the first event marker is irrelevant chrome/markup.
  const eventChunks = annotated.split(EVENT_MARK).slice(1);

  for (const chunk of eventChunks) {
    const titleEndIdx = chunk.indexOf(EVENT_END_MARK);
    if (titleEndIdx === -1) continue;

    const movieName = extractMovieName(stripTags(chunk.slice(0, titleEndIdx)));
    if (!movieName) continue;

    // Body = everything up to the next event marker (already sliced out by split).
    const body = chunk.slice(titleEndIdx + EVENT_END_MARK.length);
    const dateMap = schedule.get(movieName) ?? new Map<string, Set<string>>();

    const dateSegments = body.split(DATE_MARK).slice(1);
    for (const seg of dateSegments) {
      const dateEndIdx = seg.indexOf(DATE_END_MARK);
      if (dateEndIdx === -1) continue;

      const dateKey = parseDateFromLabel(stripTags(seg.slice(0, dateEndIdx)));
      if (!dateKey) continue;

      // Times live in the rest of this table row, i.e. up to the next row marker.
      const afterDate = seg.slice(dateEndIdx + DATE_END_MARK.length);
      const rowEndIdx = afterDate.indexOf(ROW_MARK);
      const rowScope = rowEndIdx === -1 ? afterDate : afterDate.slice(0, rowEndIdx);

      const times = rowScope.match(/\b\d{2}:\d{2}\b/g) ?? [];
      if (times.length === 0) continue;

      const timeSet = dateMap.get(dateKey) ?? new Set<string>();
      for (const time of times) timeSet.add(time);
      dateMap.set(dateKey, timeSet);
    }

    schedule.set(movieName, dateMap);
  }

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

  await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/${String(env.WORKFLOW_ID)}/dispatches`, {
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
}

async function checkForScheduleUpdates(
  env: Env,
): Promise<{ changed: boolean; changes: ScheduleChange[] }> {
  const [pageRes, baseline] = await Promise.all([
    fetch(env.SCHEDULE_PAGE_URL),
    fetchBaselineSchedule(env.BASELINE_SCHEDULE_URL ?? DEFAULT_BASELINE_URL),
  ]);

  if (!pageRes.ok) {
    throw new Error(`Failed to fetch live schedule page: ${pageRes.status}`);
  }

  const html = await pageRes.text();
  const annotated = await annotateHtml(html);
  const live = parseAnnotatedSchedule(annotated);

  const changes = diffSchedules(live, baseline, new Date());

  if (changes.length > 0) {
    await onScheduleChanged(changes, env);
  }

  return { changed: changes.length > 0, changes };
}

export default {
  // Manual/testing trigger: hit the worker's URL to see the diff as JSON.
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/") {
      return new Response(undefined, { status: 404 });
    }
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
  },

  // Cron trigger: schedule this in wrangler.toml to poll periodically.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkForScheduleUpdates(env));
  },
};
