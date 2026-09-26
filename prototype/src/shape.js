// 병 형상. 물리(충돌점/내부 공간)와 렌더(Lathe 프로파일)가 같은 수치를 공유한다.
// 로컬 원점 = 병 바닥 중심, +y = 병 위쪽.

const BASE = {
  radius: 0.033,
  shoulderY: 0.13, // 몸통이 끝나고 어깨가 시작되는 높이
  neckY: 0.183, // 어깨가 끝나고 목이 시작되는 높이
  neckR: 0.0135,
  capY: 0.193,
  capR: 0.0155,
  height: 0.212,
  wall: 0.0015,
  bottomIn: 0.004,
};

export function makeShape(scale) {
  const s = {};
  for (const [k, v] of Object.entries(BASE)) s[k] = v * scale;
  s.rIn = s.radius - s.wall;
  s.neckRIn = s.neckR - s.wall;
  s.topIn = s.capY - s.wall;

  // 높이 y 에서 내부 반경
  s.innerRadius = (y) => {
    if (y <= s.shoulderY) return s.rIn;
    if (y >= s.neckY) return s.neckRIn;
    const t = (y - s.shoulderY) / (s.neckY - s.shoulderY);
    // 둥근 어깨: smoothstep 보간
    const e = t * t * (3 - 2 * t);
    return s.rIn + (s.neckRIn - s.rIn) * e;
  };
  // dr/dy (어깨 경사, 벽 법선 계산용)
  s.innerSlope = (y) => {
    if (y <= s.shoulderY || y >= s.neckY) return 0;
    const h = s.neckY - s.shoulderY;
    const t = (y - s.shoulderY) / h;
    return ((s.neckRIn - s.rIn) * 6 * t * (1 - t)) / h;
  };

  // 내부 부피 (L)
  let vol = 0;
  const n = 200;
  for (let i = 0; i < n; i++) {
    const y0 = s.bottomIn + ((s.topIn - s.bottomIn) * i) / n;
    const y1 = s.bottomIn + ((s.topIn - s.bottomIn) * (i + 1)) / n;
    const r = s.innerRadius((y0 + y1) / 2);
    vol += Math.PI * r * r * (y1 - y0);
  }
  s.volumeL = vol * 1000;

  // 병 껍데기 질량중심 (대략 몸통 중간보다 약간 아래)
  s.comY = s.height * 0.44;

  // 테이블과 부딪히는 외곽 충돌점: 바닥 링, 어깨 링, 뚜껑 링
  s.hull = [];
  const ring = (y, r, count) => {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      s.hull.push([Math.cos(a) * r, y, Math.sin(a) * r]);
    }
  };
  ring(0, s.radius * 0.92, 16);
  ring(s.shoulderY, s.radius, 16);
  ring(s.height, s.capR, 10);

  return s;
}

// 렌더용 외곽 프로파일 (x = 반경, y = 높이), 뚜껑 제외
export function outerProfile(shape) {
  const pts = [];
  const r = shape.radius;
  pts.push([0, 0]);
  pts.push([r * 0.78, 0]);
  pts.push([r * 0.92, 0.002 * (r / 0.033)]);
  pts.push([r, 0.008 * (r / 0.033)]);
  // 몸통 (약간의 홈)
  const segs = 10;
  for (let i = 0; i <= segs; i++) {
    const y = 0.01 * (r / 0.033) + ((shape.shoulderY - 0.01 * (r / 0.033)) * i) / segs;
    const groove = i === 3 || i === 7 ? 0.0012 * (r / 0.033) : 0;
    pts.push([r - groove, y]);
  }
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    const e = t * t * (3 - 2 * t);
    pts.push([r + (shape.neckR - r) * e, shape.shoulderY + (shape.neckY - shape.shoulderY) * t]);
  }
  pts.push([shape.neckR, shape.capY]);
  pts.push([shape.neckR * 0.8, shape.capY]);
  return pts;
}
