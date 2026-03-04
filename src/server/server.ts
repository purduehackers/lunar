import { Server, type Connection } from "partyserver";
import {
  type RGB,
  type Lander,
  type MapLine,
  type PlayerInput,
  generateTerrain,
  createDefaultLander,
  updateLanderPhysics,
  applyInput,
  checkCollision,
  determineLandingOutcome,
  isOutOfBounds,
  calculateLandingScore,
} from "../lib/simulation";
import {
  type BinaryPlayerEntry,
  type PlayerSnapshot,
  encodeWorldUpdate,
  encodeCrash,
  packFlags,
  hasStateChanged,
} from "../lib/protocol";

const COLORS: RGB[] = [
  [0, 255, 100],
  [255, 80, 80],
  [80, 130, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [255, 165, 0],
  [255, 120, 200],
  [150, 255, 150],
  [200, 150, 255],
];

const TICK_MS = 50; // 20 Hz
const MAX_PLAYERS = 255; // uint8 slot limit in binary protocol

function randomSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

type ClientMessage = {
  type: "input";
  thrust: 0 | 1;
  rotation: -1 | 0 | 1;
  seq: number;
};

interface PlayerState {
  lander: Lander;
  lastInput: PlayerInput;
  color: RGB;
  score: number;
  slot: number;
}

export class GameServer extends Server<Env> {
  seed = randomSeed();
  stage = 1; // 0=playing, 1=waiting
  colorIndex = 0;
  nextSlot = 0;
  freeSlots: number[] = [];
  players = new Map<string, PlayerState>();
  prevSent = new Map<string, PlayerSnapshot>();
  mapLines: MapLine[] = [];
  tickRunning = false;

  // Timers tracked as absolute timestamps (checked each tick)
  endgameDeadline = 0; // 0 = not active
  intermissionDeadline = 0; // 0 = not active

  allocSlot(): number {
    if (this.freeSlots.length > 0) return this.freeSlots.pop()!;
    if (this.nextSlot >= MAX_PLAYERS) return -1;
    return this.nextSlot++;
  }

  // ── Alarm-based tick loop ────────────────────────────────────

  scheduleNextAlarm(): void {
    this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  startTickLoop(): void {
    if (this.tickRunning) return;
    this.tickRunning = true;
    this.scheduleNextAlarm();
  }

  stopTickLoop(): void {
    this.tickRunning = false;
  }

  async onAlarm(): Promise<void> {
    // Handle intermission → new round transition (can happen while tick is stopped)
    if (
      this.intermissionDeadline > 0 &&
      Date.now() >= this.intermissionDeadline
    ) {
      this.intermissionDeadline = 0;
      this.beginNewRound();
      return;
    }

    if (!this.tickRunning) {
      // If we're in intermission, keep alarm going to check deadline
      if (this.intermissionDeadline > 0) {
        this.scheduleNextAlarm();
      }
      return;
    }

    // Handle endgame countdown
    if (this.endgameDeadline > 0 && Date.now() >= this.endgameDeadline) {
      this.endgameDeadline = 0;
      this.enterIntermission();
      return;
    }

    this.tick();
    this.scheduleNextAlarm();
  }

  tick(): void {
    if (this.stage !== 0 || this.players.size === 0) return;

    const dt = TICK_MS / 1000;

    for (const [, ps] of this.players) {
      if (ps.lander.a !== 0) continue;

      applyInput(ps.lander, ps.lastInput);
      updateLanderPhysics(ps.lander, dt);

      if (checkCollision(ps.lander, this.mapLines)) {
        const outcome = determineLandingOutcome(ps.lander);
        ps.lander.a = outcome;
        const points = calculateLandingScore(ps.lander);
        ps.score += points;
        if (outcome === 1 && points === 50) {
          // Good landing bonus: +50 fuel
          ps.lander.fuel += 50;
        }
        if (outcome === 2) {
          this.broadcast(encodeCrash(ps.lander.x, ps.lander.y, ps.color));
        }
      } else if (isOutOfBounds(ps.lander)) {
        ps.lander.a = 2;
        ps.score += 5; // crash score
        this.broadcast(encodeCrash(ps.lander.x, ps.lander.y, ps.color));
      }
    }

    // Broadcast world snapshot (binary, delta-compressed)
    const entries: BinaryPlayerEntry[] = [];
    for (const [id, ps] of this.players) {
      const curr: PlayerSnapshot = {
        x: ps.lander.x,
        y: ps.lander.y,
        r: ps.lander.r,
        vx: ps.lander.vx,
        vy: ps.lander.vy,
        vr: ps.lander.vr,
        t: ps.lander.t,
        a: ps.lander.a,
        fuel: Math.floor(ps.lander.fuel),
        score: ps.score,
      };

      const prev = this.prevSent.get(id);
      if (prev && !hasStateChanged(prev, curr)) continue;

      this.prevSent.set(id, curr);
      entries.push({
        slot: ps.slot,
        flags: packFlags(ps.lander.t, ps.lander.a),
        x: ps.lander.x,
        y: ps.lander.y,
        r: ps.lander.r,
        vx: ps.lander.vx,
        vy: ps.lander.vy,
        vr: ps.lander.vr,
        fuel: Math.floor(ps.lander.fuel),
        score: ps.score,
      });
    }

    if (entries.length > 0) {
      this.broadcast(encodeWorldUpdate(entries));
    }
    this.checkEndgame();
  }

  // ── Connection Lifecycle ─────────────────────────────────────

  onConnect(connection: Connection): void {
    const color = COLORS[this.colorIndex % COLORS.length];
    this.colorIndex++;
    const slot = this.allocSlot();

    if (slot === -1) {
      connection.close(4000, "Server full");
      return;
    }

    // Transition from waiting → playing before building init payload
    const wasWaiting = this.stage === 1;
    if (wasWaiting) {
      this.seed = randomSeed();
      this.stage = 0;
      this.mapLines = generateTerrain(this.seed);
      this.endgameDeadline = 0;
      this.intermissionDeadline = 0;
      this.prevSent.clear();
      // Reset existing players for the new round (preserve connections)
      for (const [, ps] of this.players) {
        ps.lander = createDefaultLander(ps.color);
        ps.lastInput = { thrust: 0, rotation: 0, seq: 0 };
      }
    }

    // Register the new player before building the init payload
    this.players.set(connection.id, {
      lander: createDefaultLander(color),
      lastInput: { thrust: 0, rotation: 0, seq: 0 },
      color,
      score: 0,
      slot,
    });

    // Build current player states for init (exclude self)
    const playersInit: Record<
      string,
      {
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
        color: RGB;
        slot: number;
      }
    > = {};
    for (const [id, ps] of this.players) {
      if (id === connection.id) continue;
      playersInit[id] = {
        x: ps.lander.x,
        y: ps.lander.y,
        r: ps.lander.r,
        vx: ps.lander.vx,
        vy: ps.lander.vy,
        vr: ps.lander.vr,
        t: ps.lander.t,
        a: ps.lander.a,
        fuel: ps.lander.fuel,
        score: ps.score,
        color: ps.color,
        slot: ps.slot,
      };
    }

    // Send init with correct seed/stage (after potential round transition)
    connection.send(
      JSON.stringify({
        type: "init",
        id: connection.id,
        color,
        slot,
        seed: this.seed,
        stage: this.stage,
        players: playersInit,
      }),
    );

    this.broadcast(
      JSON.stringify({ type: "player_join", id: connection.id, color, slot }),
      [connection.id],
    );

    if (wasWaiting) {
      // Notify existing players about the new round (new player already has correct data)
      this.broadcast(
        JSON.stringify({ type: "new_round", seed: this.seed }),
        [connection.id],
      );
    }

    this.startTickLoop();
  }

  onMessage(connection: Connection, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;

    let data: ClientMessage;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (data.type !== "input") return;

    const ps = this.players.get(connection.id);
    if (!ps) return;

    ps.lastInput = {
      thrust: data.thrust === 1 ? 1 : 0,
      rotation: data.rotation === -1 ? -1 : data.rotation === 1 ? 1 : 0,
      seq: typeof data.seq === "number" ? data.seq : 0,
    };
  }

  onClose(connection: Connection): void {
    const ps = this.players.get(connection.id);
    if (ps) this.freeSlots.push(ps.slot);
    this.players.delete(connection.id);
    this.prevSent.delete(connection.id);
    this.broadcast(JSON.stringify({ type: "player_leave", id: connection.id }));

    if (this.players.size === 0) {
      this.stopTickLoop();
      this.endgameDeadline = 0;
      this.intermissionDeadline = 0;
    } else {
      this.checkEndgame();
    }
  }

  // ── Endgame / Round Logic ────────────────────────────────────

  checkEndgame(): void {
    if (this.stage !== 0 || this.players.size === 0) return;

    const allDone = [...this.players.values()].every((ps) => ps.lander.a !== 0);

    if (allDone && this.endgameDeadline === 0) {
      this.endgameDeadline = Date.now() + 6000;
      this.broadcast(JSON.stringify({ type: "endgame_start" }));
    } else if (!allDone && this.endgameDeadline > 0) {
      this.endgameDeadline = 0;
      this.broadcast(JSON.stringify({ type: "endgame_cancel" }));
    }
  }

  enterIntermission(): void {
    this.stage = 1;
    this.stopTickLoop();
    this.broadcast(JSON.stringify({ type: "stage", stage: 1 }));

    // Schedule new round after 4s intermission
    this.intermissionDeadline = Date.now() + 4000;
    this.scheduleNextAlarm();
  }

  beginNewRound(): void {
    this.seed = randomSeed();
    this.stage = 0;
    this.mapLines = generateTerrain(this.seed);
    this.endgameDeadline = 0;
    this.prevSent.clear();

    // Reset all connected players (preserve score across rounds)
    for (const [, ps] of this.players) {
      ps.lander = createDefaultLander(ps.color);
      ps.lastInput = { thrust: 0, rotation: 0, seq: 0 };
    }

    this.broadcast(
      JSON.stringify({
        type: "new_round",
        seed: this.seed,
      }),
    );

    if (this.players.size > 0) {
      this.startTickLoop();
    }
  }
}
