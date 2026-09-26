// 게임플레이 물리 코어 (렌더와 무관, Node 에서도 돈다).
//
// 병 = 강체 1개, 유체 = 병 안에 갇힌 입자 N개(대리 모델).
// 입자가 벽에 부딪히며 병에 충격량을 주고받기 때문에
//  - 비행 중: 원심력으로 물이 길게 퍼짐 → 관성모멘트 증가 → 회전이 느려짐
//  - 착지 시: 물이 바닥을 비탄성으로 때림 → 반동 흡수
// 가 자연스럽게 나온다. 고정 타임스텝 + 난수 시드로 결정적이다.

import {
  add, sub, scale, dot, cross, len, normalize,
  quatFromAxisAngle, quatMul, quatNormalize, rotate, rotateInv, mulberry32,
} from './math.js';
import { makeShape } from './shape.js';
import { BOTTLES, FLUIDS, MAPS, TABLE, THROW } from './config.js';

export const DT = 1 / 240;
const ITERATIONS = 12;
const MARGIN = 0.004; // 스펙큘러티브 접촉 여유
const SLOP = 0.0005;
const BAUMGARTE = 0.25;
const ABSORB_WINDOW = 0.15; // 착지 흡수가 작동하는 시간 (s)
const HOLD_MAX_SPIN = 10; // 손에 든 병이 기울기를 따라가는 최대 각속도 (rad/s)
const HOLD_MAX_SPEED = 4; // 손에 든 병이 커서를 따라가는 최대 속도 (m/s)
const LAUNCH_LIFT = 0.05; // 던지는 순간 병 바닥의 최소 높이 (m)

export class BottleSim {
  constructor(opts = {}) {
    this.configure(opts);
  }

  configure({ bottle = 'standard', fluid = 'water', fill = 0.3, map = 'forest', seed = 1, tuning = {} } = {}) {
    this.opts = { bottle, fluid, fill, map, seed, tuning };
    this.bottleCfg = BOTTLES[bottle];
    this.fluidCfg = FLUIDS[fluid];
    this.mapCfg = MAPS[map];
    this.throwCfg = { ...THROW, ...tuning };
    this.shape = makeShape(this.bottleCfg.scale);
    this.rng = mulberry32(seed);

    const sh = this.shape;
    const m = this.bottleCfg.shellMass;
    this.invM = 1 / m;
    const iPerp = m * (sh.radius * sh.radius / 2 + sh.height * sh.height / 12);
    const iAxis = m * sh.radius * sh.radius;
    this.invIBody = [1 / iPerp, 1 / iAxis, 1 / iPerp];
    this.com = [0, sh.comY, 0];

    // 유체 입자
    const fluidVolL = sh.volumeL * fill;
    this.fluidMass = fluidVolL * this.fluidCfg.density;
    this.nParticles = fill > 0.001 ? Math.max(3, Math.min(20, Math.round(fill * 24))) : 0;
    if (this.nParticles) {
      this.pMass = this.fluidMass / this.nParticles;
      this.pInvM = 1 / this.pMass;
      const perVol = fluidVolL / 1000 / this.nParticles;
      this.pSpacing = Math.cbrt(perVol) * 1.05;
      this.pRadius = Math.min(this.pSpacing / 2, sh.rIn * 0.9);
    }
    this.reset();
  }

  reset() {
    const sh = this.shape;
    this.time = 0;
    this.state = 'ready'; // ready → flying → done
    this.result = null;
    this.held = true;
    // 손 위치는 유지한다 (손에 든 채로 다시 시작).
    // 유체는 항상 같은 기준 자세에서 가라앉혀서, 어느 컴퓨터든 같은 초기 상태가 되게 한다.
    const keepHold = this.holdPos ?? [0, TABLE.y + 0.0005, this.throwCfg.startZ];
    this.holdPos = [0, TABLE.y + 0.0005, this.throwCfg.startZ];
    this.holdQuat = [0, 0, 0, 1];
    // 병 위치 = 질량중심 월드 좌표
    this.x = add(this.holdPos, this.com);
    this.q = [0, 0, 0, 1];
    this.v = [0, 0, 0];
    this.w = [0, 0, 0];
    this.landed = false;
    this.restTimer = 0;
    this.flightTime = 0;
    this.spinAngle = 0;
    this.impactSpeed = 0;
    this.fizzed = false;
    this.events = [];

    // 입자를 바닥부터 층층이 배치한 뒤 잠깐 가라앉힌다.
    this.p = [];
    this.pv = [];
    const n = this.nParticles;
    if (n) {
      const d = this.pSpacing;
      const ringR = Math.max(0, sh.rIn - this.pRadius) * 0.6;
      let y = sh.bottomIn + this.pRadius;
      let placed = 0;
      while (placed < n) {
        const perLayer = Math.max(1, Math.min(n - placed, Math.floor((2 * Math.PI * ringR) / d) + 1));
        for (let i = 0; i < perLayer; i++) {
          const a = (i / perLayer) * Math.PI * 2 + y * 37;
          const r = perLayer === 1 ? 0 : ringR;
          const local = [Math.cos(a) * r, y, Math.sin(a) * r];
          this.p.push(this.localToWorld(local));
          this.pv.push([0, 0, 0]);
          placed++;
        }
        y += d * 0.9;
      }
      for (let i = 0; i < 180; i++) this.step();
    }
    // 가라앉은 유체의 병 기준 위치 (던질 때마다 여기서 출발 → 결정적)
    this.restLocal = this.p.map((p) => this.worldToLocal(p));
    // 원래 손 위치로 통째로 옮긴다
    const shift = sub(keepHold, this.holdPos);
    this.holdPos = keepHold;
    this.x = add(this.x, shift);
    this.p = this.p.map((p) => add(p, shift));
    this.pv = this.pv.map(() => [0, 0, 0]);
    this.time = 0;
  }

  // ---- 좌표 변환 ----
  localToWorld(pl) {
    return add(this.x, rotate(this.q, sub(pl, this.com)));
  }
  worldToLocal(pw) {
    return add(rotateInv(this.q, sub(pw, this.x)), this.com);
  }
  up() {
    return rotate(this.q, [0, 1, 0]);
  }
  // 병 바닥 중심의 월드 좌표 (렌더용)
  bottomWorld() {
    return this.localToWorld([0, 0, 0]);
  }

  systemCom() {
    let c = scale(this.x, this.bottleCfg.shellMass);
    let m = this.bottleCfg.shellMass;
    for (const p of this.p) {
      c = add(c, scale(p, this.pMass));
      m += this.pMass;
    }
    return scale(c, 1 / m);
  }

  applyInvInertia(vec) {
    const l = rotateInv(this.q, vec);
    return rotate(this.q, [l[0] * this.invIBody[0], l[1] * this.invIBody[1], l[2] * this.invIBody[2]]);
  }

  // ---- 입력 ----
  // 던지는 방향 dir = [dx, dz] (수평 단위벡터) 에 대한 회전축.
  // 축 방향으로 +회전하면 병 위쪽이 던지는 사람 쪽으로 넘어오고 아래쪽이 위로 올라간다.
  static spinAxis(dir) {
    return normalize(cross([dir[0], 0, dir[1]], [0, 1, 0]));
  }

  // 손에 든 병의 자세: 로컬 +z(손/라벨 앞면)가 던지는 사람 쪽을 보게 돌린 뒤 tilt 만큼 기울인다
  static holdQuat(dir, tiltDeg) {
    const yaw = quatFromAxisAngle([0, 1, 0], Math.atan2(-dir[0], -dir[1]));
    const tilt = quatFromAxisAngle(BottleSim.spinAxis(dir), (tiltDeg * Math.PI) / 180);
    return quatMul(tilt, yaw);
  }

  // 손에 든 병을 (x, z) 위치, 테이블 위 lift 높이로 옮긴다. 움직이면 물이 출렁인다.
  // tilt: 병 위쪽을 던지는 사람 쪽으로 기울인 각도(도)
  setHold(x, z, lift = 0, tilt = 0, dir = [0, -1]) {
    if (!this.held) return;
    this.holdPos = [x, TABLE.y + 0.0005 + lift, z];
    this.holdQuat = BottleSim.holdQuat(dir, tilt);
  }

  // power: 0 ~ maxPower
  // angle: 앞으로 기울여 던지는 각도(도), dir: 수평 던지기 방향 [dx, dz] (기본: 테이블 안쪽 -z)
  // start: 병 바닥의 출발 위치 (생략하면 손 위치), seed: 탄산 등 랜덤 요소 시드
  // 같은 인자면 어느 컴퓨터에서든 같은 결과가 나온다 (온라인에서는 이 인자만 주고받는다).
  throw({ power, angle = this.throwCfg.angle, dir = [0, -1], start = null, seed = this.opts.seed }) {
    if (this.state !== 'ready') return null;
    const c = this.throwCfg;
    power = Math.max(0, Math.min(c.maxPower, power));
    const dl = Math.hypot(dir[0], dir[1]) || 1;
    dir = [dir[0] / dl, dir[1] / dl];
    const vUp = c.minUp + c.upPerPower * power;
    const fwd = vUp * Math.tan((angle * Math.PI) / 180);
    const v = [dir[0] * fwd, vUp, dir[1] * fwd];
    const axis = BottleSim.spinAxis(dir);
    // 기울여 던질수록(낮고 빠른 궤적) 손목 스냅이 더 들어가 회전이 빨라진다.
    // 그래야 체공이 짧아도 한 바퀴를 돌 수 있다.
    const snap = 1 + c.angleSpin * Math.sin((angle * Math.PI) / 180);
    // 무거운 껍데기는 같은 손목 동작에 덜 회전한다. 가득 찬 병은 물이
    // 퍼질 여유가 적어 비행 중 감속도 작으므로 출발 스냅을 함께 낮춘다.
    // 30% 페트병의 기존 손맛은 유지하는 게임플레이 보정 (실측 유체 모델 아님).
    const shellLoad = Math.max(0, this.bottleCfg.shellMass / this.bottleCfg.scale ** 3 - 0.022);
    const fullLoad = Math.max(0, (this.opts.fill - 0.4) / 0.6);
    const wristResponse = 1 / (1 + 4 * shellLoad + 0.65 * fullLoad);
    const w = scale(axis, (c.spinBase + c.spinRatio * vUp) * snap * wristResponse);
    this.held = false;
    // 시작 자세를 손에 들고 있던 상태와 무관하게 새로 만든다 (결정성):
    // 위쪽이 던지는 사람 쪽으로 startTilt 만큼 기운 병, 가라앉은 유체, 손 위치에서 출발.
    // 테이블에 너무 가까우면 바닥이 테이블을 긁으며 출발하므로 최소 높이를 둔다.
    const from = start ?? this.holdPos;
    const s0 = [from[0], Math.max(from[1], TABLE.y + LAUNCH_LIFT), from[2]];
    this.q = BottleSim.holdQuat(dir, c.startTilt);
    this.x = add(s0, rotate(this.q, this.com));
    this.p = this.restLocal.map((pl) => this.localToWorld(pl));
    // 병+유체 전체의 질량중심을 기준으로 강체 회전을 준다.
    // (병 껍데기 중심 기준으로 돌리면 바닥의 물이 뒤로 튀어 전체가 뒤로 간다)
    const cm = this.systemCom();
    this.v = add(v, cross(w, sub(this.x, cm)));
    this.w = w;
    this.pv = this.p.map((p) => add(v, cross(w, sub(p, cm))));
    this.rng = mulberry32(seed);
    this.time = 0; // 기차 흔들림 위상도 던지는 순간부터
    this.state = 'flying';
    this.throwTime = 0;
    this.flightTime = 0;
    this.spinAngle = 0;
    this.throwInfo = { power, angle, dir, start: s0, seed, vUp, spin: len(w) };
    return this.throwInfo;
  }

  // ---- 시뮬레이션 ----
  gravityVec(t) {
    const g = this.mapCfg.gravity;
    const sk = this.mapCfg.shake;
    if (!sk) return [0, -g, 0];
    // 기차: 좌우 흔들림 + 주기적인 덜컹 (프레임 가속도로 모델링, 결정적)
    const ax = sk.amp * (Math.sin((2 * Math.PI * t) / sk.period) + 0.4 * Math.sin((2 * Math.PI * t) / (sk.period * 0.37)));
    const phase = t % 2.3;
    const bump = phase < 0.08 ? sk.bump * Math.sin((phase / 0.08) * Math.PI) : 0;
    return [ax, -g - bump, 0];
  }

  surfaceHeight(x, z) {
    return Math.abs(x) <= TABLE.halfX && Math.abs(z) <= TABLE.halfZ ? TABLE.y : 0;
  }

  step() {
    const dt = DT;
    const g = this.gravityVec(this.time);
    const heldInv = this.held;

    // 손에 든 상태: 목표 자세로 가는 속도를 직접 설정 (키네마틱)
    if (heldInv) {
      const target = add(this.holdPos, rotate(this.holdQuat, this.com));
      // 커서를 바짝 따라가되, 순간이동으로 물이 폭발하지 않게 속도 상한을 둔다
      this.v = scale(sub(target, this.x), 0.5 / dt);
      const sp = len(this.v);
      if (sp > HOLD_MAX_SPEED) this.v = scale(this.v, HOLD_MAX_SPEED / sp);
      // 기울기도 각속도로 따라가게 해서 안의 물이 자연스럽게 반응한다
      let dq = quatMul(this.holdQuat, [-this.q[0], -this.q[1], -this.q[2], this.q[3]]);
      if (dq[3] < 0) dq = dq.map((c) => -c);
      const sinH = Math.hypot(dq[0], dq[1], dq[2]);
      if (sinH > 1e-6) {
        const ang = 2 * Math.atan2(sinH, dq[3]);
        let wm = (ang * 0.5) / dt;
        if (wm > HOLD_MAX_SPIN) wm = HOLD_MAX_SPIN;
        this.w = scale([dq[0], dq[1], dq[2]], wm / sinH);
      } else this.w = [0, 0, 0];
    } else {
      this.v = add(this.v, scale(g, dt));
    }
    const invM = heldInv ? 0 : this.invM;
    const invIScale = heldInv ? 0 : 1;

    const n = this.p.length;
    const fl = this.fluidCfg;
    for (let i = 0; i < n; i++) this.pv[i] = add(this.pv[i], scale(g, dt));

    // 점성 결합: 입자 속도를 병 벽 속도 쪽으로 끌어당김
    if (n) {
      const beta = 1 - Math.exp(-fl.viscosity * dt);
      for (let i = 0; i < n; i++) {
        const r = sub(this.p[i], this.x);
        const vb = add(this.v, cross(this.w, r));
        const vr = sub(this.pv[i], vb);
        const P = scale(vr, -beta / (this.pInvM + invM));
        this.pv[i] = add(this.pv[i], scale(P, this.pInvM));
        this.applyBottleImpulse(scale(P, -1), r, invM, invIScale);
      }
    }

    // 착지 흡수: 착지 직후 잠깐 동안 유체가 '철퍽' 하며 회전/출렁임 에너지를 먹는다.
    // 계 전체의 질량중심 속도는 그대로 두고, 그에 대한 상대 운동(회전 포함)만 줄인다
    // → 선운동량은 보존. 유체 비율이 높을수록 크다 (빈 병/유리병은 거의 없음).
    if (this.landed && n && !heldInv && this.time - this.landTime < ABSORB_WINDOW) {
      const frac = this.fluidMass / (this.fluidMass + this.bottleCfg.shellMass);
      const k = Math.exp(-fl.absorb * frac * dt);
      const mb = this.bottleCfg.shellMass;
      let vc = scale(this.v, mb);
      for (let i = 0; i < n; i++) vc = add(vc, scale(this.pv[i], this.pMass));
      vc = scale(vc, 1 / (mb + this.fluidMass));
      this.v = add(vc, scale(sub(this.v, vc), k));
      this.w = scale(this.w, k);
      for (let i = 0; i < n; i++) this.pv[i] = add(vc, scale(sub(this.pv[i], vc), k));
    }

    // ---- 접촉 수집 ----
    const contacts = [];
    const sh = this.shape;
    const mapFriction = this.mapCfg.friction * this.bottleCfg.friction;
    const bounce = Math.min(this.mapCfg.bounce, this.bottleCfg.restitution + 0.05);

    // 병 ↔ 테이블/바닥
    for (const hl of sh.hull) {
      const pw = this.localToWorld(hl);
      const h = this.surfaceHeight(pw[0], pw[2]);
      const sep = pw[1] - h;
      if (sep < MARGIN) {
        const r = sub(pw, this.x);
        contacts.push(this.makeContact('table', -1, -1, [0, 1, 0], r, sep, mapFriction, bounce, invM, invIScale));
      }
    }

    // 입자 ↔ 병 내벽
    if (n) {
      const pr = this.pRadius;
      const yLo = sh.bottomIn + pr;
      let yHi = sh.topIn - pr;
      // 목이 입자보다 좁으면 그 높이까지만 들어갈 수 있다
      for (let y = sh.shoulderY; y < yHi; y += 0.001) {
        if (sh.innerRadius(y) < pr) { yHi = y; break; }
      }
      for (let i = 0; i < n; i++) {
        const pl = this.worldToLocal(this.p[i]);
        const y = pl[1];
        const rho = Math.hypot(pl[0], pl[2]);
        const wallR = Math.max(0, sh.innerRadius(Math.min(Math.max(y, 0), sh.topIn)) - pr);
        // 옆벽
        if (rho > 1e-6) {
          const sepS = wallR - rho;
          if (sepS < MARGIN) {
            const radial = [pl[0] / rho, 0, pl[2] / rho];
            const slope = sh.innerSlope(y);
            const nl = normalize([-radial[0], slope, -radial[2]]);
            const wallPt = [radial[0] * (wallR + pr), y, radial[2] * (wallR + pr)];
            const r = rotate(this.q, sub(wallPt, this.com));
            contacts.push(this.makeContact('wall', i, -1, rotate(this.q, nl), r, sepS, fl.wallFriction, fl.wallBounce, invM, invIScale));
          }
        }
        // 바닥
        const sepB = y - yLo;
        if (sepB < MARGIN) {
          const r = rotate(this.q, sub([pl[0], sh.bottomIn, pl[2]], this.com));
          contacts.push(this.makeContact('wall', i, -1, rotate(this.q, [0, 1, 0]), r, sepB, fl.wallFriction, fl.wallBounce, invM, invIScale));
        }
        // 천장 (뚜껑 쪽)
        const sepT = yHi - y;
        if (sepT < MARGIN) {
          const r = rotate(this.q, sub([pl[0], yHi + pr, pl[2]], this.com));
          contacts.push(this.makeContact('wall', i, -1, rotate(this.q, [0, -1, 0]), r, sepT, fl.wallFriction, fl.wallBounce, invM, invIScale));
        }
      }
      // 입자 ↔ 입자 (부피 유지)
      const d0 = this.pSpacing;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const d = sub(this.p[i], this.p[j]);
          const dist = len(d);
          const sep = dist - d0;
          if (sep < MARGIN) {
            const nn = dist > 1e-9 ? scale(d, 1 / dist) : [0, 1, 0];
            contacts.push({ type: 'pp', i, j, n: nn, sep, k: 2 * this.pInvM, mu: 0, e: 0, acc: 0, accT: [0, 0, 0], vn0: dot(sub(this.pv[i], this.pv[j]), nn) });
          }
        }
      }
    }

    // ---- 순차 충격량 솔버 ----
    for (let it = 0; it < ITERATIONS; it++) {
      for (const c of contacts) this.solveContact(c, invM, invIScale, dt);
    }

    // 착지 판정 & 탄산 거품
    let touching = false;
    for (const c of contacts) if (c.type === 'table' && c.acc > 1e-7) touching = true;
    if (this.state === 'flying') {
      this.flightTime += dt;
      if (!this.landed) this.spinAngle += len(this.w) * dt;
      if (touching && this.flightTime > 0.05 && !this.landed) {
        this.landed = true;
        this.impactSpeed = len(this.v);
        this.landTime = this.time;
        this.events.push({ type: 'land', t: this.time, speed: this.impactSpeed });
        if (fl.fizz > 0 && !this.fizzed) {
          this.fizzed = true;
          const upV = this.up();
          for (let i = 0; i < n; i++) {
            const kick = fl.fizz * (0.4 + 0.6 * this.rng());
            const side = [(this.rng() - 0.5) * 0.3, 0, (this.rng() - 0.5) * 0.3];
            this.pv[i] = add(this.pv[i], add(scale(upV, kick), side));
          }
          this.events.push({ type: 'fizz', t: this.time });
        }
      }
    }

    // 굴러다니는 저항 (테이블에 닿아있을 때)
    if (touching && !heldInv) {
      this.w = scale(this.w, Math.exp(-2.0 * dt));
      this.v = [this.v[0] * Math.exp(-0.5 * dt), this.v[1], this.v[2] * Math.exp(-0.5 * dt)];
    }

    // ---- 위치 적분 ----
    this.x = add(this.x, scale(this.v, dt));
    const wl = len(this.w);
    if (wl > 1e-9) {
      const dq = quatFromAxisAngle(scale(this.w, 1 / wl), wl * dt);
      this.q = quatNormalize(quatMul(dq, this.q));
    }
    for (let i = 0; i < n; i++) this.p[i] = add(this.p[i], scale(this.pv[i], dt));

    this.time += dt;
    if (this.state === 'flying') this.checkRest();
  }

  makeContact(type, i, j, n, r, sep, mu, e, invM, invIScale) {
    // 유효 질량: 입자(있으면) + 병(팔 r)
    const rn = cross(r, n);
    const angular = invIScale ? dot(n, cross(this.applyInvInertia(rn), r)) : 0;
    const k = invM + angular + (i >= 0 ? this.pInvM : 0);
    const vrel = this.relVel({ type, i, r });
    return { type, i, j, n, r, sep, mu, e, k, acc: 0, accT: [0, 0, 0], vn0: dot(vrel, n) };
  }

  relVel(c) {
    if (c.type === 'pp') return sub(this.pv[c.i], this.pv[c.j]);
    const vb = add(this.v, cross(this.w, c.r));
    if (c.type === 'table') return vb;
    return sub(this.pv[c.i], vb); // wall: 입자 - 병
  }

  applyBottleImpulse(P, r, invM, invIScale) {
    if (!invM) return;
    this.v = add(this.v, scale(P, invM));
    if (invIScale) this.w = add(this.w, this.applyInvInertia(cross(r, P)));
  }

  applyContactImpulse(c, P, invM, invIScale) {
    if (c.type === 'pp') {
      this.pv[c.i] = add(this.pv[c.i], scale(P, this.pInvM));
      this.pv[c.j] = sub(this.pv[c.j], scale(P, this.pInvM));
    } else if (c.type === 'table') {
      this.applyBottleImpulse(P, c.r, invM, invIScale);
    } else {
      this.pv[c.i] = add(this.pv[c.i], scale(P, this.pInvM));
      this.applyBottleImpulse(scale(P, -1), c.r, invM, invIScale);
    }
  }

  solveContact(c, invM, invIScale, dt) {
    if (c.k <= 0) return;
    const vrel = this.relVel(c);
    const vn = dot(vrel, c.n);
    let target;
    if (c.sep > 0) target = -c.sep / dt;
    else target = (BAUMGARTE * Math.max(0, -c.sep - SLOP)) / dt;
    if (c.e > 0 && c.vn0 < -0.4 && c.sep < 0.002) target = Math.max(target, -c.e * c.vn0);
    let dl = (target - vn) / c.k;
    const newAcc = Math.max(0, c.acc + dl);
    dl = newAcc - c.acc;
    c.acc = newAcc;
    if (dl !== 0) this.applyContactImpulse(c, scale(c.n, dl), invM, invIScale);

    // 마찰 (벡터형, 쿨롱 원뿔로 클램프)
    if (c.mu > 0 && c.acc > 0) {
      const vr2 = this.relVel(c);
      const vt = sub(vr2, scale(c.n, dot(vr2, c.n)));
      const vtl = len(vt);
      if (vtl > 1e-9) {
        const t = scale(vt, 1 / vtl);
        let kt;
        if (c.type === 'pp') kt = 2 * this.pInvM;
        else {
          const rt = cross(c.r, t);
          const ang = invIScale ? dot(t, cross(this.applyInvInertia(rt), c.r)) : 0;
          kt = invM + ang + (c.type === 'wall' ? this.pInvM : 0);
        }
        if (kt > 0) {
          const old = c.accT;
          let acc = add(old, scale(t, -vtl / kt));
          const maxF = c.mu * c.acc;
          const al = len(acc);
          if (al > maxF) acc = scale(acc, maxF / al);
          const d = sub(acc, old);
          c.accT = acc;
          this.applyContactImpulse(c, d, invM, invIScale);
        }
      }
    }
  }

  checkRest() {
    const bottomY = this.bottomWorld()[1];
    const offTable = bottomY < TABLE.y - 0.15 && this.x[1] < TABLE.y - 0.05;
    const slow = len(this.v) < 0.03 && len(this.w) < 0.4;
    this.restTimer = this.landed && slow ? this.restTimer + DT : 0;
    const timeout = this.flightTime > 8;
    if (!(this.restTimer > 0.4 || timeout || (offTable && this.flightTime > 1.0))) return;

    const upY = this.up()[1];
    let outcome;
    if (offTable || this.x[1] < TABLE.y - 0.05) outcome = 'offtable';
    else if (upY > 0.97) outcome = 'upright';
    else if (upY < -0.97) outcome = 'cap';
    else outcome = 'fallen';
    this.state = 'done';
    this.result = {
      outcome,
      rotations: this.spinAngle / (Math.PI * 2),
      airTime: this.landed ? this.landTime - this.throwTime : null,
      impactSpeed: this.impactSpeed,
      time: this.flightTime,
    };
  }

  // 한 번 던지고 결과가 날 때까지 돌린다 (테스트/AI/리플레이용)
  runToEnd(maxSeconds = 10) {
    const steps = Math.ceil(maxSeconds / DT);
    for (let i = 0; i < steps && this.state !== 'done'; i++) this.step();
    return this.result;
  }

  // 렌더러용 스냅샷 (멀티에서는 호스트가 이것만 뿌리면 된다)
  snapshot() {
    return {
      bottom: this.bottomWorld(),
      q: this.q.slice(),
      particles: this.p.map((p) => p.slice()),
      com: this.x.slice(),
      state: this.state,
    };
  }
}
