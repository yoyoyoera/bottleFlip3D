export class RoomConnection {
  constructor(onMessage, onClose) { this.onMessage = onMessage; this.onClose = onClose; this.ws = null; }
  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/multiplayer`);
    this.ws = ws;
    this.connecting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('서버 연결 시간이 초과됐습니다.')); ws.close(); }, 8000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('온라인 서버에 연결할 수 없습니다.')); };
      ws.onmessage = event => { if (this.ws === ws) this.onMessage(JSON.parse(event.data)); };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error('서버 연결이 종료됐습니다.'));
        if (this.ws === ws) { this.ws = null; this.connecting = null; this.onClose(); }
      };
    });
    return this.connecting;
  }
  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }
  close() {
    const ws = this.ws;
    this.ws = null; this.connecting = null;
    if (ws) ws.close();
  }
}
