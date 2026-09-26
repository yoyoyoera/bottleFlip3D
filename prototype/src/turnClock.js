export const TURN_MS = 15_000;

// 절대 시각 기준: 프레임 속도, 슬로모션, 창 비활성화의 영향을 받지 않는다.
export class TurnClock {
  constructor(duration = TURN_MS) { this.duration = duration; this.deadline = null; }
  start(now) { this.deadline = now + this.duration; }
  stop() { this.deadline = null; }
  remaining(now) { return this.deadline === null ? 0 : Math.max(0, this.deadline - now); }
  expired(now) { return this.deadline !== null && now >= this.deadline; }
}
