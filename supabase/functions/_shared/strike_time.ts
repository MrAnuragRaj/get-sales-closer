import { DateTime } from "npm:luxon@3.4.4";

export function computeStrikeTime(
  nowUtcISO: string,
  leadTimezone: string = "America/New_York" // Default safety
): string {
  // 1. Parse time in Lead's Zone
  let nowLocal = DateTime.fromISO(nowUtcISO).setZone(leadTimezone);
  
  // 2. Extract constraints
  const hour = nowLocal.hour;
  const weekday = nowLocal.weekday; // 1=Mon ... 7=Sun
  
  // 3. Define Window (8:00 to 19:59 is allowed)
  const isSunday = weekday === 7;
  const isTooEarly = hour < 8;
  const isTooLate = hour >= 20;
  const isAllowed = !isSunday && !isTooEarly && !isTooLate;

  // ✅ IMMEDIATE STRIKE
  if (isAllowed) {
    return nowUtcISO; // Return original UTC string
  }

  // 🚫 DEFERRED STRIKE (Calculate next 8:01 AM)
  let next = nowLocal;

  if (isSunday) {
    // If Sunday -> Jump to Monday
    next = next.plus({ days: 1 });
  } else if (isTooLate) {
    // If Late -> Jump to Tomorrow
    next = next.plus({ days: 1 });
  }
  // (If TooEarly, we stay on same day, just move hour forward)

  // Hard set to 8:01 AM
  next = next.set({
    hour: 8,
    minute: 1,
    second: 0,
    millisecond: 0
  });

  return next.toUTC().toISO();
}