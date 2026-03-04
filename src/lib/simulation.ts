// ─── Shared simulation module (no browser APIs) ─────────────
// Used by both client (rendering) and server (authoritative physics)

// ─── Types ────────────────────────────────────────────────────

export type RGB = [number, number, number];

export interface Lander {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  vr: number;
  t: number;
  a: number; // 0=flying, 1=landed, 2=crashed
  fuel: number;
  color: RGB;
}

export type MapLine = [number, number, number, number];

export interface PlayerInput {
  thrust: 0 | 1;
  rotation: -1 | 0 | 1;
  seq: number;
}

// ─── Constants ────────────────────────────────────────────────

export const MAP_WIDTH = 4000;
export const MAP_HEIGHT = 400;
export const THRUST_POWER = 10;
export const GRAVITY = 3;
export const S = 2; // ship scale factor
export const STARTING_FUEL = 5000;
export const FUEL_IDLE_RATE = 0.25; // per tick (20/sec)
export const FUEL_THRUST_RATE = 5; // per tick, additional when thrusting (100/sec)

// ─── Seeded PRNG (mulberry32) ─────────────────────────────────

export function createRng(seed: number) {
  let state = seed | 0;
  return {
    next(): number {
      let t = (state += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    random(min: number, max: number): number {
      return min + this.next() * (max - min);
    },
    randomInt(min: number, max: number): number {
      return Math.floor(this.random(min, max));
    },
  };
}

// ─── Terrain Generation ───────────────────────────────────────

// Pad width in indices — ship is ~32px, pads are ~64px (2x ship width)
const PAD_WIDTH_IDX = 16; // ~64px at current step size, 2x ship width
const MAX_HEIGHT = 750;

// Shared helper: convert a heightmap + pad definitions into MapLine[]
// Merges short terrain segments; emits each pad as a single flat line
function heightmapToMapLines(
  heights: number[],
  stepSize: number,
  pads: { startIdx: number; width: number }[],
): MapLine[] {
  const effective = heights.slice();

  // Mark pad indices and flatten
  const isPad = new Uint8Array(heights.length);
  for (const pad of pads) {
    const padHeight = effective[pad.startIdx];
    for (
      let i = pad.startIdx;
      i < pad.startIdx + pad.width && i < effective.length;
      i++
    ) {
      effective[i] = padHeight;
      isPad[i] = 1;
    }
  }

  const minSegX = PAD_WIDTH_IDX * stepSize * 0.5;
  const lines: MapLine[] = [];
  let i = 0;

  while (i < effective.length - 1) {
    // If this is the start of a pad, emit one flat segment for the whole pad
    if (isPad[i]) {
      let end = i + 1;
      while (end < effective.length && isPad[end]) end++;
      // Flat pad line
      lines.push([
        i * stepSize,
        -effective[i],
        (end - 1) * stepSize,
        -effective[i],
      ]);
      // Connecting segment from pad end to next terrain point
      if (end < effective.length) {
        lines.push([
          (end - 1) * stepSize,
          -effective[end - 1],
          end * stepSize,
          -effective[end],
        ]);
      }
      i = end;
      continue;
    }

    // Terrain: merge short segments
    let j = i + 1;
    while (
      j < effective.length - 1 &&
      !isPad[j] &&
      (j - i) * stepSize < minSegX
    ) {
      j++;
    }
    lines.push([i * stepSize, -effective[i], j * stepSize, -effective[j]]);
    i = j;
  }

  return lines;
}

// Get terrain height at a given x position (returns positive height value)
export function getTerrainHeightAt(x: number, mapLines: MapLine[]): number {
  // Wrap x into [0, MAP_WIDTH)
  let wx = x % MAP_WIDTH;
  if (wx < 0) wx += MAP_WIDTH;

  for (const line of mapLines) {
    const x1 = line[0];
    const x2 = line[2];
    if (wx >= x1 && wx <= x2 && x2 > x1) {
      const t = (wx - x1) / (x2 - x1);
      // y values are negative, return positive height
      return -(line[1] + (line[3] - line[1]) * t);
    }
  }
  return 0;
}

// Helper: find pad placements spread across the map, avoiding overlap
function placePads(
  numPads: number,
  numPoints: number,
  padWidth: number,
  rng: ReturnType<typeof createRng>,
): { startIdx: number; width: number }[] {
  const pads: { startIdx: number; width: number }[] = [];
  const spacing = Math.floor(numPoints / (numPads + 1));
  for (let i = 0; i < numPads; i++) {
    const idx = spacing * (i + 1) + rng.randomInt(-3, 4);
    const startIdx = Math.max(0, Math.min(numPoints - padWidth - 1, idx));
    const overlaps = pads.some(
      (p) =>
        startIdx < p.startIdx + p.width + 2 &&
        startIdx + padWidth + 2 > p.startIdx,
    );
    if (!overlaps) {
      pads.push({ startIdx, width: padWidth });
    }
  }
  return pads;
}

// Random Walk terrain: coarse anchors for broad mountains, then subdivided slopes
export function generateTerrain(seed: number): MapLine[] {
  const rng = createRng(seed);

  // Phase 1: Generate coarse anchor points for the major mountain shapes
  const numAnchors = 100;
  const maxSlope = 120;
  const baseline = 300;

  const anchors = new Array(numAnchors + 1).fill(0);
  anchors[0] = rng.random(100, 500);

  for (let i = 1; i <= numAnchors; i++) {
    const bias = (baseline - anchors[i - 1]) * 0.05;
    let delta = (rng.next() - 0.5) * maxSlope * 2 + bias;
    if (rng.next() < 0.15) {
      delta *= 2;
    }
    delta = Math.max(-maxSlope * 2, Math.min(maxSlope * 2, delta));
    anchors[i] = Math.max(5, Math.min(MAX_HEIGHT, anchors[i - 1] + delta));

    // Wrap back toward start near the end
    if (i > numAnchors * 0.85) {
      const t = (i - numAnchors * 0.85) / (numAnchors * 0.15);
      anchors[i] = anchors[i] * (1 - t) + anchors[0] * t;
    }
  }

  // Phase 2: Subdivide each anchor segment into sub-segments with small perturbations
  const subsPerAnchor = 8;
  const numPoints = numAnchors * subsPerAnchor;
  const stepSize = MAP_WIDTH / numPoints;
  const heights = new Array(numPoints + 1).fill(0);

  for (let a = 0; a < numAnchors; a++) {
    const h0 = anchors[a];
    const h1 = anchors[a + 1];
    for (let s = 0; s < subsPerAnchor; s++) {
      const idx = a * subsPerAnchor + s;
      const t = s / subsPerAnchor;
      const base = h0 + (h1 - h0) * t;
      // Small perturbation proportional to the slope steepness
      const slopeScale = Math.abs(h1 - h0) * 0.08;
      const jitter = (rng.next() - 0.5) * Math.max(slopeScale, 8);
      heights[idx] = Math.max(5, Math.min(MAX_HEIGHT, base + jitter));
    }
  }
  heights[numPoints] = anchors[numAnchors];

  // Place landing pads
  const numPads = rng.randomInt(10, 16);
  const pads = placePads(numPads, numPoints, PAD_WIDTH_IDX, rng);

  return heightmapToMapLines(heights, stepSize, pads);
}

// ─── Default Lander ───────────────────────────────────────────

export function createDefaultLander(color: RGB = [255, 255, 255]): Lander {
  return {
    x: -15,
    y: 1000,
    r: -Math.PI / 2,
    vx: 80,
    vy: 0,
    vr: 0,
    t: 0,
    a: 0,
    fuel: STARTING_FUEL,
    color,
  };
}

// ─── Physics ──────────────────────────────────────────────────

export function updateLanderPhysics(l: Lander, dt: number): void {
  if (l.a !== 0) {
    l.vx = 0;
    l.vy = 0;
    l.vr = 0;
    return;
  }

  // Fuel drain: idle + thrust
  l.fuel = Math.max(0, l.fuel - FUEL_IDLE_RATE);
  if (l.t > 0 && l.fuel > 0) {
    l.fuel = Math.max(0, l.fuel - FUEL_THRUST_RATE);
  }
  // Disable thrust when out of fuel
  if (l.fuel <= 0) {
    l.t = 0;
  }

  l.x += l.vx * dt;
  l.y += l.vy * dt;
  l.r += l.vr * dt;
  l.vx += Math.sin(l.r) * l.t * THRUST_POWER * dt;
  l.vy += Math.cos(l.r) * l.t * THRUST_POWER * dt - GRAVITY * dt;

  if (l.x > MAP_WIDTH) l.x -= MAP_WIDTH;
  if (l.x < 0) l.x += MAP_WIDTH;
}

// ─── Input Application ───────────────────────────────────────

export function applyInput(l: Lander, input: PlayerInput): void {
  if (l.a !== 0) return;
  l.t = input.thrust;
  l.vr = input.rotation;
}

// ─── Collision Detection ──────────────────────────────────────

function lineIntersects(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  x4: number,
  y4: number,
): boolean {
  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  const uA = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const uB = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;
  return uA >= 0 && uA <= 1 && uB >= 0 && uB <= 1;
}

export function checkCollision(l: Lander, mapLines: MapLine[]): boolean {
  const cr = Math.cos(l.r);
  const sr = Math.sin(l.r);
  const hs = 8 * S;
  const h = 16 * S;

  const ax = l.x - hs * cr;
  const ay = -l.y - hs * sr;
  const bx = l.x + hs * cr;
  const by = -l.y + hs * sr;

  const upX = h * sr;
  const upY = -h * cr;

  const dx = ax + upX;
  const dy = ay + upY;
  const cx = bx + upX;
  const cy = by + upY;

  // Ship hitbox segments
  const segments: [number, number, number, number][] = [
    [ax, ay, bx, by],
    [ax, ay, dx, dy],
    [dx, dy, cx, cy],
    [bx, by, cx, cy],
  ];

  for (let offset = -1; offset <= 1; offset++) {
    const ox = offset * MAP_WIDTH;
    for (const line of mapLines) {
      const lx1 = line[0] + ox;
      const ly1 = line[1];
      const lx2 = line[2] + ox;
      const ly2 = line[3];
      for (const seg of segments) {
        if (
          lineIntersects(lx1, ly1, lx2, ly2, seg[0], seg[1], seg[2], seg[3])
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

// ─── Landing / Crash Outcome ──────────────────────────────────

export function determineLandingOutcome(l: Lander): 1 | 2 {
  if (Math.abs(l.vx) < 1.5 && l.vy > -5 && l.vy <= 0) return 1;
  return 2;
}

// ─── Out of Bounds ────────────────────────────────────────────

export function isOutOfBounds(l: Lander): boolean {
  return l.y > 2000 || l.y < -5;
}

// ─── Scoring ──────────────────────────────────────────────────

export function calculateLandingScore(l: Lander): number {
  if (Math.abs(l.vx) < 0.5 && l.vy > -2 && l.vy <= 0) return 50; // good landing
  if (Math.abs(l.vx) < 1.5 && l.vy > -5 && l.vy <= 0) return 15; // hard landing
  return 5; // crash
}
