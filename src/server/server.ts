import { validateDisplayOptions, type DisplayOptions } from "../lib/display-options";
import { Server, type Connection } from "partyserver";
import {
  type RGB,
  type Lander,
  createDefaultLander,
} from "../lib/simulation";
import { isFlightUpdate, reportedLander, type FlightUpdate } from "../lib/flight-protocol";
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
import { getPlaySchedule, type PlaySchedule } from "../lib/play-schedule";

const COLORS = SHIP_COLORS.map((ship) => ship.color);

const TERRAIN_REVEAL_MS = 1800;

const TICK_MS = 50; // 20 Hz
const SILENT_CLIENT_MS = 15000;
const MAX_PLAYERS = 255; // uint8 slot limit in binary protocol

function randomSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

type ClientMessage = FlightUpdate | { type: "suspend"; authority: string } | { type: "options"; sessionId: string; name?: string; options?: Partial<DisplayOptions> } | { type: "camera"; command: CameraCommand } | { type: "start_session"; name: string } | { type: "quit_session"; sessionId: string };

interface PlayerState {
  connection: Connection;
  pilotId: string;
  joinedAt: number;
  name: string;
  lander: Lander;
  authority: string;
  lastSeq: number;
  lastSeenAt: number;
  elapsedMs: number;
  statsFlightBase: number;
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
  playSchedule: PlaySchedule | null = null;
  scheduleKey = "";
  pausedAt: number | null = null;

  async onStart(): Promise<void> {
    const saved = await this.ctx.storage.get<SessionStats>("session-stats");
    if (saved?.id && saved.name && saved.expiresAt > Date.now()) {
      this.stats = new SessionTracker(saved);
      this.syncPlaySchedule();
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
    this.syncPlaySchedule();
    this.scheduleNextAlarm();
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
    for (const player of [...this.players.values(), ...this.departed.values()]) player.statsFlightBase = player.elapsedMs;
    for (const player of this.players.values()) this.stats.join(player.pilotId, player.name);
    this.publishStats();
    this.syncPlaySchedule();
    this.scheduleNextAlarm();
  }

  syncPlaySchedule(now = Date.now()): void {
    const session = this.stats?.state ?? null;
    const key = session ? `${session.id}:${session.name}` : "";
    if (key === this.scheduleKey && (!this.playSchedule || now < this.playSchedule.changesAt)) return;
    this.scheduleKey = key;
    const next = getPlaySchedule(session, now);
    const wasPaused = this.pausedAt !== null;
    this.playSchedule = next;

    if (next?.phase === "paused" && !wasPaused) {
      this.epoch++;
      this.pausedAt = now;
      for (const player of this.players.values()) {
        player.lander.t = 0;
        player.lander.vr = 0;
      }
      this.prevSent.clear();
    } else if (next?.phase !== "paused" && this.pausedAt !== null) {
      this.epoch++;
      const duration = now - this.pausedAt;
      for (const player of this.players.values()) {
        player.joinedAt += now - Math.max(this.pausedAt, player.joinedAt);
        player.lastSeenAt = now;
      }
      // Landing records and all round deadlines exclude time spent paused.
      if (this.roundStartedAt > 0) {
        const startedAt = session?.startedAt ?? 0;
        this.roundStartedAt = Math.max(this.roundStartedAt, startedAt) + now - Math.max(this.pausedAt, startedAt);
      }
      if (this.revealDeadline > 0) this.revealDeadline += duration;
      if (this.endgameDeadline > 0) this.endgameDeadline += duration;
      if (this.intermissionDeadline > 0) this.intermissionDeadline += duration;
      this.pausedAt = null;
    }

    this.broadcast(JSON.stringify({ type: "play_schedule", schedule: next, epoch: this.epoch }));
    if (wasPaused && this.pausedAt === null) {
      if (this.stage === 1 && !this.intermissionDeadline && this.players.size > 0) this.beginNewRound();
      else this.checkEndgame();
    }
    this.scheduleNextAlarm();
  }

  seed = randomSeed();
  roundId = randomSeed();
  epoch = 0;
  stage = 1; // 0=playing, 1=waiting, 2=drawing terrain
  colorIndex = 0;
  nextSlot = 0;
  freeSlots: number[] = [];
  players = new Map<string, PlayerState>();
  // Retain accepted flights through disconnects until this round ends. Detached
  // ships never block the round; terminal states also prevent duplicate results.
  departed = new Map<string, PlayerState>();
  prevSent = new Map<string, PlayerSnapshot>();
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
    const next = Math.min(
      this.pausedAt === null && (this.tickRunning || this.intermissionDeadline > 0) ? Date.now() + TICK_MS : Infinity,
      this.playSchedule?.changesAt ?? Infinity,
      this.stats?.state.expiresAt ?? Infinity,
    );
    if (Number.isFinite(next)) this.ctx.storage.setAlarm(next);
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
    this.syncPlaySchedule();
    if (this.pausedAt !== null) {
      this.scheduleNextAlarm();
      return;
    }
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
        for (const player of this.players.values()) player.lastSeenAt = Date.now();
        this.broadcast(JSON.stringify({ type: "stage", stage: 0, roundId: this.roundId }));
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
    if (this.pausedAt !== null || this.stage !== 0 || this.players.size === 0) return;

    // A suspended browser cannot simulate. Remove its active ship without
    // inventing a crash, even if the underlying socket never delivers a close.
    for (const ps of this.players.values()) {
      if (ps.lander.a !== 0 || Date.now() - ps.lastSeenAt < SILENT_CLIENT_MS) continue;
      this.onClose(ps.connection);
      try { ps.connection.close(4002, "Flight suspended; reconnect to resume"); } catch { /* Already closed. */ }
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
      this.broadcast(encodeWorldUpdate(this.roundId, entries));
    }
    this.checkEndgame();
  }

  // ── Connection Lifecycle ─────────────────────────────────────

  onConnect(connection: Connection, context: { request: Request }): void {
    this.expireSession();
    this.syncPlaySchedule();
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
    let transferredSlot: number | undefined;
    let previous: PlayerState | undefined = spectator ? undefined : this.departed.get(pilotId);
    if (!spectator) this.departed.delete(pilotId);
    if (!spectator) {
      for (const [id, player] of this.players) {
        if (player.pilotId !== pilotId && id !== connection.id) continue;
        if (previous && this.players.has(previous.connection.id) && previous.slot !== player.slot) this.freeSlots.push(previous.slot);
        previous = player;
        transferredSlot = player.slot;
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
    const slot = spectator ? -1 : transferredSlot ?? this.allocSlot();

    if (!spectator && slot === -1) {
      connection.close(4000, "Server full");
      return;
    }

    // Transition from waiting → playing before building init payload
    const wasWaiting = !spectator && this.stage === 1 && !this.intermissionDeadline && this.pausedAt === null;
    if (wasWaiting) {
      this.seed = randomSeed();
      this.stage = 2;
      this.revealDeadline = Date.now() + TERRAIN_REVEAL_MS;
      this.roundId = (this.roundId + 1) >>> 0;
      this.departed.clear();
      this.endgameDeadline = 0;
      this.intermissionDeadline = 0;
      this.prevSent.clear();
      // Reset existing players for the new round (preserve connections)
      for (const [, ps] of this.players) {
        ps.lander = createDefaultLander(ps.color);
        ps.elapsedMs = 0;
        ps.statsFlightBase = 0;
        ps.lastSeq = -1;
        ps.lastSeenAt = Date.now();
      }
    }

    // Register the new player before building the init payload
    if (!spectator)
      this.players.set(connection.id, {
        connection,
        name,
        pilotId,
        joinedAt: previous?.joinedAt ?? Date.now(),
        lander: !wasWaiting && previous ? previous.lander : createDefaultLander(color),
        authority: crypto.randomUUID(),
        lastSeq: -1,
        lastSeenAt: Date.now(),
        elapsedMs: !wasWaiting ? previous?.elapsedMs ?? 0 : 0,
        statsFlightBase: !wasWaiting ? previous?.statsFlightBase ?? 0 : 0,
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
        roundId: this.roundId,
        epoch: this.epoch,
        authority: spectator ? null : this.players.get(connection.id)!.authority,
        endgameMs: Math.max(0, this.endgameDeadline - (this.pausedAt ?? Date.now())),
        stage: this.stage,
        revealMs: Math.max(0, this.revealDeadline - (this.pausedAt ?? Date.now())),
        players: playersInit,
        camera: this.camera,
        self: spectator ? null : { lander: this.players.get(connection.id)!.lander, score: this.players.get(connection.id)!.score, elapsedMs: this.players.get(connection.id)!.elapsedMs },
        stats: this.stats?.snapshot() ?? null,
        playSchedule: this.playSchedule ? { ...this.playSchedule, serverNow: Date.now() } : null,
      }),
    );

    if (!spectator)
      this.broadcast(
        JSON.stringify({ type: "player_join", id: connection.id, pilotId, name, color, slot, lander: this.players.get(connection.id)!.lander }),
        [connection.id],
      );

    if (wasWaiting) {
      // Notify existing players about the new round (new player already has correct data)
      this.broadcast(JSON.stringify({ type: "new_round", roundId: this.roundId, seed: this.seed, revealMs: TERRAIN_REVEAL_MS }), [connection.id]);
    }

    this.publishCamera();
    if (!spectator) {
      this.startTickLoop();
      this.checkEndgame();
    }
  }

  onMessage(connection: Connection, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > 4096) return;

    let data: ClientMessage;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    this.expireSession();
    this.syncPlaySchedule();
    if (data.type === "options") {
      if (!this.displays.has(connection.id) || !this.stats || this.stats.state.id !== data.sessionId) return;
      if (data.name !== undefined) {
        const name = normalizeName(data.name);
        if (name) this.stats.state.name = name;
      }
      if (data.options && typeof data.options === "object") this.stats.state.options = validateDisplayOptions(this.stats.state.options, data.options);
      this.publishStats();
      this.syncPlaySchedule();
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
    const ps = this.players.get(connection.id);
    if (!ps || ps.connection !== connection || data.authority !== ps.authority) return;
    if (data.type === "suspend") {
      this.onClose(connection);
      connection.close(4002, "Flight suspended");
      return;
    }
    if (!isFlightUpdate(data) || data.roundId !== this.roundId || data.epoch !== this.epoch ||
      this.pausedAt !== null || this.stage !== 0 || data.seq <= ps.lastSeq || data.elapsedMs < ps.elapsedMs) return;

    ps.lastSeq = data.seq;
    ps.lastSeenAt = Date.now();
    if (ps.lander.a === 0) {
      Object.assign(ps.lander, reportedLander({ ...data.lander, color: ps.color }));
      ps.elapsedMs = data.elapsedMs;
      if (data.result) {
        ps.lander.t = 0;
        ps.lander.vr = 0;
        ps.score += data.result.points;
        this.stats?.outcome(ps.pilotId, data.lander.a === 1, Math.max(0, ps.elapsedMs - ps.statsFlightBase));
        this.publishStats();
        if (data.lander.a === 2) this.broadcast(encodeCrash(this.roundId, ps.slot, ps.lander.x, ps.lander.y, ps.color));
        this.checkEndgame();
      }
    }
    // Results are terminal for this pilot/round, including across reconnects.
    // Repeated reports get an ack but never award points or stats again.
    if (ps.lander.a !== 0) connection.send(JSON.stringify({
      type: "result_ack", roundId: this.roundId, authority: ps.authority, score: ps.score,
    }));
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
    this.departed.set(ps.pilotId, ps);
    if (this.camera.followPilotId === ps.pilotId) this.camera = { ...this.camera, followPilotId: null };
    this.publishCamera();
    this.prevSent.delete(connection.id);
    this.broadcast(JSON.stringify({ type: "player_leave", id: connection.id }));

    if (this.players.size === 0) {
      this.stage = 1;
      this.revealDeadline = 0;
      this.broadcast(JSON.stringify({ type: "stage", stage: 1, roundId: this.roundId }));
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
    if (this.pausedAt !== null || this.stage !== 0 || this.players.size === 0) return;

    const allDone = [...this.players.values()].every((ps) => ps.lander.a !== 0);

    if (allDone && this.endgameDeadline === 0) {
      this.endgameDeadline = Date.now() + 6000;
      this.broadcast(JSON.stringify({ type: "endgame_start", roundId: this.roundId }));
    } else if (!allDone && this.endgameDeadline > 0) {
      this.endgameDeadline = 0;
      this.broadcast(JSON.stringify({ type: "endgame_cancel", roundId: this.roundId }));
    }
  }

  enterIntermission(): void {
    this.stage = 1;
    this.stopTickLoop();
    this.broadcast(JSON.stringify({ type: "stage", stage: 1, roundId: this.roundId }));

    // Schedule new round after 4s intermission
    this.intermissionDeadline = Date.now() + 4000;
    this.scheduleNextAlarm();
  }

  beginNewRound(): void {
    this.seed = randomSeed();
    this.stage = 2;
    this.revealDeadline = Date.now() + TERRAIN_REVEAL_MS;
    this.roundId = (this.roundId + 1) >>> 0;
    this.departed.clear();
    this.intermissionDeadline = 0;
    this.endgameDeadline = 0;
    this.prevSent.clear();

    // Reset all connected players (preserve score across rounds)
    for (const [, ps] of this.players) {
      ps.lander = createDefaultLander(ps.color);
      ps.elapsedMs = 0;
      ps.statsFlightBase = 0;
      ps.lastSeq = -1;
      ps.lastSeenAt = Date.now();
    }

    this.broadcast(
      JSON.stringify({
        type: "new_round",
        roundId: this.roundId,
        seed: this.seed,
        revealMs: TERRAIN_REVEAL_MS,
      }),
    );

    if (this.players.size > 0) {
      this.startTickLoop();
    }
  }
}
