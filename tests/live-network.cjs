// Optional integration check against an already running local Astro/PartyServer.
// node tests/live-network.cjs http://127.0.0.1:4322
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { runtime } = require('./helpers/runtime.cjs');
const { decodeWorldUpdate, MSG_WORLD, MSG_CRASH } = runtime().load('src/lib/protocol.ts');
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:4322');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Integration checks run only on a local server');
const room = `authority-test-${randomUUID()}`;
const clients = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(20); }
  throw new Error('Timed out waiting for local server evidence');
}
async function connect(mode, pilotId = randomUUID(), id = randomUUID()) {
  const url = new URL(`/parties/game-server/${room}`, base);
  url.protocol = 'ws:';
  url.search = new URLSearchParams({ mode, pilotId, _pk: id, name: mode || 'Test Pilot' });
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const client = { socket, messages: [], id, pilotId, seq: 0, worlds: [], crashes: 0 };
  clients.push(client);
  socket.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) {
      if (new Uint8Array(data)[0] === MSG_WORLD) client.worlds.push(decodeWorldUpdate(data));
      if (new Uint8Array(data)[0] === MSG_CRASH) client.crashes++;
    } else client.messages.push(JSON.parse(data));
  });
  socket.addEventListener('close', e => { client.closed = e.code; });
  socket.addEventListener('error', e => { client.error = String(e.message); });
  client.init = await until(() => client.messages.find(m => m.type === 'init'));
  return client;
}
function send(client, data) { client.socket.send(JSON.stringify(data)); }
function report(client, lander, result = null, extra = {}) {
  const data = { type: 'state', roundId: client.init.roundId, epoch: client.init.epoch,
    authority: client.init.authority, seq: ++client.seq, lander, elapsedMs: 1000, result, ...extra };
  send(client, data);
  return data;
}
(async () => {
  const display = await connect('display');
  send(display, { type: 'start_session', name: 'Network Test' });
  const a = await connect('');
  const b = await connect('');
  await until(() => a.messages.find(m => m.type === 'stage' && m.stage === 0));
  const aState = { ...a.init.self.lander, x: 900, y: 1200, vx: 4, vy: -1, fuel: 4000 };
  report(a, aState);
  report(b, { ...b.init.self.lander, x: 1500 });
  await until(() => display.worlds.some(w => w?.players.some(p => p.slot === a.init.slot && p.x === 900)));
  const lateDisplay = await connect('display');
  assert.equal(lateDisplay.init.players[a.id].x, 900);
  await delay(200);
  const stationary = await connect('display');
  assert.equal(stationary.init.players[a.id].x, 900, 'Real server does not simulate while a client is silent');
  report(display, { ...aState, x: 111 }, null, { authority: a.init.authority, roundId: a.init.roundId });
  const takeover = await connect('', a.pilotId, a.id);
  assert.equal(takeover.init.self.lander.x, 900);
  assert.notEqual(takeover.init.authority, a.init.authority);
  await until(() => a.closed === 4001);
  report(takeover, { ...aState, x: 333 }, null, { authority: a.init.authority, seq: 500 });
  const before = display.worlds.length;
  report(takeover, { ...aState, x: 950 });
  await until(() => display.worlds.slice(before).some(w => w?.players.some(p => p.slot === takeover.init.slot && p.x === 950)));
  report(takeover, { ...aState, a: 1 }, { points: 50 });
  await until(() => takeover.messages.find(m => m.type === 'result_ack'));
  report(takeover, { ...aState, a: 1 }, { points: 50 });
  report(b, { ...b.init.self.lander, a: 2 }, { points: 5 });
  await until(() => display.messages.find(m => m.type === 'stats' && m.stats?.landed === 1 && m.stats.crashed === 1));
  assert.equal(display.crashes, 1);
  takeover.socket.close();
  await until(() => display.messages.find(m => m.type === 'player_leave' && m.id === takeover.id));
  const resumed = await connect('', a.pilotId);
  assert.equal(resumed.init.self.score, 50);
  assert.equal(resumed.init.self.lander.a, 1);
  report(resumed, { ...aState, a: 1 }, { points: 50 });
  await until(() => resumed.messages.find(m => m.type === 'result_ack'));
  await until(() => resumed.messages.find(m => m.type === 'new_round'), 12000);
  const next = resumed.messages.find(m => m.type === 'new_round');
  assert.notEqual(next.roundId, resumed.init.roundId);
  const fresh = await connect('display');
  assert.equal(fresh.init.stats.landed, 1, 'Duplicate outcomes remain single-counted across real reconnects');
  assert.equal(fresh.init.stats.crashed, 1);
  console.log('Live PartyServer WebSocket checks passed: two pilots, spectator snapshots, no server simulation, same-ID takeover, stale-token rejection, outcomes, disconnect/reconnect and new rounds.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { for (const c of clients) c.socket.close(); });
