const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { runtime } = require('./helpers/runtime.cjs');

(async () => {
  const rt = runtime();
  const { load, connect, report } = rt;
  const { LocalFlight } = load('src/lib/flight.ts');
  const sim = load('src/lib/simulation.ts');
  const { RemoteLander } = load('src/lib/remote-lander.ts');
  const protocol = load('src/lib/protocol.ts');
  const { GameServer } = load('src/server/server.ts');
  const controls = { thrust: 1, rotation: 1, seq: 0 };
  const expected = sim.createDefaultLander();
  for (let i = 0; i < 200; i++) { sim.applyInput(expected, controls); sim.updateLanderPhysics(expected, 0.05); }
  for (const fps of [20, 30, 60, 144, 240]) {
    const flight = new LocalFlight(sim.createDefaultLander());
    for (let i = 0; i < fps * 10; i++) flight.advance(1000 / fps, controls, []);
    assert.equal(JSON.stringify(flight.lander), JSON.stringify(expected), `${fps} fps uses the original 20 Hz physics and fuel`);
    assert.equal(flight.lander.fuel, 3950);
    assert.equal(flight.elapsedMs, 10000);
    const before = JSON.stringify(flight.lander);
    flight.advance(60000, controls, []);
    assert.equal(JSON.stringify(flight.lander), before, 'Suspension never fast-forwards a minute of physics');
  }
  for (const [vx, vy, points, state] of [[0, -1, 50, 1], [1, -3, 15, 1], [5, -8, 5, 2]]) {
    const flight = new LocalFlight({ ...sim.createDefaultLander(), x: 500, y: 0.01, r: 0, vx, vy, vr: 0 });
    const result = flight.advance(50, { thrust: 0, rotation: 0, seq: 0 }, [[0, 0, 4000, 0]]);
    assert.equal(result.points, points);
    assert.equal(flight.lander.a, state);
    assert.equal(flight.lander.fuel, 4999.75 + (points === 50 ? 50 : 0));
    assert.equal(flight.advance(50, controls, []), null, 'A result happens once');
    assert.equal(flight.elapsedMs, 50, 'Landing stops the flight clock');
  }
  const bounds = new LocalFlight({ ...sim.createDefaultLander(), y: 2001 });
  assert.equal(bounds.advance(50, controls, []).points, 5);
  assert.equal(bounds.lander.a, 2);
  const empty = new LocalFlight({ ...sim.createDefaultLander(), fuel: 0 });
  empty.advance(100, controls, []);
  assert.equal(empty.lander.t, 0);

  const remote = new RemoteLander({ ...sim.createDefaultLander(), x: 3998 }, 1000);
  remote.sample(1050, 50);
  assert.ok(remote.rendered.x < 10, 'Remote smoothing follows the short path across the wrap');
  for (let i = 0; i < 100; i++) remote.sample(10000 + i * 50, 50);
  assert.ok(Math.abs(remote.rendered.x - 10) < 0.001, 'A silent ship extrapolates at most 150 ms');
  const frozen = JSON.stringify(remote.rendered);
  remote.sample(20000, 5000, true);
  assert.equal(JSON.stringify(remote.rendered), frozen);
  remote.receive({ ...remote.snapshot, a: 1, x: 123 }, 20000);
  assert.equal(remote.sample(30000, 100).x, 123, 'Terminal snapshots stop interpolation immediately');

  const server = new GameServer();
  await server.onStart();
  const display = connect(server, 'display', 'mode=display');
  const controller = connect(server, 'camera', 'mode=camera');
  server.onMessage(display, JSON.stringify({ type: 'start_session', name: 'Authority Test' }));
  assert.equal(server.players.size, 0);
  const pilotId = randomUUID();
  const a = connect(server, 'a', `pilotId=${pilotId}`);
  const b = connect(server, 'b', `pilotId=${randomUUID()}`);
  const initial = server.players.get('a');
  report(server, a, { lander: { ...initial.lander, x: 400 } });
  assert.equal(initial.lander.x, -15, 'Reveal rejects flight updates');
  rt.advance(1800); await server.onAlarm();
  const state = { ...initial.lander, x: 345, y: 1234, vx: 12, vy: -50, t: 1, fuel: 4321.5 };
  const accepted = report(server, a, { lander: state, elapsedMs: 100 });
  const stored = JSON.stringify(initial.lander);
  rt.advance(500); server.tick();
  assert.equal(JSON.stringify(initial.lander), stored, 'Server never moves ships or burns fuel');
  const world = protocol.decodeWorldUpdate(server.messages.findLast(m => m.message instanceof ArrayBuffer).message);
  assert.equal(world.roundId, server.roundId);
  assert.equal(world.players.find(p => p.slot === initial.slot).x, 345, 'Spectator broadcast relays accepted position');
  assert.equal(world.players.find(p => p.slot === initial.slot).fuel, 4321);
  const spectator = connect(server, 'late-display', 'mode=display');
  assert.equal(spectator.sent.find(m => m.type === 'init').players.a.x, 345, 'Late displays get current states');

  for (const bad of [
    { ...accepted, seq: accepted.seq - 1 },
    { ...accepted, roundId: server.roundId - 1, seq: 100 },
    { ...accepted, authority: 'old-transport', seq: 100 },
    { ...accepted, epoch: server.epoch + 1, seq: 100 },
    { ...accepted, elapsedMs: 0, seq: 100 },
    { ...accepted, seq: -1 },
    { ...accepted, seq: 1.5 },
    { ...accepted, lander: { ...state, x: null }, seq: 100 },
    { ...accepted, lander: { ...state, y: 1e100 }, seq: 100 },
    { ...accepted, lander: { ...state, a: 8 }, seq: 100 },
    { ...accepted, lander: { ...state, fuel: -10 }, seq: 100 },
    { ...accepted, lander: { ...state, a: 1 }, result: { points: 999 }, seq: 100 },
    null, [], 3, { type: 'state' },
  ]) server.onMessage(a, JSON.stringify(bad));
  server.onMessage(a, '{invalid');
  server.onMessage(a, new ArrayBuffer(8));
  server.onMessage(a, 'x'.repeat(5000));
  server.onMessage(display, JSON.stringify({ ...accepted, seq: 100 }));
  server.onMessage(controller, JSON.stringify({ ...accepted, seq: 100 }));
  server.onMessage(b, JSON.stringify({ ...accepted, seq: 100, id: 'a' }));
  assert.equal(JSON.stringify(initial.lander), stored, 'Malformed, stale, spectator and wrong-owner updates are ignored');
  assert.equal(server.players.get('b').lander.x, -15);
  const trusted = report(server, a, { lander: { ...state, x: 800, color: [1, 1, 1] }, elapsedMs: 150 });
  assert.equal(initial.lander.x, 800, 'No trajectory validation is imposed');
  assert.notEqual(JSON.stringify(initial.lander.color), '[1,1,1]', 'Server retains pilot metadata');

  const outcome = report(server, a, { lander: { ...state, a: 1 }, elapsedMs: 5550, result: { points: 50 } });
  report(server, a, { ...outcome, seq: outcome.seq + 1 });
  report(server, a, { ...outcome, seq: outcome.seq + 2, lander: { ...state, a: 2 }, result: { points: 5 } });
  assert.equal(initial.score, 50);
  assert.equal(server.stats.state.landed, 1);
  assert.equal(server.stats.state.crashed, 0);
  assert.equal(server.stats.state.pilots[0].fastestMs, 5550, 'Landing records use the browser flight clock');
  assert.equal(initial.lander.a, 1, 'Terminal states cannot be changed');
  assert.ok(a.sent.some(m => m.type === 'result_ack' && m.score === 50));

  const replacement = connect(server, 'a', `pilotId=${pilotId}`);
  const replacementState = server.players.get('a');
  assert.notEqual(replacementState.authority, initial.authority);
  assert.equal(replacementState.lander.a, 1);
  server.onClose(a); server.onError(a);
  server.onMessage(a, JSON.stringify({ ...trusted, seq: 1000 }));
  assert.equal(server.players.get('a'), replacementState, 'Superseded callbacks and messages cannot affect the replacement');
  server.onClose(replacement);
  const resumed = connect(server, 'resumed', `pilotId=${pilotId}`);
  report(server, resumed, { lander: { ...state, a: 1 }, result: { points: 50 }, elapsedMs: 5550 });
  assert.equal(server.players.get('resumed').score, 50);
  assert.equal(server.stats.state.landed, 1, 'Disconnect/reconnect does not award a completed flight twice');
  assert.equal(server.nextSlot, 2, 'Released slots are reused');

  const bState = server.players.get('b');
  report(server, b, { lander: { ...bState.lander, a: 2 }, result: { points: 5 } });
  const crash = protocol.decodeCrash(server.messages.findLast(m => m.message instanceof ArrayBuffer && new Uint8Array(m.message)[0] === protocol.MSG_CRASH).message);
  assert.equal(crash.roundId, server.roundId);
  assert.equal(crash.slot, bState.slot);
  assert.ok(server.endgameDeadline > 0);
  rt.advance(6000); await server.onAlarm();
  assert.equal(server.stage, 1);
  const oldRound = server.roundId;
  const intermissionDeadline = server.intermissionDeadline;
  const late = connect(server, 'late', `pilotId=${randomUUID()}`);
  assert.equal(server.stage, 1, 'Joining cannot skip the shared intermission');
  assert.equal(server.intermissionDeadline, intermissionDeadline);
  report(server, late, { lander: { ...state, a: 2 }, result: { points: 5 } });
  assert.equal(server.players.get('late').lander.a, 0, 'Intermission rejects reports');
  rt.advance(4000); await server.onAlarm();
  assert.equal(server.stage, 2);
  assert.notEqual(server.roundId, oldRound);
  rt.advance(1800); await server.onAlarm();
  report(server, resumed, { ...outcome, authority: server.players.get('resumed').authority, seq: 999 });
  assert.equal(server.players.get('resumed').lander.a, 0, 'Previous-round outcomes cannot finish a new flight');
  assert.equal(server.stats.state.landed, 1);

  // A connected but frozen owner must not hold healthy pilots in the round.
  report(server, resumed, { lander: { ...server.players.get('resumed').lander, a: 1 }, elapsedMs: 50, result: { points: 15 } });
  rt.advance(15001); await server.onAlarm();
  assert.equal(server.players.size, 1, 'Silent flying clients are detached');
  assert.equal(server.stats.state.crashed, 1, 'Incomplete suspended flights do not count as crashes');
  assert.ok(server.endgameDeadline > 0);
  assert.equal(b.closed.code, 4002);
  assert.equal(late.closed.code, 4002);

  // Pause generations reject delayed pre-pause messages after reopening.
  const paused = new GameServer(); await paused.onStart();
  rt.setTime(Date.parse('2026-10-23T20:59:50-04:00'));
  const pd = connect(paused, 'd', 'mode=display');
  paused.onMessage(pd, JSON.stringify({ type: 'start_session', name: 'Hack Night' }));
  const pp = connect(paused, 'p');
  rt.advance(1800); await paused.onAlarm();
  const prePause = report(paused, pp, { elapsedMs: 50 });
  rt.setTime(Date.parse('2026-10-23T21:00:00-04:00')); await paused.onAlarm();
  const pauseState = JSON.stringify(paused.players.get('p').lander);
  report(paused, pp, { lander: { ...state, a: 2 }, result: { points: 5 }, elapsedMs: 100 });
  assert.equal(JSON.stringify(paused.players.get('p').lander), pauseState);
  rt.setTime(Date.parse('2026-10-23T21:45:00-04:00')); await paused.onAlarm();
  paused.onMessage(pp, JSON.stringify({ ...prePause, seq: 100, lander: state }));
  assert.equal(JSON.stringify(paused.players.get('p').lander), pauseState);
  report(paused, pp, { lander: state, elapsedMs: 100 });
  assert.equal(paused.players.get('p').lander.x, state.x);
  assert.equal(paused.players.size, 1, 'Scheduled pauses do not trip the silent-client timeout');

  assert.equal(protocol.decodeWorldUpdate(new ArrayBuffer(2)), null);
  assert.equal(protocol.decodeCrash(new ArrayBuffer(12)), null);
  console.log('Client authority checks passed: fixed-step physics/fuel, local outcomes, relay, ownership, validation, duplicate results, reconnects, round lifecycle, suspension, pause generations and spectator smoothing.');
})().catch(error => { console.error(error); process.exitCode = 1; });
