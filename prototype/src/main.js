import * as THREE from 'three';
import { BottleSim, DT } from './physics.js';
import { BOTTLES, FLUIDS, MAPS, TABLE, THROW } from './config.js';
import { BottleView, LABELS } from './bottleView.js';
import { buildWorld } from './world.js';
import { computeGuide } from './guide.js';
import { MODES, createMatch, recordThrow, advanceTurn, ranking } from './rules.js';
import { TurnClock } from './turnClock.js';
import { RoomConnection } from './network.js';

const turnClock = new TurnClock();
let onlineRoom = null;
let onlineId = null;
let onlinePending = false;
let localSetup = null;
let onlineAction = 'host';
let remoteSnapshot = null;
const isMyTurn = () => !onlineRoom || onlineRoom.match?.players[onlineRoom.match.turn].id === onlineId;
const canControl = () => mode === 'play' && sim.state === 'ready' &&
  (!onlineRoom || (onlineRoom.phase === 'ready' && isMyTurn() && !onlinePending));

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
const stats = { ok: 0, all: 0, streak: 0, caps: 0, best: saved.best || 0 };
const prefs = { showMeter: true, slowmo: false, ...saved.prefs };
const PLAYER_COLORS = ['#4fa8ff', '#ff7a7a', '#56d98a', '#ffd36e'];
const matchCfg = {
  count: 2,
  mode: 'first',
  target: 1,
  capDouble: true,
  continueOnHit: false,
  names: ['플레이어 1', '플레이어 2', '플레이어 3', '플레이어 4'],
  ...saved.matchCfg,
};
const persist = () => { if (!onlineRoom) save({ opts, look, tuning, best: stats.best, prefs, angle: aim.angle, matchCfg }); };

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
let afterPending = false; // 결과 후 다음 단계로 한 번만 넘어가게
let guide = null; // 성공 파워 구간 (결정적 시뮬로 미리 계산)

function rebuild() {
  if (worldMap !== opts.map) {
    if (world) scene.remove(world);
    world = buildWorld(scene, opts.map);
    worldMap = opts.map;
    updateSeats();
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
const guidePos = { x: 0, z: 0 };
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
  if (game === 'match') return;
  // 손 위치/방향에 따라 테이블 안에 떨어지는지가 달라지므로 현재 손 위치로 계산
  guidePos.x = hand.x;
  guidePos.z = hand.z;
  const [wx, wz] = handWorld();
  const req = {
    simOpts: { ...opts, tuning: { spinBase: tuning.spinBase, spinRatio: tuning.spinRatio } },
    x: wx,
    z: wz,
    dir: throwDir(),
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
  if (!guide || game === 'match') return;
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
    if (act === 'practice') startPractice();
    if (act === 'local') openSetup();
    if (act === 'host' || act === 'join') openOnline(act);
    if (act === 'customize') { togglePanel('settings', false); togglePanel('panel', true); }
    if (act === 'settings') { togglePanel('panel', false); togglePanel('settings', true); }
  };
});
$('panelClose').onclick = () => togglePanel('panel', false);
$('settingsClose').onclick = () => togglePanel('settings', false);
$('btnCustom').onclick = () => { togglePanel('settings', false); togglePanel('panel', $('panel').classList.contains('hidden')); };
$('btnSettings').onclick = () => { togglePanel('panel', false); togglePanel('settings', $('settings').classList.contains('hidden')); };
$('btnMenu').onclick = () => goMenu();

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
  $('sRate').textContent = stats.all ? `${Math.round((stats.ok / stats.all) * 100)}%` : '-';
  $('sStreak').textContent = stats.streak;
  $('sBest').textContent = stats.best;
  $('sCaps').textContent = stats.caps;
};
updateStats();

// ---------- 입력 ----------
// 마우스 이동: 병이 커서를 따라 테이블 위를 움직인다 (손에 든 상태)
// 스크롤: 던지는 각도 (앞으로 기울일수록 멀리 가지만 착지가 어려워진다)
// 누른 채 위로 드래그: 끈 거리만큼 힘이 찬다 → 놓으면 던지기
let drag = null;
let charge = null;
let lastPower = null;
// ---------- 좌석 ----------
// 테이블 네 자리. 각 자리의 '로컬 좌표'는 내가 +z 쪽에 앉아 -z(테이블 가운데)를 보는 기준이다.
// yaw 로 돌려서 월드 좌표가 된다. depth = 내 앞 테이블 가장자리까지 거리, width = 좌우 반폭.
const SEATS = [
  { yaw: 0, depth: TABLE.halfZ, width: TABLE.halfX }, // 0: 앞 (+z)
  { yaw: Math.PI, depth: TABLE.halfZ, width: TABLE.halfX }, // 1: 맞은편 (-z)
  { yaw: Math.PI / 2, depth: TABLE.halfX, width: TABLE.halfZ }, // 2: 오른쪽 (+x)
  { yaw: -Math.PI / 2, depth: TABLE.halfX, width: TABLE.halfZ }, // 3: 왼쪽 (-x)
];
let seatIdx = 0;
const seat = () => SEATS[seatIdx];
// 로컬 (lx, lz) → 월드 [x, z]
const toWorld = (lx, lz) => {
  const { yaw } = seat();
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  return [lx * c + lz * sn, -lx * sn + lz * c];
};

// ---------- 손 ----------
// 병을 쥔 손: 내 눈앞, 테이블 앞쪽 가장자리 위에 들고 있다. (좌석 로컬 좌표)
// 커서 좌우 → 손 좌우, (누르지 않은 상태의) 커서 상하 → 손 앞뒤 (위 = 멀리, 아래 = 가까이)
const HAND_Z_OFF = 0.06; // 기본: 테이블 가장자리보다 6cm 내 쪽
const HAND_Z_FAR_OFF = -0.2;
const HAND_Z_NEAR_OFF = 0.16;
const HAND_LIFT = 0.2; // 테이블 위 손 높이 (병 바닥 기준, m)
const HAND_X = 0.3;
const EYE_Y = 1.2;
const EYE_BACK = 0.4; // 눈은 테이블 가장자리에서 40cm 뒤
const hand = { x: 0, z: TABLE.halfZ + HAND_Z_OFF };
const eyeLocalZ = () => seat().depth + EYE_BACK;
const eyeWorld = () => {
  const [x, z] = toWorld(0, eyeLocalZ());
  return new THREE.Vector3(x, EYE_Y, z);
};
const handWorld = () => toWorld(hand.x, hand.z);
// 던지는 방향 = 내 눈에서 병을 바라본 수평 방향 → 테이블 기준으로는 사선 던지기
const throwDir = () => {
  const dx = hand.x;
  const dz = hand.z - eyeLocalZ();
  const l = Math.hypot(dx, dz) || 1;
  const [wx, wz] = toWorld(dx / l, dz / l);
  return [wx, wz];
};
// 손에 든 병 자세: 힘을 모을수록 들리고, 위쪽이 내 쪽으로 기운다 (던지기 준비 동작)
const handLift = (power) => HAND_LIFT + (power / THROW.maxPower) * DRAG_LIFT;
const hold = (power = 0) => {
  // 메뉴에서는 테이블 위에 세워두고, 플레이 중에는 손에 든다
  if (mode === 'menu') return sim.setHold(0, THROW.startZ, 0);
  const [x, z] = handWorld();
  sim.setHold(x, z, handLift(power), THROW.startTilt * Math.min(1, power / 0.3), throwDir());
};
// 자리를 옮기면 손을 그 자리 기본 위치로
const sitAt = (i) => {
  seatIdx = i;
  hand.x = 0;
  hand.z = seat().depth + HAND_Z_OFF;
  refCam.position.set(0, EYE_Y, eyeLocalZ());
  refCam.lookAt(0, 0.8, 0);
  zAnchor = null;
  if (sim) scheduleGuideSoon();
};

const raycaster = new THREE.Raycaster();
// 커서 → 손 위치 변환은 좌석 로컬 좌표의 고정된 기준 카메라로 한다.
// (실제 카메라는 커서를 따라 고개를 돌리므로, 그걸 쓰면 병 위치가 되먹임으로 흔들린다)
const refCam = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.01, 60);
refCam.position.set(0, EYE_Y, TABLE.halfZ + EYE_BACK);
refCam.lookAt(0, 0.8, 0);
addEventListener('resize', () => {
  refCam.aspect = innerWidth / innerHeight;
  refCam.updateProjectionMatrix();
});
const handPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -hand.z);
// 커서 상하 → 손 앞뒤. 절대 위치로 매핑하되, 힘 모으기(위로 끌기)가 끝나면 기준점을 다시 잡아서
// 놓은 직후 손이 멀리 튀지 않게 한다.
const zFromY = (y) => {
  const t = Math.max(0, Math.min(1, (y / innerHeight - 0.25) / 0.6));
  return seat().depth + HAND_Z_FAR_OFF + t * (HAND_Z_NEAR_OFF - HAND_Z_FAR_OFF);
};
let zAnchor = null; // null = 다음 이동에서 현재 손 위치 기준으로 다시 잡기
let zOffset = 0;
function aimHandZ(e) {
  if (zAnchor === null) {
    zOffset = hand.z - zFromY(e.clientY);
    zAnchor = true;
  }
  const d = seat().depth;
  hand.z = Math.max(d + HAND_Z_FAR_OFF, Math.min(d + HAND_Z_NEAR_OFF, zFromY(e.clientY) + zOffset));
  // 한계에 닿으면 기준점을 끌고 가서, 반대로 움직이면 바로 반응하게
  zOffset = hand.z - zFromY(e.clientY);
}
// 커서 좌우 → 손 좌우 위치 (손이 있는 세로 평면과 만나는 점)
function aimHand(e) {
  handPlane.constant = -hand.z;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, refCam);
  const hit = raycaster.ray.intersectPlane(handPlane, new THREE.Vector3());
  if (!hit) return;
  hand.x = Math.max(-HAND_X, Math.min(HAND_X, hit.x));
  // 손 위치가 바뀌면 (특히 사선/가장자리) 테이블 안에 떨어지는지가 달라진다
  if (Math.hypot(hand.x - guidePos.x, hand.z - guidePos.z) > 0.03) scheduleGuideSoon();
}

function resetThrow() {
  drag = null;
  charge = null;
  sim.reset();
  hold(0);
  resultShownAt = 0;
  afterPending = false;
  meterMark.style.opacity = 0;
  setMeter(0);
  $('last').textContent = '';
}

function doThrow(power) {
  if (!canControl() || expireLocalTurn()) return;
  lastPower = power;
  if (onlineRoom) {
    const [x, z] = handWorld();
    onlinePending = network.send({ type: 'throw', turnId: onlineRoom.turnId,
      input: { power, angle: aim.angle, dir: throwDir(), start: [x, TABLE.y + 0.0005 + handLift(power), z] } });
    return;
  }
  turnClock.stop();
  sim.throw({ power, angle: aim.angle, dir: throwDir() });
  setMeter(power, power);
  $('last').textContent = '';
}

const dragPower = (d, y) => Math.max(0, (d.startY - y) / innerHeight / tuning.dragRef);
const DRAG_LIFT = 0.05; // 힘을 모을수록 병을 이만큼까지 들어 올린다 (m)

canvas.addEventListener('pointermove', (e) => {
  if (!canControl()) return;
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
  if (!canControl() || expireLocalTurn() || e.button !== 0) return;
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
  clearTimeout(guideTimer);
  guideTimer = setTimeout(() => { scheduleGuide(); persist(); }, 250);
};
canvas.addEventListener('wheel', (e) => {
  if (!canControl()) return;
  e.preventDefault();
  // 한 칸에 1°, Shift 를 누르면 5°
  const stepDeg = e.shiftKey ? 5 : 1;
  const d = e.deltaY || e.deltaX; // Shift+휠은 가로 스크롤로 오는 환경이 있다
  if (!d) return;
  setAngle(aim.angle + (d < 0 ? stepDeg : -stepDeg));
}, { passive: false });

addEventListener('keydown', (e) => {
  if (mode !== 'play') return;
  if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea, button')) return;
  if (onlineRoom && !canControl()) return;
  if (expireLocalTurn()) return;
  if (e.code === 'Space' && !e.repeat && sim.state === 'ready') {
    charge = { t0: performance.now() };
    meterMark.style.opacity = 0;
    e.preventDefault();
  }
  // 멀티에서는 던진 뒤 다시 던지기 방지 (손에 들고 있을 때만)
  if (e.code === 'KeyR' && (game === 'practice' || sim.state === 'ready')) resetThrow();
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
const isHit = (o) => o === 'upright' || o === 'cap';
function throwInfo(r) {
  const pct = lastPower != null ? `파워 ${Math.round(lastPower * 100)}%` : '';
  return `${pct} · ${r.rotations.toFixed(2)}회전 · 체공 ${r.airTime != null ? r.airTime.toFixed(2) : '-'}s`;
}
function onResult(r) {
  $('last').textContent = r.outcome === 'timeout' ? '던지지 않아 0점 처리됐습니다.' : throwInfo(r);
  if (game === 'match') return onMatchResult(r);
  stats.all++;
  if (isHit(r.outcome)) {
    stats.ok++;
    stats.streak++;
    stats.best = Math.max(stats.best, stats.streak);
    if (r.outcome === 'cap') {
      stats.caps++;
      showToast('뚜껑 착지!!', 'gold');
    } else showToast(stats.streak >= 3 ? `성공! ${stats.streak}연속` : '성공!', 'ok');
  } else {
    stats.streak = 0;
    showToast(r.outcome === 'offtable' ? '테이블 밖으로…' : '쓰러짐', 'bad');
  }
  updateStats();
  persist();
}

// 결과를 보여준 뒤 (약 1.7초) 다음으로
function afterResult() {
  if (onlineRoom) return;
  if (game === 'practice') return resetThrow();
  if (match.over) return showMatchResult();
  const i = advanceTurn(match);
  sitAt(match.players[i].seat);
  resetThrow();
  updateSeats();
  renderScoreboard();
  turnClock.start(performance.now());
  showToast(`${match.players[i].name} 차례`, 'ok');
}

// ---------- 게임 모드 ----------
let game = 'practice'; // 'practice' | 'match'
let match = null;
const SEAT_ORDER = { 2: [0, 1], 3: [0, 2, 1], 4: [0, 2, 1, 3] }; // 테이블을 도는 순서

function hidePanels() {
  for (const id of ['panel', 'settings', 'setup', 'result', 'online']) togglePanel(id, false);
}
function goMenu() {
  if (onlineRoom) leaveOnline();
  turnClock.stop();
  hidePanels();
  game = 'practice';
  match = null;
  sitAt(0);
  setMode('menu');
  resetThrow();
  updateSeats();
  lockMatchSettings(false);
}
function startPractice() {
  turnClock.stop();
  hidePanels();
  game = 'practice';
  match = null;
  sitAt(0);
  $('practiceStats').classList.remove('hidden');
  $('scoreboard').classList.add('hidden');
  $('turnBanner').classList.add('hidden');
  setMode('play');
  resetThrow();
  updateSeats();
  lockMatchSettings(false);
}
function startMatch() {
  hidePanels();
  const n = matchCfg.count;
  match = createMatch({
    players: SEAT_ORDER[n].map((seatNo, i) => ({
      name: matchCfg.names[i].trim() || `플레이어 ${i + 1}`,
      color: PLAYER_COLORS[i],
      seat: seatNo,
    })),
    mode: matchCfg.mode,
    target: matchCfg.target,
    capDouble: matchCfg.capDouble,
    continueOnHit: matchCfg.continueOnHit,
  });
  game = 'match';
  scheduleGuide();
  sitAt(match.players[0].seat);
  $('practiceStats').classList.add('hidden');
  $('scoreboard').classList.remove('hidden');
  $('last').textContent = '';
  setMode('play');
  resetThrow();
  updateSeats();
  renderScoreboard();
  turnClock.start(performance.now());
  lockMatchSettings(true);
  showToast(`${match.players[0].name} 차례`, 'ok');
}

function lockMatchSettings(locked) {
  $('btnCustom').disabled = locked;
  $('btnSettings').disabled = locked;
}

function expireLocalTurn() {
  if (onlineRoom || game !== 'match' || !match || match.over || sim.state !== 'ready' || !turnClock.expired(performance.now())) return false;
  turnClock.stop();
  drag = null; charge = null;
  sim.state = 'done'; sim.held = false;
  sim.result = { outcome: 'timeout', rotations: 0, airTime: null };
  lastPower = null;
  resultShownAt = performance.now();
  onResult(sim.result);
  return true;
}

function updateClock() {
  expireLocalTurn();
  const visible = mode === 'play' && game === 'match' && match && !match.over;
  $('pitchClock').classList.toggle('hidden', !visible);
  if (!visible) return;
  const ready = onlineRoom ? onlineRoom.phase === 'ready' : sim.state === 'ready';
  const left = Math.ceil(turnClock.remaining(performance.now()) / 1000);
  $('pitchClock').textContent = ready ? `${left}초` : '판정 중';
  $('pitchClock').classList.toggle('urgent', ready && left <= 5);
}
setInterval(updateClock, 100);

function onMatchResult(r) {
  const p = match.players[match.turn];
  const res = recordThrow(match, r.outcome);
  if (r.outcome === 'cap') showToast(`뚜껑 착지!! +${res.points}`, 'gold');
  else if (res.points) showToast(`성공! +${res.points}`, 'ok');
  else showToast(r.outcome === 'timeout' ? '시간 초과 · 0점' : r.outcome === 'offtable' ? '테이블 밖으로…' : '쓰러짐', 'bad');
  if (res.finished && !res.over) {
    setTimeout(() => showToast(`${p.name} 통과! ${p.place}등`, 'gold'), 800);
  }
  renderScoreboard();
}

function renderScoreboard() {
  if (!match) return;
  const el = $('scoreboard');
  el.innerHTML = '';
  match.players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = `p${i === match.turn && !match.over ? ' now' : ''}${p.done ? ' done' : ''}`;
    const status = p.done ? `통과 · ${p.place}등 (관전)` : i === match.turn ? '던지는 중' : `${p.throws}번 던짐`;
    row.innerHTML = `<span class="dot"></span><span class="nm"></span><span class="st"></span><span class="sc"></span>`;
    row.querySelector('.dot').style.background = p.color;
    row.querySelector('.nm').textContent = p.name;
    row.querySelector('.st').textContent = status;
    row.querySelector('.sc').textContent = `${p.score}/${match.target}`;
    el.appendChild(row);
  });
  const banner = $('turnBanner');
  const cur = match.players[match.turn];
  banner.classList.toggle('hidden', match.over);
  banner.textContent = `${cur.name} 차례${onlineRoom ? (isMyTurn() ? ' · 내 차례' : ' · 관전') : ''}`;
  banner.style.borderColor = cur.color;
}

function showMatchResult() {
  if (!$('result').classList.contains('hidden')) return;
  const order = ranking(match);
  const title = match.mode === 'first'
    ? `${match.players[match.winner].name} 승리!`
    : `꼴등: ${match.players[match.loser].name}`;
  $('resultTitle').textContent = title;
  const list = $('resultList');
  list.innerHTML = '';
  order.forEach((i, rank) => {
    const p = match.players[i];
    const li = document.createElement('li');
    const rate = p.throws ? Math.round((p.hits / p.throws) * 100) : 0;
    li.textContent = `${p.name} · ${p.score}점 · ${p.throws}번 던짐 (성공률 ${rate}%${p.caps ? `, 뚜껑 ${p.caps}` : ''})`;
    if (match.mode === 'first' && rank === 0) li.className = 'win';
    if (match.mode === 'last' && i === match.loser) li.className = 'loser';
    list.appendChild(li);
  });
  $('turnBanner').classList.add('hidden');
  togglePanel('result', true);
}
$('resultAgain').onclick = () => onlineRoom ? network.send({ type: 'start' }) : startMatch();
$('resultMenu').onclick = () => goMenu();

// 좌석 표시: 멀티에서는 참가자 자리에 색깔 표시, 지금 던지는 사람 자리는 (카메라가 있으니) 숨김
function updateSeats() {
  const ghosts = world?.userData.seatGhosts;
  if (!ghosts) return;
  ghosts.forEach((g) => (g.visible = false));
  if (mode !== 'play' || game !== 'match' || !match) return;
  match.players.forEach((p, i) => {
    const g = ghosts[p.seat];
    g.visible = i !== match.turn || match.over;
    g.material.color.set(p.color);
    g.material.opacity = p.done ? 0.15 : 0.45;
  });
}

// ---------- 멀티 설정 창 ----------
function openSetup() {
  hidePanels();
  renderSetup();
  togglePanel('setup', true);
}
function renderSetup() {
  document.querySelectorAll('#setupCount button').forEach((b) => b.classList.toggle('on', +b.dataset.n === matchCfg.count));
  document.querySelectorAll('#setupMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === matchCfg.mode));
  $('setupModeDesc').textContent = MODES[matchCfg.mode].desc;
  $('targetVal').textContent = matchCfg.target;
  $('capDouble').checked = matchCfg.capDouble;
  $('continueOnHit').checked = matchCfg.continueOnHit;
  const names = $('setupNames');
  names.innerHTML = '';
  for (let i = 0; i < matchCfg.count; i++) {
    const row = document.createElement('label');
    row.className = 'pl';
    row.innerHTML = `<span class="dot"></span><input id="pname${i}" maxlength="12" />`;
    row.querySelector('.dot').style.background = PLAYER_COLORS[i];
    const input = row.querySelector('input');
    input.value = matchCfg.names[i];
    input.setAttribute('aria-label', `플레이어 ${i + 1} 이름`);
    input.oninput = () => { matchCfg.names[i] = input.value; persist(); };
    names.appendChild(row);
  }
}
document.querySelectorAll('#setupCount button').forEach((b) => (b.onclick = () => { matchCfg.count = +b.dataset.n; persist(); renderSetup(); }));
document.querySelectorAll('#setupMode button').forEach((b) => (b.onclick = () => { matchCfg.mode = b.dataset.mode; persist(); renderSetup(); }));
$('targetMinus').onclick = () => { matchCfg.target = Math.max(1, matchCfg.target - 1); persist(); renderSetup(); };
$('targetPlus').onclick = () => { matchCfg.target = Math.min(5, matchCfg.target + 1); persist(); renderSetup(); };
$('capDouble').onchange = (e) => { matchCfg.capDouble = e.target.checked; persist(); };
$('continueOnHit').onchange = (e) => { matchCfg.continueOnHit = e.target.checked; persist(); };
$('setupClose').onclick = () => togglePanel('setup', false);
$('setupStart').onclick = () => startMatch();

// ---------- 온라인 방 ----------
const network = new RoomConnection(handleNetworkMessage, () => {
  const wasInRoom = !!onlineRoom;
  goMenu();
  openOnline('join');
  $('onlineStatus').textContent = wasInRoom ? '서버 연결이 끊겼습니다. 방에 다시 참가해주세요.' : '온라인 서버에 연결할 수 없습니다.';
  $('onlineSubmit').disabled = false;
});

function settingsText(settings) {
  return `${MAPS[settings.map].name} · ${BOTTLES[settings.bottle].name} · ${FLUIDS[settings.fluid].name} ${Math.round(settings.fill * 100)}% · ${MODES[settings.mode].name} ${settings.target}점`;
}
function openOnline(action) {
  onlineAction = action;
  hidePanels();
  $('menu').classList.add('hidden');
  $('onlineTitle').textContent = action === 'host' ? '온라인 방 만들기' : '온라인 방 참가';
  $('onlineForm').classList.remove('hidden');
  $('onlineLobby').classList.add('hidden');
  $('codeField').classList.toggle('hidden', action === 'host');
  $('hostInfo').textContent = action === 'host' ? `${settingsText({ ...opts, ...matchCfg })}. 이 방은 같은 병과 유체로 겨룹니다. 메뉴의 커스터마이즈와 한 PC 멀티 설정이 적용됩니다.` : '친구와 같은 서버 주소를 연 뒤 방 코드를 입력하세요.';
  $('onlineSubmit').textContent = action === 'host' ? '방 만들기' : '참가';
  $('onlineSubmit').disabled = false;
  $('onlineStatus').textContent = '';
  togglePanel('online', true);
}
function leaveOnline() {
  network.close();
  onlineRoom = null; onlineId = null; onlinePending = false; remoteSnapshot = null;
  turnClock.stop();
  $('resultAgain').disabled = false;
  $('resultAgain').textContent = '다시 하기';
  if (localSetup) {
    Object.assign(opts, localSetup.opts); Object.assign(tuning, localSetup.tuning); Object.assign(look, localSetup.look);
    localSetup = null;
    rebuild();
  }
}
$('onlineClose').onclick = () => { leaveOnline(); goMenu(); };
$('onlineLeave').onclick = () => { leaveOnline(); goMenu(); };
$('onlineStart').onclick = () => network.send({ type: 'start' });
$('onlineSubmit').onclick = async () => {
  const code = $('onlineCode').value.trim().toUpperCase();
  if (onlineAction === 'join' && !/^[A-F0-9]{6}$/.test(code)) {
    $('onlineStatus').textContent = '6자리 방 코드를 입력해주세요.'; return;
  }
  $('onlineSubmit').disabled = true;
  $('onlineStatus').textContent = '연결 중…';
  try {
    await network.connect();
    if ($('online').classList.contains('hidden')) return;
    network.send({ type: onlineAction === 'host' ? 'create' : 'join', code,
      name: $('onlineName').value, settings: { ...opts, mode: matchCfg.mode, target: matchCfg.target,
        capDouble: matchCfg.capDouble, continueOnHit: matchCfg.continueOnHit } });
  } catch (e) { $('onlineStatus').textContent = e.message; $('onlineSubmit').disabled = false; }
};
function handleNetworkMessage(msg) {
  if (msg.type === 'welcome') { onlineId = msg.id; return; }
  if (msg.type === 'error') {
    onlinePending = false;
    $('onlineSubmit').disabled = false;
    $('onlineStatus').textContent = msg.message;
    if (mode === 'play') showToast(msg.message, 'bad');
    return;
  }
  if (msg.type === 'clock' && msg.turnId === onlineRoom?.turnId && onlineRoom.phase === 'ready') {
    turnClock.deadline = performance.now() + msg.remaining;
    return;
  }
  if (msg.type === 'launch' && msg.turnId === onlineRoom?.turnId) {
    drag = null; charge = null; onlinePending = false;
    turnClock.stop(); remoteSnapshot = null;
    lastPower = msg.input.power;
    sim.throw(msg.input);
    setMeter(lastPower, lastPower);
    $('last').textContent = '';
    return;
  }
  if (msg.type === 'frame' && msg.turnId === onlineRoom?.turnId) {
    remoteSnapshot = msg.snapshot;
    sim.held = false; sim.state = msg.snapshot.state; sim.time = msg.time;
    for (const ev of msg.events) if (ev.type === 'fizz') view.triggerFizz();
    return;
  }
  if (msg.type !== 'room') return;
  const previousRoom = onlineRoom;
  if (!localSetup) localSetup = { opts: { ...opts }, tuning: { ...tuning }, look: { ...look } };
  onlineRoom = msg;
  $('onlineStatus').textContent = msg.notice || '';
  $('onlineSubmit').disabled = false;
  $('resultAgain').disabled = msg.hostId !== onlineId;
  $('resultAgain').textContent = msg.hostId === onlineId ? '다시 하기' : '방장 시작 대기';
  if (msg.phase === 'lobby') {
    turnClock.stop(); remoteSnapshot = null; onlinePending = false;
    game = 'practice'; match = null;
    hidePanels(); setMode('menu'); resetThrow(); updateSeats();
    $('menu').classList.add('hidden');
    togglePanel('online', true);
    $('onlineTitle').textContent = '온라인 대기실';
    $('onlineForm').classList.add('hidden');
    $('onlineLobby').classList.remove('hidden');
    $('roomCode').textContent = msg.code;
    $('roomSettings').textContent = settingsText(msg.settings);
    $('roomPlayers').replaceChildren(...msg.members.map(m => {
      const li = document.createElement('li');
      li.textContent = `${m.name}${m.id === onlineId ? ' (나)' : ''}${m.id === msg.hostId ? ' · 방장' : ''}`;
      return li;
    }));
    $('onlineStart').disabled = msg.hostId !== onlineId || msg.members.length < 2;
    $('onlineStart').textContent = msg.hostId !== onlineId ? '방장이 시작하기를 기다리는 중' : msg.members.length < 2 ? '친구를 기다리는 중 (2명 이상)' : '게임 시작';
    return;
  }
  const newTurn = !previousRoom?.match || previousRoom.turnId !== msg.turnId;
  const firstStart = !previousRoom?.match;
  match = msg.match; game = 'match';
  if (newTurn) scheduleGuide();
  hidePanels(); setMode('play'); lockMatchSettings(true);
  $('practiceStats').classList.add('hidden'); $('scoreboard').classList.remove('hidden');
  if (newTurn) {
    drag = null; charge = null; remoteSnapshot = null; onlinePending = false;
    sitAt(match.players[match.turn].seat);
    if (firstStart) {
      for (const key of ['bottle', 'fluid', 'fill', 'map']) opts[key] = msg.settings[key];
      Object.assign(tuning, { spinBase: THROW.spinBase, spinRatio: THROW.spinRatio });
      look.fluidColor = FLUIDS[opts.fluid].color;
      rebuild();
    }
    resetThrow();
    $('last').textContent = '';
    showToast(isMyTurn() ? '내 차례 · 15초!' : `${match.players[match.turn].name} 차례`, 'ok');
  }
  if (msg.phase === 'ready') turnClock.deadline = performance.now() + msg.remaining;
  else turnClock.stop();
  if (msg.phase === 'result') {
    drag = null; charge = null; onlinePending = false;
    sim.state = 'done'; sim.held = false;
    const r = msg.result;
    const points = match.lastPoints;
    $('last').textContent = r.outcome === 'timeout' ? '던지지 않아 0점 처리됐습니다.' : throwInfo(r);
    showToast(r.outcome === 'timeout' ? '시간 초과 · 0점' : points ? `성공! +${points}` : r.outcome === 'offtable' ? '테이블 밖으로…' : '쓰러짐', points ? 'ok' : 'bad');
  }
  renderScoreboard(); updateSeats();
  if (msg.phase === 'over') showMatchResult();
}

// ---------- 카메라 ----------
// 1인칭: 내 자리(테이블 앞쪽 의자)에 앉은 눈높이
const camPlay = { pos: new THREE.Vector3(0, EYE_Y, TABLE.halfZ + EYE_BACK), look: new THREE.Vector3(0, 0.8, 0.0) };
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
  const show = canControl();
  arc.visible = show;
  landMark.visible = show;
  if (!show) return;
  // 힘을 모으는 중이면 그 힘, 아니면 가이드 기준 힘(1.0)으로 흐리게
  const power = drag ? drag.power : charge ? chargePower() : 1.0;
  arc.material.opacity = drag || charge ? 0.9 : 0.35;
  const vUp = THROW.minUp + THROW.upPerPower * power;
  const fwd = vUp * Math.tan((aim.angle * Math.PI) / 180);
  const [dx, dz] = throwDir();
  const [hx, hz] = handWorld();
  const g = MAPS[opts.map].gravity;
  // 손 높이에서 출발해 테이블 높이로 돌아올 때까지
  const h = handLift(power);
  const T = (vUp + Math.sqrt(vUp * vUp + 2 * g * h)) / g;
  const pos = arcGeo.attributes.position;
  const y0 = TABLE.y + 0.005 + h;
  for (let i = 0; i < ARC_N; i++) {
    const t = (i / (ARC_N - 1)) * T;
    pos.setXYZ(i, hx + dx * fwd * t, y0 + vUp * t - 0.5 * g * t * t, hz + dz * fwd * t);
  }
  pos.needsUpdate = true;
  landMark.position.set(hx + dx * fwd * T, TABLE.y + 0.002, hz + dz * fwd * T);
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
  const scaleT = !onlineRoom && prefs.slowmo && sim.state === 'flying' ? 0.35 : 1;
  acc += real * scaleT;

  if (charge) {
    const p = chargePower();
    setMeter(p);
    hold(p);
  }
  meter.classList.toggle('hidden', game === 'match' || mode !== 'play');
  meter.style.opacity = prefs.showMeter || charge ? 1 : 0;

  while (acc >= DT) {
    if (!onlineRoom || onlineRoom.phase === 'lobby' || onlineRoom.phase === 'ready') sim.step();
    acc -= DT;
  }
  if (remoteSnapshot) {
    // 서버의 20Hz 상태를 짧게 보간한다. 클라이언트는 착지/점수를 판정하지 않는다.
    const t = Math.min(1, real * 22);
    sim.x = sim.x.map((v, i) => v + (remoteSnapshot.com[i] - v) * t);
    const q = new THREE.Quaternion(...sim.q).slerp(new THREE.Quaternion(...remoteSnapshot.q), t);
    sim.q = q.toArray();
    sim.p = remoteSnapshot.particles.map((p, i) => p.map((v, j) => (sim.p[i]?.[j] ?? v) + (v - (sim.p[i]?.[j] ?? v)) * t));
  }
  for (const ev of sim.events.splice(0)) if (ev.type === 'fizz') view.triggerFizz();

  if (sim.state === 'done' && !onlineRoom) {
    if (!resultShownAt) {
      resultShownAt = now;
      onResult(sim.result);
    } else if (now - resultShownAt > 1700 && !afterPending) {
      afterPending = true;
      afterResult();
    }
  }

  view.handVisible = mode === 'play' && sim.held && isMyTurn();
  view.update(real);
  updateArc();

  // 카메라 (기차는 흔들림 반영)
  const target = mode === 'menu' ? camMenu : camPlay;
  // 1인칭: 병(손)이 있는 쪽으로 고개를 돌린다
  if (mode === 'play') {
    camPlay.pos.copy(eyeWorld());
    const [lx, lz] = toWorld(hand.x * LOOK_FOLLOW, 0);
    camPlay.look.set(lx, LOOK_Y, lz);
  }
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
window.__bottleflip = { get sim() { return sim; }, get match() { return match; }, doThrow, resetThrow, setMode, setAngle, startMatch, matchCfg, opts, hand, get guide() { return guide; } };
