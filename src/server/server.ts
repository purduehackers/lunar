import { validateDisplayOptions, type DisplayOptions } from "../lib/display-options";
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

import { updateCamera, type CameraState, type CameraCommand } from "../lib/camera";
import { SessionTracker, type SessionStats } from "../lib/session-stats";
import { normalizeName } from "../lib/names";
import { SHIP_COLORS } from "../lib/colors";

const COLORS = SHIP_COLORS.map((ship) => ship.color);

const TERRAIN_REVEAL_MS = 1800;

const TICK_MS = 50; // 20 Hz
const MAX_PLAYERS = 255; // uint8 slot limit in binary protocol

function randomSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

type ClientMessage = { type: "options"; sessionId: string; name?: string; options?: Partial<DisplayOptions> } | { type: "camera"; command: CameraCommand } | { type: "start_session"; name: string } | { type: "quit_session"; sessionId: string } | {
  type: "input";
  thrust: 0 | 1;
  rotation: -1 | 0 | 1;
  seq: number;
};

interface PlayerState {
  connection: Connection;
  pilotId: string;
  joinedAt: number;
  name: string;
  lander: Lander;
  lastInput: PlayerInput;
  color: RGB;
  score: number;
  slot: number;
}

export class GameServer extends Server<Env> {
  stats: SessionTracker | null = null;
  displays = new Set<string>();
  controllers = new Set<string>();
  camera: CameraState = { custom: null, followPilotId: null };

  publishCamera(): void {
    this.broadcast(JSON.stringify({ type: "camera", camera: this.camera, ships: Array.from(this.players.values(), p => ({ pilotId: p.pilotId, name: p.name, color: p.color })) }));
  }
  lastStatsSent = 0;
  roundStartedAt = 0;

  async onStart(): Promise<void> {
    const saved = await this.ctx.storage.get<SessionStats>("session-stats");
    if (saved?.id && saved.name && saved.expiresAt > Date.now()) {
      this.stats = new SessionTracker(saved);
      this.scheduleNextAlarm();
    } else {
      await this.ctx.storage.put("session-stats", null);
    }
  }

  expireSession(): void {
    if (this.stats && Date.now() >= this.stats.state.expiresAt) {
      this.quitSession();
    }
  }

  quitSession(): void {
    this.stats = null;
    this.publishStats();
  }

  publishStats(): void {
    const stats = this.stats?.snapshot() ?? null;
    this.broadcast(JSON.stringify({ type: "stats", stats }));
    void this.ctx.storage.put("session-stats", stats);
    this.lastStatsSent = Date.now();
  }

  startSession(name: string): void {
    if (this.stats) return;
    this.stats = SessionTracker.create(crypto.randomUUID(), name);
    for (const player of this.players.values()) this.stats.join(player.pilotId, player.name);
    this.publishStats();
    this.scheduleNextAlarm();
  }

  seed = randomSeed();
  stage = 1; // 0=playing, 1=waiting, 2=drawing terrain
  colorIndex = 0;
  nextSlot = 0;
  freeSlots: number[] = [];
  players = new Map<string, PlayerState>();
  prevSent = new Map<string, PlayerSnapshot>();
  mapLines: MapLine[] = [];
  tickRunning = false;

  // Timers tracked as absolute timestamps (checked each tick)
  revealDeadline = 0;
  endgameDeadline = 0; // 0 = not active
  intermissionDeadline = 0; // 0 = not active

  allocSlot(): number {
    if (this.freeSlots.length > 0) return this.freeSlots.pop()!;
    if (this.nextSlot >= MAX_PLAYERS) return -1;
    return this.nextSlot++;
  }

  // ── Alarm-based tick loop ────────────────────────────────────

  scheduleNextAlarm(): void {
    const next = this.tickRunning || this.intermissionDeadline > 0
      ? Date.now() + TICK_MS
      : this.stats?.state.expiresAt;
    if (next !== undefined) this.ctx.storage.setAlarm(next);
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
    this.expireSession();
    // Handle intermission → new round transition (can happen while tick is stopped)
    if (this.intermissionDeadline > 0 && Date.now() >= this.intermissionDeadline) {
      this.intermissionDeadline = 0;
      this.beginNewRound();
      return;
    }

    if (!this.tickRunning) {
      // If we're in intermission, keep alarm going to check deadline
      if (this.intermissionDeadline > 0 || this.stats) {
        this.scheduleNextAlarm();
      }
      return;
    }

    if (this.stage === 2) {
      if (Date.now() >= this.revealDeadline) {
        this.stage = 0;
        this.roundStartedAt = Date.now();
        this.revealDeadline = 0;
        this.broadcast(JSON.stringify({ type: "stage", stage: 0 }));
      } else {
        this.scheduleNextAlarm();
        return;
      }
    }

    // Handle endgame countdown
    if (this.endgameDeadline > 0 && Date.now() >= this.endgameDeadline) {
      this.endgameDeadline = 0;
      this.enterIntermission();
      return;
    }

    this.tick();
    if (Date.now() - this.lastStatsSent >= 1000) this.publishStats();
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
        this.stats?.outcome(ps.pilotId, outcome === 1, Date.now() - Math.max(this.roundStartedAt, ps.joinedAt, this.stats?.state.startedAt ?? 0));
        this.publishStats();
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
        this.stats?.outcome(ps.pilotId, false, 0);
        this.publishStats();
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

  onConnect(connection: Connection, context: { request: Request }): void {
    this.expireSession();
    const query = new URL(context.request.url).searchParams;
    const controller = query.get("mode") === "camera";
    const spectator = query.get("mode") === "display" || controller;
    if (controller) this.controllers.add(connection.id);
    if (spectator && !controller) this.displays.add(connection.id);
    const name = normalizeName(query.get("name")) || "Pilot";
    const requestedId = query.get("pilotId") ?? "";
    const pilotId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedId) ? requestedId : connection.id;
    // A browser UUID owns one active ship. Transfer it before closing its old socket,
    // so delayed close/error callbacks cannot delete the replacement connection.
    let previous: PlayerState | undefined;
    if (!spectator) {
      for (const [id, player] of this.players) {
        if (player.pilotId !== pilotId && id !== connection.id) continue;
        if (previous && previous.slot !== player.slot) this.freeSlots.push(previous.slot);
        previous = player;
        this.players.delete(id);
        this.prevSent.delete(id);
        this.stats?.leave(player.pilotId);
        this.broadcast(JSON.stringify({ type: "player_leave", id }));
        if (player.connection !== connection) {
          try {
            player.connection.send(JSON.stringify({ type: "superseded" }));
            player.connection.close(4001, "Ship opened in another tab");
          } catch { /* The previous socket may already be disconnected. */ }
        }
      }
    }
    const color: RGB = previous?.color ?? (spectator ? [255, 255, 255] : COLORS[this.colorIndex % COLORS.length]);
    if (!spectator && !previous) this.colorIndex++;
    const slot = spectator ? -1 : previous?.slot ?? this.allocSlot();

    if (!spectator && slot === -1) {
      connection.close(4000, "Server full");
      return;
    }

    // Transition from waiting → playing before building init payload
    const wasWaiting = !spectator && this.stage === 1;
    if (wasWaiting) {
      this.seed = randomSeed();
      this.stage = 2;
      this.revealDeadline = Date.now() + TERRAIN_REVEAL_MS;
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
    if (!spectator)
      this.players.set(connection.id, {
        connection,
        name,
        pilotId,
        joinedAt: previous?.joinedAt ?? Date.now(),
        lander: previous?.lander ?? createDefaultLander(color),
        lastInput: { thrust: 0, rotation: 0, seq: 0 },
        color,
        score: previous?.score ?? 0,
        slot,
      });

    if (!spectator) {
      this.stats?.join(pilotId, name);
      this.publishStats();
    }

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
        pilotId: string;
        name: string;
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
        pilotId: ps.pilotId,
        name: ps.name,
      };
    }

    // Send init with correct seed/stage (after potential round transition)
    connection.send(
      JSON.stringify({
        type: "init",
        id: connection.id,
        name,
        color,
        slot,
        seed: this.seed,
        stage: this.stage,
        revealMs: Math.max(0, this.revealDeadline - Date.now()),
        players: playersInit,
        camera: this.camera,
        self: spectator ? null : { lander: this.players.get(connection.id)!.lander, score: this.players.get(connection.id)!.score },
        stats: this.stats?.snapshot() ?? null,
      }),
    );

    if (!spectator)
      this.broadcast(
        JSON.stringify({ type: "player_join", id: connection.id, pilotId, name, color, slot }),
        [connection.id],
      );

    if (wasWaiting) {
      // Notify existing players about the new round (new player already has correct data)
      this.broadcast(JSON.stringify({ type: "new_round", seed: this.seed, revealMs: TERRAIN_REVEAL_MS }), [connection.id]);
    }

    this.publishCamera();
    if (!spectator) this.startTickLoop();
  }

  onMessage(connection: Connection, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;

    let data: ClientMessage;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    this.expireSession();
    if (data.type === "options") {
      if (!this.displays.has(connection.id) || !this.stats || this.stats.state.id !== data.sessionId) return;
      if (data.name !== undefined) {
        const name = normalizeName(data.name);
        if (name) this.stats.state.name = name;
      }
      if (data.options && typeof data.options === "object") this.stats.state.options = validateDisplayOptions(this.stats.state.options, data.options);
      this.publishStats();
      return;
    }
    if (data.type === "camera") {
      if (!this.controllers.has(connection.id) || !data.command || typeof data.command !== "object") return;
      this.camera = updateCamera(this.camera, data.command, Array.from(this.players.values(), p => p.pilotId));
      this.publishCamera();
      return;
    }
    if (data.type === "quit_session") {
      if (this.displays.has(connection.id) && this.stats?.state.id === data.sessionId) {
        this.quitSession();
      }
      return;
    }
    if (data.type === "start_session") {
      if (!this.displays.has(connection.id)) return;
      const name = normalizeName(data.name);
      if (name) this.startSession(name);
      // Return the winning session when two displays submit at once.
      connection.send(JSON.stringify({ type: "stats", stats: this.stats?.snapshot() ?? null }));
      return;
    }
    if (data.type !== "input" || this.stage !== 0) return;

    const ps = this.players.get(connection.id);
    if (!ps || ps.connection !== connection) return;

    ps.lastInput = {
      thrust: data.thrust === 1 ? 1 : 0,
      rotation: data.rotation === -1 ? -1 : data.rotation === 1 ? 1 : 0,
      seq: typeof data.seq === "number" ? data.seq : 0,
    };
  }

  onClose(connection: Connection): void {
    this.displays.delete(connection.id);
    this.controllers.delete(connection.id);
    this.expireSession();
    const ps = this.players.get(connection.id);
    if (!ps || ps.connection !== connection) return;
    this.stats?.leave(ps.pilotId);
    this.publishStats();
    this.freeSlots.push(ps.slot);
    this.players.delete(connection.id);
    if (this.camera.followPilotId === ps.pilotId) this.camera = { ...this.camera, followPilotId: null };
    this.publishCamera();
    this.prevSent.delete(connection.id);
    this.broadcast(JSON.stringify({ type: "player_leave", id: connection.id }));

    if (this.players.size === 0) {
      this.stage = 1;
      this.revealDeadline = 0;
      this.broadcast(JSON.stringify({ type: "stage", stage: 1 }));
      this.stopTickLoop();
      this.endgameDeadline = 0;
      this.intermissionDeadline = 0;
      this.scheduleNextAlarm();
    } else {
      this.checkEndgame();
    }
  }

  onError(connection: Connection): void {
    this.onClose(connection);
    try { connection.close(1011, "Connection error"); } catch { /* Already closed. */ }
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
    this.stage = 2;
    this.revealDeadline = Date.now() + TERRAIN_REVEAL_MS;
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
        revealMs: TERRAIN_REVEAL_MS,
      }),
    );

    if (this.players.size > 0) {
      this.startTickLoop();
    }
  }
}
