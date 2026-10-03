import { MAP_WIDTH } from './simulation';
export interface CameraView { x: number; y: number; zoom: number }
export interface CameraState { custom: CameraView | null; followPilotId: string | null }
export interface CameraShip { pilotId: string; name: string; color: number[] }
export type CameraCommand =
  | { action: 'pan'; dx: number; dy: number }
  | { action: 'zoom'; factor: number }
  | { action: 'follow'; pilotId: string }
  | { action: 'unfollow' | 'reset' };
export function updateCamera(state: CameraState, command: CameraCommand, pilots: string[]): CameraState {
  if (command.action === 'reset') return { custom: null, followPilotId: null };
  if (command.action === 'unfollow') return { ...state, followPilotId: null };
  if (command.action === 'follow') return pilots.includes(command.pilotId) ? { ...state, followPilotId: command.pilotId } : state;
  const view = state.custom ?? { x: MAP_WIDTH / 2, y: 600, zoom: 1 };
  if (command.action === 'pan' && Number.isFinite(command.dx) && Number.isFinite(command.dy)) {
    return { followPilotId: null, custom: {
      ...view,
      x: ((view.x + Math.max(-1, Math.min(1, command.dx)) * 240 / view.zoom) % MAP_WIDTH + MAP_WIDTH) % MAP_WIDTH,
      y: Math.max(-2000, Math.min(5000, view.y + Math.max(-1, Math.min(1, command.dy)) * 240 / view.zoom)),
    } };
  }
  if (command.action === 'zoom' && Number.isFinite(command.factor) && command.factor > 0) {
    return { followPilotId: null, custom: { ...view, zoom: Math.max(0.5, Math.min(12, view.zoom * Math.max(0.5, Math.min(2, command.factor)))) } };
  }
  return state;
}
