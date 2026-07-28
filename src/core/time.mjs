export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function timestampMillis(value) {
  const millis = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : typeof value === "string" && value.length > 0
        ? Date.parse(value)
        : NaN;
  if (!Number.isFinite(millis)) {
    throw new TypeError(`Invalid timestamp: ${value}`);
  }
  return millis;
}

export function toUtcIso(value) {
  return new Date(timestampMillis(value)).toISOString();
}

export function floorHour(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid timestamp: ${value}`);
  date.setUTCMinutes(0, 0, 0);
  return date;
}

export function ceilHour(value) {
  const floored = floorHour(value);
  return floored.getTime() === new Date(value).getTime()
    ? floored
    : new Date(floored.getTime() + HOUR_MS);
}

export function addHours(value, hours) {
  return new Date(new Date(value).getTime() + hours * HOUR_MS);
}

export function addDays(value, days) {
  return new Date(new Date(value).getTime() + days * DAY_MS);
}

export function differenceInHours(later, earlier) {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / HOUR_MS;
}

export function utcHourRange(start, count) {
  const first = floorHour(start);
  return Array.from({ length: count }, (_, index) => {
    const slotStart = addHours(first, index);
    return {
      start: toUtcIso(slotStart),
      end: toUtcIso(addHours(slotStart, 1)),
    };
  });
}

export function halfOpenRange(start, end, precision = "hour", originalText = null) {
  const startIso = toUtcIso(start);
  const endIso = toUtcIso(end);
  if (Date.parse(startIso) >= Date.parse(endIso)) {
    throw new RangeError("Half-open range start must precede end");
  }
  return {
    start: startIso,
    end: endIso,
    boundary: "[start,end)",
    precision,
    timezone_basis: "UTC",
    original_text: originalText,
  };
}

export function hourOfWeek(value) {
  const date = new Date(value);
  const mondayBasedDay = (date.getUTCDay() + 6) % 7;
  return mondayBasedDay * 24 + date.getUTCHours();
}

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
