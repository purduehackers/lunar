const assert = require('node:assert/strict');
const { runtime } = require('./helpers/runtime.cjs');

function client(display = false) {
  let time = 1000;
  let frame;
  const handlers = new Map();
  const documentHandlers = new Map();
  const drawn = [];
  const socketInstances = [];
  const screens = [];
  const ctx = new Proxy({ measureText: text => ({ width: text.length * 8 }), fillText: text => drawn.push(text) }, {
    get(target, key) { return target[key] ?? (() => {}); },
  });
  const canvas = { style: {}, getContext: () => ctx, addEventListener() {}, removeEventListener() {} };
  const document = { hidden: false, fonts: { add() {} }, addEventListener: (name, handler) => documentHandlers.set(name, handler), removeEventListener: name => documentHandlers.delete(name) };
  const window = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, matchMedia: () => ({ matches: false }), addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener: name => handlers.delete(name) };
  class Socket {
    readyState = 0;
    handlers = new Map();
    sent = [];
    reconnects = 0;
    closed = 0;
    constructor(options) { this.options = options; socketInstances.push(this); }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    emit(name, event) { this.handlers.get(name)?.(event); }
    send(data) { assert.equal(this.readyState, 1, 'No offline sends'); this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.closed++; this.emit('close', { code: 1000 }); }
    reconnect() { this.readyState = 0; this.reconnects++; }
  }
  const screen = () => { const view = { update: data => { view.latest = data; }, destroy() {}, hide() {}, toggle() {} }; screens.push(view); return view; };
  const rt = runtime({ window, document, Element: class {}, FontFace: class { load() { return Promise.resolve(this); } },
    performance: { now: () => time }, localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame: () => {},
  }, {
    partysocket: { default: Socket },
    './play-schedule-screen': { createPlayScheduleScreen: screen },
    './stats-screen': { createStatsScreen: screen },
    './display-settings-screen': { createDisplaySettings: screen },
  });
  const { createDefaultLander } = rt.load('src/lib/simulation.ts');
  const protocol = rt.load('src/lib/protocol.ts');
  const stop = rt.load('src/lib/game.ts').startGame(canvas, 'localhost', { name: 'Test Pilot', display });
  const socket = socketInstances[0];
  const init = { type: 'init', camera: { custom: null, followPilotId: null }, stats: null, playSchedule: null,
    id: 'self', name: 'Test Pilot', color: [255, 255, 255], slot: display ? -1 : 0, seed: 42, stage: 0, revealMs: 0,
    roundId: 10, epoch: 0, authority: display ? null : 'authority-1', endgameMs: 0,
    self: display ? null : { lander: createDefaultLander(), score: 0, elapsedMs: 0 }, players: {},
  };
  function deliver(data) { socket.emit('message', { data: data instanceof ArrayBuffer ? data : JSON.stringify(data) }); }
  function open(patch = {}) { socket.readyState = 1; socket.emit('open', {}); deliver({ ...init, ...patch }); }
  function tick(ms = 50) { time += ms; drawn.length = 0; frame(time); }
  function key(name, down = true) { handlers.get(down ? 'keydown' : 'keyup')?.({ key: name, preventDefault() {} }); }
  function visibility(hidden) { document.hidden = hidden; documentHandlers.get('visibilitychange')(); }
  return { open, deliver, tick, key, socket, protocol, init, drawn, stop, visibility, now: () => time, screens };
}

const c = client();
c.socket.readyState = 1; c.socket.emit('open', {}); c.tick();
assert.equal(c.socket.sent.length, 0, 'An open socket without init cannot send state');
c.open(); c.tick(); c.key('ArrowUp'); c.key('ArrowRight');
for (let i = 0; i < 20; i++) c.tick();
const first = c.socket.sent.at(-1);
assert.equal(first.type, 'state');
assert.equal(first.lander.fuel, 4895, 'One second of thrust uses 105 fuel without receiving any world snapshot');
assert.equal(first.elapsedMs, 1000);
assert.ok(first.lander.r > c.init.self.lander.r);
assert.ok(first.lander.x > 0);
assert.equal(c.socket.options.maxEnqueuedMessages, 0);

const maliciousEcho = { slot: 0, flags: c.protocol.packFlags(0, 2), x: 999, y: 2000, r: 0, vx: 0, vy: 0, vr: 0, fuel: 1, score: 999 };
c.deliver(c.protocol.encodeWorldUpdate(10, [maliciousEcho]));
c.tick();
const afterEcho = c.socket.sent.at(-1);
assert.equal(afterEcho.lander.a, 0);
assert.ok(afterEcho.lander.fuel > 4800);
assert.notEqual(afterEcho.lander.x, 999, 'Self echoes never overwrite the live flight');
assert.ok(c.drawn.some(text => text === 'SCORE    0000'), 'Self echoes cannot override the local score');

// Pause without changing round identity; resume cannot catch up paused time.
c.deliver({ type: 'play_schedule', epoch: 1, schedule: { phase: 'paused', changesAt: 100000, serverNow: 0 } });
const beforePause = c.socket.sent.length;
for (let i = 0; i < 60; i++) c.tick(500);
assert.equal(c.socket.sent.length, beforePause);
c.deliver({ type: 'play_schedule', epoch: 2, schedule: null });
c.tick(); c.tick();
const resumed = c.socket.sent.at(-1);
assert.equal(resumed.epoch, 2);
assert.equal(resumed.lander.t, 0, 'Pause clears held controls');
assert.equal(resumed.elapsedMs, afterEcho.elapsedMs + 50);
assert.equal(resumed.lander.fuel, afterEcho.lander.fuel - 0.25);

c.deliver({ type: 'new_round', roundId: 11, seed: 50, revealMs: 1800 });
const beforeReveal = c.socket.sent.length;
c.tick(50);
assert.equal(c.socket.sent.length, beforeReveal);
c.deliver({ type: 'stage', roundId: 10, stage: 0 }); c.tick();
assert.equal(c.socket.sent.length, beforeReveal, 'Stale stage messages cannot open a new round');
c.deliver({ type: 'stage', roundId: 11, stage: 0 }); c.tick(); c.tick();
assert.equal(c.socket.sent.at(-1).roundId, 11);
assert.equal(c.socket.sent.at(-1).lander.fuel, 4999.75);
assert.equal(c.socket.sent.at(-1).elapsedMs, 50);
c.deliver(c.protocol.encodeWorldUpdate(10, [maliciousEcho])); c.tick();
assert.equal(c.socket.sent.at(-1).lander.a, 0);

c.visibility(true);
assert.equal(c.socket.sent.at(-1).type, 'suspend');
const beforeHidden = c.socket.sent.length;
c.tick(60000);
assert.equal(c.socket.sent.length, beforeHidden, 'Hidden browsers do not simulate or buffer messages');
c.visibility(false);
assert.equal(c.socket.reconnects, 1);
c.tick();
assert.equal(c.socket.sent.length, beforeHidden, 'Resume waits for a fresh init');
c.open({ roundId: 12, authority: 'authority-2', self: { lander: { ...c.init.self.lander, x: 123 }, score: 25, elapsedMs: 500 } });
c.tick(); c.tick();
assert.equal(c.socket.sent.at(-1).authority, 'authority-2');
assert.equal(c.socket.sent.at(-1).elapsedMs, 550);
assert.ok(c.socket.sent.at(-1).lander.x >= 123);
c.tick(10000);
assert.equal(c.socket.reconnects, 2, 'An OS suspension without visibilitychange also reacquires authority');
c.open({ authority: 'authority-3' }); c.tick();
c.deliver({ type: 'superseded' });
const beforeSuperseded = c.socket.sent.length;
c.visibility(true); c.visibility(false); c.tick();
assert.equal(c.socket.reconnects, 2, 'Superseded tabs never reconnect on visibility changes');
assert.equal(c.socket.sent.length, beforeSuperseded);
c.stop();

// An actual local collision must send the result promptly and retry until acked.
const terminal = client();
terminal.open({ self: { lander: { ...terminal.init.self.lander, y: 2001 }, score: 10, elapsedMs: 100 } });
terminal.tick(); terminal.tick();
const result = terminal.socket.sent.at(-1);
assert.equal(result.lander.a, 2);
assert.equal(result.result.points, 5);
assert.ok(terminal.drawn.includes('CRASHED'));
terminal.tick();
assert.equal(terminal.socket.sent.at(-1).result.points, 5, 'Outcome retries use terminal reports, not a second local event');
terminal.deliver({ type: 'result_ack', roundId: 9, authority: 'authority-1', score: 500 });
terminal.tick();
assert.ok(terminal.drawn.includes('SCORE    0015'), 'Stale acknowledgements are ignored');
terminal.deliver({ type: 'result_ack', roundId: 10, authority: 'authority-1', score: 15 });
const ackedCount = terminal.socket.sent.length;
terminal.tick();
assert.equal(terminal.socket.sent.length, ackedCount, 'Acknowledged results stop retries');
terminal.stop();

// Spectator runs the same rendering loop but can never send a flight report.
const spectator = client(true);
spectator.open({ players: { other: { x: 123, y: 999, r: 0, vx: 80, vy: 0, vr: 0, t: 0, a: 0, fuel: 5000, color: [255, 0, 0], slot: 1, name: 'Remote Pilot', pilotId: 'remote' } } });
spectator.tick(); spectator.key('ArrowUp');
for (let i = 0; i < 10; i++) spectator.tick();
assert.equal(spectator.socket.sent.length, 0);
spectator.deliver(spectator.protocol.encodeWorldUpdate(10, [{ ...maliciousEcho, slot: 1, flags: spectator.protocol.packFlags(0, 1) }]));
spectator.tick();
assert.ok(spectator.drawn.includes('Remote Pilot LANDED!'), 'Spectators render terminal snapshots and announcements');
spectator.deliver(spectator.protocol.encodeWorldUpdate(9, [{ ...maliciousEcho, slot: 1 }]));
spectator.tick();
assert.equal(spectator.socket.sent.length, 0);
spectator.stop();
console.log('Browser-loop checks passed: controls without snapshots, ignored echoes, result retries/acks, pause/resume, stale rounds, reconnect gating, suspension, superseded tabs and spectator announcements.');
