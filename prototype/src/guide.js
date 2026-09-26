// 성공 구간 가이드: 같은 입력이면 같은 결과가 나오므로 파워별 결과를 미리 돌려본다.
// 한 번에 수십 번 시뮬레이션하므로 화면이 끊기지 않게 워커에서 돌린다 (guideWorker.js).

import { BottleSim } from './physics.js';

// req: { simOpts, z, angle, liftBase, dragLift, maxPower, step }
export function computeGuide(req) {
  const probe = new BottleSim(req.simOpts);
  const results = [];
  for (let p = 0; p <= req.maxPower + 1e-9; p += req.step) {
    probe.reset();
    probe.setHold(0, req.z, req.liftBase + (p / req.maxPower) * req.dragLift);
    probe.throw({ power: p, angle: req.angle });
    const r = probe.runToEnd();
    results.push({ p, ok: !!r && (r.outcome === 'upright' || r.outcome === 'cap') });
  }
  return results;
}
