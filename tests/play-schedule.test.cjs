const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

let now = 0;
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
const at = value => Date.parse(value);
const { getPlaySchedule } = load('src/lib/play-schedule.ts');
const session = { name: 'Hack Night', startedAt: at('2026-10-23T20:00:00-04:00'), expiresAt: at('2026-10-24T08:00:00-04:00') };
for (const [time, phase, next] of [
  ['2026-10-23T20:59:59.999-04:00', 'before_start', '2026-10-23T21:00:00-04:00'],
  ['2026-10-23T21:00:00-04:00', 'paused', '2026-10-23T21:45:00-04:00'],
  ['2026-10-23T21:44:59.999-04:00', 'paused', '2026-10-23T21:45:00-04:00'],
  ['2026-10-23T21:45:00-04:00', 'playing', '2026-10-23T22:00:00-04:00'],
  ['2026-10-23T21:59:59.999-04:00', 'playing', '2026-10-23T22:00:00-04:00'],
  ['2026-10-23T22:00:00-04:00', 'paused', '2026-10-23T22:45:00-04:00'],
  ['2026-10-24T00:00:00-04:00', 'paused', '2026-10-24T00:45:00-04:00'],
  ['2026-10-24T02:45:00-04:00', 'playing', '2026-10-24T03:00:00-04:00'],
]) {
  const schedule = getPlaySchedule(session, at(time));
  assert.equal(schedule.phase, phase, time);
  assert.equal(schedule.changesAt, at(next), time);
  assert.equal(schedule.serverNow, at(time));
}
assert.equal(getPlaySchedule(null, session.startedAt), null);
assert.equal(getPlaySchedule({ ...session, name: 'Birthday' }, session.startedAt), null);
assert.equal(getPlaySchedule(session, session.expiresAt), null);
assert.equal(getPlaySchedule({ ...session, name: '  hAcK   nIgHt  ' }, at('2026-10-23T21:10:00-04:00')).phase, 'paused');
assert.equal(getPlaySchedule({ ...session, startedAt: at('2026-10-23T21:30:00-04:00') }, at('2026-10-23T21:35:00-04:00')).changesAt, at('2026-10-23T21:45:00-04:00'), 'Late sessions keep the wall-clock windows');
assert.equal(getPlaySchedule({ ...session, startedAt: at('2026-10-24T00:20:00-04:00') }, at('2026-10-24T00:20:00-04:00')).phase, 'paused', 'Sessions opened after midnight belong to the previous night');
for (const [start, current, next] of [
  ['2026-12-04T20:00:00-05:00', '2026-12-04T21:10:00-05:00', '2026-12-04T21:45:00-05:00'],
  ['2026-10-31T20:00:00-04:00', '2026-11-01T01:10:00-05:00', '2026-11-01T01:45:00-05:00'],
  ['2027-03-13T20:00:00-05:00', '2027-03-14T03:10:00-04:00', '2027-03-14T03:45:00-04:00'],
]) {
  const schedule = getPlaySchedule({ name: 'Hack Night', startedAt: at(start), expiresAt: at(start) + 12 * 3600000 }, at(current));
  assert.equal(schedule.phase, 'paused');
  assert.equal(schedule.changesAt, at(next), 'Uses Purdue time in winter and across DST transitions');
}

const { GameServer } = load('src/server/server.ts');
function connect(server, id, query) {
  const connection = { id, sent: [], send(message) { this.sent.push(JSON.parse(message)); }, close() {} };
  server.onConnect(connection, { request: new Request('https://example.com/?' + query) });
  return connection;
}
function send(server, connection, data) { server.onMessage(connection, JSON.stringify(data)); }
async function setup(time, name = 'Hack Night') {
  now = at(time);
  const server = new GameServer();
  await server.onStart();
  const display = connect(server, 'display', 'mode=display');
  send(server, display, { type: 'start_session', name });
  return { server, display };
}
async function advance(server, time) {
  now = at(time);
  await server.onAlarm();
}

(async () => {
  const { server, display } = await setup('2026-10-23T20:59:55-04:00');
  const pilotId = randomUUID();
  const player = connect(server, 'player', `name=Pilot&pilotId=${pilotId}`);
  await advance(server, '2026-10-23T20:59:56.800-04:00');
  assert.equal(server.stage, 0);
  const roundStart = server.roundStartedAt;
  send(server, player, { type: 'input', thrust: 1, rotation: 1, seq: 1 });
  await advance(server, '2026-10-23T20:59:59.950-04:00');
  const ship = server.players.get('player').lander;
  const before = JSON.stringify({ ...ship, t: 0 });
  await advance(server, '2026-10-23T21:00:00-04:00');
  assert.equal(server.playSchedule.phase, 'paused');
  assert.equal(JSON.stringify(ship), before, 'Pausing preserves the flight and clears thrust');
  assert.equal(server.players.get('player').lastInput.thrust, 0);
  assert.equal(server.players.get('player').lastInput.rotation, 0);
  assert.equal(server.alarm, at('2026-10-23T21:45:00-04:00'), 'Paused servers sleep until the next window');
  await advance(server, '2026-10-23T21:15:00-04:00');
  send(server, player, { type: 'input', thrust: 1, rotation: -1, seq: 2 });
  server.tick();
  assert.equal(JSON.stringify(ship), before, 'Neither alarms nor input advance paused ships');
  assert.equal(server.players.get('player').lastInput.thrust, 0, 'Server rejects input from clients during pauses');
  assert.equal(server.stats.state.landed + server.stats.state.crashed, 0);
  const late = connect(server, 'late', `name=Late&pilotId=${randomUUID()}`);
  assert.equal(late.sent.find(m => m.type === 'init').playSchedule.phase, 'paused');
  assert.equal(late.sent.find(m => m.type === 'init').playSchedule.serverNow, now, 'New connections receive a fresh server clock');
  const replacement = connect(server, 'replacement', `name=Pilot&pilotId=${pilotId}`);
  assert.equal(server.players.get('replacement').lander, ship, 'Reconnect during a pause preserves the ship');
  server.onClose(player);
  assert.equal(server.players.size, 2);
  await advance(server, '2026-10-23T21:45:00-04:00');
  assert.equal(server.playSchedule.phase, 'playing');
  assert.equal(server.pausedAt, null);
  assert.equal(server.roundStartedAt, roundStart + 45 * 60000);
  assert.equal(server.players.get('late').joinedAt, now, 'Late arrivals start flight timing when play opens');
  assert.notEqual(JSON.stringify(ship), before, 'Existing flights resume automatically');
  send(server, replacement, { type: 'input', thrust: 1, rotation: 0, seq: 3 });
  assert.equal(server.players.get('replacement').lastInput.thrust, 1);
  send(server, replacement, { type: 'input', thrust: 0, rotation: 0, seq: 4 });
  Object.assign(ship, { x: 100, y: 0, r: 0, vx: 0, vy: -0.1, vr: 0, a: 0 });
  server.mapLines = [[0, 0, 3000, 0]];
  await advance(server, '2026-10-23T21:45:01-04:00');
  assert.equal(server.stats.state.pilots.find(p => p.id === pilotId).fastestMs, 4200, 'Landing records exclude the entire pause');
  await advance(server, '2026-10-23T22:00:00-04:00');
  assert.equal(server.playSchedule.phase, 'paused', 'The next hour pauses again');
  assert.equal(server.alarm, at('2026-10-23T22:45:00-04:00'));
  send(server, display, { type: 'options', sessionId: server.stats.state.id, name: 'Another Night' });
  assert.equal(server.playSchedule, null, 'Renaming out of Hack Night releases the pause');
  send(server, display, { type: 'options', sessionId: server.stats.state.id, name: 'Hack Night' });
  assert.equal(server.playSchedule.phase, 'paused');
  send(server, display, { type: 'quit_session', sessionId: server.stats.state.id });
  assert.equal(server.pausedAt, null, 'Ending the session releases the pause');
  assert.equal(server.playSchedule, null);

  // Reveal, endgame, and intermission deadlines all retain their remaining time.
  for (const stage of [2, 0, 1]) {
    const { server } = await setup('2026-10-23T20:59:59-04:00');
    connect(server, 'player', 'name=Pilot');
    server.stage = stage;
    const field = stage === 2 ? 'revealDeadline' : stage === 0 ? 'endgameDeadline' : 'intermissionDeadline';
    if (stage === 0) server.players.get('player').lander.a = 1;
    if (stage === 1) server.stopTickLoop();
    server[field] = now + 3000;
    await advance(server, '2026-10-23T21:00:00-04:00');
    const joined = connect(server, 'joined', 'mode=display');
    if (stage === 2) assert.equal(joined.sent.find(m => m.type === 'init').revealMs, 2000);
    await advance(server, '2026-10-23T21:45:00-04:00');
    assert.equal(server.stage, stage, `${field} cannot expire while paused`);
    assert.equal(server[field], now + 2000, `${field} retains its remaining time`);
    await advance(server, '2026-10-23T21:45:02-04:00');
    assert.equal(server.stage, stage === 2 ? 0 : stage === 0 ? 1 : 2);
  }

  // No player needs to stay connected for the schedule to advance or survive a restart.
  const { server: idle } = await setup('2026-10-23T20:00:00-04:00');
  assert.equal(idle.alarm, at('2026-10-23T21:00:00-04:00'));
  await advance(idle, '2026-10-23T21:10:00-04:00');
  const restored = new GameServer();
  restored.saved = idle.saved;
  await restored.onStart();
  assert.equal(restored.playSchedule.phase, 'paused');
  assert.equal(restored.alarm, at('2026-10-23T21:45:00-04:00'));
  connect(restored, 'new-player', 'name=New');
  assert.equal(restored.stage, 1, 'A player joining an idle paused server cannot start a round');
  await advance(restored, '2026-10-23T21:45:00-04:00');
  assert.equal(restored.stage, 2, 'Waiting players start automatically when play opens');
  assert.equal(restored.revealDeadline, now + 1800);
  now = restored.stats.state.expiresAt;
  await restored.onAlarm();
  assert.equal(restored.stats, null);
  assert.equal(restored.playSchedule, null, 'Expiry removes the schedule');

  const { server: standalone } = await setup('2026-10-23T21:10:00-04:00', 'Other Session');
  const freePlayer = connect(standalone, 'player', 'name=Free');
  await advance(standalone, '2026-10-23T21:10:02-04:00');
  send(standalone, freePlayer, { type: 'input', thrust: 1, rotation: 0 });
  assert.equal(standalone.players.get('player').lastInput.thrust, 1);
  assert.equal(standalone.playSchedule, null, 'Other sessions remain unrestricted');
  console.log('Hack Night schedule checks passed: time boundaries, midnight, DST, frozen flights and timers, rejected input, reconnects, landing records, idle wakeups, persistence, renaming, quit, and expiry.');
})().catch(error => { console.error(error); process.exitCode = 1; });
