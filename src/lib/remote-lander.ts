import { MAP_WIDTH, type Lander } from "./simulation";

// Each remote ship has its own receive clock. Another pilot's updates must not
// keep a silent ship moving. Prediction stops after 150 ms without a snapshot.
export class RemoteLander {
  rendered: Lander;
  constructor(public snapshot: Lander, public receivedAt: number) {
    this.rendered = { ...snapshot };
  }

  receive(snapshot: Lander, now: number): void {
    this.snapshot = snapshot;
    this.receivedAt = now;
    if (snapshot.a !== 0) this.rendered = { ...snapshot };
  }

  sample(now: number, dtMs: number, paused = false): Lander {
    const snap = this.snapshot;
    if (paused || snap.a !== 0) return this.rendered;
    const dt = Math.max(0, Math.min(0.15, (now - this.receivedAt) / 1000));
    const x = ((snap.x + snap.vx * dt) % MAP_WIDTH + MAP_WIDTH) % MAP_WIDTH;
    const dx = ((x - this.rendered.x + MAP_WIDTH * 1.5) % MAP_WIDTH) - MAP_WIDTH / 2;
    const blend = 1 - Math.exp(-Math.max(0, dtMs) / 50);
    this.rendered = {
      ...snap,
      x: ((this.rendered.x + dx * blend) % MAP_WIDTH + MAP_WIDTH) % MAP_WIDTH,
      y: this.rendered.y + (snap.y + snap.vy * dt - this.rendered.y) * blend,
      r: this.rendered.r + (snap.r + snap.vr * dt - this.rendered.r) * blend,
    };
    return this.rendered;
  }
}
