import type { Lander } from "./simulation";
import type { FlightResult } from "./flight";

export type ReportedLander = Omit<Lander, "color">;
export interface FlightUpdate {
  type: "state";
  roundId: number;
  authority: string;
  epoch: number;
  seq: number;
  lander: ReportedLander;
  elapsedMs: number;
  result: FlightResult | null;
}

// Structural and finite-number checks only. The browser decides what happened;
// the server deliberately does not validate trajectories or repeat collisions.
export function isFlightUpdate(value: unknown): value is FlightUpdate {
  if (!value || typeof value !== "object") return false;
  const v = value as FlightUpdate;
  if (v.type !== "state" || typeof v.authority !== "string" || v.authority.length > 64) return false;
  if (![v.roundId, v.epoch, v.seq].every(n => Number.isSafeInteger(n) && n >= 0)) return false;
  if (!Number.isFinite(v.elapsedMs) || v.elapsedMs < 0 || v.elapsedMs > 86400000) return false;
  const l = v.lander;
  if (!l || typeof l !== "object") return false;
  if (![l.x, l.y, l.r, l.vx, l.vy, l.vr, l.fuel].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e7)) return false;
  if (l.fuel < 0 || (l.t !== 0 && l.t !== 1) || ![0, 1, 2].includes(l.a)) return false;
  if (l.a === 0) return v.result === null;
  return !!v.result && typeof v.result === "object" && (l.a === 1
    ? v.result.points === 15 || v.result.points === 50
    : v.result.points === 5);
}

export function reportedLander(l: Lander): ReportedLander {
  const { x, y, r, vx, vy, vr, t, a, fuel } = l;
  return { x, y, r, vx, vy, vr, t, a, fuel };
}
