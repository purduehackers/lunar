import type { PilotStats } from './session-stats';
export const LEADERBOARD_METRICS = {
  landed: 'NUMBER OF LANDS', crashed: 'NUMBER OF CRASHES', playedMs: 'TIME PLAYED', bestStreak: 'LONGEST LAND STREAK', streak: 'CURRENT LAND STREAK', fastestMs: 'FASTEST LANDING',
} as const;
export type LeaderboardMetric = keyof typeof LEADERBOARD_METRICS;
export interface DisplayOptions { leaderboardStat: LeaderboardMetric; showLeaderboard: boolean; showQr: boolean; qrTitle: string }
export function defaultDisplayOptions(): DisplayOptions {
  return { leaderboardStat: 'landed', showLeaderboard: true, showQr: true, qrTitle: 'SCAN TO PLAY' };
}
export function validateDisplayOptions(current: DisplayOptions, patch: Partial<DisplayOptions>): DisplayOptions {
  const next = { ...current };
  if (typeof patch.leaderboardStat === 'string' && Object.hasOwn(LEADERBOARD_METRICS, patch.leaderboardStat)) next.leaderboardStat = patch.leaderboardStat;
  if (typeof patch.showLeaderboard === 'boolean') next.showLeaderboard = patch.showLeaderboard;
  if (typeof patch.showQr === 'boolean') next.showQr = patch.showQr;
  if (typeof patch.qrTitle === 'string') next.qrTitle = Array.from(patch.qrTitle.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()).slice(0, 48).join('') || 'SCAN TO PLAY';
  return next;
}
export function leaderboardValue(pilot: PilotStats, metric: LeaderboardMetric, now: number): number {
  if (metric === 'playedMs') return pilot.playedMs + (pilot.connections ? Math.max(0, now - pilot.activeSince) : 0);
  return pilot[metric] ?? Infinity;
}
export function rankPilots(pilots: PilotStats[], metric: LeaderboardMetric, now: number): PilotStats[] {
  return pilots.filter(p => metric !== 'fastestMs' || p.fastestMs !== null).slice().sort((a, b) => {
    const difference = leaderboardValue(a, metric, now) - leaderboardValue(b, metric, now);
    return (metric === 'fastestMs' ? difference : -difference) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}
export function formatLeaderboardValue(value: number, metric: LeaderboardMetric): string {
  if (metric === 'fastestMs') return `${(value / 1000).toFixed(2)}s`;
  if (metric === 'playedMs') { const seconds = Math.floor(value / 1000); return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`; }
  return String(value);
}
