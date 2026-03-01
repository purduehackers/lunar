import PartySocket from "partysocket";

// ─── Constants ────────────────────────────────────────────────

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 400;
const THRUST_POWER = 8;
const GRAVITY = 4;
const S = 2; // ship scale factor (2x for CRT visibility)
const MAX_ZOOM = 4;
const UPDATE_INTERVAL = 100; // ms between network updates

// ─── Types ────────────────────────────────────────────────────

interface Lander {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  vr: number;
  t: number;
  a: number; // 0=flying, 1=landed, 2=crashed
  color: [number, number, number];
}

interface CrashEffect {
  x: number;
  y: number;
  time: number;
  color: [number, number, number];
}

interface Grave {
  x: number;
  y: number;
  color: [number, number, number];
}

type MapLine = [number, number, number, number];

// ─── Seeded PRNG (mulberry32) ─────────────────────────────────

function createRng(seed: number) {
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

function generateTerrain(seed: number): MapLine[] {
  const rng = createRng(seed);
  const lines: MapLine[] = [];

  const numLandingPoints = rng.randomInt(5, 15);

  const offsets: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  const intermediateHeights: number[] = [];
  let totalWidth = 0;

  for (let i = 0; i <= numLandingPoints; i++) {
    offsets[i] = rng.random(10, MAP_WIDTH / numLandingPoints);
    widths[i] = rng.random(36, 80);
    heights[i] = rng.random(0, MAP_HEIGHT / 2);
    intermediateHeights[i] = rng.random(0, MAP_HEIGHT);
    totalWidth += offsets[i];
  }

  const fudge = (MAP_WIDTH - totalWidth) / (numLandingPoints + 1);
  let accum = 0;

  // Landing platforms (flat segments)
  for (let i = 0; i < numLandingPoints; i++) {
    accum += offsets[i] + fudge;
    lines.push([accum, -heights[i], accum + widths[i], -heights[i]]);
  }

  // Connecting terrain pillars
  accum = offsets[0] + fudge;
  const firstPillarX = accum / 2;
  const firstPillarY = -intermediateHeights[0];

  lines.push([firstPillarX, firstPillarY, accum, -heights[0]]);

  for (let i = 1; i < numLandingPoints; i++) {
    const midX =
      (accum + accum + offsets[i] + fudge) / 2;

    lines.push([
      accum + widths[i - 1],
      -heights[i - 1],
      midX,
      -intermediateHeights[i],
    ]);

    accum += offsets[i] + fudge;

    lines.push([accum, -heights[i], midX, -intermediateHeights[i]]);
  }

  lines.push([
    accum + widths[numLandingPoints - 1],
    -heights[numLandingPoints - 1],
    firstPillarX + MAP_WIDTH,
    firstPillarY,
  ]);

  return lines;
}

// ─── Default Lander ───────────────────────────────────────────

function createDefaultLander(
  color: [number, number, number] = [255, 255, 255]
): Lander {
  return {
    x: -15,
    y: 600,
    r: -Math.PI / 2,
    vx: 100,
    vy: 0,
    vr: 0,
    t: 0,
    a: 0,
    color,
  };
}

// ─── Physics ──────────────────────────────────────────────────

function updateLanderPhysics(l: Lander, dt: number) {
  if (l.a !== 0) {
    l.vx = 0;
    l.vy = 0;
    l.vr = 0;
    return;
  }

  l.x += l.vx * dt;
  l.y += l.vy * dt;
  l.r += l.vr * dt;
  l.vx += Math.sin(l.r) * l.t * THRUST_POWER * dt;
  l.vy += Math.cos(l.r) * l.t * THRUST_POWER * dt - GRAVITY * dt;

  if (l.x > MAP_WIDTH) l.x -= MAP_WIDTH;
  if (l.x < 0) l.x += MAP_WIDTH;
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
  y4: number
): boolean {
  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  const uA = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const uB = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;
  return uA >= 0 && uA <= 1 && uB >= 0 && uB <= 1;
}

function checkCollision(l: Lander, mapLines: MapLine[]): boolean {
  const cr = Math.cos(l.r);
  const sr = Math.sin(l.r);
  const hs = 8 * S; // half-span (wing)
  const h = 16 * S; // height

  // Wing tips in screen coordinates
  const ax = l.x - hs * cr;
  const ay = -l.y - hs * sr;
  const bx = l.x + hs * cr;
  const by = -l.y + hs * sr;

  // "Up" direction from ship (wing → cockpit)
  const upX = h * sr;
  const upY = -h * cr;

  // Top corners
  const dx = ax + upX;
  const dy = ay + upY;
  const cx = bx + upX;
  const cy = by + upY;

  // Check 4 hitbox segments against terrain (with map wrapping)
  for (let offset = -1; offset <= 1; offset++) {
    const ox = offset * MAP_WIDTH;
    for (const line of mapLines) {
      const lx1 = line[0] + ox;
      const ly1 = line[1];
      const lx2 = line[2] + ox;
      const ly2 = line[3];
      if (
        lineIntersects(lx1, ly1, lx2, ly2, ax, ay, bx, by) ||
        lineIntersects(lx1, ly1, lx2, ly2, ax, ay, dx, dy) ||
        lineIntersects(lx1, ly1, lx2, ly2, dx, dy, cx, cy) ||
        lineIntersects(lx1, ly1, lx2, ly2, bx, by, cx, cy)
      ) {
        return true;
      }
    }
  }
  return false;
}

// ─── Drawing Helpers ──────────────────────────────────────────

function drawLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawQuad(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  x4: number,
  y4: number
) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.lineTo(x4, y4);
  ctx.closePath();
  ctx.stroke();
}

// ─── Ship Rendering ──────────────────────────────────────────

function drawShip(
  ctx: CanvasRenderingContext2D,
  l: Lander,
  scale: number,
  frameCount: number
) {
  ctx.save();
  const [r, g, b] = l.color;
  ctx.strokeStyle = `rgb(${r},${g},${b})`;
  ctx.lineWidth = 3 / scale;
  ctx.translate(l.x, -l.y);
  ctx.rotate(l.r);

  // Wings
  drawLine(ctx, -8 * S, 0, -5 * S, 0);
  drawLine(ctx, 5 * S, 0, 8 * S, 0);

  // Landing legs
  drawLine(ctx, -6.5 * S, 0, -3.5 * S, -4 * S);
  drawLine(ctx, 6.5 * S, 0, 3.5 * S, -4 * S);

  // Undercarriage / leg connectors
  drawLine(ctx, 2 * S, -4 * S, 3 * S, -1.5 * S);
  drawLine(ctx, 3 * S, -1.5 * S, -3 * S, -1.5 * S);
  drawLine(ctx, -3 * S, -1.5 * S, -2 * S, -4 * S);

  // Cabin
  drawQuad(
    ctx,
    -4.5 * S,
    -5.5 * S,
    4.5 * S,
    -5.5 * S,
    4.5 * S,
    -4 * S,
    -4.5 * S,
    -4 * S
  );

  // Cockpit
  drawLine(ctx, -2 * S, -5.5 * S, -4 * S, -7.5 * S);
  drawLine(ctx, -4 * S, -7.5 * S, -4 * S, -11.5 * S);
  drawLine(ctx, -4 * S, -11.5 * S, -2 * S, -13.5 * S);
  drawLine(ctx, -2 * S, -13.5 * S, 2 * S, -13.5 * S);
  drawLine(ctx, 2 * S, -13.5 * S, 4 * S, -11.5 * S);
  drawLine(ctx, 4 * S, -11.5 * S, 4 * S, -7.5 * S);
  drawLine(ctx, 4 * S, -7.5 * S, 2 * S, -5.5 * S);

  // Engine flame (only when flying and thrusting)
  if (l.a === 0 && l.t > 0) {
    const flicker = Math.sin(frameCount * 0.5) * 3 * S * l.t;
    const flameLen = -1.5 * S + flicker + 10 * S * l.t;
    drawLine(ctx, -2 * S, -1.5 * S, 0, flameLen);
    drawLine(ctx, 2 * S, -1.5 * S, 0, flameLen);
  }

  ctx.restore();
}

// ─── Terrain Rendering ───────────────────────────────────────

function drawTerrain(
  ctx: CanvasRenderingContext2D,
  mapLines: MapLine[],
  scale: number,
  offset: number
) {
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3 / scale;
  ctx.beginPath();
  for (const line of mapLines) {
    ctx.moveTo(line[0] + offset * MAP_WIDTH, line[1]);
    ctx.lineTo(line[2] + offset * MAP_WIDTH, line[3]);
  }
  ctx.stroke();
}

// ─── Crash Effect ─────────────────────────────────────────────

function drawCrashEffect(
  ctx: CanvasRenderingContext2D,
  crash: CrashEffect,
  scale: number
) {
  ctx.save();
  const [r, g, b] = crash.color;
  ctx.strokeStyle = `rgb(${r},${g},${b})`;
  ctx.lineWidth = 5 / scale;
  ctx.translate(crash.x, -crash.y);

  for (let i = 0; i < Math.PI * 2; i += Math.PI / 4) {
    const innerR = 0.008 * crash.time;
    const outerR = 0.02 * crash.time;
    drawLine(
      ctx,
      Math.sin(i + Math.PI / 8) * innerR,
      Math.cos(i + Math.PI / 8) * innerR,
      Math.sin(i) * outerR,
      Math.cos(i) * outerR
    );
    drawLine(
      ctx,
      Math.sin(i - Math.PI / 8) * innerR,
      Math.cos(i - Math.PI / 8) * innerR,
      Math.sin(i) * outerR,
      Math.cos(i) * outerR
    );
  }

  ctx.restore();
}

// ─── Grave Rendering ──────────────────────────────────────────

function drawGrave(
  ctx: CanvasRenderingContext2D,
  grave: Grave,
  scale: number
) {
  ctx.save();
  const [r, g, b] = grave.color;
  ctx.strokeStyle = `rgb(${r},${g},${b})`;
  ctx.lineWidth = 3 / scale;
  ctx.translate(grave.x, -grave.y);

  const s = 6;
  // Vertical bar
  drawLine(ctx, 0, -s * 2.5, 0, 0);
  // Horizontal bar
  drawLine(ctx, -s, -s * 1.8, s, -s * 1.8);

  ctx.restore();
}

// ─── Main Game ────────────────────────────────────────────────

export function startGame(canvas: HTMLCanvasElement, workerHost: string) {
  const ctx = canvas.getContext("2d")!;

  // ── State ──
  let myColor: [number, number, number] = [255, 255, 255];
  let myLander = createDefaultLander(myColor);
  const remoteLanders = new Map<string, Lander>();
  let crashes: CrashEffect[] = [];
  let graves: Grave[] = [];
  let mapLines: MapLine[] = [];
  let mapSeed = 1;
  let gameStage = 1;
  let myId = "";
  let frameCount = 0;
  let lastTime = 0;
  let lastUpdateTime = 0;
  let endgameStartTime = 0;
  let endgameActive = false;

  // ── Input ──
  const keysDown = new Set<string>();

  window.addEventListener("keydown", (e) => {
    keysDown.add(e.key);
    if (
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)
    ) {
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => keysDown.delete(e.key));

  // Touch input
  let activeTouches: { x: number }[] = [];
  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    activeTouches = Array.from(e.touches).map((t) => ({ x: t.clientX }));
  });
  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    activeTouches = Array.from(e.touches).map((t) => ({ x: t.clientX }));
  });
  canvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    activeTouches = Array.from(e.touches).map((t) => ({ x: t.clientX }));
  });
  canvas.addEventListener("touchcancel", (e) => {
    e.preventDefault();
    activeTouches = [];
  });

  // ── Resize ──
  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener("resize", resize);

  // ── Load font ──
  const fontFace = new FontFace("Vectrex", "url(/vectrex-bold.ttf)");
  fontFace
    .load()
    .then((f) => document.fonts.add(f))
    .catch(() => {});

  // ── Network ──
  const socket = new PartySocket({
    host: workerHost,
    party: "game-server",
    room: "main",
  });

  socket.addEventListener("message", (e) => {
    let data: any;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }

    switch (data.type) {
      case "init":
        myId = data.id;
        myColor = data.color;
        myLander.color = data.color;
        mapSeed = data.seed;
        gameStage = data.stage;
        mapLines = generateTerrain(mapSeed);
        for (const [id, player] of Object.entries(
          data.players as Record<string, { color: [number, number, number] }>
        )) {
          remoteLanders.set(id, createDefaultLander(player.color));
        }
        break;

      case "player_join":
        remoteLanders.set(data.id, createDefaultLander(data.color));
        break;

      case "update":
        if (data.id === myId) break;
        remoteLanders.set(data.id, {
          x: data.x,
          y: data.y,
          r: data.r,
          vx: data.vx,
          vy: data.vy,
          vr: data.vr,
          t: data.t,
          a: data.a,
          color: data.color,
        });
        break;

      case "crash":
        crashes.push({
          x: data.x,
          y: data.y,
          time: 0,
          color: data.color,
        });
        graves.push({
          x: data.x,
          y: data.y,
          color: data.color,
        });
        break;

      case "player_leave":
        remoteLanders.delete(data.id);
        break;

      case "new_round":
        mapSeed = data.seed;
        mapLines = generateTerrain(mapSeed);
        gameStage = 0;
        myLander = createDefaultLander(myColor);
        remoteLanders.clear();
        crashes = [];
        graves = [];
        endgameActive = false;
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

  // ── Game Loop ──
  function loop(time: number) {
    const rawDt = lastTime === 0 ? 0.016 : (time - lastTime) / 1000;
    const dt = Math.min(rawDt, 0.05); // cap to prevent huge jumps
    lastTime = time;
    frameCount++;

    // ── Handle Input ──
    let vr = 0;
    let foundLT = false;
    let foundRT = false;
    let foundCT = false;

    for (const touch of activeTouches) {
      if (touch.x < canvas.width / 3) foundLT = true;
      else if (touch.x < (canvas.width * 2) / 3) foundCT = true;
      else foundRT = true;
    }

    if (
      keysDown.has("ArrowLeft") ||
      keysDown.has("a") ||
      keysDown.has("A") ||
      foundLT
    )
      vr -= 1;
    if (
      keysDown.has("ArrowRight") ||
      keysDown.has("d") ||
      keysDown.has("D") ||
      foundRT
    )
      vr += 1;
    myLander.vr = vr;

    if (
      keysDown.has("ArrowUp") ||
      keysDown.has("w") ||
      keysDown.has("W") ||
      foundCT
    ) {
      myLander.t = 1;
    } else {
      myLander.t = 0;
    }

    // ── Physics & Collisions ──
    if (gameStage === 0) {
      updateLanderPhysics(myLander, dt);

      // Collision detection
      if (myLander.a === 0) {
        if (checkCollision(myLander, mapLines)) {
          if (
            Math.abs(myLander.vx) < 1.5 &&
            myLander.vy > -5 &&
            myLander.vy <= 0
          ) {
            myLander.a = 1; // landed!
          } else {
            myLander.a = 2; // crashed
            socket.send(
              JSON.stringify({
                type: "crash",
                x: myLander.x,
                y: myLander.y,
              })
            );
          }
        } else if (myLander.y > 1000 || myLander.y < -5) {
          // Out of bounds
          myLander.a = 2;
          socket.send(
            JSON.stringify({
              type: "crash",
              x: myLander.x,
              y: myLander.y,
            })
          );
        }
      }

      // Update remote landers (client-side prediction)
      for (const [, lander] of remoteLanders) {
        updateLanderPhysics(lander, dt);
      }
    } else {
      // Waiting stage: reset lander each frame (matches original behavior)
      myLander = createDefaultLander(myColor);
    }

    // ── Network Update ──
    if (time - lastUpdateTime > UPDATE_INTERVAL && gameStage === 0) {
      lastUpdateTime = time;
      socket.send(
        JSON.stringify({
          type: "update",
          x: myLander.x,
          y: myLander.y,
          r: myLander.r,
          vx: myLander.vx,
          vy: myLander.vy,
          vr: myLander.vr,
          t: myLander.t,
          a: myLander.a,
        })
      );
    }

    // ── Render ──
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Camera setup
    ctx.save();
    let camS: number;

    if (gameStage === 0) {
      const camX = -myLander.x;
      const camY = myLander.y;
      camS = Math.min(canvas.height / 2 / Math.max(myLander.y, 50), MAX_ZOOM);

      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.scale(camS, camS);
      ctx.translate(camX, camY);
    } else {
      // Overview camera
      const camX = -MAP_WIDTH / 2;
      let camY: number;
      if (canvas.width > canvas.height) {
        camY = canvas.height / 2;
        camS = canvas.height / 2 / 600;
      } else {
        camY = canvas.width / 2;
        camS = canvas.width / 2 / 600;
      }

      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.scale(camS, camS);
      ctx.translate(camX, camY);
    }

    // Terrain (3 instances for horizontal wrapping)
    drawTerrain(ctx, mapLines, camS, -1);
    drawTerrain(ctx, mapLines, camS, 0);
    drawTerrain(ctx, mapLines, camS, 1);

    // Graves
    for (const grave of graves) {
      drawGrave(ctx, grave, camS);
    }

    // Remote landers
    for (const [, lander] of remoteLanders) {
      if (lander.a !== 2) {
        drawShip(ctx, lander, camS, frameCount);
      }
    }

    // My lander
    if (myLander.a !== 2) {
      drawShip(ctx, myLander, camS, frameCount);
    }

    // Crash effects
    crashes = crashes.filter((c) => {
      c.time += rawDt * 1000;
      if (c.time >= 1000) return false;
      drawCrashEffect(ctx, c, camS);
      return true;
    });

    ctx.restore();

    // ── HUD (drawn in screen space) ──
    ctx.font = "28px Vectrex, monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";

    if (gameStage === 0) {
      ctx.fillText(`ALT: ${myLander.y.toFixed(1)}`, 16, 40);
      ctx.fillText(`HSPD: ${myLander.vx.toFixed(1)}`, 16, 76);
      ctx.fillText(`VSPD: ${myLander.vy.toFixed(1)}`, 16, 112);
    }

    // Win/crash overlay
    ctx.textAlign = "center";
    ctx.font = "48px Vectrex, monospace";
    if (myLander.a === 1) {
      ctx.fillStyle = "#00ff64";
      ctx.fillText("LANDED", canvas.width / 2, canvas.height / 2);
    } else if (myLander.a === 2) {
      ctx.fillStyle = "#ff5050";
      ctx.fillText("CRASHED", canvas.width / 2, canvas.height / 2);
    }

    // Endgame countdown
    if (endgameActive && gameStage === 0) {
      const elapsed = (performance.now() - endgameStartTime) / 1000;
      const remaining = Math.max(0, 6 - elapsed);
      ctx.textAlign = "left";
      ctx.font = "28px Vectrex, monospace";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`NEW ROUND: ${remaining.toFixed(1)}`, 16, 148);
    }

    if (gameStage === 1) {
      ctx.textAlign = "center";
      ctx.font = "36px Vectrex, monospace";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(
        "WAITING FOR NEXT ROUND",
        canvas.width / 2,
        canvas.height / 2
      );
    }

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);

  return () => {
    socket.close();
    window.removeEventListener("resize", resize);
  };
}
