// 병 렌더링: 투명 페트 껍데기 + 라벨 + 뚜껑 + 유체(클리핑 평면으로 수면 표현) + 탄산 거품.
// 유체의 '모양'은 물리 입자의 무게중심으로부터 추정한 시각 효과일 뿐이고 동기화하지 않는다.

import * as THREE from 'three';
import { outerProfile } from './shape.js';

export const LABELS = {
  none: '없음',
  stripe: '스트라이프',
  dots: '도트',
  wave: '웨이브',
};

function makeLabelTexture(kind, color) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  if (kind === 'stripe') {
    for (let x = -128; x < 512; x += 48) {
      g.beginPath();
      g.moveTo(x, 128);
      g.lineTo(x + 24, 128);
      g.lineTo(x + 24 + 128, 0);
      g.lineTo(x + 128, 0);
      g.fill();
    }
  } else if (kind === 'dots') {
    for (let y = 16; y < 128; y += 32) for (let x = (y / 32) % 2 ? 16 : 0; x < 512; x += 32) {
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fill();
    }
  } else if (kind === 'wave') {
    g.lineWidth = 10;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    for (let row = 0; row < 3; row++) {
      g.beginPath();
      for (let x = 0; x <= 512; x += 4) g.lineTo(x, 28 + row * 36 + Math.sin((x / 512) * Math.PI * 8) * 8);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

export class BottleView {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.surfaceNormal = new THREE.Vector3(0, 1, 0);
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    this.bubbleClip = this.clipPlane;
    this.foam = 0;
  }

  build(sim, look) {
    this.root.clear();
    const sh = sim.shape;
    this.shape = sh;
    this.sim = sim;
    const prof = outerProfile(sh).map(([x, y]) => new THREE.Vector2(x, y));

    // 껍데기
    const shellGeo = new THREE.LatheGeometry(prof, 40);
    const glass = sim.opts.bottle === 'glass';
    const shellMat = new THREE.MeshPhysicalMaterial({
      color: glass ? 0x9fd9b0 : 0xeaf6ff,
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      opacity: glass ? 0.4 : 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
      clearcoat: 1,
    });
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.renderOrder = 3;
    shell.castShadow = true;
    this.root.add(shell);

    // 뚜껑
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(sh.capR, sh.capR, sh.height - sh.capY, 24),
      new THREE.MeshStandardMaterial({ color: look.capColor, roughness: 0.5 }),
    );
    cap.position.y = (sh.height + sh.capY) / 2;
    cap.castShadow = true;
    this.root.add(cap);

    // 라벨
    if (look.label !== 'none') {
      const h = sh.shoulderY * 0.32;
      const label = new THREE.Mesh(
        new THREE.CylinderGeometry(sh.radius * 1.012, sh.radius * 1.012, h, 40, 1, true),
        new THREE.MeshStandardMaterial({ map: makeLabelTexture(look.label, look.labelColor), roughness: 0.6, side: THREE.DoubleSide }),
      );
      label.position.y = sh.shoulderY * 0.66;
      label.renderOrder = 4;
      this.root.add(label);
    }

    // 유체
    this.liquid = null;
    this.bubbles = null;
    if (sim.nParticles) {
      const inner = prof.map((v) => new THREE.Vector2(Math.max(0, v.x - sh.wall * 1.6), Math.max(sh.bottomIn, Math.min(v.y, sh.topIn))));
      const liqMat = new THREE.MeshStandardMaterial({
        color: look.fluidColor,
        transparent: true,
        opacity: sim.fluidCfg.opacity,
        roughness: 0.15,
        side: THREE.DoubleSide,
        clippingPlanes: [this.clipPlane],
        depthWrite: false,
      });
      this.liquid = new THREE.Mesh(new THREE.LatheGeometry(inner, 32), liqMat);
      this.liquid.renderOrder = 1;
      this.root.add(this.liquid);

      // 탄산 거품 (병 로컬 공간에서 위로 올라감, 수면 위는 잘림)
      if (sim.fluidCfg.fizz > 0) {
        const count = 60;
        const geo = new THREE.BufferGeometry();
        this.bubbleSeeds = [];
        const pos = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          this.bubbleSeeds.push({ a: Math.random() * Math.PI * 2, r: Math.random() * sh.rIn * 0.85, y: Math.random() * sh.topIn, s: 0.02 + Math.random() * 0.04 });
        }
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this.bubbles = new THREE.Points(geo, new THREE.PointsMaterial({
          color: 0xffffff, size: 0.004, transparent: true, opacity: 0.8, clippingPlanes: [this.clipPlane], depthWrite: false,
        }));
        this.bubbles.renderOrder = 2;
        this.root.add(this.bubbles);
      }
    }

    // 착지 거품 링 (탄산)
    this.foamMesh = new THREE.Mesh(
      new THREE.CircleGeometry(sh.rIn * 0.95, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.foamMesh.renderOrder = 2;
    this.scene.add(this.foamMesh);
    this.surfaceNormal.set(0, 1, 0);
    this.foam = 0;
  }

  dispose() {
    this.root.clear();
    if (this.foamMesh) this.scene.remove(this.foamMesh);
  }

  triggerFizz() {
    this.foam = 1;
  }

  update(frameDt) {
    const sim = this.sim;
    const snap = sim.snapshot();
    this.root.position.set(...snap.bottom);
    this.root.quaternion.set(...snap.q);
    this.root.updateMatrixWorld();

    if (!this.liquid) return;
    const sh = this.shape;
    // 유체 무게중심 → 수면 방향 추정
    const centroid = new THREE.Vector3();
    for (const p of snap.particles) centroid.add(new THREE.Vector3(...p));
    centroid.multiplyScalar(1 / snap.particles.length);
    const interiorMid = new THREE.Vector3(0, (sh.bottomIn + sh.topIn) / 2, 0).applyMatrix4(this.root.matrixWorld);
    const toMid = interiorMid.clone().sub(centroid);
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(this.root.quaternion);
    let target;
    if (toMid.length() > sh.rIn * 0.25) target = toMid.normalize();
    else target = axis.clone();
    // 튀지 않게 보간
    this.surfaceNormal.lerp(target, 1 - Math.exp(-frameDt * 12)).normalize();
    const n = this.surfaceNormal;
    // 수면 높이: 병 내부가 n 방향으로 차지하는 길이 * 채움 비율
    const cosT = Math.abs(n.dot(axis));
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const hIn = sh.topIn - sh.bottomIn;
    const extent = hIn * cosT + 2 * sh.rIn * sinT;
    const fill = sim.opts.fill;
    // 병이 서 있을 때는 목이 좁아 채움 높이가 조금 더 올라간다 (대략 보정)
    const d = extent * fill * (0.5 + 0.12 * fill * cosT);
    const surfacePoint = centroid.clone().addScaledVector(n, d);
    this.clipPlane.setFromNormalAndCoplanarPoint(n.clone().negate(), surfacePoint);

    // 착지 거품
    if (this.foam > 0) {
      this.foam = Math.max(0, this.foam - frameDt * 0.7);
      this.foamMesh.material.opacity = 0.85 * Math.min(1, this.foam * 2);
      this.foamMesh.position.copy(surfacePoint).addScaledVector(n, 0.002 + (1 - this.foam) * 0.01);
      this.foamMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    } else {
      this.foamMesh.material.opacity = 0;
    }

    if (this.bubbles) {
      const pos = this.bubbles.geometry.attributes.position;
      const speed = 1 + this.foam * 6;
      this.bubbleSeeds.forEach((b, i) => {
        b.y += b.s * speed * frameDt;
        if (b.y > sh.topIn) b.y = sh.bottomIn;
        const r = Math.min(b.r, sh.innerRadius(b.y) * 0.9);
        pos.setXYZ(i, Math.cos(b.a) * r, b.y, Math.sin(b.a) * r);
      });
      pos.needsUpdate = true;
    }
  }
}
