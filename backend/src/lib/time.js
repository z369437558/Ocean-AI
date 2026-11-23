/**
 * Time-zone helpers built on the ICU data that ships with Node.js (no extra dependency).
 *
 * Certificates store their issue instant in UTC. Everything a tenant admin sees or sorts by is
 * that instant converted to the tenant's IANA time zone, DST rules included.
 */

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone) {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function toDate(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid timestamp: ${String(instant)}`);
  return date;
}

/** Wall-clock fields ({ year, month, day, hour, minute, second } as zero-padded strings). */
export function zonedParts(instant, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(toDate(instant))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

/** Tenant-local calendar date, `YYYY-MM-DD`. */
export function localDate(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Tenant-local date and time, `YYYY-MM-DD HH:mm`. */
export function localDateTime(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** UTC offset in force at that instant, e.g. `+11:00` (Sydney in January) or `+10:00` (Sydney in July). */
export function utcOffset(instant, timeZone) {
  const date = toDate(instant);
  const p = zonedParts(date, timeZone);
  const wallClockAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const wholeSeconds = Math.floor(date.getTime() / 1000) * 1000;
  const minutes = Math.round((wallClockAsUtc - wholeSeconds) / 60_000);
  const abs = Math.abs(minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Returns a memoising `instant -> 'YYYY-MM-DD HH:mm'` function for hot loops (CSV export).
 * Bulk operations stamp many certificates with the same instant, so the cache hits often.
 */
export function createLocalDateTimeFormatter(timeZone, { maxEntries = 50_000 } = {}) {
  const cache = new Map();
  return (instant) => {
    let text = cache.get(instant);
    if (text === undefined) {
      text = localDateTime(instant, timeZone);
      if (cache.size >= maxEntries) cache.clear();
      cache.set(instant, text);
    }
    return text;
  };
}

/** Canonical storage format for instants: ISO-8601 UTC with milliseconds (sorts lexicographically). */
export function toUtcIso(instant) {
  return toDate(instant).toISOString();
}
