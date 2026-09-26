// 맵 환경: 4인 테이블 + 맵별 테마. 에셋 없이 기본 도형으로만 구성한다.

import * as THREE from 'three';
import { TABLE } from './config.js';

const THEMES = {
  forest: { sky: 0xa9d8ff, fog: 0xa9d8ff, ground: 0x5f8f3e, table: 0x9b6a3f, tableRough: 0.8, chair: 0x7a5230 },
  arctic: { sky: 0xdff1ff, fog: 0xe8f6ff, ground: 0xf4f9ff, table: 0xbfe6ff, tableRough: 0.05, chair: 0x8fb3c9 },
  train: { sky: 0x3a2d24, fog: 0x3a2d24, ground: 0x5a3b2a, table: 0x6e4b33, tableRough: 0.6, chair: 0x8c2f2f },
  space: { sky: 0x05060f, fog: 0x05060f, ground: 0x2a2f3a, table: 0x9aa4b5, tableRough: 0.3, chair: 0x3d4656 },
};

export function buildWorld(scene, mapId) {
  const t = THEMES[mapId];
  const g = new THREE.Group();
  scene.background = new THREE.Color(t.sky);
  scene.fog = new THREE.Fog(t.fog, 4, 14);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: t.ground, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  g.add(ground);

  // 테이블
  const topH = 0.04;
  const tableMat = new THREE.MeshStandardMaterial({
    color: t.table,
    roughness: t.tableRough,
    metalness: mapId === 'space' ? 0.7 : 0,
    transparent: mapId === 'arctic',
    opacity: mapId === 'arctic' ? 0.9 : 1,
  });
  const top = new THREE.Mesh(new THREE.BoxGeometry(TABLE.halfX * 2, topH, TABLE.halfZ * 2), tableMat);
  top.position.y = TABLE.y - topH / 2;
  top.receiveShadow = true;
  top.castShadow = true;
  g.add(top);
  const legMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(t.table).multiplyScalar(0.7), roughness: 0.7 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, TABLE.y - topH, 0.06), legMat);
    leg.position.set(sx * (TABLE.halfX - 0.08), (TABLE.y - topH) / 2, sz * (TABLE.halfZ - 0.08));
    leg.castShadow = true;
    g.add(leg);
  }

  // 4인 좌석 (앞=나, 좌/우/맞은편=다른 플레이어)
  const chairMat = new THREE.MeshStandardMaterial({ color: t.chair, roughness: 0.8 });
  const seats = [
    [0, TABLE.halfZ + 0.35, 0],
    [0, -TABLE.halfZ - 0.35, Math.PI],
    [TABLE.halfX + 0.35, 0, -Math.PI / 2],
    [-TABLE.halfX - 0.35, 0, Math.PI / 2],
  ];
  seats.forEach(([x, z, ry], i) => {
    const chair = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.42), chairMat);
    seat.position.y = 0.45;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.05), chairMat);
    back.position.set(0, 0.7, 0.19);
    chair.add(seat, back);
    chair.position.set(x, 0, z);
    chair.rotation.y = ry;
    chair.traverse((o) => (o.castShadow = true));
    if (i > 0) {
      // 다른 플레이어 자리 표시 (빈 자리)
      const ghost = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.16, 0.35, 4, 12),
        new THREE.MeshStandardMaterial({ color: [0xff7a7a, 0x7ad0ff, 0xffd36e][i - 1], transparent: true, opacity: 0.35 }),
      );
      ghost.position.set(0, 0.85, 0.05);
      chair.add(ghost);
    }
    g.add(chair);
  });

  // 목표 원 (테이블 중앙)
  const target = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.085, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
  );
  target.rotation.x = -Math.PI / 2;
  target.position.set(0, TABLE.y + 0.001, 0);
  g.add(target);

  // 테마 소품
  if (mapId === 'forest') {
    const trunk = new THREE.MeshStandardMaterial({ color: 0x5b3a21 });
    const leaf = new THREE.MeshStandardMaterial({ color: 0x2f6b2a });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + 0.3;
      const r = 4 + (i % 3) * 1.5;
      const tree = new THREE.Group();
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.2), trunk);
      tr.position.y = 0.6;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.2, 10), leaf);
      cone.position.y = 2.1;
      tree.add(tr, cone);
      tree.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      tree.traverse((o) => (o.castShadow = true));
      g.add(tree);
    }
  } else if (mapId === 'arctic') {
    const iceMat = new THREE.MeshStandardMaterial({ color: 0xd8f0ff, roughness: 0.2 });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const berg = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8 + (i % 3) * 0.5, 0), iceMat);
      berg.position.set(Math.cos(a) * 6, 0.2, Math.sin(a) * 6);
      g.add(berg);
    }
  } else if (mapId === 'train') {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x7b5a3c, roughness: 0.8 });
    const winMat = new THREE.MeshBasicMaterial({ color: 0x9fd3ff });
    for (const sx of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.6, 10), wallMat);
      wall.position.set(sx * 1.6, 1.3, 0);
      g.add(wall);
      for (let z = -3; z <= 3; z += 1.5) {
        const w = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), winMat);
        w.position.set(sx * 1.54, 1.4, z);
        w.rotation.y = -sx * Math.PI / 2;
        g.add(w);
      }
    }
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.1, 10), wallMat);
    ceil.position.y = 2.6;
    g.add(ceil);
  } else if (mapId === 'space') {
    const starGeo = new THREE.BufferGeometry();
    const pts = [];
    for (let i = 0; i < 800; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(12);
      if (v.y < -1) v.y = -v.y;
      pts.push(v.x, v.y, v.z);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.04, fog: false })));
    const planet = new THREE.Mesh(new THREE.SphereGeometry(1.4, 32, 16), new THREE.MeshStandardMaterial({ color: 0xd98b4a, fog: false }));
    planet.position.set(-5, 4, -9);
    g.add(planet);
  }

  // 조명
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, mapId === 'space' ? 0.6 : 1.2);
  const sun = new THREE.DirectionalLight(0xffffff, mapId === 'train' ? 1.2 : 2.0);
  sun.position.set(1.5, 3, 1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -1.5;
  sun.shadow.camera.right = 1.5;
  sun.shadow.camera.top = 1.5;
  sun.shadow.camera.bottom = -1.5;
  sun.shadow.bias = -0.0005;
  g.add(hemi, sun);

  scene.add(g);
  return g;
}
