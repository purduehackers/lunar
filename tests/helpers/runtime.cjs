const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function runtime(extras = {}, overrides = {}) {
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
    broadcast(message, exclude = []) { this.messages.push({ message, exclude }); }
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
      require: name => overrides[name] ?? (name === 'partyserver' ? { Server } : load(path.resolve(path.dirname(file), name + '.ts'))),
      Date: Clock, URL, crypto: { randomUUID }, structuredClone, ArrayBuffer, DataView, Uint8Array,
      ...extras,
    }, { filename: file });
    return exports;
  }
  function connect(server, id, query = '') {
    const connection = { id, sent: [], send(message) { this.sent.push(typeof message === 'string' ? JSON.parse(message) : message); }, close(code, reason) { this.closed = { code, reason }; } };
    server.onConnect(connection, { request: new Request('https://example.com/?' + query) });
    return connection;
  }
  function report(server, connection, patch = {}) {
    const ps = server.players.get(connection.id);
    const data = { type: 'state', roundId: server.roundId, epoch: server.epoch, authority: ps.authority,
      seq: ps.lastSeq + 1, lander: { ...ps.lander }, elapsedMs: ps.elapsedMs, result: null, ...patch };
    server.onMessage(connection, JSON.stringify(data));
    return data;
  }
  return { load, connect, report, now: () => now, setTime: value => { now = value; }, advance: ms => { now += ms; } };
}
module.exports = { runtime };
