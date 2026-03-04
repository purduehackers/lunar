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
}

export class GameServer extends Server<Env> {
  seed = randomSeed();
  stage = 1; // 0=playing, 1=waiting
  colorIndex = 0;
  players = new Map<string, PlayerState>();
  mapLines: MapLine[] = [];
  tickRunning = false;

  // Timers tracked as absolute timestamps (checked each tick)
  endgameDeadline = 0; // 0 = not active
  intermissionDeadline = 0; // 0 = not active

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
          this.broadcast(
            JSON.stringify({
              type: "crash",
              x: ps.lander.x,
              y: ps.lander.y,
              color: ps.color,
            }),
          );
        }
      } else if (isOutOfBounds(ps.lander)) {
        ps.lander.a = 2;
        ps.score += 5; // crash score
        this.broadcast(
          JSON.stringify({
            type: "crash",
            x: ps.lander.x,
            y: ps.lander.y,
            color: ps.color,
          }),
        );
      }
    }

    // Broadcast world snapshot
    const playersData: Record<
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
        lastInputSeq: number;
      }
    > = {};

    for (const [id, ps] of this.players) {
      playersData[id] = {
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
        lastInputSeq: ps.lastInput.seq,
      };
    }

    this.broadcast(JSON.stringify({ type: "world", players: playersData }));
    this.checkEndgame();
  }

  // ── Connection Lifecycle ─────────────────────────────────────

  onConnect(connection: Connection): void {
    const color = COLORS[this.colorIndex % COLORS.length];
    this.colorIndex++;

    // Build current player states for init
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
      }
    > = {};
    for (const [id, ps] of this.players) {
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
      };
    }

    connection.send(
      JSON.stringify({
        type: "init",
        id: connection.id,
        color,
        seed: this.seed,

        stage: this.stage,
        players: playersInit,
      }),
    );

    this.broadcast(
      JSON.stringify({ type: "player_join", id: connection.id, color }),
      [connection.id],
    );

    const wasWaiting = this.stage === 1;
    if (wasWaiting) {
      this.seed = randomSeed();
      this.stage = 0;
      this.mapLines = generateTerrain(this.seed);
      this.players.clear();
      this.endgameDeadline = 0;
      this.intermissionDeadline = 0;
    }

    this.players.set(connection.id, {
      lander: createDefaultLander(color),
      lastInput: { thrust: 0, rotation: 0, seq: 0 },
      color,
      score: 0,
    });

    if (wasWaiting) {
      this.broadcast(
        JSON.stringify({
          type: "new_round",
          seed: this.seed,
        }),
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
      seq: data.seq,
    };
  }

  onClose(connection: Connection): void {
    this.players.delete(connection.id);
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
