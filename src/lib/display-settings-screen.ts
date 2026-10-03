import type { SessionStats } from './session-stats';
import { LEADERBOARD_METRICS, type DisplayOptions, type LeaderboardMetric, rankPilots, leaderboardValue, formatLeaderboardValue } from './display-options';

export function createDisplaySettings(send: (sessionId: string, patch: { name?: string; options?: Partial<DisplayOptions> }) => void, quit: (sessionId: string) => void, onOpen: () => void) {
  const leaderboard = document.createElement('aside');
  leaderboard.className = 'display-leaderboard';
  leaderboard.hidden = true;
  leaderboard.setAttribute('aria-label', 'Session leaderboard');
  leaderboard.innerHTML = '<h2></h2><p class="leaderboard-metric"></p><ol></ol>';
  const screen = document.createElement('section');
  screen.className = 'display-settings';
  screen.hidden = true;
  screen.setAttribute('aria-label', 'Display options');
  screen.innerHTML = `
    <header><h1>OPTIONS</h1><button type="button" class="back">O / BACK TO FLIGHT</button></header>
    <div class="settings-fields">
      <form class="rename"><label for="option-session-name">SESSION NAME</label><div class="settings-input-row"><input id="option-session-name" maxlength="24" required /><button>SAVE NAME</button></div></form>
      <div class="settings-row"><label for="option-stat">LEADERBOARD STAT</label><select id="option-stat"></select></div>
      <div class="settings-row"><label for="option-leaderboard">SHOW LEADERBOARD</label><input id="option-leaderboard" type="checkbox" /></div>
      <div class="settings-row"><label for="option-qr">SHOW QR CODE</label><input id="option-qr" type="checkbox" /></div>
      <form class="qr-title"><label for="option-qr-title">QR CODE TITLE</label><div class="settings-input-row"><input id="option-qr-title" maxlength="48" required /><button>SAVE TITLE</button></div></form>
      <div class="settings-row"><span>END SESSION</span><button class="quit" type="button">QUIT SESSION</button></div>
    </div>`;
  const shortcut = document.createElement('button');
  shortcut.className = 'options-shortcut';
  shortcut.textContent = 'O / OPTIONS';
  shortcut.hidden = true;
  const style = document.createElement('style');
  style.textContent = `
    .display-leaderboard[hidden], .display-settings[hidden], .options-shortcut[hidden] { display:none; }
    .display-leaderboard, .display-leaderboard *, .display-settings, .display-settings * { box-sizing:border-box; }
    .display-leaderboard { position:fixed; top:max(16px, env(safe-area-inset-top)); left:max(16px, env(safe-area-inset-left)); z-index:1; width:clamp(190px,24vw,300px); padding:16px; background:rgba(0,0,0,.88); color:#f5f5f5; font-family:PixelHackers,monospace; pointer-events:none; }
    .display-leaderboard h2 { font-size:20px; font-weight:normal; line-height:1.3; margin:0 0 12px; overflow-wrap:anywhere; }
    .leaderboard-metric { font-size:10px; color:#aaa; margin:0 0 12px; }
    .display-leaderboard ol { list-style:none; padding:0; margin:0; }
    .display-leaderboard li { display:grid; grid-template-columns:20px minmax(0,1fr) auto; gap:8px; padding:8px 0; border-top:1px solid #444; font-size:12px; line-height:1.4; }
    .display-leaderboard .pilot-name { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .display-settings { position:fixed; inset:0; z-index:3; overflow:auto; padding:clamp(24px,4vw,64px); background:#080808; color:#f5f5f5; font-family:PixelHackers,monospace; touch-action:pan-y; }
    .display-settings header { display:flex; justify-content:space-between; gap:24px; align-items:center; margin-bottom:40px; }
    .display-settings h1 { font-size:clamp(28px,4vw,56px); font-weight:normal; margin:0; }
    .display-settings button, .display-settings input:not([type=checkbox]), .display-settings select { background:#080808; color:#f5f5f5; border:1px solid #666; border-radius:0; padding:14px; min-height:48px; font:14px PixelHackers,monospace; min-width:0; touch-action:manipulation; }
    .display-settings button { cursor:pointer; }
    .display-settings button:focus-visible, .display-settings input:focus-visible, .display-settings select:focus-visible { outline:2px solid #f5f5f5; outline-offset:4px; }
    .settings-fields { max-width:880px; }
    .settings-row, .display-settings form { border-bottom:1px solid #333; padding:24px 0; }
    .settings-row { display:flex; align-items:center; justify-content:space-between; gap:24px; font-size:16px; }
    .display-settings form label { display:block; font-size:16px; margin-bottom:16px; }
    .settings-input-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; }
    .display-settings input[type=checkbox] { width:24px; height:24px; accent-color:#f5f5f5; cursor:pointer; }
    .options-shortcut { position:fixed; bottom:16px; right:16px; z-index:2; padding:12px; border:1px solid #666; background:#080808; color:#f5f5f5; font:12px PixelHackers,monospace; cursor:pointer; touch-action:manipulation; }
    @media(max-width:600px) { .display-settings header { align-items:flex-start; flex-direction:column; } .settings-input-row { grid-template-columns:1fr; } .settings-row { font-size:12px; } .display-settings select { max-width:55%; font-size:12px; } }
  `;
  document.head.appendChild(style);
  document.body.appendChild(leaderboard);
  document.body.appendChild(screen);
  const name = screen.querySelector('#option-session-name') as HTMLInputElement;
  const title = screen.querySelector('#option-qr-title') as HTMLInputElement;
  const metric = screen.querySelector('select')!;
  const showLeaderboard = screen.querySelector('#option-leaderboard') as HTMLInputElement;
  const showQr = screen.querySelector('#option-qr') as HTMLInputElement;
  const qr = document.querySelector('.join-qr') as HTMLElement | null;
  for (const [value, label] of Object.entries(LEADERBOARD_METRICS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    metric.appendChild(option);
  }
  let latest: SessionStats | null = null;
  let receivedAt = 0;
  function renderLeaderboard(): void {
    leaderboard.hidden = !latest || !latest.options.showLeaderboard;
    if (!latest || leaderboard.hidden) return;
    const now = Math.min(latest.expiresAt, latest.updatedAt + performance.now() - receivedAt);
    const stat = latest.options.leaderboardStat;
    leaderboard.querySelector('h2')!.textContent = latest.name;
    leaderboard.querySelector('p')!.textContent = LEADERBOARD_METRICS[stat];
    const list = leaderboard.querySelector('ol')!;
    list.replaceChildren();
    const ranked = rankPilots(latest.pilots, stat, now).slice(0, 5);
    for (let i = 0; i < ranked.length; i++) {
      const pilot = ranked[i];
      const row = document.createElement('li');
      const position = document.createElement('span'); position.textContent = String(i + 1);
      const pilotName = document.createElement('span'); pilotName.className = 'pilot-name'; pilotName.textContent = pilot.name;
      const value = document.createElement('span'); value.textContent = formatLeaderboardValue(leaderboardValue(pilot, stat, now), stat);
      row.appendChild(position); row.appendChild(pilotName); row.appendChild(value); list.appendChild(row);
    }
    if (!ranked.length) { const row = document.createElement('li'); row.textContent = 'NO RECORDS YET'; list.appendChild(row); }
  }
  function hide(): void { screen.hidden = true; shortcut.hidden = !latest; }
  function toggle(): void {
    if (!latest) return;
    if (screen.hidden) { onOpen(); screen.hidden = false; shortcut.hidden = true; (screen.querySelector('.back') as HTMLButtonElement).focus(); }
    else hide();
  }
  function change(options: Partial<DisplayOptions>): void { if (latest) send(latest.id, { options }); }
  screen.querySelector('.rename')!.addEventListener('submit', event => { event.preventDefault(); if (latest && name.value.trim()) send(latest.id, { name: name.value.trim() }); name.blur(); });
  screen.querySelector('.qr-title')!.addEventListener('submit', event => { event.preventDefault(); change({ qrTitle: title.value }); title.blur(); });
  metric.addEventListener('change', () => change({ leaderboardStat: metric.value as LeaderboardMetric }));
  showLeaderboard.addEventListener('change', () => change({ showLeaderboard: showLeaderboard.checked }));
  showQr.addEventListener('change', () => change({ showQr: showQr.checked }));
  screen.querySelector('.quit')!.addEventListener('click', () => { if (latest) quit(latest.id); });
  screen.querySelector('.back')!.addEventListener('click', hide);
  shortcut.addEventListener('click', toggle);
  const timer = window.setInterval(renderLeaderboard, 1000);
  return {
    update(stats: SessionStats | null) {
      latest = stats; receivedAt = performance.now();
      if (!stats) hide();
      shortcut.hidden = !stats || !screen.hidden;
      if (stats) {
        if (document.activeElement !== name) name.value = stats.name;
        if (document.activeElement !== title) title.value = stats.options.qrTitle;
        metric.value = stats.options.leaderboardStat;
        showLeaderboard.checked = stats.options.showLeaderboard;
        showQr.checked = stats.options.showQr;
        if (qr) { qr.hidden = !stats.options.showQr; qr.querySelector('span')!.textContent = stats.options.qrTitle; }
      }
      renderLeaderboard();
    }, toggle, hide,
    destroy() { clearInterval(timer); leaderboard.remove(); screen.remove(); shortcut.remove(); style.remove(); },
  };
}
