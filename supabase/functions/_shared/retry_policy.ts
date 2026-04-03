export function getRetrySchedule(channel: string): number[] {
    // Intervals in seconds
    switch (channel) {
      case "sms":
        // Aggressive: Instant -> 5 mins -> 30 mins
        return [0, 5 * 60, 30 * 60];

      case "voice":
        // Persistent: Instant -> 1 hour
        return [0, 60 * 60];

      case "email":
        // Nurture: Day 0 -> Day 1 -> Day 4
        return [0, 24 * 3600, 4 * 24 * 3600];

      default:
        return [0]; // Single attempt
    }
  }

/**
 * Compressed retry schedule for high-priority leads.
 *
 * IMPORTANT — TCPA COMPLIANCE NOTE:
 * These offsets are applied on top of the base strike time produced by
 * computeStrikeTime(), which enforces the Mon–Sat 08:00–19:59 local-time
 * contact window.  Compressing retry offsets does NOT bypass that window —
 * the strike time gate is applied at task-creation time (execution_planner),
 * not at delivery time.  A compressed retry scheduled inside a blocked window
 * will simply sit pending until the next allowed window opens, which is the
 * same behaviour as standard retries.
 *
 * Priority advantage: (a) faster retries during business hours,
 * (b) high-priority tasks dispatched first in fetch_due_tasks.
 */
export function getRetryScheduleHighPriority(channel: string): number[] {
  switch (channel) {
    case "sms":
      // Instant -> 2 mins -> 15 mins  (vs standard 5 / 30)
      return [0, 2 * 60, 15 * 60];

    case "voice":
      // Instant -> 30 mins  (vs standard 60 mins)
      return [0, 30 * 60];

    case "email":
      // Day 0 -> 12 hours -> Day 3  (vs standard Day 1 / Day 4)
      return [0, 12 * 3600, 3 * 24 * 3600];

    default:
      return [0];
  }
}