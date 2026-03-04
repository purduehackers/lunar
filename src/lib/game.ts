import PartySocket from "partysocket";
import {
  type RGB,
  type Lander,
  type MapLine,
  MAP_WIDTH,
  S,
  generateTerrain,
  createDefaultLander,
  getTerrainHeightAt,
} from "./simulation";
import {
  MSG_WORLD,
  MSG_CRASH,
  decodeWorldUpdate,
  decodeCrash,
  unpackThrust,
  unpackState,
} from "./protocol";

// ─── Constants ────────────────────────────────────────────────

const MAX_ZOOM = 4;
const INPUT_INTERVAL = 50; // ms between input sends
const MAX_DT = 0.1; // cap delta-time to prevent physics explosions
const MAX_EXTRAPOLATION = 0.15; // max seconds to extrapolate beyond last server tick

// ─── Types ────────────────────────────────────────────────────

interface CrashEffect {
  x: number;
  y: number;
  time: number;
  color: RGB;
}

interface Grave {
  x: number;
  y: number;
  color: RGB;
}

// Network message types (JSON only — world/crash are binary)
type ServerMessage =
  | {
      type: "init";
      id: string;
      color: RGB;
      slot: number;
      seed: number;
      stage: number;
      players: Record<
        string,
        { x: number; y: number; r: number; vx: number; vy: number; vr: number; t: number; a: number; fuel: number; score: number; color: RGB; slot: number }
      >;
    }
  | { type: "player_join"; id: string; color: RGB; slot: number }
  | { type: "player_leave"; id: string }
  | { type: "new_round"; seed: number }
  | { type: "stage"; stage: number }
  | { type: "endgame_start" }
  | { type: "endgame_cancel" };

// ─── Ship Rendering ──────────────────────────────────────────

function drawShip(
  ctx: CanvasRenderingContext2D,
  l: Lander,
  scale: number,
  frameCount: number,
): void {
  ctx.save();
  const [r, g, b] = l.color;
  ctx.strokeStyle = `rgb(${r},${g},${b})`;
  ctx.lineWidth = 3 / scale;
  ctx.translate(l.x, -l.y);
  ctx.rotate(l.r);

  // Ship body — batched into a single path
  ctx.beginPath();

  // Wings
  ctx.moveTo(-8 * S, 0);
  ctx.lineTo(-5 * S, 0);
  ctx.moveTo(5 * S, 0);
  ctx.lineTo(8 * S, 0);

  // Landing legs
  ctx.moveTo(-6.5 * S, 0);
  ctx.lineTo(-3.5 * S, -4 * S);
  ctx.moveTo(6.5 * S, 0);
  ctx.lineTo(3.5 * S, -4 * S);

  // Undercarriage
  ctx.moveTo(2 * S, -4 * S);
  ctx.lineTo(3 * S, -1.5 * S);
  ctx.lineTo(-3 * S, -1.5 * S);
  ctx.lineTo(-2 * S, -4 * S);

  // Cabin
  ctx.moveTo(-4.5 * S, -4 * S);
  ctx.lineTo(-4.5 * S, -5.5 * S);
  ctx.lineTo(4.5 * S, -5.5 * S);
  ctx.lineTo(4.5 * S, -4 * S);
  ctx.lineTo(-4.5 * S, -4 * S);

  // Cockpit
  ctx.moveTo(-2 * S, -5.5 * S);
  ctx.lineTo(-4 * S, -7.5 * S);
  ctx.lineTo(-4 * S, -11.5 * S);
  ctx.lineTo(-2 * S, -13.5 * S);
  ctx.lineTo(2 * S, -13.5 * S);
  ctx.lineTo(4 * S, -11.5 * S);
  ctx.lineTo(4 * S, -7.5 * S);
  ctx.lineTo(2 * S, -5.5 * S);

  ctx.stroke();

  // Engine flame (separate — animated)
  if (l.a === 0 && l.t > 0) {
    const flicker = Math.sin(frameCount * 0.5) * 3 * S * l.t;
    const flameLen = -1.5 * S + flicker + 10 * S * l.t;
    ctx.beginPath();
    ctx.moveTo(-2 * S, -1.5 * S);
    ctx.lineTo(0, flameLen);
    ctx.moveTo(2 * S, -1.5 * S);
    ctx.lineTo(0, flameLen);
    ctx.stroke();
  }

  ctx.restore();
}

// ─── Terrain Rendering ───────────────────────────────────────

function drawTerrain(
  ctx: CanvasRenderingContext2D,
  mapLines: MapLine[],
  scale: number,
  offset: number,
): void {
  const ox = offset * MAP_WIDTH;

  // Draw terrain lines
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3 / scale;
  ctx.beginPath();
  for (const line of mapLines) {
    if (line[1] !== line[3]) {
      ctx.moveTo(line[0] + ox, line[1]);
      ctx.lineTo(line[2] + ox, line[3]);
    }
  }
  ctx.stroke();

  // Draw landing pads (flat segments) bolder
  ctx.lineWidth = 6 / scale;
  ctx.beginPath();
  for (const line of mapLines) {
    if (line[1] === line[3]) {
      ctx.moveTo(line[0] + ox, line[1]);
      ctx.lineTo(line[2] + ox, line[3]);
    }
  }
  ctx.stroke();
}

// ─── Crash Effect ─────────────────────────────────────────────

function drawCrashEffect(ctx: CanvasRenderingContext2D, crash: CrashEffect, scale: number): void {
  ctx.save();
  const [r, g, b] = crash.color;
  ctx.strokeStyle = `rgb(${r},${g},${b})`;
  ctx.lineWidth = 5 / scale;
  ctx.translate(crash.x, -crash.y);

  const innerR = 0.008 * crash.time;
  const outerR = 0.02 * crash.time;

  ctx.beginPath();
  for (let i = 0; i < Math.PI * 2; i += Math.PI / 4) {
    const sinI = Math.sin(i);
    const cosI = Math.cos(i);
    const sinPlus = Math.sin(i + Math.PI / 8);
    const cosPlus = Math.cos(i + Math.PI / 8);
    const sinMinus = Math.sin(i - Math.PI / 8);
    const cosMinus = Math.cos(i - Math.PI / 8);

    ctx.moveTo(sinPlus * innerR, cosPlus * innerR);
    ctx.lineTo(sinI * outerR, cosI * outerR);
    ctx.moveTo(sinMinus * innerR, cosMinus * innerR);
    ctx.lineTo(sinI * outerR, cosI * outerR);
  }
  ctx.stroke();

  ctx.restore();
}

// ─── Grave Rendering ──────────────────────────────────────────

function drawGrave(ctx: CanvasRenderingContext2D, grave: Grave, scale: number): void {
  ctx.save();
  const [r, g, b] = grave.color;
  ctx.strokeStyle = `rgb(${r},${g},${b})`;
  ctx.lineWidth = 3 / scale;
  ctx.translate(grave.x, -grave.y);

  const s = 6;
  ctx.beginPath();
  ctx.moveTo(-s, -s * 2);
  ctx.lineTo(s, 0);
  ctx.moveTo(s, -s * 2);
  ctx.lineTo(-s, 0);
  ctx.stroke();

  ctx.restore();
}

// ─── Arcade Button Rendering ─────────────────────────────────

function drawArcadeBtn(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  label: string,
  active: boolean,
): void {
  ctx.save();

  // Outer glow when active
  if (active) {
    ctx.shadowColor = "rgba(255, 255, 255, 0.5)";
    ctx.shadowBlur = 18;
  }

  // Button housing (outer ring)
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = active ? "rgba(255, 255, 255, 0.1)" : "rgba(255, 255, 255, 0.03)";
  ctx.fill();
  ctx.strokeStyle = active ? "rgba(255, 255, 255, 0.8)" : "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.shadowBlur = 0;

  // Inner raised surface
  ctx.beginPath();
  ctx.arc(x, y, r * 0.65, 0, Math.PI * 2);
  ctx.fillStyle = active ? "rgba(255, 255, 255, 0.07)" : "rgba(255, 255, 255, 0.015)";
  ctx.fill();
  ctx.strokeStyle = active ? "rgba(255, 255, 255, 0.5)" : "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Label
  ctx.fillStyle = active ? "rgba(255, 255, 255, 0.9)" : "rgba(255, 255, 255, 0.3)";
  ctx.font = `${r * 0.55}px 'PixelHackers', monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x, y);

  ctx.restore();
}

// ─── Main Game ────────────────────────────────────────────────

export function startGame(canvas: HTMLCanvasElement, workerHost: string): () => void {
  const _ctx = canvas.getContext("2d");
  if (!_ctx) throw new Error("Canvas 2D context not supported");
  const ctx = _ctx;

  // ── State ──
  let myColor: RGB = [255, 255, 255];
  let myLander = createDefaultLander(myColor);
  const remoteLanders = new Map<string, Lander>();
  let crashes: CrashEffect[] = [];
  let graves: Grave[] = [];
  let mapLines: MapLine[] = [];
  let mapSeed = 1;
  let gameStage = 1;
  let myId = "";
  let mySlot = 0;
  const slotToId = new Map<number, string>();
  const idToSlot = new Map<string, number>();
  const idToColor = new Map<string, RGB>();
  let frameCount = 0;
  let lastTime = 0;
  let lastInputTime = 0;
  let inputSeq = 0;
  let endgameStartTime = 0;
  let endgameActive = false;
  let connected = false;
  let animationId = 0;
  let myScore = 0;
  let myFuel = myLander.fuel;
  let roundStartTime = 0;
  const isMobile = window.matchMedia("(pointer: coarse)").matches;

  // Track last sent input to only send on change
  let lastSentThrust: 0 | 1 = 0;
  let lastSentRotation: -1 | 0 | 1 = 0;

  // Smooth camera zoom
  let smoothCamS = 0;

  // Client-side interpolation: snapshot server state, extrapolate between ticks
  let serverMyLander: Lander = { ...myLander };
  const serverRemoteLanders = new Map<string, Lander>();
  let lastServerTime = 0;

  // ── Input ──
  const keysDown = new Set<string>();

  function onKeyDown(e: KeyboardEvent): void {
    keysDown.add(e.key);
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) {
      e.preventDefault();
    }
  }
  function onKeyUp(e: KeyboardEvent): void {
    keysDown.delete(e.key);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // Touch input
  let activeTouches: { x: number; y: number }[] = [];
  function handleTouch(e: TouchEvent): void {
    e.preventDefault();
    activeTouches = Array.from(e.touches).map((t) => ({ x: t.clientX, y: t.clientY }));
  }
  canvas.addEventListener("touchstart", handleTouch);
  canvas.addEventListener("touchmove", handleTouch);
  canvas.addEventListener("touchend", handleTouch);
  canvas.addEventListener("touchcancel", handleTouch);

  // ── Resize (with HiDPI support) ──
  const baseDpr = window.devicePixelRatio || 1;
  let dpr = baseDpr;

  function resize(): void {
    dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
  }
  resize();
  window.addEventListener("resize", resize);

  // ── Load font ──
  const pixelFont = new FontFace("PixelHackers", "url(/PixelHackers.woff2)");
  pixelFont.load().then((f) => document.fonts.add(f)).catch(() => {});

  // ── Network ──
  const socket = new PartySocket({
    host: workerHost,
    party: "game-server",
    room: "main",
  });

  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    connected = true;
  });
  socket.addEventListener("close", () => {
    connected = false;
  });

  socket.addEventListener("message", (e) => {
    // Binary messages: world updates and crash events
    if (e.data instanceof ArrayBuffer) {
      const msgType = new Uint8Array(e.data)[0];
      if (msgType === MSG_WORLD) {
        lastServerTime = performance.now();
        const players = decodeWorldUpdate(e.data);
        for (const p of players) {
          const id = slotToId.get(p.slot);
          if (!id) continue;
          const color = idToColor.get(id) ?? myColor;
          const t = unpackThrust(p.flags);
          const a = unpackState(p.flags);
          const snap: Lander = { x: p.x, y: p.y, r: p.r, vx: p.vx, vy: p.vy, vr: p.vr, t, a, fuel: p.fuel, color };
          if (id === myId) {
            serverMyLander = snap;
            Object.assign(myLander, snap);
            myFuel = p.fuel;
            myScore = p.score;
          } else {
            serverRemoteLanders.set(id, snap);
            remoteLanders.set(id, { ...snap });
          }
        }
      } else if (msgType === MSG_CRASH) {
        const c = decodeCrash(e.data);
        if (c) {
          crashes.push({ x: c.x, y: c.y, time: 0, color: c.color });
          graves.push({ x: c.x, y: c.y, color: c.color });
        }
      }
      return;
    }

    // JSON messages
    let data: ServerMessage;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }

    switch (data.type) {
      case "init":
        myId = data.id;
        myColor = data.color;
        mySlot = data.slot;
        myLander = createDefaultLander(myColor);
        serverMyLander = { ...myLander };
        mapSeed = data.seed;
        gameStage = data.stage;
        mapLines = generateTerrain(mapSeed);
        myScore = 0;
        myFuel = myLander.fuel;
        roundStartTime = performance.now();
        remoteLanders.clear();
        serverRemoteLanders.clear();
        slotToId.clear();
        idToSlot.clear();
        idToColor.clear();
        slotToId.set(mySlot, myId);
        idToSlot.set(myId, mySlot);
        idToColor.set(myId, myColor);
        for (const [id, player] of Object.entries(data.players)) {
          const { x, y, r, vx, vy, vr, t, a, fuel, color, slot } = player;
          const snap: Lander = { x, y, r, vx, vy, vr, t, a, fuel, color };
          remoteLanders.set(id, snap);
          serverRemoteLanders.set(id, { ...snap });
          slotToId.set(slot, id);
          idToSlot.set(id, slot);
          idToColor.set(id, color);
        }
        lastServerTime = performance.now();
        break;

      case "player_join":
        remoteLanders.set(data.id, createDefaultLander(data.color));
        slotToId.set(data.slot, data.id);
        idToSlot.set(data.id, data.slot);
        idToColor.set(data.id, data.color);
        break;

      case "player_leave": {
        remoteLanders.delete(data.id);
        serverRemoteLanders.delete(data.id);
        const leftSlot = idToSlot.get(data.id);
        if (leftSlot !== undefined) slotToId.delete(leftSlot);
        idToSlot.delete(data.id);
        idToColor.delete(data.id);
        break;
      }

      case "new_round":
        mapSeed = data.seed;
        mapLines = generateTerrain(mapSeed);
        gameStage = 0;
        myLander = createDefaultLander(myColor);
        serverMyLander = { ...myLander };
        myFuel = myLander.fuel;
        roundStartTime = performance.now();
        remoteLanders.clear();
        serverRemoteLanders.clear();
        crashes = [];
        graves = [];
        endgameActive = false;
        smoothCamS = 0;
        lastSentThrust = 0;
        lastSentRotation = 0;
        inputSeq = 0;
        lastServerTime = performance.now();
        break;

      case "stage":
        gameStage = data.stage;
        break;

      case "endgame_start":
        endgameActive = true;
        endgameStartTime = performance.now();
        break;

      case "endgame_cancel":
        endgameActive = false;
        break;
    }
  });

  // ── Visibility ──
  function onVisibilityChange(): void {
    if (!document.hidden) {
      lastTime = 0;
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  // ── Send Input ──
  function sendInput(thrust: 0 | 1, rotation: -1 | 0 | 1): void {
    inputSeq++;
    lastSentThrust = thrust;
    lastSentRotation = rotation;
    socket.send(JSON.stringify({ type: "input", thrust, rotation, seq: inputSeq }));
  }

  // ── Game Loop ──
  function loop(time: number): void {
    animationId = requestAnimationFrame(loop);

    const rawDt = Math.min(lastTime === 0 ? 0.016 : (time - lastTime) / 1000, MAX_DT);
    lastTime = time;
    frameCount++;

    // Logical canvas dimensions (CSS pixels)
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    // ── Mobile button positions ──
    const btnR = Math.max(Math.min(w, h) * 0.09, 32);
    const btnBaseY = h - btnR * 2.8;
    const btnGap = btnR * 2.5;
    const leftBtn = { x: w / 2 - btnGap, y: btnBaseY };
    const rightBtn = { x: w / 2 + btnGap, y: btnBaseY };
    const thrustBtn = { x: w / 2, y: btnBaseY - btnR * 1.8 };
    const hitR2 = (btnR * 1.4) * (btnR * 1.4);

    // ── Handle Input ──
    let rotation: -1 | 0 | 1 = 0;
    let foundLT = false;
    let foundRT = false;
    let foundCT = false;

    if (isMobile) {
      for (const touch of activeTouches) {
        const dxL = touch.x - leftBtn.x, dyL = touch.y - leftBtn.y;
        const dxR = touch.x - rightBtn.x, dyR = touch.y - rightBtn.y;
        const dxT = touch.x - thrustBtn.x, dyT = touch.y - thrustBtn.y;
        if (dxL * dxL + dyL * dyL <= hitR2) foundLT = true;
        if (dxR * dxR + dyR * dyR <= hitR2) foundRT = true;
        if (dxT * dxT + dyT * dyT <= hitR2) foundCT = true;
      }
    }

    if (keysDown.has("ArrowLeft") || keysDown.has("a") || keysDown.has("A") || foundLT) rotation = -1;
    if (keysDown.has("ArrowRight") || keysDown.has("d") || keysDown.has("D") || foundRT) rotation = rotation === -1 ? 0 : 1;
    const thrust: 0 | 1 =
      keysDown.has("ArrowUp") || keysDown.has("w") || keysDown.has("W") || foundCT ? 1 : 0;

    // Send input to server when it changes, or at minimum interval
    if (gameStage === 0 && myLander.a === 0) {
      const changed = thrust !== lastSentThrust || rotation !== lastSentRotation;
      if (changed || time - lastInputTime >= INPUT_INTERVAL) {
        lastInputTime = time;
        sendInput(thrust, rotation);
      }
    }

    // ── Client-side extrapolation (smooth 60fps from 20Hz server ticks) ──
    if (gameStage === 0) {
      const sinceTick = (performance.now() - lastServerTime) / 1000;
      if (sinceTick > 0 && sinceTick < MAX_EXTRAPOLATION) {
        // Extrapolate my lander from last server snapshot
        if (serverMyLander.a === 0) {
          myLander.x = serverMyLander.x + serverMyLander.vx * sinceTick;
          myLander.y = serverMyLander.y + serverMyLander.vy * sinceTick;
          myLander.r = serverMyLander.r + serverMyLander.vr * sinceTick;
          // Wrap x
          if (myLander.x > MAP_WIDTH) myLander.x -= MAP_WIDTH;
          if (myLander.x < 0) myLander.x += MAP_WIDTH;
        }
        // Extrapolate remote landers
        for (const [id, lander] of remoteLanders) {
          const srv = serverRemoteLanders.get(id);
          if (srv && srv.a === 0) {
            lander.x = srv.x + srv.vx * sinceTick;
            lander.y = srv.y + srv.vy * sinceTick;
            lander.r = srv.r + srv.vr * sinceTick;
            if (lander.x > MAP_WIDTH) lander.x -= MAP_WIDTH;
            if (lander.x < 0) lander.x += MAP_WIDTH;
          }
        }
      }
    }

    // ── Render ──
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);

    // Camera setup
    ctx.save();
    let camS: number;

    if (gameStage === 0) {
      const camX = -myLander.x;
      const camY = myLander.y;
      const maxZoom = isMobile ? 2 : MAX_ZOOM;
      const minZoom = isMobile ? 0.25 : 0.4;
      const zoomThreshold = 250; // altitude above terrain where zoom kicks in

      const terrainH = getTerrainHeightAt(myLander.x, mapLines);
      const altAboveTerrain = Math.max(myLander.y - terrainH, 20);

      let targetCamS: number;
      if (altAboveTerrain > zoomThreshold) {
        // Far from terrain — fixed wide zoom
        targetCamS = minZoom;
      } else {
        // Close to terrain — zoom in proportionally
        targetCamS = Math.min(h / 2 / altAboveTerrain, maxZoom);
      }

      // Smooth the camera zoom (frame-rate independent)
      if (smoothCamS === 0) smoothCamS = targetCamS;
      const smoothFactor = 1 - Math.pow(0.98, rawDt * 60);
      smoothCamS += (targetCamS - smoothCamS) * smoothFactor;
      camS = smoothCamS;

      ctx.translate(w / 2, h / 2);
      ctx.scale(camS, camS);
      ctx.translate(camX, camY);
    } else {
      const dim = Math.min(w, h);
      camS = dim / 2 / 600;

      ctx.translate(w / 2, h / 2);
      ctx.scale(camS, camS);
      ctx.translate(-MAP_WIDTH / 2, dim / 2);
    }

    // Scale factor for line widths: constant physical pixels regardless of browser zoom
    const drawScale = camS * dpr / baseDpr;

    // Terrain (3 instances for horizontal wrapping)
    drawTerrain(ctx, mapLines, drawScale, -1);
    drawTerrain(ctx, mapLines, drawScale, 0);
    drawTerrain(ctx, mapLines, drawScale, 1);

    // Graves
    for (const grave of graves) {
      drawGrave(ctx, grave, drawScale);
    }

    // Remote landers
    for (const [, lander] of remoteLanders) {
      if (lander.a !== 2) {
        drawShip(ctx, lander, drawScale, frameCount);
      }
    }

    // My lander
    if (myLander.a !== 2) {
      drawShip(ctx, myLander, drawScale, frameCount);
    }

    // Crash effects
    crashes = crashes.filter((c) => {
      c.time += rawDt * 1000;
      if (c.time >= 1000) return false;
      drawCrashEffect(ctx, c, drawScale);
      return true;
    });

    ctx.restore(); // camera

    // ── Mobile controls (arcade buttons, drawn under HUD text) ──
    if (isMobile) {
      drawArcadeBtn(ctx, leftBtn.x, leftBtn.y, btnR, "\u25C0", foundLT);
      drawArcadeBtn(ctx, rightBtn.x, rightBtn.y, btnR, "\u25B6", foundRT);
      drawArcadeBtn(ctx, thrustBtn.x, thrustBtn.y, btnR, "\u25B2", foundCT);
    }

    // ── HUD (drawn in screen space, on top of everything) ──
    const hudSize = isMobile ? 14 : 22;
    const hudLine = isMobile ? 22 : 32;
    const hudPad = 12;

    if (gameStage === 0) {
      ctx.font = `${hudSize}px 'PixelHackers', monospace`;
      ctx.fillStyle = "#ffffff";

      // ── Left column (top-left) ──
      ctx.textAlign = "left";
      const scoreStr = String(myScore).padStart(4, "0");
      const elapsed = (performance.now() - roundStartTime) / 1000;
      const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const secs = String(Math.floor(elapsed % 60)).padStart(2, "0");
      const fuelStr = String(Math.floor(myFuel));

      ctx.fillText(`SCORE    ${scoreStr}`, hudPad, hudLine);
      ctx.fillText(`TIME     ${mins} ${secs}`, hudPad, hudLine * 2);
      ctx.fillText(`FUEL     ${fuelStr}`, hudPad, hudLine * 3);

      // ── Right column (top-right) ──
      ctx.textAlign = "right";
      const alt = Math.floor(myLander.y);
      const absVx = Math.floor(Math.abs(myLander.vx));
      const absVy = Math.floor(Math.abs(myLander.vy));
      const hArrow = myLander.vx >= 0 ? "\u2192" : "\u2190";
      const vArrow = myLander.vy >= 0 ? "\u2191" : "\u2193";

      ctx.fillText(`ALTITUDE  ${alt}`, w - hudPad, hudLine);
      ctx.fillText(`HORIZONTAL SPEED  ${absVx} ${hArrow}`, w - hudPad, hudLine * 2);
      ctx.fillText(`VERTICAL SPEED  ${absVy} ${vArrow}`, w - hudPad, hudLine * 3);
    }

    // Win/crash overlay
    ctx.textAlign = "center";
    ctx.font = `${isMobile ? 32 : 48}px 'PixelHackers', monospace`;
    if (myLander.a === 1) {
      ctx.fillStyle = "#00ff64";
      ctx.fillText("LANDED", w / 2, h / 3);
    } else if (myLander.a === 2) {
      ctx.fillStyle = "#ff5050";
      ctx.fillText("CRASHED", w / 2, h / 3);
    }

    // Endgame countdown (centered below win/crash overlay to avoid HUD overlap)
    if (endgameActive && gameStage === 0) {
      const elapsedEnd = (performance.now() - endgameStartTime) / 1000;
      const remaining = Math.max(0, 6 - elapsedEnd);
      ctx.textAlign = "center";
      ctx.font = `${hudSize}px 'PixelHackers', monospace`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`NEW ROUND: ${remaining.toFixed(1)}`, w / 2, h / 3 + (isMobile ? 48 : 64));
    }

    if (gameStage === 1) {
      ctx.textAlign = "center";
      ctx.font = `${isMobile ? 24 : 36}px 'PixelHackers', monospace`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText("WAITING FOR NEXT ROUND", w / 2, h / 2);
    }

    // Connection indicator
    if (!connected) {
      ctx.textAlign = "center";
      ctx.font = `${isMobile ? 16 : 24}px 'PixelHackers', monospace`;
      ctx.fillStyle = "#ff5050";
      ctx.fillText("CONNECTING...", w / 2, h - (isMobile ? 16 : 32));
    }

    ctx.restore(); // dpr scale
  }

  animationId = requestAnimationFrame(loop);

  // ── Cleanup ──
  return () => {
    cancelAnimationFrame(animationId);
    socket.close();
    window.removeEventListener("resize", resize);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    canvas.removeEventListener("touchstart", handleTouch);
    canvas.removeEventListener("touchmove", handleTouch);
    canvas.removeEventListener("touchend", handleTouch);
    canvas.removeEventListener("touchcancel", handleTouch);
  };
}
