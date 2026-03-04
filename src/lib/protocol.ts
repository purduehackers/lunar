// ─── Binary Protocol ─────────────────────────────────────────
// Shared encode/decode for world updates and crash events.
// Imported by both server and client.

export const MSG_WORLD = 0x01;
export const MSG_CRASH = 0x02;
export const PLAYER_BYTE_SIZE = 30;

// Per-player binary layout (30 bytes):
//   uint8  slot         (1)
//   uint8  flags        (1)  — bit 0: thrust, bits 1-2: state (a)
//   float32 x,y,r,vx,vy,vr (24)
//   uint16 fuel         (2)
//   uint16 score        (2)

export interface BinaryPlayerEntry {
  slot: number;
  flags: number;
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  vr: number;
  fuel: number;
  score: number;
}

// ─── Flags helpers ───────────────────────────────────────────

export function packFlags(thrust: number, a: number): number {
  return (thrust & 1) | ((a & 3) << 1);
}

export function unpackThrust(flags: number): number {
  return flags & 1;
}

export function unpackState(flags: number): number {
  return (flags >> 1) & 3;
}

// ─── World Update ────────────────────────────────────────────

export function encodeWorldUpdate(players: BinaryPlayerEntry[]): ArrayBuffer {
  const count = Math.min(players.length, 255);
  const buf = new ArrayBuffer(2 + PLAYER_BYTE_SIZE * count);
  const view = new DataView(buf);
  view.setUint8(0, MSG_WORLD);
  view.setUint8(1, count);

  let offset = 2;
  for (let i = 0; i < count; i++) {
    const p = players[i];
    view.setUint8(offset, p.slot);
    view.setUint8(offset + 1, p.flags);
    view.setFloat32(offset + 2, p.x);
    view.setFloat32(offset + 6, p.y);
    view.setFloat32(offset + 10, p.r);
    view.setFloat32(offset + 14, p.vx);
    view.setFloat32(offset + 18, p.vy);
    view.setFloat32(offset + 22, p.vr);
    view.setUint16(offset + 26, Math.min(p.fuel, 0xffff));
    view.setUint16(offset + 28, Math.min(p.score, 0xffff));
    offset += PLAYER_BYTE_SIZE;
  }

  return buf;
}

export function decodeWorldUpdate(buf: ArrayBuffer): BinaryPlayerEntry[] {
  if (buf.byteLength < 2) return [];
  const view = new DataView(buf);
  const count = view.getUint8(1);
  if (buf.byteLength < 2 + count * PLAYER_BYTE_SIZE) return [];
  const players: BinaryPlayerEntry[] = [];

  let offset = 2;
  for (let i = 0; i < count; i++) {
    players.push({
      slot: view.getUint8(offset),
      flags: view.getUint8(offset + 1),
      x: view.getFloat32(offset + 2),
      y: view.getFloat32(offset + 6),
      r: view.getFloat32(offset + 10),
      vx: view.getFloat32(offset + 14),
      vy: view.getFloat32(offset + 18),
      vr: view.getFloat32(offset + 22),
      fuel: view.getUint16(offset + 26),
      score: view.getUint16(offset + 28),
    });
    offset += PLAYER_BYTE_SIZE;
  }

  return players;
}

// ─── Crash Event ─────────────────────────────────────────────
// 12 bytes: type(1) + x(4) + y(4) + r(1) + g(1) + b(1)

export function encodeCrash(x: number, y: number, color: [number, number, number]): ArrayBuffer {
  const buf = new ArrayBuffer(12);
  const view = new DataView(buf);
  view.setUint8(0, MSG_CRASH);
  view.setFloat32(1, x);
  view.setFloat32(5, y);
  view.setUint8(9, color[0]);
  view.setUint8(10, color[1]);
  view.setUint8(11, color[2]);
  return buf;
}

export function decodeCrash(buf: ArrayBuffer): { x: number; y: number; color: [number, number, number] } | null {
  if (buf.byteLength < 12) return null;
  const view = new DataView(buf);
  return {
    x: view.getFloat32(1),
    y: view.getFloat32(5),
    color: [view.getUint8(9), view.getUint8(10), view.getUint8(11)],
  };
}

// ─── Delta Detection ─────────────────────────────────────────

export interface PlayerSnapshot {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  vr: number;
  t: number;
  a: number;
  fuel: number;
  score: number;
}

export function hasStateChanged(prev: PlayerSnapshot, curr: PlayerSnapshot): boolean {
  return (
    prev.x !== curr.x ||
    prev.y !== curr.y ||
    prev.r !== curr.r ||
    prev.vx !== curr.vx ||
    prev.vy !== curr.vy ||
    prev.vr !== curr.vr ||
    prev.t !== curr.t ||
    prev.a !== curr.a ||
    prev.fuel !== curr.fuel ||
    prev.score !== curr.score
  );
}
