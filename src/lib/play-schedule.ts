import type { SessionStats } from "./session-stats";

export const HACK_NIGHT_TIME_ZONE = "America/Indiana/Indianapolis";
const HOUR_MS = 60 * 60 * 1000;
const PAUSE_MS = 45 * 60 * 1000;

export interface PlaySchedule {
  phase: "before_start" | "paused" | "playing";
  changesAt: number;
  serverNow: number;
}

const localClock = new Intl.DateTimeFormat("en-US", {
  timeZone: HACK_NIGHT_TIME_ZONE,
  year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
});

function localParts(time: number): Record<string, number> {
  return Object.fromEntries(localClock.formatToParts(time)
    .filter(part => part.type !== "literal")
    .map(part => [part.type, Number(part.value)]));
}

function scheduleStart(startedAt: number): number {
  const { year, month, day, hour } = localParts(startedAt);
  // A session opened after midnight, before 9 a.m., belongs to the previous night.
  const target = Date.UTC(year, month - 1, day - (hour < 9 ? 1 : 0), 21);
  let time = target;
  // Convert 9 p.m. in Purdue's time zone to an instant, including DST changes.
  for (let i = 0; i < 2; i++) {
    const local = localParts(time);
    time += target - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  }
  return time;
}

export function getPlaySchedule(
  session: Pick<SessionStats, "name" | "startedAt" | "expiresAt"> | null,
  now = Date.now(),
): PlaySchedule | null {
  if (!session || session.name.trim().replace(/\s+/g, " ").toLowerCase() !== "hack night" || now >= session.expiresAt) return null;
  const startsAt = scheduleStart(session.startedAt);
  if (now < startsAt) return { phase: "before_start", changesAt: startsAt, serverNow: now };
  const cycleStart = startsAt + Math.floor((now - startsAt) / HOUR_MS) * HOUR_MS;
  const paused = now < cycleStart + PAUSE_MS;
  return {
    phase: paused ? "paused" : "playing",
    changesAt: cycleStart + (paused ? PAUSE_MS : HOUR_MS),
    serverNow: now,
  };
}
