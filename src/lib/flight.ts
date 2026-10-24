import {
  type Lander, type MapLine, type PlayerInput,
  applyInput, updateLanderPhysics, checkCollision, determineLandingOutcome,
  isOutOfBounds, calculateLandingScore, MAP_WIDTH,
} from "./simulation";

export const FLIGHT_TICK_MS = 50;
export const MAX_FRAME_GAP_MS = 1000;

export interface FlightResult {
  points: 5 | 15 | 50;
}

// Only the owning browser runs this clock. Network snapshots never advance it.
export class LocalFlight {
  remainderMs = 0;
  result: FlightResult | null = null;

  constructor(public lander: Lander, public elapsedMs = 0) {}

  freeze(): void {
    this.remainderMs = 0;
    this.lander.t = 0;
    this.lander.vr = 0;
  }

  advance(dtMs: number, input: PlayerInput, terrain: MapLine[]): FlightResult | null {
    if (this.lander.a !== 0 || dtMs < 0 || dtMs > MAX_FRAME_GAP_MS) return null;
    applyInput(this.lander, { ...input, thrust: this.lander.fuel > 0 ? input.thrust : 0 });
    this.remainderMs += dtMs;
    while (this.remainderMs + 1e-6 >= FLIGHT_TICK_MS) {
      this.remainderMs = Math.max(0, this.remainderMs - FLIGHT_TICK_MS);
      this.elapsedMs += FLIGHT_TICK_MS;
      updateLanderPhysics(this.lander, FLIGHT_TICK_MS / 1000);
      const collision = checkCollision(this.lander, terrain);
      if (!collision && !isOutOfBounds(this.lander)) continue;
      const points = collision ? calculateLandingScore(this.lander) : 5;
      this.lander.a = collision ? determineLandingOutcome(this.lander) : 2;
      if (points === 50) this.lander.fuel += 50;
      this.freeze();
      this.result = { points: points as FlightResult["points"] };
      return this.result;
    }
    return null;
  }

  // Smooth drawing between fixed physics steps without consuming extra fuel.
  render(): Lander {
    const dt = this.lander.a === 0 ? this.remainderMs / 1000 : 0;
    return {
      ...this.lander,
      x: ((this.lander.x + this.lander.vx * dt) % MAP_WIDTH + MAP_WIDTH) % MAP_WIDTH,
      y: this.lander.y + this.lander.vy * dt,
      r: this.lander.r + this.lander.vr * dt,
    };
  }
}
