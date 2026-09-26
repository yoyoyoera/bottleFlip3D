// 게임플레이 파라미터 모음. 물리/렌더 코드는 이 값들만 읽는다.
// 단위: m, kg, s.

// 병: 형상은 기본 500ml 페트 프로파일을 scale 배율로 늘린다.
// shellMass 가 클수록 유체의 영향이 줄어든다(유리병 = 둔하지만 안정적).
export const BOTTLES = {
  mini: { name: '미니 페트 (330ml)', scale: 0.86, shellMass: 0.016, restitution: 0.3, friction: 1.0 },
  standard: { name: '기본 페트 (500ml)', scale: 1.0, shellMass: 0.022, restitution: 0.3, friction: 1.0 },
  large: { name: '대형 페트 (1.5L)', scale: 1.42, shellMass: 0.045, restitution: 0.25, friction: 1.0 },
  glass: { name: '유리병 (500ml)', scale: 1.0, shellMass: 0.28, restitution: 0.12, friction: 0.8 },
};

// 유체: 게임플레이용 대리 모델(입자) 파라미터.
//  density     밀도 (kg/L)
//  viscosity   병과의 상대속도 감쇠율 (1/s). 클수록 병과 한 몸처럼 움직인다.
//  wallFriction 벽면 마찰
//  wallBounce  벽에 부딪힐 때 반발 (슬라임 = 탱글)
//  fizz        착지 순간 입자에 주는 랜덤 튐 속도 (m/s, 탄산)
//  absorb      착지 직후 출렁임이 충격을 흡수하는 정도 (1/s). 물병 뒤집기의 핵심 '철퍽' 효과를
//              게임적으로 강조하는 값이라 플레이테스트로 맞춘다.
export const FLUIDS = {
  water: { name: '물', density: 1.0, viscosity: 1.5, wallFriction: 0.05, wallBounce: 0.0, fizz: 0, absorb: 14, color: '#4fa8ff', opacity: 0.55 },
  honey: { name: '꿀', density: 1.4, viscosity: 10, wallFriction: 0.1, wallBounce: 0.0, fizz: 0, absorb: 30, color: '#e8a317', opacity: 0.9 },
  soda: { name: '탄산', density: 1.0, viscosity: 1.5, wallFriction: 0.05, wallBounce: 0.0, fizz: 0.9, absorb: 12, color: '#c9e8a0', opacity: 0.5 },
  slime: { name: '슬라임', density: 1.1, viscosity: 8, wallFriction: 0.4, wallBounce: 0.55, fizz: 0, absorb: 3, color: '#7dff6a', opacity: 0.85 },
};

// 맵: 같은 조작이 다르게 먹히도록 표면/환경만 바꾼다.
//  shake: 기차 흔들림 (좌우 가속 진폭 m/s², 주기 s, 덜컹 세기)
export const MAPS = {
  forest: { name: '숲속 (기본)', gravity: 9.81, friction: 0.55, bounce: 0.25, shake: null },
  arctic: { name: '북극 (얼음 테이블)', gravity: 9.81, friction: 0.06, bounce: 0.3, shake: null },
  train: { name: '기차 안 (흔들림)', gravity: 9.81, friction: 0.5, bounce: 0.25, shake: { amp: 0.9, period: 1.7, bump: 1.6 } },
  space: { name: '우주선 (중력 -15%)', gravity: 9.81 * 0.85, friction: 0.5, bounce: 0.3, shake: null },
};

export const TABLE = { y: 0.75, halfX: 0.7, halfZ: 0.5 };

// 던지기 매핑: 드래그 거리 → 발사 속도/회전, 스크롤 → 각도.
export const THROW = {
  dragRef: 0.3, // 위로 이만큼(화면 높이 비율) 끌면 power 1.0
  maxPower: 1.5,
  minUp: 1.2, // power 0 일 때 위 속도
  upPerPower: 1.8, // power 1 당 추가 위 속도
  angle: 10, // 기본 던지기 각도(도). 앞으로 나가는 속도 = 위 속도 * tan(각도)
  minAngle: 0,
  maxAngle: 20, // 이보다 크면 테이블 밖으로 나간다
  startTilt: 20, // 던지기 직전 병 위쪽이 나를 향해 기운 각도(도)
  spinBase: 19, // 회전(rad/s) = spinBase + 위 속도 * spinRatio
  spinRatio: 1.5,
  startZ: 0.3,
};
