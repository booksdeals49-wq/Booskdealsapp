// Shared "resolve a date range from URL search params" helper, used by
// every report loader (Reports hub, its CSV download, City Performance)
// so a custom range picked in one place stays consistent everywhere it's
// passed through as ?from=YYYY-MM-DD&to=YYYY-MM-DD.
//
// Falls back to "last 30 days" when no params are present, which keeps
// every existing bookmarked/linked URL working unchanged.

export type ResolvedDateRange = {
  from: Date;
  to: Date; // exclusive upper bound (start of the day after the selected end date)
  fromLabel: string; // YYYY-MM-DD, for reflecting back into <input type="date">
  toLabel: string; // YYYY-MM-DD, inclusive end date as shown to the user
  days: number; // whole days spanned, for display ("last 7 days" etc.)
};

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateOnly(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function resolveDateRange(url: URL): ResolvedDateRange {
  const fromParam = parseDateOnly(url.searchParams.get("from"));
  const toParam = parseDateOnly(url.searchParams.get("to"));

  let from: Date;
  let to: Date; // inclusive end date, at 00:00

  if (fromParam && toParam && fromParam <= toParam) {
    from = fromParam;
    to = toParam;
  } else {
    // Default: last 30 days, ending today.
    to = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
    from = new Date(to.getTime() - 29 * DAY_MS);
  }

  const toExclusive = new Date(to.getTime() + DAY_MS); // include the entire end day
  const days = Math.round((toExclusive.getTime() - from.getTime()) / DAY_MS);

  return {
    from,
    to: toExclusive,
    fromLabel: from.toISOString().slice(0, 10),
    toLabel: to.toISOString().slice(0, 10),
    days,
  };
}

/** Build the query string for a preset range ending today, e.g. lastNDays(7). */
export function lastNDaysParams(n: number): string {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (n - 1) * DAY_MS).toISOString().slice(0, 10);
  return `from=${from}&to=${to}`;
}

/** Build the query string for "this month" (1st of the current month through today). */
export function thisMonthParams(): string {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return `from=${from}&to=${to}`;
}
