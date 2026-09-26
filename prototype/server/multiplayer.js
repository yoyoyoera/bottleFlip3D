import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { BottleSim, DT } from '../src/physics.js';
import { BOTTLES, FLUIDS, MAPS, THROW, TABLE } from '../src/config.js';
import { createMatch, recordThrow, advanceTurn } from '../src/rules.js';
import { TurnClock, TURN_MS } from '../src/turnClock.js';

const COLORS = ['#4fa8ff', '#ff7a7a', '#56d98a', '#ffd36e'];
const SEATS = { 2: [0, 1], 3: [0, 2, 1], 4: [0, 2, 1, 3] };
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const vector = (v, n, min, max) => Array.isArray(v) && v.length === n && v.every(x => finite(x, min, max));
const member = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);
const nameOf = v => (typeof v === 'string' ? v.trim().slice(0, 12) : '') || '플레이어';

export function validateSettings(value = {}) {
  if (!value || typeof value !== 'object') throw new Error('방 설정이 올바르지 않습니다.');
  const { bottle = 'standard', fluid = 'water', map = 'forest', fill = 0.3,
    mode = 'first', target = 1, capDouble = true, continueOnHit = false } = value;
  if (!member(BOTTLES, bottle) || !member(FLUIDS, fluid) || !member(MAPS, map) || !finite(fill, 0, 1)
    || !['first', 'last'].includes(mode) || !Number.isInteger(target) || target < 1 || target > 5
    || typeof capDouble !== 'boolean' || typeof continueOnHit !== 'boolean') throw new Error('방 설정이 올바르지 않습니다.');
  return { bottle, fluid, map, fill, mode, target, capDouble, continueOnHit };
}

export function validateThrow(value, seat) {
  if (!value || !finite(value.power, 0, THROW.maxPower) || !finite(value.angle, THROW.minAngle, THROW.maxAngle)
    || !vector(value.dir, 2, -1, 1) || Math.abs(Math.hypot(...value.dir) - 1) > 0.01
    || !vector(value.start, 3, -2, 2)) throw new Error('던지기 입력이 올바르지 않습니다.');
  const yaw = [0, Math.PI, Math.PI / 2, -Math.PI / 2][seat];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const [x, y, z] = value.start;
  const lx = x * c - z * s, lz = x * s + z * c;
  const depth = seat < 2 ? TABLE.halfZ : TABLE.halfX;
  const dx = value.dir[0] * c - value.dir[1] * s;
  const dz = value.dir[0] * s + value.dir[1] * c;
  if (Math.abs(lx) > 0.301 || lz < depth - 0.201 || lz > depth + 0.161
    || y < TABLE.y + 0.199 || y > TABLE.y + 0.252 || dz > -0.6 || Math.abs(dx) > 0.8)
    throw new Error('자기 자리에서 테이블 쪽으로 던져주세요.');
  return { power: value.power, angle: value.angle, start: [...value.start], dir: [...value.dir] };
}

// 방장 브라우저가 아닌 서버가 물리와 점수의 최종 권한을 가진다.
export function attachMultiplayer(server, { now = Date.now, turnMs = TURN_MS, resultMs = 1700, autoTick = true } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const rooms = new Map();
  const clients = new Set();
  const send = (client, message) => {
    if (client.ws.readyState === WebSocket.OPEN && client.ws.bufferedAmount < 256 * 1024)
      client.ws.send(JSON.stringify(message));
  };
  const broadcast = (room, message) => room.members.forEach(c => send(c, message));
  const publish = room => broadcast(room, {
    type: 'room', code: room.code, hostId: room.hostId, settings: room.settings,
    members: room.members.map(c => ({ id: c.id, name: c.name })), match: room.match,
    phase: room.phase, turnId: room.turnId, remaining: room.clock.remaining(now()),
    result: room.result, notice: room.notice,
  });
  function startTurn(room) {
    room.turnId++;
    room.phase = 'ready';
    room.result = null;
    room.sim = new BottleSim(room.settings);
    room.acc = 0;
    room.clock.start(now());
    publish(room);
  }
  function finishThrow(room, result) {
    if (!['ready', 'flying'].includes(room.phase)) return;
    room.clock.stop();
    recordThrow(room.match, result.outcome);
    room.result = result;
    room.phase = 'result';
    room.nextAt = now() + resultMs;
    publish(room);
  }
  function leave(client) {
    const room = client.room;
    if (!room) return;
    client.room = null;
    room.members = room.members.filter(c => c !== client);
    if (!room.members.length) { rooms.delete(room.code); return; }
    if (room.hostId === client.id) room.hostId = room.members[0].id;
    room.notice = `${client.name}님이 나갔습니다. 대기실에서 다시 시작하세요.`;
    room.match = null;
    room.sim = null;
    room.result = null;
    room.phase = 'lobby';
    room.clock.stop();
    publish(room);
  }
  function receive(client, msg) {
    if (!msg || typeof msg !== 'object') throw new Error('잘못된 요청입니다.');
    let room = client.room;
    if (msg.type === 'create' || msg.type === 'join') {
      if (room) throw new Error('현재 방을 먼저 나가주세요.');
      client.name = nameOf(msg.name);
      if (msg.type === 'create') {
        const settings = validateSettings(msg.settings);
        if (rooms.size >= 100) throw new Error('서버의 방이 가득 찼습니다.');
        let code;
        do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
        room = { code, hostId: client.id, members: [], settings, match: null, phase: 'lobby',
          turnId: 0, clock: new TurnClock(turnMs), result: null, notice: '' };
        rooms.set(code, room);
      } else {
        room = rooms.get(String(msg.code ?? '').trim().toUpperCase());
        if (!room) throw new Error('방 코드를 찾을 수 없습니다.');
        if (room.phase !== 'lobby') throw new Error('이미 게임 중인 방입니다.');
        if (room.members.length >= 4) throw new Error('방이 가득 찼습니다 (최대 4명).');
      }
      client.room = room;
      room.members.push(client);
      room.notice = '';
      publish(room);
      return;
    }
    if (!room) throw new Error('먼저 방에 참가하세요.');
    if (msg.type === 'leave') { leave(client); send(client, { type: 'left' }); return; }
    if (msg.type === 'start') {
      if (room.hostId !== client.id) throw new Error('방장만 시작할 수 있습니다.');
      if (!['lobby', 'over'].includes(room.phase)) throw new Error('이미 진행 중입니다.');
      if (room.members.length < 2) throw new Error('2명 이상 모이면 시작할 수 있습니다.');
      room.match = createMatch({ ...room.settings, players: room.members.map((c, i) => ({
        id: c.id, name: c.name, color: COLORS[i], seat: SEATS[room.members.length][i],
      })) });
      room.notice = '';
      startTurn(room);
      return;
    }
    if (msg.type === 'throw') {
      if (room.phase !== 'ready' || msg.turnId !== room.turnId) throw new Error('현재 던질 수 없는 차례입니다.');
      const player = room.match.players[room.match.turn];
      if (player.id !== client.id) throw new Error('자신의 차례를 기다려주세요.');
      if (room.clock.expired(now())) {
        finishThrow(room, { outcome: 'timeout', rotations: 0, airTime: null });
        throw new Error('15초 제한 시간이 지났습니다.');
      }
      const input = validateThrow(msg.input, player.seat);
      input.seed = randomBytes(4).readUInt32LE();
      room.sim.throw(input);
      room.clock.stop();
      room.phase = 'flying';
      room.acc = 0;
      broadcast(room, { type: 'launch', turnId: room.turnId, input });
      publish(room);
      return;
    }
    throw new Error('지원하지 않는 요청입니다.');
  }
  let previous = now();
  function tick() {
    const time = now();
    const elapsed = Math.min(0.1, Math.max(0, (time - previous) / 1000));
    previous = time;
    for (const room of rooms.values()) {
      if (room.phase === 'ready' && room.clock.expired(time))
        finishThrow(room, { outcome: 'timeout', rotations: 0, airTime: null });
      if (room.phase === 'flying') {
        room.acc += elapsed;
        while (room.acc >= DT && room.sim.state !== 'done') { room.sim.step(); room.acc -= DT; }
        const events = room.sim.events.splice(0);
        broadcast(room, { type: 'frame', turnId: room.turnId, snapshot: room.sim.snapshot(), time: room.sim.time, events });
        if (room.sim.state === 'done') finishThrow(room, { ...room.sim.result, power: room.sim.throwInfo.power });
      }
      if (room.phase === 'result' && time >= room.nextAt) {
        if (room.match.over) { room.phase = 'over'; publish(room); }
        else { advanceTurn(room.match); startTurn(room); }
      }
      if (room.phase === 'ready') broadcast(room, { type: 'clock', turnId: room.turnId, remaining: room.clock.remaining(time) });
    }
  }
  const onUpgrade = (req, socket, head) => {
    if (req.url !== '/multiplayer') return; // Vite HMR handles its own path.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  };
  server.on('upgrade', onUpgrade);
  wss.on('connection', ws => {
    const client = { id: randomUUID(), name: '', room: null, ws, alive: true, count: 0, window: now() };
    clients.add(client);
    send(client, { type: 'welcome', id: client.id });
    ws.on('pong', () => { client.alive = true; });
    ws.on('error', () => {});
    ws.on('message', data => {
      if (now() - client.window >= 1000) { client.count = 0; client.window = now(); }
      if (++client.count > 30) { ws.close(1008, 'Too many requests'); return; }
      try { receive(client, JSON.parse(data.toString())); }
      catch (e) { send(client, { type: 'error', message: e.message }); }
    });
    ws.on('close', () => { leave(client); clients.delete(client); });
  });
  const interval = autoTick ? setInterval(tick, 50) : null;
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false; c.ws.ping();
    }
  }, 15_000);
  heartbeat.unref();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(interval); clearInterval(heartbeat);
    server.off('upgrade', onUpgrade);
    for (const c of clients) c.ws.terminate();
    wss.close();
  }
  server.once('close', close);
  return { tick, close };
}
