import * as THREE from 'three';
import { BottleSim, DT } from './physics.js';
import { BOTTLES, FLUIDS, MAPS, TABLE, THROW } from './config.js';
import { BottleView, LABELS } from './bottleView.js';
import { buildWorld } from './world.js';
import { computeGuide } from './guide.js';

// ---------- 저장 (브라우저별 편의 기능, 실패해도 동작) ----------
const STORE_KEY = 'bottleflip3d.v1';
const load = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
};
const save = (data) => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* 무시 */
  }
};

const saved = load();
const opts = { map: 'forest', bottle: 'standard', fluid: 'water', fill: 0.3, ...saved.opts };
const look = { fluidColor: FLUIDS[opts.fluid].color, capColor: '#e84a5f', label: 'stripe', labelColor: '#2d6cdf', ...saved.look };
const tuning = { dragRef: THROW.dragRef, spinBase: THROW.spinBase, spinRatio: THROW.spinRatio, ...saved.tuning };
const aim = { angle: saved.angle ?? THROW.angle };
const stats = { ok: 0, all: 0, streak: 0, best: saved.best || 0 };
const prefs = { showMeter: true, slowmo: false, ...saved.prefs };
const persist = () => save({ opts, look, tuning, best: stats.best, prefs, angle: aim.angle });

// ---------- 렌더러 ----------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.localClippingEnabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.01, 60);
const resize = () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
};
addEventListener('resize', resize);
resize();

let world = null;
let worldMap = null;
const view = new BottleView(scene);
let sim = null;
let resultShownAt = 0;
let guide = null; // 성공 파워 구간 (결정적 시뮬로 미리 계산)

function rebuild() {
  if (worldMap !== opts.map) {
    if (world) scene.remove(world);
    world = buildWorld(scene, opts.map);
    worldMap = opts.map;
  }
  sim = new BottleSim({ ...opts, tuning: { spinBase: tuning.spinBase, spinRatio: tuning.spinRatio } });
  view.dispose();
  view.build(sim, look);
  hold(0);
  resultShownAt = 0;
  scheduleGuide();
  persist();
}

// ---------- 성공 구간 가이드 ----------
// 같은 입력이면 같은 결과가 나오므로 파워별 결과를 미리 돌려볼 수 있다.
let guideJob = 0;
let guideZ = 0;
let guideSoonTimer = 0;
const scheduleGuideSoon = () => {
  clearTimeout(guideSoonTimer);
  guideSoonTimer = setTimeout(scheduleGuide, 300);
};
let guideWorker = null;
try {
  guideWorker = new Worker(new URL('./guideWorker.js', import.meta.url), { type: 'module' });
  guideWorker.onmessage = (e) => {
    if (e.data.job !== guideJob) return; // 그 사이 조건이 바뀐 옛 결과
    guide = e.data.results;
    drawGuide();
  };
  guideWorker.onerror = () => { guideWorker = null; scheduleGuide(); };
} catch {
  guideWorker = null; // 워커를 못 쓰는 환경이면 메인 스레드에서 계산
}
function scheduleGuide() {
  const job = ++guideJob;
  guide = null;
  drawGuide();
  // 손 앞뒤 위치에 따라 테이블 안에 떨어지는지가 달라지므로 현재 손 위치로 계산
  guideZ = hand.z;
  const req = {
    simOpts: { ...opts, tuning: { spinBase: tuning.spinBase, spinRatio: tuning.spinRatio } },
    z: hand.z,
    angle: aim.angle,
    liftBase: HAND_LIFT,
    dragLift: DRAG_LIFT,
    maxPower: THROW.maxPower,
    step: 0.05,
  };
  if (guideWorker) guideWorker.postMessage({ job, req });
  else setTimeout(() => {
    if (job !== guideJob) return;
    guide = computeGuide(req);
    drawGuide();
  }, 50);
}

const meter = document.getElementById('meter');
const meterFill = document.getElementById('meterFill');
const meterMark = document.getElementById('meterMark');
function drawGuide() {
  meter.querySelectorAll('.band').forEach((b) => b.remove());
  if (!guide) return;
  for (const g of guide) {
    if (!g.ok) continue;
    const b = document.createElement('div');
    b.className = 'band';
    Object.assign(b.style, {
      position: 'absolute', left: 0, right: 0, background: 'rgba(86,217,138,0.55)',
      bottom: `${((g.p - 0.025) / THROW.maxPower) * 100}%`, height: `${(0.05 / THROW.maxPower) * 100}%`,
    });
    meter.insertBefore(b, meterMark);
  }
}
const setMeter = (power, mark) => {
  meterFill.style.height = `${(Math.max(0, Math.min(THROW.maxPower, power)) / THROW.maxPower) * 100}%`;
  if (mark != null) {
    meterMark.style.opacity = 1;
    meterMark.style.bottom = `${(Math.min(THROW.maxPower, mark) / THROW.maxPower) * 100}%`;
  }
};

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const fillSelect = (el, entries, value) => {
  el.innerHTML = entries.map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  el.value = value;
};
fillSelect($('map'), Object.entries(MAPS).map(([k, v]) => [k, v.name]), opts.map);
fillSelect($('bottle'), Object.entries(BOTTLES).map(([k, v]) => [k, v.name]), opts.bottle);
fillSelect($('fluid'), Object.entries(FLUIDS).map(([k, v]) => [k, v.name]), opts.fluid);
fillSelect($('label'), Object.entries(LABELS), look.label);
$('fill').value = Math.round(opts.fill * 100);
$('fluidColor').value = look.fluidColor;
$('capColor').value = look.capColor;
$('labelColor').value = look.labelColor;

const FLUID_INFO = {
  water: '기준. 공중에서 길게 퍼지며 회전이 느려지고, 착지 때 철퍽 하고 흡수한다. 1/3 정도 채우면 가장 쉽다.',
  honey: '무겁고 끈적. 회전이 빨리 죽어서 세게 던져야 하지만, 대신 착지가 묵직하고 성공 구간이 넓다.',
  soda: '물과 비슷한데 착지 순간 거품이 튀어 오른다. 결과에 약간의 랜덤성.',
  slime: '탱글탱글. 벽에 튕겨서 착지가 통통 튄다. 성공 구간이 좁은 도박형.',
};
const updateInfo = () => {
  $('fillVal').textContent = `${Math.round(opts.fill * 100)}%`;
  $('fluidInfo').textContent = opts.fill > 0 ? FLUID_INFO[opts.fluid] : '빈 병: 유체 효과가 없어서 거의 서지 않는다 (비교용).';
};
updateInfo();

$('map').onchange = (e) => { opts.map = e.target.value; rebuild(); };
$('bottle').onchange = (e) => { opts.bottle = e.target.value; rebuild(); };
$('fluid').onchange = (e) => {
  opts.fluid = e.target.value;
  look.fluidColor = FLUIDS[opts.fluid].color;
  $('fluidColor').value = look.fluidColor;
  updateInfo();
  rebuild();
};
$('fill').oninput = (e) => { opts.fill = e.target.value / 100; updateInfo(); };
$('fill').onchange = () => rebuild();
$('fluidColor').oninput = (e) => { look.fluidColor = e.target.value; view.build(sim, look); persist(); };
$('capColor').oninput = (e) => { look.capColor = e.target.value; view.build(sim, look); persist(); };
$('label').onchange = (e) => { look.label = e.target.value; view.build(sim, look); persist(); };
$('labelColor').oninput = (e) => { look.labelColor = e.target.value; view.build(sim, look); persist(); };

const bindRange = (id, key, fmt, rebuildSim) => {
  const el = $(id);
  const out = $(`${id}Val`);
  const sync = () => { el.value = tuning[key]; out.textContent = fmt(tuning[key]); };
  sync();
  el.oninput = () => { tuning[key] = +el.value; out.textContent = fmt(tuning[key]); persist(); };
  if (rebuildSim) el.onchange = () => rebuild();
  return sync;
};
const syncs = [
  bindRange('dragRef', 'dragRef', (v) => `화면 높이의 ${Math.round(v * 100)}% = 파워 100%`, false),
  bindRange('spinBase', 'spinBase', (v) => `${v} rad/s`, true),
  bindRange('spinRatio', 'spinRatio', (v) => `× ${v}`, true),
];
$('showMeter').checked = prefs.showMeter;
$('slowmo').checked = prefs.slowmo;
$('showMeter').onchange = (e) => { prefs.showMeter = e.target.checked; persist(); };
$('slowmo').onchange = (e) => { prefs.slowmo = e.target.checked; persist(); };
$('resetTuning').onclick = () => {
  Object.assign(tuning, { dragRef: THROW.dragRef, spinBase: THROW.spinBase, spinRatio: THROW.spinRatio });
  syncs.forEach((s) => s());
  rebuild();
};

let mode = 'menu';
const setMode = (m) => {
  mode = m;
  $('menu').classList.toggle('hidden', m !== 'menu');
  $('hud').classList.toggle('hidden', m !== 'play');
  if (sim?.state === 'ready') hold(0);
};
const togglePanel = (id, show) => $(id).classList.toggle('hidden', !show);
document.querySelectorAll('#menu button').forEach((b) => {
  b.onclick = () => {
    const act = b.dataset.act;
    if (act === 'practice') { setMode('play'); togglePanel('panel', false); togglePanel('settings', false); }
    if (act === 'customize') { togglePanel('settings', false); togglePanel('panel', true); }
    if (act === 'settings') { togglePanel('panel', false); togglePanel('settings', true); }
  };
});
$('panelClose').onclick = () => togglePanel('panel', false);
$('settingsClose').onclick = () => togglePanel('settings', false);
$('btnCustom').onclick = () => { togglePanel('settings', false); togglePanel('panel', $('panel').classList.contains('hidden')); };
$('btnSettings').onclick = () => { togglePanel('panel', false); togglePanel('settings', $('settings').classList.contains('hidden')); };
$('btnMenu').onclick = () => { setMode('menu'); resetThrow(); };

const toast = $('toast');
let toastTimer = 0;
const showToast = (text, cls) => {
  toast.textContent = text;
  toast.className = `toast show ${cls}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.className = 'toast'), 1400);
};
const updateStats = () => {
  $('sOk').textContent = stats.ok;
  $('sAll').textContent = stats.all;
  $('sStreak').textContent = stats.streak;
  $('sBest').textContent = stats.best;
};
updateStats();

// ---------- 입력 ----------
// 마우스 이동: 병이 커서를 따라 테이블 위를 움직인다 (손에 든 상태)
// 스크롤: 던지는 각도 (앞으로 기울일수록 멀리 가지만 착지가 어려워진다)
// 누른 채 위로 드래그: 끈 거리만큼 힘이 찬다 → 놓으면 던지기
let drag = null;
let charge = null;
let lastPower = null;
// 병을 쥔 손: 내 눈앞, 테이블 앞쪽 가장자리 위에 들고 있다.
// 커서 좌우 → 손 좌우, (누르지 않은 상태의) 커서 상하 → 손 앞뒤 (위 = 멀리, 아래 = 가까이)
const HAND_Z = 0.56;
const HAND_Z_FAR = 0.3;
const HAND_Z_NEAR = 0.66;
const HAND_LIFT = 0.2; // 테이블 위 손 높이 (병 바닥 기준, m)
const HAND_X = 0.3;
const hand = { x: 0, z: HAND_Z };
const EYE = new THREE.Vector3(0, 1.2, 0.9); // 1인칭 눈 위치 (내 의자)
// 던지는 방향 = 내 눈에서 병을 바라본 수평 방향 → 테이블 기준으로는 사선 던지기
const throwDir = () => {
  const dx = hand.x - EYE.x;
  const dz = hand.z - EYE.z;
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
};
// 손에 든 병 자세: 힘을 모을수록 들리고, 위쪽이 내 쪽으로 기운다 (던지기 준비 동작)
const handLift = (power) => HAND_LIFT + (power / THROW.maxPower) * DRAG_LIFT;
const hold = (power = 0) => {
  // 메뉴에서는 테이블 위에 세워두고, 플레이 중에는 손에 든다
  if (mode !== 'play') return sim.setHold(0, THROW.startZ, 0);
  sim.setHold(hand.x, hand.z, handLift(power), THROW.startTilt * Math.min(1, power / 0.3), throwDir());
};

const raycaster = new THREE.Raycaster();
// 커서 → 테이블 위치 변환은 고정된 기준 카메라로 한다.
// (실제 카메라는 커서를 따라 고개를 돌리므로, 그걸 쓰면 병 위치가 되먹임으로 흔들린다)
const refCam = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.01, 60);
refCam.position.copy(EYE);
refCam.lookAt(0, 0.8, 0);
addEventListener('resize', () => {
  refCam.aspect = innerWidth / innerHeight;
  refCam.updateProjectionMatrix();
});
const handPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -HAND_Z);
// 커서 상하 → 손 앞뒤. 절대 위치로 매핑하되, 힘 모으기(위로 끌기)가 끝나면 기준점을 다시 잡아서
// 놓은 직후 손이 멀리 튀지 않게 한다.
const zFromY = (y) => {
  const t = Math.max(0, Math.min(1, (y / innerHeight - 0.25) / 0.6));
  return HAND_Z_FAR + t * (HAND_Z_NEAR - HAND_Z_FAR);
};
let zAnchor = null; // null = 다음 이동에서 현재 손 위치 기준으로 다시 잡기
let zOffset = 0;
function aimHandZ(e) {
  if (zAnchor === null) {
    zOffset = hand.z - zFromY(e.clientY);
    zAnchor = true;
  }
  hand.z = Math.max(HAND_Z_FAR, Math.min(HAND_Z_NEAR, zFromY(e.clientY) + zOffset));
  // 한계에 닿으면 기준점을 끌고 가서, 반대로 움직이면 바로 반응하게
  zOffset = hand.z - zFromY(e.clientY);
  if (Math.abs(hand.z - guideZ) > 0.03) scheduleGuideSoon();
}
// 커서 좌우 → 손 좌우 위치 (손이 있는 세로 평면과 만나는 점)
function aimHand(e) {
  handPlane.constant = -hand.z;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, refCam);
  const hit = raycaster.ray.intersectPlane(handPlane, new THREE.Vector3());
  if (!hit) return;
  hand.x = Math.max(-HAND_X, Math.min(HAND_X, hit.x));
}

function resetThrow() {
  drag = null;
  charge = null;
  sim.reset();
  hold(0);
  resultShownAt = 0;
  meterMark.style.opacity = 0;
  setMeter(0);
}

function doThrow(power) {
  if (sim.state !== 'ready') return;
  lastPower = power;
  sim.throw({ power, angle: aim.angle, dir: throwDir() });
  setMeter(power, power);
  $('last').textContent = '';
}

const dragPower = (d, y) => Math.max(0, (d.startY - y) / innerHeight / tuning.dragRef);
const DRAG_LIFT = 0.05; // 힘을 모을수록 병을 이만큼까지 들어 올린다 (m)

canvas.addEventListener('pointermove', (e) => {
  if (mode !== 'play' || sim.state !== 'ready') return;
  if (!drag) {
    aimHandZ(e);
    aimHand(e);
    hold(0);
    return;
  }
  // 힘 모으는 중: 손 위치는 고정, 끈 만큼 병이 들리고 미터가 찬다
  drag.power = Math.min(THROW.maxPower, dragPower(drag, e.clientY));
  hold(drag.power);
  setMeter(drag.power);
});
canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'play' || sim.state !== 'ready' || e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  drag = { startY: e.clientY, power: 0 };
  meterMark.style.opacity = 0;
});
const endDrag = () => {
  if (!drag) return;
  const p = drag.power;
  drag = null;
  zAnchor = null;
  if (p < 0.05) {
    // 거의 안 끌었으면 던지지 않고 내려놓기
    hold(0);
    setMeter(0);
    return;
  }
  doThrow(p);
};
canvas.addEventListener('pointerup', endDrag);
const cancelDrag = () => {
  if (!drag) return;
  drag = null;
  zAnchor = null;
  hold(0);
  setMeter(0);
};
canvas.addEventListener('pointercancel', cancelDrag);
canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); cancelDrag(); });

let guideTimer = 0;
const setAngle = (deg) => {
  const a = Math.max(THROW.minAngle, Math.min(THROW.maxAngle, deg));
  if (a === aim.angle) return;
  aim.angle = a;
  $('angle').textContent = `${a}°`;
  clearTimeout(guideTimer);
  guideTimer = setTimeout(() => { scheduleGuide(); persist(); }, 250);
};
$('angle').textContent = `${aim.angle}°`;
canvas.addEventListener('wheel', (e) => {
  if (mode !== 'play') return;
  e.preventDefault();
  // 한 칸에 1°, Shift 를 누르면 5°
  const stepDeg = e.shiftKey ? 5 : 1;
  const d = e.deltaY || e.deltaX; // Shift+휠은 가로 스크롤로 오는 환경이 있다
  if (!d) return;
  setAngle(aim.angle + (d < 0 ? stepDeg : -stepDeg));
}, { passive: false });

addEventListener('keydown', (e) => {
  if (mode !== 'play') return;
  if (e.code === 'Space' && !e.repeat && sim.state === 'ready') {
    charge = { t0: performance.now() };
    meterMark.style.opacity = 0;
    e.preventDefault();
  }
  if (e.code === 'KeyR') resetThrow();
  if (e.code === 'Escape') cancelDrag();
  if (e.code === 'ArrowUp') setAngle(aim.angle + 1);
  if (e.code === 'ArrowDown') setAngle(aim.angle - 1);
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' && charge) {
    const p = chargePower();
    charge = null;
    doThrow(p);
  }
});
// 스페이스 충전: 0 → 최대 → 0 을 2.4초 주기로 왕복
const chargePower = () => {
  const t = ((performance.now() - charge.t0) / 1000 / 2.4) % 1;
  return THROW.maxPower * (t < 0.5 ? t * 2 : 2 - t * 2);
};

// ---------- 결과 처리 ----------
function onResult(r) {
  stats.all++;
  const pct = lastPower != null ? `파워 ${Math.round(lastPower * 100)}%` : '';
  const info = `${pct} · ${r.rotations.toFixed(2)}회전 · 체공 ${r.airTime != null ? r.airTime.toFixed(2) : '-'}s`;
  if (r.outcome === 'upright' || r.outcome === 'cap') {
    stats.ok++;
    stats.streak++;
    stats.best = Math.max(stats.best, stats.streak);
    if (r.outcome === 'cap') showToast('뚜껑 착지!!', 'gold');
    else showToast(stats.streak >= 3 ? `성공! ${stats.streak}연속` : '성공!', 'ok');
  } else {
    stats.streak = 0;
    showToast(r.outcome === 'offtable' ? '테이블 밖으로…' : '쓰러짐', 'bad');
  }
  $('last').textContent = info;
  updateStats();
  persist();
}

// ---------- 카메라 ----------
// 1인칭: 내 자리(테이블 앞쪽 의자)에 앉은 눈높이
const camPlay = { pos: EYE.clone(), look: new THREE.Vector3(0, 0.8, 0.0) };
const LOOK_Y = 0.93; // 시선 높이: 높을수록 손에 든 병이 화면 아래로 내려간다
const LOOK_FOLLOW = 0.8; // 커서 좌우를 따라 고개를 돌리는 정도 (0 = 고정, 1 = 병을 정면으로)
const camMenu = { pos: new THREE.Vector3(-0.2, 0.9, 0.68), look: new THREE.Vector3(-0.17, 0.85, 0.3) };
const camPos = camMenu.pos.clone();
const camLook = camMenu.look.clone();

// ---------- 조준 궤적 (각도 + 현재 힘으로 그린 포물선) ----------
const ARC_N = 40;
const arcGeo = new THREE.BufferGeometry();
arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_N * 3), 3));
const arc = new THREE.Line(arcGeo, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.02, gapSize: 0.015, transparent: true, opacity: 0.8, depthTest: false }));
arc.renderOrder = 10;
arc.frustumCulled = false;
scene.add(arc);
// 착지 예상 지점 (1인칭에서는 궤적이 겹쳐 보이므로 거리감을 이걸로 준다)
const landMark = new THREE.Mesh(
  new THREE.RingGeometry(0.03, 0.042, 32),
  new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, depthTest: false, side: THREE.DoubleSide }),
);
landMark.rotation.x = -Math.PI / 2;
landMark.renderOrder = 10;
scene.add(landMark);
function updateArc() {
  const show = mode === 'play' && sim.state === 'ready';
  arc.visible = show;
  landMark.visible = show;
  if (!show) return;
  // 힘을 모으는 중이면 그 힘, 아니면 가이드 기준 힘(1.0)으로 흐리게
  const power = drag ? drag.power : charge ? chargePower() : 1.0;
  arc.material.opacity = drag || charge ? 0.9 : 0.35;
  const vUp = THROW.minUp + THROW.upPerPower * power;
  const fwd = vUp * Math.tan((aim.angle * Math.PI) / 180);
  const [dx, dz] = throwDir();
  const g = MAPS[opts.map].gravity;
  // 손 높이에서 출발해 테이블 높이로 돌아올 때까지
  const h = handLift(power);
  const T = (vUp + Math.sqrt(vUp * vUp + 2 * g * h)) / g;
  const pos = arcGeo.attributes.position;
  const y0 = TABLE.y + 0.005 + h;
  for (let i = 0; i < ARC_N; i++) {
    const t = (i / (ARC_N - 1)) * T;
    pos.setXYZ(i, hand.x + dx * fwd * t, y0 + vUp * t - 0.5 * g * t * t, hand.z + dz * fwd * t);
  }
  pos.needsUpdate = true;
  landMark.position.set(hand.x + dx * fwd * T, TABLE.y + 0.002, hand.z + dz * fwd * T);
  landMark.material.opacity = arc.material.opacity;
  arcGeo.computeBoundingSphere();
  arc.computeLineDistances();
}

// ---------- 루프 ----------
rebuild();
setMode('menu');
let acc = 0;
let last = performance.now();
function frame(now) {
  const real = Math.min(0.05, (now - last) / 1000);
  last = now;
  const scaleT = prefs.slowmo && sim.state === 'flying' ? 0.35 : 1;
  acc += real * scaleT;

  if (charge) {
    const p = chargePower();
    setMeter(p);
    hold(p);
  }
  if (!prefs.showMeter && !charge) meter.style.opacity = 0;
  else meter.style.opacity = 1;

  while (acc >= DT) {
    sim.step();
    acc -= DT;
  }
  for (const ev of sim.events.splice(0)) if (ev.type === 'fizz') view.triggerFizz();

  if (sim.state === 'done') {
    if (!resultShownAt) {
      resultShownAt = now;
      onResult(sim.result);
    } else if (now - resultShownAt > 1700) resetThrow();
  }

  view.handVisible = mode === 'play' && sim.held;
  view.update(real);
  updateArc();

  // 카메라 (기차는 흔들림 반영)
  const target = mode === 'menu' ? camMenu : camPlay;
  // 1인칭: 병(손)이 있는 쪽으로 고개를 돌린다
  if (mode === 'play') camPlay.look.set(hand.x * LOOK_FOLLOW, LOOK_Y, 0);
  const k = 1 - Math.exp(-real * 4);
  // 병이 높이 뜨면 고개를 들어 따라본다 (몸은 그대로)
  const lift = mode === 'play' ? Math.max(0, sim.x[1] - 0.95) : 0;
  camPos.lerp(target.pos, k);
  camLook.lerp(target.look.clone().setY(target.look.y + lift * 1.1), k);
  const shake = MAPS[opts.map].shake ? sim.gravityVec(sim.time) : null;
  camera.position.copy(camPos);
  if (shake) camera.position.x += shake[0] * 0.004;
  camera.lookAt(camLook);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 디버그/자동 테스트용
window.__bottleflip = { get sim() { return sim; }, doThrow, resetThrow, setMode, setAngle, opts, hand, get guide() { return guide; } };
