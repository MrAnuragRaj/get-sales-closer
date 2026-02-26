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