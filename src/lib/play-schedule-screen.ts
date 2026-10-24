import type { PlaySchedule } from "./play-schedule";

export function createPlayScheduleScreen(display: boolean) {
  const pause = document.createElement("section");
  pause.className = "play-pause";
  pause.hidden = true;
  pause.setAttribute("aria-label", "Hack Night play schedule");
  pause.innerHTML = `
    <p class="play-eyebrow">HACK NIGHT</p>
    <h1>TIME TO HACK</h1>
    <p>Lunar Lander is paused.</p>
    <div class="play-countdown"><p>PLAY RESUMES IN</p><output role="timer" aria-live="off"></output></div>`;
  const status = document.createElement("aside");
  status.className = `play-status${display ? " play-status-display" : ""}`;
  status.hidden = true;
  status.setAttribute("aria-label", "Hack Night play window");
  const style = document.createElement("style");
  style.textContent = `
    .play-pause[hidden], .play-status[hidden] { display: none; }
    .play-pause, .play-status { box-sizing: border-box; font-family: 'PixelHackers', monospace; }
    .play-pause { position: fixed; inset: 0; z-index: 2; display: grid; place-content: center; gap: 20px; padding: 24px 24px 80px; overflow-y: auto; background: #000; color: #fff; text-align: center; touch-action: pan-y; }
    .play-pause p, .play-pause h1 { margin: 0; }
    .play-pause p { font-size: clamp(12px, 2vw, 18px); line-height: 1.7; }
    .play-pause .play-eyebrow { color: #00ff64; letter-spacing: 0.12em; }
    .play-pause h1 { font-size: clamp(28px, 6vw, 64px); font-weight: normal; line-height: 1.3; }
    .play-countdown { margin: 20px 0; }
    .play-countdown p { color: #aaa; }
    .play-countdown output { display: block; margin-top: 16px; font-size: clamp(48px, 14vw, 128px); line-height: 1.2; font-variant-numeric: tabular-nums; }
    .play-status { position: fixed; bottom: max(16px, env(safe-area-inset-bottom)); left: 50%; z-index: 1; transform: translateX(-50%); width: max-content; max-width: calc(100% - 32px); padding: 10px 14px; background: #000; color: #00ff64; border: 1px solid #444; font-size: clamp(10px, 1.5vw, 14px); line-height: 1.5; text-align: center; pointer-events: none; }
    .play-status-display { bottom: 72px; }
    @media (max-height: 550px) { .play-pause { gap: 10px; padding-top: 16px; } .play-countdown { margin: 4px 0; } .play-countdown output { font-size: 48px; margin-top: 8px; } }
  `;
  document.head.appendChild(style);
  document.body.appendChild(pause);
  document.body.appendChild(status);
  const countdown = pause.querySelector("output")!;
  let latest: PlaySchedule | null = null;
  let receivedAt = 0;

  function render(): void {
    pause.hidden = latest?.phase !== "paused";
    status.hidden = !latest || latest.phase === "paused";
    if (!latest) return;
    // Follow the server's clock, even when a player's device clock is wrong.
    const seconds = Math.max(0, Math.ceil((latest.changesAt - latest.serverNow - (performance.now() - receivedAt)) / 1000));
    const remaining = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    countdown.textContent = remaining;
    status.textContent = latest.phase === "before_start"
      ? `HACK NIGHT · PAUSES IN ${remaining}`
      : `PLAY TIME · ${remaining} LEFT`;
    // Only a server message can reopen play; reaching zero locally is insufficient.
    if (seconds === 0) {
      status.textContent = "WAITING FOR SERVER...";
      pause.querySelector(".play-countdown p")!.textContent = "WAITING TO RESUME...";
    } else {
      pause.querySelector(".play-countdown p")!.textContent = "PLAY RESUMES IN";
    }
  }

  const timer = window.setInterval(render, 250);
  return {
    update(schedule: PlaySchedule | null) {
      latest = schedule;
      receivedAt = performance.now();
      render();
    },
    destroy() { clearInterval(timer); pause.remove(); status.remove(); style.remove(); },
  };
}
