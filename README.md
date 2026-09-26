# Bottle Flip 3D

4명이 한 테이블에 둘러앉아 물병을 던져 세우는 물리 파티 게임.

- 기획서: [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md)
- 던지기 손맛 프로토타입: [`prototype/`](prototype/)

## 프로토타입 실행

```bash
cd prototype
npm install
npm run dev      # http://localhost:5173
npm test         # 물리 코어 테스트 (결정성, 유체 효과, 성공 구간)
```

### 조작
- 화면을 **누른 채 위로 휙** 올렸다 놓기: 빠를수록 세게 던진다. 좌우로 휘면 조준이 바뀐다
- **Space** 길게 누르기: 파워가 0에서 최대까지 왕복한다. 놓으면 던진다
- **R**: 다시 세우기
- 오른쪽 아래 파워 미터의 **초록 띠** = 지금 조합(병, 유체, 채운 양, 맵)에서 서는 파워 구간 (결정적 시뮬레이션으로 미리 계산)

### 구조
| 파일 | 역할 |
|---|---|
| `src/physics.js` | 게임플레이 물리 (병 강체 + 유체 대리 입자, 고정 스텝, 결정적). 렌더와 무관해서 Node에서도 돈다 |
| `src/config.js` | 병, 유체, 맵, 던지기 튜닝 값 |
| `src/shape.js` | 병 형상 (물리와 렌더가 공유) |
| `src/bottleView.js` | 병, 라벨, 액체(클리핑 수면), 탄산 거품 렌더링 |
| `src/world.js` | 4인 테이블과 맵 테마 |
| `src/main.js` | 메뉴, HUD, 입력(플릭/충전), 게임 루프 |
