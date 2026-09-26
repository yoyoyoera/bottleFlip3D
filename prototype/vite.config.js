import { defineConfig } from 'vite';

// 상대 경로로 빌드해서 어느 주소(웹 링크, 하위 폴더)에 올려도 동작하게 한다
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1000 },
});
