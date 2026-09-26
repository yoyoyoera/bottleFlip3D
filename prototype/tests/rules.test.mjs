import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, recordThrow, advanceTurn, ranking, pointsFor } from '../src/rules.js';

const players = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}` }));

test('점수: 세우기 1점, 뚜껑 착지는 옵션에 따라 2점', () => {
  assert.equal(pointsFor('upright', true), 1);
  assert.equal(pointsFor('cap', true), 2);
  assert.equal(pointsFor('cap', false), 1);
  assert.equal(pointsFor('fallen', true), 0);
  assert.equal(pointsFor('offtable', true), 0);
});

test('먼저 성공: 목표에 먼저 닿은 사람이 이기고 바로 끝난다', () => {
  const m = createMatch({ players: players(3), mode: 'first', target: 2 });
  recordThrow(m, 'upright'); advanceTurn(m); // P1 1점
  recordThrow(m, 'fallen'); advanceTurn(m); // P2
  recordThrow(m, 'cap'); // P3 뚜껑 2점 → 승리
  assert.equal(m.over, true);
  assert.equal(m.winner, 2);
  assert.deepEqual(ranking(m), [2, 0, 1]);
});

test('꼴등 가리기: 통과한 사람은 빠지고 마지막 한 명이 꼴등', () => {
  const m = createMatch({ players: players(3), mode: 'last', target: 1 });
  recordThrow(m, 'upright'); // P1 통과 (1등)
  assert.equal(m.players[0].done, true);
  assert.equal(advanceTurn(m), 1);
  recordThrow(m, 'fallen');
  assert.equal(advanceTurn(m), 2);
  recordThrow(m, 'fallen');
  assert.equal(advanceTurn(m), 1, '빠진 P1은 건너뛴다');
  recordThrow(m, 'upright'); // P2 통과 → P3 꼴등
  assert.equal(m.over, true);
  assert.equal(m.loser, 2);
  assert.deepEqual(ranking(m), [0, 1, 2]);
});

test('뚜껑 2점을 끄면 목표 2점은 두 번 성공해야 한다', () => {
  const m = createMatch({ players: players(2), mode: 'first', target: 2, capDouble: false });
  recordThrow(m, 'cap');
  assert.equal(m.over, false);
  advanceTurn(m);
  recordThrow(m, 'fallen');
  advanceTurn(m);
  recordThrow(m, 'upright');
  assert.equal(m.winner, 0);
});

test('성공하면 한 번 더: 옵션을 켜면 성공한 사람이 계속 던진다', () => {
  const m = createMatch({ players: players(2), mode: 'first', target: 3, continueOnHit: true });
  recordThrow(m, 'upright');
  assert.equal(advanceTurn(m), 0, '성공했으니 그대로 P1');
  recordThrow(m, 'fallen');
  assert.equal(advanceTurn(m), 1, '실패하면 다음 사람');
  const off = createMatch({ players: players(2), mode: 'first', target: 3 });
  recordThrow(off, 'upright');
  assert.equal(advanceTurn(off), 1, '기본은 끔');
});
