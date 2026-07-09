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
 * It only detects ADDED or MODIFIED showtimes vs. the baseline schedule.json.
 * Removed showtimes are ignored on purpose (per spec). When anything new is
 * found, `onScheduleChanged` is invoked — currently a no-op stub for you to
 * fill in (trigger a GitHub Action, send a notification, bust a cache, etc.).
 */

export interface Env {
  /** URL of the live cinema schedule page (HTML) to poll. */
  SCHEDULE_PAGE_URL: string;
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
// Diffing — only additions/modifications matter, removals are ignored
// ---------------------------------------------------------------------------

export type ScheduleChange = {
  type: "new-movie" | "new-date" | "new-time";
  movie: string;
  date: string;
  time: string;
};

function diffSchedules(live: ScheduleMap, baseline: ScheduleMap): ScheduleChange[] {
  const changes: ScheduleChange[] = [];

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

  // Note: times/dates/movies present only in the baseline (i.e. removed
  // showings) are intentionally never reported — that's a no-op per spec.

  return changes;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Called whenever new or modified showtimes are found. Currently empty —
 * fill this in with whatever should happen next (e.g. a repository_dispatch
 * to rerun the heavy enrichment script, a Discord/Telegram ping, a cache
 * purge, writing to KV, etc).
 */
async function onScheduleChanged(changes: ScheduleChange[]): Promise<void> {
  // TODO: do something
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

  const changes = diffSchedules(live, baseline);

  if (changes.length > 0) {
    await onScheduleChanged(changes);
  }

  return { changed: changes.length > 0, changes };
}

export default {
  // Manual/testing trigger: hit the worker's URL to see the diff as JSON.
  async fetch(_request: Request, env: Env): Promise<Response> {
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
