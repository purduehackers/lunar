import { Server, type Connection } from "partyserver";

const COLORS: [number, number, number][] = [
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

export class GameServer extends Server<Env> {
  seed: number = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  stage: number = 1;
  colorIndex: number = 0;
  playerStates: Map<string, number> = new Map();
  endgameTimer: ReturnType<typeof setTimeout> | null = null;

  onConnect(connection: Connection) {
    const color = COLORS[this.colorIndex % COLORS.length];
    this.colorIndex++;
    connection.setState({ color });

    const players: Record<string, { color: [number, number, number] }> = {};
    for (const conn of this.getConnections()) {
      if (conn.id === connection.id) continue;
      const st = conn.state as { color?: [number, number, number] };
      if (st?.color) players[conn.id] = { color: st.color };
    }

    connection.send(
      JSON.stringify({
        type: "init",
        id: connection.id,
        color,
        seed: this.seed,
        stage: this.stage,
        players,
      })
    );

    this.broadcast(
      JSON.stringify({
        type: "player_join",
        id: connection.id,
        color,
      }),
      [connection.id]
    );

    // If we're in waiting stage, kick off a new round now that someone joined
    if (this.stage === 1) {
      this.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      this.stage = 0;
      this.playerStates.clear();
      this.broadcast(
        JSON.stringify({ type: "new_round", seed: this.seed })
      );
    }
  }

  onMessage(connection: Connection, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (data.type === "update") {
      const st = connection.state as { color: [number, number, number] };
      this.playerStates.set(connection.id, data.a);

      this.broadcast(
        JSON.stringify({
          type: "update",
          id: connection.id,
          x: data.x,
          y: data.y,
          r: data.r,
          vx: data.vx,
          vy: data.vy,
          vr: data.vr,
          t: data.t,
          a: data.a,
          color: st.color,
        }),
        [connection.id]
      );

      this.checkEndgame();
    }

    if (data.type === "crash") {
      const st = connection.state as { color: [number, number, number] };
      this.broadcast(
        JSON.stringify({
          type: "crash",
          x: data.x,
          y: data.y,
          color: st.color,
        })
      );
    }
  }

  onClose(connection: Connection) {
    this.playerStates.delete(connection.id);
    this.broadcast(
      JSON.stringify({
        type: "player_leave",
        id: connection.id,
      })
    );
    this.checkEndgame();
  }

  checkEndgame() {
    if (this.stage !== 0) return;
    if (this.playerStates.size === 0) return;

    let allDone = true;
    for (const [, a] of this.playerStates) {
      if (a === 0) {
        allDone = false;
        break;
      }
    }

    if (allDone && !this.endgameTimer) {
      this.endgameTimer = setTimeout(() => this.startNewRound(), 6000);
      this.broadcast(JSON.stringify({ type: "endgame_start" }));
    } else if (!allDone && this.endgameTimer) {
      clearTimeout(this.endgameTimer);
      this.endgameTimer = null;
      this.broadcast(JSON.stringify({ type: "endgame_cancel" }));
    }
  }

  startNewRound() {
    this.endgameTimer = null;
    this.stage = 1;
    this.broadcast(JSON.stringify({ type: "stage", stage: 1 }));

    setTimeout(() => {
      this.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      this.stage = 0;
      this.playerStates.clear();
      this.broadcast(
        JSON.stringify({ type: "new_round", seed: this.seed })
      );
    }, 4000);
  }
}
