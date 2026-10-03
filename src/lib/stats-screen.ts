import type { PilotStats, SessionStats } from "./session-stats";

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function createStatsScreen(startSession: (name: string) => void): {
  update: (stats: SessionStats | null) => void;
  toggle: () => void;
  hide: () => void;
  destroy: () => void;
} {
  const screen = document.createElement("section");
  screen.className = "session-stats";
  screen.hidden = true;
  screen.setAttribute("aria-label", "Current session statistics");
  screen.innerHTML = `
    <header><div><h1>SESSION STATS</h1></div><button type="button">S / BACK TO FLIGHT</button></header>
    <div class="stats-totals">
      <div><span>SHIPS JOINED</span><strong data-stat="joined">0</strong></div>
      <div><span>SHIPS LANDED</span><strong data-stat="landed">0</strong></div>
      <div><span>SHIPS CRASHED</span><strong data-stat="crashed">0</strong></div>
    </div>
    <div class="stats-records"></div>
    <footer><span>S TO RETURN · Q TO END SESSION</span></footer>`;
  const style = document.createElement("style");
  style.textContent = `
    .session-setup[hidden] { display: none; }
    .session-setup, .session-setup * { box-sizing: border-box; margin: 0; padding: 0; }
    .session-setup { position: fixed; inset: 0; z-index: 4; overflow-y: auto; background: #000; color: #fff; font-family: 'PixelHackers', monospace; touch-action: pan-y; }
    .session-setup form { min-height: 100%; display: grid; place-content: center; gap: 24px; padding: 24px; }
    .session-setup .session-game-title { margin-bottom: 20px; color: #fff; font-size: clamp(32px, 7vw, 72px); font-weight: normal; line-height: 1.25; letter-spacing: -0.04em; text-align: center; text-transform: uppercase; text-shadow: 1px 1px 0 #ccc, 2px 2px 0 #ccc, 3px 3px 0 #999, 4px 4px 0 #999, 5px 5px 0 #666, 6px 6px 0 #666, 7px 7px 0 #333, 8px 8px 0 #333; }
    .session-setup h2 { font-size: clamp(24px, 5vw, 40px); font-weight: normal; }
    .session-setup label { font-size: 16px; }
    .session-setup input, .session-setup button { width: min(100%, 420px); min-height: 52px; padding: 14px 16px; border: 2px solid #fff; border-radius: 0; font: 20px 'PixelHackers', monospace; touch-action: manipulation; }
    .session-setup input { background: #000; color: #fff; }
    .session-setup button { background: #fff; color: #000; cursor: pointer; }
    .session-setup button:disabled { opacity: 0.6; cursor: wait; }
    .session-setup input:focus-visible, .session-setup button:focus-visible { outline: 2px solid #00ff64; outline-offset: 4px; }
    .session-setup .session-status { font-size: 12px; line-height: 1.7; }
    .session-setup .session-status:empty { display: none; }
    @media (max-width: 600px) {
      .session-setup form { grid-template-columns: minmax(0, 420px); }
      .session-setup .session-game-title { font-size: clamp(40px, 12vw, 64px); text-wrap: balance; }
    }
    .session-stats[hidden] { display: none; }
    .session-stats { position: fixed; inset: 0; z-index: 3; overflow: auto; background: #080808; color: #f5f5f5; padding: clamp(24px, 4vw, 64px); font-family: 'PixelHackers', monospace; touch-action: pan-y; }
    .session-stats header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 40px; }
    .session-stats header p, .session-stats footer { color: #aaa; font-size: 12px; line-height: 1.6; }
    .session-stats h1 { font-size: clamp(28px, 4vw, 56px); font-weight: normal; margin-top: 16px; }
    .session-stats button { background: transparent; color: inherit; border: 1px solid #666; padding: 14px; font: 12px 'PixelHackers', monospace; cursor: pointer; touch-action: manipulation; }
    .session-stats button:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 4px; }
    .stats-totals { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 2px solid #f5f5f5; border-bottom: 1px solid #555; margin-bottom: 20px; }
    .stats-totals > div { padding: 24px 0; }
    .stats-totals span { display: block; font-size: clamp(10px, 1.2vw, 16px); color: #aaa; }
    .stats-totals strong { display: block; margin-top: 18px; font-weight: normal; font-size: clamp(36px, 5vw, 72px); }
    .stats-record { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 0.7fr); gap: 24px; align-items: center; padding: 22px 0; border-bottom: 1px solid #333; font-size: clamp(14px, 1.7vw, 24px); line-height: 1.5; }
    .stats-record dt { color: #aaa; font-size: clamp(11px, 1vw, 14px); }
    .stats-record dd { margin: 0; overflow-wrap: anywhere; }
    .stats-record .stats-value { text-align: right; white-space: nowrap; }
    .session-stats footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 28px; }
    @media (max-width: 650px) { .session-stats header { flex-direction: column; } .stats-record { grid-template-columns: 1fr auto; gap: 8px; } .stats-record dt { grid-column: 1 / -1; } .session-stats footer { flex-direction: column; } }
  `;
  document.head.appendChild(style);
  document.body.appendChild(screen);
  const setup = document.createElement("section");
  setup.className = "session-setup";
  setup.hidden = true;
  setup.setAttribute("aria-label", "Create a session");
  setup.innerHTML = `
    <form>
      <h1 class="session-game-title">Lunar Lander</h1>
      <h2>START A SESSION</h2>
      <label for="session-name">SESSION NAME</label>
      <input id="session-name" name="session-name" type="text" maxlength="24" required autocomplete="off" placeholder="Hack Night" />
      <button type="submit">START SESSION</button>
      <p class="session-status" role="status"></p>
    </form>`;
  document.body.appendChild(setup);
  const sessionInput = setup.querySelector("input")!;
  const sessionSubmit = setup.querySelector("button")!;
  sessionInput.addEventListener("input", () => sessionInput.setCustomValidity(""));
  let pending = false;
  let pendingTimer = 0;
  setup.querySelector("form")!.addEventListener("submit", event => {
    event.preventDefault();
    const name = sessionInput.value.replace(/\s+/g, " ").trim();
    if (!name) {
      sessionInput.setCustomValidity("Enter a session name.");
      sessionInput.reportValidity();
      return;
    }
    if (pending) return;
    pending = true;
    sessionSubmit.disabled = true;
    setup.querySelector(".session-status")!.textContent = "STARTING SESSION...";
    startSession(name);
    pendingTimer = window.setTimeout(() => {
      pending = false;
      sessionSubmit.disabled = false;
      setup.querySelector(".session-status")!.textContent = "COULD NOT CONNECT. TRY AGAIN.";
    }, 5000);
  });
  const records = screen.querySelector(".stats-records")!;
  const definitions: { label: string; value: (p: PilotStats, now: number) => number; format: (value: number) => string; smallest?: boolean }[] = [
    { label: "FASTEST LANDING", value: p => p.fastestMs ?? 0, format: v => `${(v / 1000).toFixed(2)}s`, smallest: true },
    { label: "LONGEST LANDING STREAK", value: p => p.bestStreak, format: v => `${v} IN A ROW` },
    { label: "MOST LANDINGS", value: p => p.landed, format: String },
    { label: "MOST CRASHES", value: p => p.crashed, format: String },
    { label: "LONGEST TIME PLAYING", value: (p, now) => p.playedMs + (p.connections ? Math.max(0, now - p.activeSince) : 0), format: duration },
  ];
  const rows = definitions.map(({label}) => {
    const row = document.createElement("dl");
    row.className = "stats-record";
    const title = document.createElement("dt");
    title.textContent = label;
    const name = document.createElement("dd");
    const value = document.createElement("dd");
    value.className = "stats-value";
    row.appendChild(title);
    row.appendChild(name);
    row.appendChild(value);
    records.appendChild(row);
    return { name, value };
  });
  const toggleButton = document.createElement("button");
  toggleButton.textContent = "S / STATS · Q / END SESSION";
  toggleButton.style.cssText = "position:fixed;bottom:16px;left:16px;z-index:2;background:#080808;color:#f5f5f5;border:1px solid #666;padding:12px;font:12px PixelHackers,monospace;cursor:pointer;touch-action:manipulation";
  toggleButton.hidden = true;
  function toggle(): void {
    if (!latest) return;
    screen.hidden = !screen.hidden;
    toggleButton.hidden = !screen.hidden;
    if (!screen.hidden) (screen.querySelector("button") as HTMLButtonElement).focus();
    render();
  }
  toggleButton.addEventListener("click", toggle);
  let latest: SessionStats | null = null;
  let receivedAt = 0;
  function render(): void {
    if (!latest || screen.hidden) return;
    const now = Math.min(latest.expiresAt, latest.updatedAt + performance.now() - receivedAt);
    screen.querySelector("h1")!.textContent = latest.name;
    for (const key of ["joined", "landed", "crashed"] as const) {
      screen.querySelector(`[data-stat="${key}"]`)!.textContent = String(latest[key]);
    }
    definitions.forEach((definition, index) => {
      const candidates = latest!.pilots.filter(p => definition.smallest ? p.fastestMs !== null : definition.value(p, now) > 0);
      candidates.sort((a, b) => (definition.smallest ? 1 : -1) * (definition.value(a, now) - definition.value(b, now)));
      const winner = candidates[0];
      const value = winner ? definition.value(winner, now) : 0;
      const tied = candidates.filter(p => definition.value(p, now) === value);
      rows[index].name.textContent = winner ? tied.map(p => p.name).join(" / ") : "NO RECORD YET";
      rows[index].value.textContent = winner ? definition.format(value) : "—";
    });
  }
  function hide(): void { screen.hidden = true; toggleButton.hidden = !latest; if (latest) toggleButton.focus(); }
  screen.querySelector("button")!.addEventListener("click", hide);
  const timer = window.setInterval(render, 1000);
  return {
    update(stats) {
      const wasSetup = !setup.hidden;
      clearTimeout(pendingTimer);
      pending = false;
      sessionSubmit.disabled = false;
      setup.querySelector(".session-status")!.textContent = "";
      if (!stats && latest) sessionInput.value = "";
      latest = stats;
      receivedAt = performance.now();
      setup.hidden = stats !== null;
      toggleButton.hidden = !stats || !screen.hidden;
      if (!stats) {
        screen.hidden = true;
        if (!wasSetup) sessionInput.focus();
      } else if (wasSetup) {
        toggleButton.focus();
      }
      render();
    },
    toggle,
    hide,
    destroy() { clearInterval(timer); clearTimeout(pendingTimer); screen.remove(); setup.remove(); style.remove(); toggleButton.remove(); },
  };
}
