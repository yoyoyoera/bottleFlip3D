import { defineConfig } from 'vite';
import { attachMultiplayer } from './server/multiplayer.js';

// 상대 경로로 빌드해서 어느 주소(웹 링크, 하위 폴더)에 올려도 동작하게 한다
export default defineConfig({
  base: './',
  plugins: [{
    name: 'bottle-multiplayer',
    configureServer(server) { attachMultiplayer(server.httpServer); },
    configurePreviewServer(server) { attachMultiplayer(server.httpServer); },
  }],
  build: { chunkSizeWarningLimit: 1000 },
});
