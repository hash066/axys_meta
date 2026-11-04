/**
 * Demo-only sample insights for a 10 second reel after one week. SAMPLE:
 * every record carries `sample: true` and the source label below, and the route
 * that stores it only exists when AXYS_DEMO_SAMPLES=true. Never Instagram data.
 *
 * The record keeps the real Instagram shape (`data.data` rows) so the real
 * grounded feedback planner reads it unchanged, plus a 7-day series, a
 * retention curve and an audience split for the Studio dashboard.
 */
export const SAMPLE_SOURCE = "Sample data (not Instagram)";
export const SAMPLE_PRESET = "reel-week-1";

// Daily figures sum to the totals below (plays 18,420; likes 1,184; saves 341; shares 97).
const PLAYS = [6120, 4310, 2640, 1760, 1390, 1200, 1000];
const LIKES = [392, 281, 176, 118, 90, 75, 52];
const SAVES = [112, 84, 52, 38, 26, 18, 11];
const SHARES = [33, 24, 15, 10, 7, 5, 3];
/** Unique accounts reached so far (cumulative), ending at the reach total. */
const REACH_CUMULATIVE = [4890, 7420, 9250, 10610, 11700, 12430, 12960];
/** Share of viewers still watching at each second 0..10 (mean watch time 6.4 s). */
const RETENTION = [100, 88, 79, 71, 65, 60, 56, 52, 49, 47, 46];
const AGE = [
  ["13-17", 4],
  ["18-24", 27],
  ["25-34", 38],
  ["35-44", 19],
  ["45-54", 8],
  ["55+", 4],
] as const;
const COUNTRY = [
  ["United States", 58],
  ["Canada", 9],
  ["United Kingdom", 8],
  ["Australia", 5],
  ["Germany", 4],
  ["Other", 16],
] as const;

const total = (a: number[]) => a.reduce((x, y) => x + y, 0);
const row = (name: string, value: number) => ({
  name,
  period: "lifetime",
  total_value: { value },
});

export function sampleInstagramRecord(now = new Date()) {
  const day = (i: number) =>
    new Date(now.getTime() - (6 - i) * 86400000).toISOString().slice(0, 10);
  return {
    source: SAMPLE_SOURCE,
    sample: true as const,
    preset: SAMPLE_PRESET,
    observedAt: now.toISOString(),
    note: "Sample numbers for a demonstration. Not retrieved from Instagram.",
    data: {
      data: [
        row("plays", total(PLAYS)),
        row("reach", REACH_CUMULATIVE[6]),
        row("likes", total(LIKES)),
        row("comments", 62),
        row("saves", total(SAVES)),
        row("shares", total(SHARES)),
        row("profile_visits", 428),
        row("follows", 56),
        row("avg_watch_time", 6.4),
        row("retention_end_pct", RETENTION[10]),
      ],
    },
    series: {
      days: PLAYS.map((plays, i) => ({
        day: day(i),
        plays,
        reach_cumulative: REACH_CUMULATIVE[i],
        likes: LIKES[i],
        saves: SAVES[i],
        shares: SHARES[i],
      })),
      retention: RETENTION.map((pct, t) => ({ second: t, pct })),
      audience: {
        age: AGE.map(([label, pct]) => ({ label, pct })),
        country: COUNTRY.map(([label, pct]) => ({ label, pct })),
      },
      avgWatchTimeSeconds: 6.4,
    },
  };
}

/** Website rows in the shape the real metrics route reports (kind, value, observedAt). */
export function sampleWebsiteRows(now = new Date()) {
  const at = now.toISOString();
  return [
    { kind: "visit", value: 58, observedAt: at },
    { kind: "contact", value: 3, observedAt: at },
  ];
}
