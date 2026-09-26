// 멀티플레이 룰 (화면/네트워크와 무관한 순수 로직).
// 온라인에서도 이 상태를 호스트가 들고, 던진 결과만 recordThrow 로 넣으면 된다.
//
// 모드
//  first : 누군가 목표 점수에 닿으면 바로 끝 (그 사람이 1등)
//  last  : 목표 점수에 닿은 사람은 빠져서 관전, 마지막 한 명(꼴등)이 남을 때까지
// 점수: 세우기 1점, 뚜껑 착지 2점 (capDouble 옵션, 기본 켬)
// continueOnHit: 성공하면 (아직 안 빠졌을 때) 같은 사람이 한 번 더 던진다 (기본 끔)

export const MODES = {
  first: { name: '먼저 성공', desc: '누군가 목표 점수에 닿으면 바로 끝나요.' },
  last: { name: '꼴등 가리기', desc: '목표 점수에 닿은 사람은 빠져서 관전. 마지막 한 명이 남을 때까지.' },
};

export function createMatch({ players, mode = 'first', target = 1, capDouble = true, continueOnHit = false }) {
  if (players.length < 2) throw new Error('2명 이상 필요');
  return {
    mode,
    target,
    capDouble,
    continueOnHit,
    lastPoints: 0,
    players: players.map((p) => ({ ...p, score: 0, throws: 0, hits: 0, caps: 0, done: false, place: null })),
    turn: 0,
    finishOrder: [],
    over: false,
    winner: null,
    loser: null,
  };
}

export function pointsFor(outcome, capDouble) {
  if (outcome === 'upright') return 1;
  if (outcome === 'cap') return capDouble ? 2 : 1;
  return 0;
}

// 현재 차례 플레이어의 던지기 결과를 반영한다.
export function recordThrow(m, outcome) {
  if (m.over) return null;
  const idx = m.turn;
  const p = m.players[idx];
  const points = pointsFor(outcome, m.capDouble);
  p.throws++;
  if (points) p.hits++;
  if (outcome === 'cap') p.caps++;
  p.score += points;
  m.lastPoints = points;
  let finished = false;
  if (!p.done && p.score >= m.target) {
    finished = true;
    p.done = true;
    m.finishOrder.push(idx);
    p.place = m.finishOrder.length;
  }
  if (m.mode === 'first') {
    if (finished) {
      m.over = true;
      m.winner = idx;
    }
  } else {
    const active = activePlayers(m);
    if (active.length <= 1) {
      m.over = true;
      m.loser = active.length ? active[0] : null;
      if (m.loser != null) m.players[m.loser].place = m.players.length;
    }
  }
  return { player: idx, points, finished, over: m.over };
}

export function activePlayers(m) {
  return m.players.map((p, i) => (p.done ? -1 : i)).filter((i) => i >= 0);
}

// 다음 차례: 아직 안 빠진 사람 중 자리 순서대로
export function advanceTurn(m) {
  if (m.over) return m.turn;
  if (m.continueOnHit && m.lastPoints > 0 && !m.players[m.turn].done) return m.turn;
  const n = m.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (m.turn + k) % n;
    if (!m.players[i].done) {
      m.turn = i;
      return i;
    }
  }
  return m.turn;
}

// 최종 순위 (위에서부터)
export function ranking(m) {
  const idx = m.players.map((_, i) => i);
  if (m.mode === 'last') {
    const rest = idx.filter((i) => !m.finishOrder.includes(i));
    return [...m.finishOrder, ...rest];
  }
  const byScore = (a, b) => m.players[b].score - m.players[a].score || m.players[a].throws - m.players[b].throws;
  const others = idx.filter((i) => i !== m.winner).sort(byScore);
  return m.winner != null ? [m.winner, ...others] : others;
}
