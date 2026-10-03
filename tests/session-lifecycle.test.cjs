const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
let now = 1000;
class Clock extends Date { static now() { return now; } }
class Server {
  saved = new Map();
  alarm = 0;
  messages = [];
  ctx = { storage: {
    get: async key => structuredClone(this.saved.get(key)),
    put: async (key, value) => this.saved.set(key, structuredClone(value)),
    setAlarm: time => { this.alarm = time; },
  } };
  broadcast(message) { this.messages.push(message); }
}
const modules = new Map();
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {};
  modules.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require: name => name === 'partyserver' ? { Server } : load(path.resolve(path.dirname(file), name + '.ts')),
    Date: Clock, URL, crypto: { randomUUID }, structuredClone, ArrayBuffer, DataView, Uint8Array,
  });
  return exports;
}
(async () => {
  const { GameServer } = load('src/server/server.ts');
  const server = new GameServer();
  await server.onStart();
  assert.equal(server.stats, null);
  function connect(id, query) {
    const connection = { id, sent: [], send(message) { this.sent.push(JSON.parse(message)); }, close(code, reason) { this.closed = { code, reason }; } };
    server.onConnect(connection, { request: new Request('https://example.com/?' + query) });
    return connection;
  }
  const pilotId = randomUUID();
  const player = connect('player', `name=Pilot&pilotId=${pilotId}`);
  server.onMessage(player, JSON.stringify({ type: 'start_session', name: 'Unauthorized' }));
  assert.equal(server.stats, null, 'Players cannot create sessions');
  const display = connect('display', 'mode=display');
  assert.equal(display.sent.at(-1).stats, null);
  server.onMessage(display, JSON.stringify({ type: 'start_session', name: '  Hack   Night  ' }));
  const firstId = server.stats.state.id;
  const originalExpiry = server.stats.state.expiresAt;
  assert.equal(server.stats.state.options.leaderboardStat, 'landed');
  server.onMessage(player, JSON.stringify({ type: 'options', sessionId: firstId, name: 'Blocked' }));
  assert.equal(server.stats.state.name, 'Hack Night');
  server.onMessage(display, JSON.stringify({ type: 'options', sessionId: firstId, name: ' Renamed Night ', options: { leaderboardStat: 'crashed', showLeaderboard: false, showQr: false, qrTitle: 'JOIN THE FLEET' } }));
  assert.equal(server.stats.state.name, 'Renamed Night');
  assert.equal(server.stats.state.options.leaderboardStat, 'crashed');
  assert.equal(server.stats.state.options.showLeaderboard, false);
  assert.equal(server.stats.state.options.showQr, false);
  assert.equal(server.stats.state.options.qrTitle, 'JOIN THE FLEET');
  assert.equal(server.stats.state.expiresAt, originalExpiry, 'Options do not extend the session');
  assert.equal(server.stats.state.joined, 1, 'Renaming preserves stats');
  server.onMessage(display, JSON.stringify({ type: 'options', sessionId: 'stale', name: 'Blocked' }));
  assert.equal(server.stats.state.name, 'Renamed Night');
  server.onMessage(display, JSON.stringify({ type: 'options', sessionId: firstId, name: 'Hack Night' }));
  const expiry = server.stats.state.expiresAt;
  assert.equal(server.stats.state.name, 'Hack Night');
  assert.equal(server.stats.state.joined, 1, 'Already connected players are included');
  assert.equal(expiry, now + 12 * 60 * 60 * 1000);
  const secondDisplay = connect('display-2', 'mode=display');
  server.onMessage(secondDisplay, JSON.stringify({ type: 'start_session', name: 'Other Name' }));
  assert.equal(server.stats.state.id, firstId, 'Concurrent displays share one session');
  server.onClose(player);
  now += 1000;
  const returning = connect('returning', `name=Renamed&pilotId=${pilotId}`);
  assert.equal(server.stats.state.joined, 1, 'Reconnect counts once');
  const different = connect('different', `name=Renamed&pilotId=${randomUUID()}`);
  assert.equal(server.stats.state.joined, 2, 'Same name with different UUID counts separately');
  server.onClose(returning);
  server.onClose(different);
  assert.equal(server.alarm, expiry, 'Expiry alarm remains scheduled with no players');
  const restored = new GameServer();
  restored.saved = server.saved;
  await restored.onStart();
  assert.equal(restored.stats.state.id, firstId);
  assert.equal(restored.stats.state.options.showQr, false, 'Display settings survive restart');
  assert.equal(restored.stats.state.expiresAt, expiry, 'Restart does not extend session');
  now = expiry;
  await server.onAlarm();
  assert.equal(server.stats, null, 'Idle session expires automatically');
  assert.equal(server.saved.get('session-stats'), null);
  assert.ok(server.messages.some(m => typeof m === 'string' && JSON.parse(m).type === 'stats' && JSON.parse(m).stats === null));
  server.onMessage(display, JSON.stringify({ type: 'start_session', name: 'Next Night' }));
  assert.notEqual(server.stats.state.id, firstId);
  assert.equal(server.stats.state.joined, 0);
  assert.equal(server.stats.state.options.showQr, true, 'New sessions use default settings');
  assert.equal(server.stats.state.options.leaderboardStat, 'landed');
  const nextPlayer = connect('next-player', `name=Pilot&pilotId=${pilotId}`);
  assert.equal(server.stats.state.joined, 1, 'Ship can count again in a new session');
  const activeId = server.stats.state.id;
  server.onMessage(nextPlayer, JSON.stringify({ type: 'quit_session', sessionId: activeId }));
  assert.equal(server.stats.state.id, activeId, 'Players cannot end sessions');
  server.onMessage(display, JSON.stringify({ type: 'quit_session', sessionId: firstId }));
  assert.equal(server.stats.state.id, activeId, 'Stale quit cannot end a new session');
  const ship = server.players.get('next-player').lander;
  server.onMessage(display, JSON.stringify({ type: 'quit_session', sessionId: activeId }));
  assert.equal(server.stats, null, 'Display quits the session');
  assert.equal(server.saved.get('session-stats'), null);
  assert.equal(server.players.get('next-player').lander, ship, 'Quitting does not reset the ship');
  server.stage = 0;
  server.onMessage(nextPlayer, JSON.stringify({ type: 'input', thrust: 1, rotation: -1, seq: 3 }));
  assert.equal(server.players.get('next-player').lastInput.thrust, 1, 'Standalone play accepts input');
  server.onMessage(display, JSON.stringify({ type: 'start_session', name: 'New Session' }));
  assert.equal(server.stats.state.joined, 1, 'Existing ship joins the new session automatically');
  assert.equal(server.stats.state.pilots[0].id, pilotId);
  assert.equal(server.players.get('next-player').lander, ship, 'Starting a session requires no reload or ship reset');
  server.stats.outcome(pilotId, true, 10000);
  assert.equal(server.stats.state.landed, 1, 'Existing ship outcomes count in the new session');
  server.players.get('next-player').score = 125;
  ship.y = 777;
  const oldSlot = server.players.get('next-player').slot;
  const beforeSlots = server.nextSlot;
  const replacement = connect('replacement', `name=Pilot&pilotId=${pilotId}`);
  assert.equal(server.players.size, 1, 'A UUID has exactly one live ship');
  assert.equal(nextPlayer.closed.code, 4001, 'Old tab is closed');
  assert.ok(nextPlayer.sent.some(m => m.type === 'superseded'), 'Old client is told to stop reconnecting');
  assert.equal(server.players.get('replacement').slot, oldSlot, 'Reconnect reuses its slot');
  assert.equal(server.nextSlot, beforeSlots, 'Reconnect does not leak slots');
  assert.equal(server.players.get('replacement').lander, ship, 'Reconnect preserves the current flight');
  const init = replacement.sent.find(m => m.type === 'init');
  assert.equal(init.self.lander.y, 777);
  assert.equal(init.self.score, 125);
  assert.equal(server.stats.state.joined, 1);
  assert.equal(server.stats.state.pilots[0].connections, 1);
  server.onClose(nextPlayer);
  server.onError(nextPlayer);
  assert.equal(server.players.size, 1, 'Delayed old close/error cannot remove the replacement');
  server.onMessage(display, JSON.stringify({ type: 'quit_session', sessionId: server.stats.state.id }));
  server.onMessage(display, JSON.stringify({ type: 'start_session', name: 'Reconnect Session' }));
  assert.equal(server.players.size, 1, 'New stats sessions do not create ships');
  assert.equal(server.stats.state.joined, 1);
  const sameSocketId = connect('replacement', `name=Pilot&pilotId=${pilotId}`);
  assert.equal(server.players.size, 1, 'Reconnect with the same connection ID also replaces the old socket');
  server.onClose(replacement);
  assert.equal(server.players.size, 1, 'Old callback with the same ID cannot remove the new socket');
  server.onError(sameSocketId);
  assert.equal(server.players.size, 0, 'Socket errors clean up the active ship');
  assert.equal(server.stats.state.pilots[0].connections, 0);
  assert.equal(server.freeSlots.filter(slot => slot === oldSlot).length, 1);
  const cameraPilot = connect('camera-pilot', `name=Pilot&pilotId=${pilotId}`);
  const controller = connect('controller', 'mode=camera');
  const uniqueShips = server.stats.state.joined;
  assert.equal(server.players.size, 1, 'Camera controllers do not create ships');
  const command = (connection, value) => server.onMessage(connection, JSON.stringify({ type: 'camera', command: value }));
  command(cameraPilot, { action: 'pan', dx: 1, dy: 0 });
  assert.equal(server.camera.custom, null, 'Players cannot control display cameras');
  command(controller, { action: 'pan', dx: 1, dy: 0 });
  command(controller, { action: 'zoom', factor: 1.25 });
  const custom = JSON.stringify(server.camera.custom);
  command(controller, { action: 'follow', pilotId });
  assert.equal(server.camera.followPilotId, pilotId);
  const followedReplacement = connect('camera-replacement', `name=Pilot&pilotId=${pilotId}`);
  assert.equal(server.camera.followPilotId, pilotId, 'Follow survives reconnecting');
  server.beginNewRound();
  assert.equal(server.camera.followPilotId, pilotId, 'Follow survives new rounds');
  assert.equal(JSON.stringify(server.camera.custom), custom, 'Custom viewport is retained during following and rounds');
  command(controller, { action: 'unfollow' });
  assert.equal(server.camera.followPilotId, null);
  assert.equal(JSON.stringify(server.camera.custom), custom);
  command(controller, { action: 'follow', pilotId });
  server.onClose(followedReplacement);
  assert.equal(server.camera.followPilotId, null, 'Disconnected followed ships return to the saved custom view');
  assert.equal(JSON.stringify(server.camera.custom), custom);
  assert.equal(server.stats.state.joined, uniqueShips, 'Camera controller never counts as a ship');
  command(controller, { action: 'reset' });
  assert.equal(server.camera.custom, null);
  console.log('Camera controller checks passed: authorization, no extra ships, shared controls, follow through reconnect/rounds, saved viewport, disconnect, reset.');
  console.log('Duplicate ship checks passed: takeover, stopped retries, slot reuse, preserved flight, late callbacks, same socket ID, error cleanup.');
  console.log('Quit and standalone play checks passed.');
  console.log('Session lifecycle checks passed: display-only creation, naming, shared session, unique UUIDs, persistence, fixed expiry, idle expiry, fresh totals.');
})().catch(error => { console.error(error); process.exitCode = 1; });
