import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { attachMultiplayer, validateSettings, validateThrow } from '../server/multiplayer.js';
import { TurnClock } from '../src/turnClock.js';
import { BottleSim } from '../src/physics.js';

const input = { power: 0.4, angle: 10, dir: [0, -1], start: [0, 0.964, 0.56] };

async function setup(t) {
  let time = 1000;
  const server = createServer();
  const game = attachMultiplayer(server, { now: () => time, autoTick: false });
  const sockets = [];
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    game.close();
    await new Promise(resolve => server.close(resolve));
  });
  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/multiplayer`);
    sockets.push(ws);
    const queue = [], listeners = new Set();
    ws.on('message', raw => { const msg = JSON.parse(raw); queue.push(msg); for (const f of listeners) f(); });
    const next = (type, predicate = () => true) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Timed out: ${type}; ${JSON.stringify(queue.map(m => [m.type, m.phase]))}`)); }, 3000);
      function check() {
        const idx = queue.findIndex(m => m.type === type && predicate(m));
        if (idx < 0) return;
        clearTimeout(timer); listeners.delete(check); resolve(queue.splice(idx, 1)[0]);
      }
      listeners.add(check); check();
    });
    const welcome = await next('welcome');
    return { ws, id: welcome.id, next, send: msg => ws.send(JSON.stringify(msg)) };
  }
  async function advance(ms) {
    const end = time + ms;
    while (time < end) { time += Math.min(50, end - time); game.tick(); await yieldIO(); }
  }
  return { client, advance, jump: ms => { time += ms; game.tick(); } };
}

async function twoPlayers(env, settings = {}) {
  const a = await env.client(), b = await env.client();
  a.send({ type: 'create', name: '방장', settings });
  const room = await a.next('room');
  b.send({ type: 'join', code: room.code, name: '친구' });
  await b.next('room'); await a.next('room', r => r.members.length === 2);
  return { a, b, room };
}

test('피치 클락: 정확히 15초에 만료, 정지 뒤에는 만료되지 않는다', () => {
  const c = new TurnClock();
  c.start(1000);
  assert.equal(c.remaining(15_999), 1);
  assert.equal(c.expired(15_999), false);
  assert.equal(c.expired(16_000), true);
  c.stop(); assert.equal(c.expired(1e9), false);
  c.start(20_000); assert.equal(c.remaining(20_000), 15_000);
});

test('서버 입력 검증: 설정, 좌석, 무한대, 과도한 파워와 위조 시작점 거부', () => {
  assert.throws(() => validateSettings({ bottle: '__proto__' }));
  assert.throws(() => validateSettings({ fill: null }));
  assert.throws(() => validateSettings({ target: 99 }));
  assert.throws(() => validateThrow({ ...input, power: Infinity }, 0));
  assert.throws(() => validateThrow({ ...input, power: 10 }, 0));
  assert.throws(() => validateThrow({ ...input, start: [0, 1.9, 0] }, 0));
  assert.throws(() => validateThrow(input, 1));
  assert.deepEqual(validateThrow(input, 0), input);
});

test('방 참가: 없는 방, 5번째 참가, 참가자의 시작, 게임 도중 참가 거부', async t => {
  const env = await setup(t);
  const { a, b, room } = await twoPlayers(env);
  b.send({ type: 'start' }); assert.match((await b.next('error')).message, /방장/);
  for (let i = 0; i < 2; i++) { const c = await env.client(); c.send({ type: 'join', code: room.code }); await c.next('room'); }
  const fifth = await env.client();
  fifth.send({ type: 'join', code: 'XXXXXX' }); assert.match((await fifth.next('error')).message, /찾을/);
  fifth.send({ type: 'join', code: room.code }); assert.match((await fifth.next('error')).message, /가득/);
  a.send({ type: 'start' }); await a.next('room', r => r.phase === 'ready');
  fifth.send({ type: 'join', code: room.code }); assert.match((await fifth.next('error')).message, /게임 중/);
});

test('15초 시간 초과는 양쪽에 같은 0점, 한 번만 기록하고 다음 차례로', async t => {
  const env = await setup(t); const { a, b } = await twoPlayers(env);
  a.send({ type: 'start' }); const ready = await a.next('room', r => r.phase === 'ready');
  await env.advance(15_000);
  const ra = await a.next('room', r => r.phase === 'result');
  const rb = await b.next('room', r => r.phase === 'result');
  assert.deepEqual(ra.match, rb.match);
  assert.equal(ra.result.outcome, 'timeout'); assert.equal(ra.match.players[0].throws, 1); assert.equal(ra.match.players[0].score, 0);
  a.send({ type: 'throw', turnId: ready.turnId, input }); await a.next('error');
  await env.advance(1700);
  const next = await a.next('room', r => r.phase === 'ready' && r.turnId > ready.turnId);
  assert.equal(next.match.turn, 1); assert.equal(next.remaining, 15_000); assert.equal(next.match.players[0].throws, 1);
});

test('유효한 던지기는 서버만 판정: 다른 차례/중복 입력 거부, 상태와 결과 일치', async t => {
  const env = await setup(t); const { a, b } = await twoPlayers(env, { target: 5 });
  a.send({ type: 'start' }); const ready = await a.next('room', r => r.phase === 'ready');
  b.send({ type: 'throw', turnId: ready.turnId, input }); assert.match((await b.next('error')).message, /자신의 차례/);
  a.send({ type: 'throw', turnId: ready.turnId, input });
  const launch = await a.next('launch'); await b.next('launch');
  a.send({ type: 'throw', turnId: ready.turnId, input }); await a.next('error');
  await env.advance(50);
  const fa = await a.next('frame'), fb = await b.next('frame');
  assert.deepEqual(fa.snapshot, fb.snapshot);
  await env.advance(9000);
  const ra = await a.next('room', r => r.phase === 'result'), rb = await b.next('room', r => r.phase === 'result');
  const expected = new BottleSim({}); expected.throw(launch.input);
  assert.equal(ra.result.outcome, expected.runToEnd().outcome);
  assert.deepEqual(ra.result, rb.result); assert.deepEqual(ra.match, rb.match);
  assert.equal(ra.match.players[0].throws, 1);
});

test('시간 경계 직전 던진 병은 공중에서 시간 초과되지 않는다', async t => {
  const env = await setup(t); const { a } = await twoPlayers(env);
  a.send({ type: 'start' }); const ready = await a.next('room', r => r.phase === 'ready');
  await env.advance(14_999);
  a.send({ type: 'throw', turnId: ready.turnId, input }); await a.next('launch');
  await env.advance(9000);
  const r = await a.next('room', r => r.phase === 'result'); assert.notEqual(r.result.outcome, 'timeout');
});

test('방장이 나가면 대기실로 복귀하고 남은 참가자에게 방장 이전', async t => {
  const env = await setup(t); const { a, b } = await twoPlayers(env);
  a.send({ type: 'start' }); await b.next('room', r => r.phase === 'ready');
  a.ws.close();
  const r = await b.next('room', r => r.phase === 'lobby' && r.members.length === 1);
  assert.equal(r.hostId, b.id); assert.equal(r.match, null); assert.match(r.notice, /나갔습니다/);
});

test('성공 점수, 승리, 재시작과 옛 차례 입력 거부가 두 참가자에게 일치한다', async t => {
  const env = await setup(t); const { a, b } = await twoPlayers(env);
  a.send({ type: 'start' }); const ready = await a.next('room', r => r.phase === 'ready');
  const winning = { ...input, power: 0.45, start: [0, 0.9655, 0.56] };
  a.send({ type: 'result', outcome: 'upright' }); await a.next('error');
  a.send({ type: 'throw', turnId: ready.turnId, input: winning }); await a.next('launch');
  await env.advance(9000);
  const ra = await a.next('room', r => r.phase === 'over'), rb = await b.next('room', r => r.phase === 'over');
  assert.deepEqual(ra.match, rb.match); assert.equal(ra.match.winner, 0); assert.equal(ra.match.players[0].score, 1);
  b.send({ type: 'start' }); await b.next('error');
  a.send({ type: 'start' }); const again = await a.next('room', r => r.phase === 'ready' && r.turnId > ready.turnId);
  assert.equal(again.match.players[0].score, 0); assert.equal(again.match.players[0].throws, 0);
  a.send({ type: 'throw', turnId: ready.turnId, input }); await a.next('error');
});
