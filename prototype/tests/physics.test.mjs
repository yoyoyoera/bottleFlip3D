import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BottleSim, DT } from '../src/physics.js';

const sweep = (opts, step = 0.05) => {
  const sim = new BottleSim(opts);
  const out = [];
  for (let p = 0; p <= 1.5 + 1e-9; p += step) {
    sim.reset();
    sim.throw({ power: p });
    out.push({ p, ...sim.runToEnd() });
  }
  return out;
};
const isOk = (r) => r.outcome === 'upright' || r.outcome === 'cap';

test('같은 입력이면 결과가 완전히 같다 (결정성)', () => {
  const run = () => {
    const sim = new BottleSim({ fluid: 'soda', map: 'train', seed: 7 });
    sim.throw({ power: 1.05, lateral: 0.1 });
    sim.runToEnd();
    return JSON.stringify(sim.snapshot());
  };
  assert.equal(run(), run());
});

test('세워둔 병은 가만히 서 있다', () => {
  for (const fluid of ['water', 'honey', 'soda', 'slime']) {
    const sim = new BottleSim({ fluid });
    sim.held = false;
    for (let i = 0; i < 2 / DT; i++) sim.step();
    assert.ok(sim.up()[1] > 0.999, `${fluid}: 기울어짐 ${sim.up()[1]}`);
    assert.ok(Math.abs(sim.x[2] - 0.3) < 0.005, `${fluid}: 미끄러짐`);
  }
});

test('물 30%: 성공하는 파워 구간이 존재한다', () => {
  const ok = sweep({ fluid: 'water', fill: 0.3 }).filter(isOk);
  assert.ok(ok.length >= 3, `성공 ${ok.length}회`);
});

test('유체가 공중에서 회전을 늦춘다 (빈 병보다 회전수가 적다)', () => {
  const rot = (fill) => {
    const sim = new BottleSim({ fluid: 'water', fill });
    sim.throw({ power: 1.1 });
    let maxW = 0;
    let minW = Infinity;
    while (!sim.landed && sim.flightTime < 2) {
      sim.step();
      const w = Math.hypot(...sim.w);
      maxW = Math.max(maxW, w);
      minW = Math.min(minW, w);
    }
    return minW / maxW;
  };
  assert.ok(rot(0.3) < 0.6, '물이 있으면 회전이 크게 줄어야 함');
  assert.ok(rot(0) > 0.95, '빈 병은 회전이 유지돼야 함');
});

test('빈 병은 물병보다 성공률이 낮다', () => {
  const empty = sweep({ fluid: 'water', fill: 0 }).filter(isOk).length;
  const water = sweep({ fluid: 'water', fill: 0.3 }).filter(isOk).length;
  assert.ok(empty < water, `empty ${empty} vs water ${water}`);
});

test('꿀은 물보다 세게 던져야 선다', () => {
  const center = (fluid) => {
    const ok = sweep({ fluid, fill: 0.3 }, 0.025).filter((r) => r.outcome === 'upright');
    return ok.reduce((a, r) => a + r.p, 0) / ok.length;
  };
  assert.ok(center('honey') > center('water'));
});

test('테이블 밖으로 나가면 offtable', () => {
  const sim = new BottleSim({});
  sim.throw({ power: 1.0, lateral: 1 });
  sim.v[0] = 6; // 옆으로 날려버림
  const r = sim.runToEnd();
  assert.equal(r.outcome, 'offtable');
});
