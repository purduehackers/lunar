import { defaultDisplayOptions, type DisplayOptions } from "./display-options";
export interface PilotStats {
  id: string;
  name: string;
  landed: number;
  crashed: number;
  streak: number;
  bestStreak: number;
  fastestMs: number | null;
  playedMs: number;
  activeSince: number;
  connections: number;
}
export const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

export interface SessionStats {
  options: DisplayOptions;
  id: string;
  name: string;
  expiresAt: number;
  startedAt: number;
  updatedAt: number;
  joined: number;
  landed: number;
  crashed: number;
  pilots: PilotStats[];
}
export class SessionTracker {
  state: SessionStats;
  static create(id: string, name: string, now = Date.now()): SessionTracker {
    return new SessionTracker({ options: defaultDisplayOptions(), id, name, expiresAt: now + SESSION_DURATION_MS, startedAt: now, updatedAt: now, joined: 0, landed: 0, crashed: 0, pilots: [] });
  }
  constructor(saved: SessionStats) {
    this.state = saved;
    this.state.options ??= defaultDisplayOptions();
    // Active connections cannot survive a server restart.
    for (const pilot of this.state.pilots) {
      if (pilot.connections) pilot.playedMs += Math.max(0, this.state.updatedAt - pilot.activeSince);
      pilot.connections = 0;
      pilot.activeSince = 0;
    }
  }
  join(id: string, name: string, now = Date.now()): void {
    let pilot = this.state.pilots.find(p => p.id === id);
    if (!pilot) {
      pilot = { id, name, landed: 0, crashed: 0, streak: 0, bestStreak: 0, fastestMs: null, playedMs: 0, activeSince: 0, connections: 0 };
      this.state.pilots.push(pilot);
      this.state.joined++;
    }
    pilot.name = name;
    if (!pilot.connections) pilot.activeSince = now;
    pilot.connections++;
  }
  leave(id: string, now = Date.now()): void {
    const pilot = this.state.pilots.find(p => p.id === id);
    if (!pilot || !pilot.connections) return;
    if (--pilot.connections === 0) {
      pilot.playedMs += Math.max(0, now - pilot.activeSince);
      pilot.activeSince = 0;
    }
  }
  outcome(id: string, landed: boolean, elapsedMs: number): void {
    const pilot = this.state.pilots.find(p => p.id === id);
    if (!pilot) return;
    if (landed) {
      this.state.landed++;
      pilot.landed++;
      pilot.streak++;
      pilot.bestStreak = Math.max(pilot.bestStreak, pilot.streak);
      pilot.fastestMs = Math.min(pilot.fastestMs ?? Infinity, Math.max(0, elapsedMs));
    } else {
      this.state.crashed++;
      pilot.crashed++;
      pilot.streak = 0;
    }
  }
  snapshot(now = Date.now()): SessionStats {
    this.state.updatedAt = now;
    return structuredClone(this.state);
  }
}
