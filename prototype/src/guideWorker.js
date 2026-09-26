import { computeGuide } from './guide.js';

// 최신 요청만 의미가 있으므로 작업 번호를 그대로 돌려준다
self.onmessage = (e) => {
  const { job, req } = e.data;
  self.postMessage({ job, results: computeGuide(req) });
};
