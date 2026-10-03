import PartySocket from 'partysocket';
import type { CameraState, CameraCommand, CameraShip } from './camera';
export function startCameraControls(host: string): void {
  const status = document.getElementById('connection')!;
  const mode = document.getElementById('camera-mode')!;
  const shipsElement = document.getElementById('ships')!;
  const stop = document.getElementById('stop-follow') as HTMLButtonElement;
  const socket = new PartySocket({ host, party: 'game-server', room: 'main', query: { mode: 'camera' } });
  socket.binaryType = 'arraybuffer';
  let connected = false;
  let state: CameraState = { custom: null, followPilotId: null };
  let ships: CameraShip[] = [];
  function render(): void {
    const followed = ships.find(ship => ship.pilotId === state.followPilotId);
    status.textContent = connected ? 'CONNECTED TO DISPLAY' : 'CONNECTING...';
    mode.textContent = followed ? `FOLLOWING ${followed.name}` : state.custom ? `CUSTOM VIEW · ${state.custom.zoom.toFixed(2)}×` : 'AUTOMATIC CAMERA';
    shipsElement.replaceChildren();
    if (!ships.length) {
      const empty = document.createElement('p');
      empty.className = 'help';
      empty.textContent = 'Ships appear here when pilots join.';
      shipsElement.appendChild(empty);
    }
    for (const ship of ships) {
      const button = document.createElement('button');
      button.className = 'ship';
      button.setAttribute('aria-pressed', String(ship.pilotId === state.followPilotId));
      const dot = document.createElement('span');
      dot.className = 'ship-dot';
      dot.style.background = `rgb(${ship.color.join(',')})`;
      dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.textContent = ship.name;
      button.appendChild(dot);
      button.appendChild(name);
      button.addEventListener('click', () => send({ action: 'follow', pilotId: ship.pilotId }));
      shipsElement.appendChild(button);
    }
    for (const button of document.querySelectorAll('button')) button.disabled = !connected;
    stop.disabled = !connected || !state.followPilotId;
  }
  function send(command: CameraCommand): void {
    if (connected) socket.send(JSON.stringify({ type: 'camera', command }));
  }
  const pans: Record<string, [number, number]> = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-pan]')) {
    button.addEventListener('click', () => {
      const [dx, dy] = pans[button.dataset.pan!];
      send({ action: 'pan', dx, dy });
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-zoom]')) button.addEventListener('click', () => send({ action: 'zoom', factor: Number(button.dataset.zoom) }));
  document.getElementById('reset')!.addEventListener('click', () => send({ action: 'reset' }));
  stop.addEventListener('click', () => send({ action: 'unfollow' }));
  window.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]'))) return;
    const direction = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[event.key];
    if (direction) {
      event.preventDefault();
      const [dx, dy] = pans[direction];
      send({ action: 'pan', dx, dy });
    } else if (['+', '=', '-', '_'].includes(event.key)) {
      event.preventDefault();
      send({ action: 'zoom', factor: ['+', '='].includes(event.key) ? 1.25 : 0.8 });
    }
  });
  socket.addEventListener('open', () => { connected = true; render(); });
  socket.addEventListener('close', () => { connected = false; render(); });
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'camera') { state = data.camera; ships = data.ships; render(); }
  });
  render();
  window.addEventListener('pagehide', () => socket.close(), { once: true });
}
