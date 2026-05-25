/* ─── Signaling Client — WebSocket connection to signaling server ─── */
class SignalingClient {
  ws: WebSocket | null;
  peerId: string | null;
  handlers: Record<string, ((data: any) => void)[]>;
  reconnectDelay: number;
  maxReconnectDelay: number;

  constructor() {
    this.ws = null;
    this.peerId = null;
    this.handlers = {};
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 16000;
  }

  connect() {
    let wsUrl = '';
    if ((window as any).api || location.protocol === 'file:') {
      wsUrl = 'ws://localhost:3000';
    } else {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${protocol}//${location.host}`;
    }
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this._emit('connected', null);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'welcome') {
          this.peerId = msg.peerId;
          this._emit('welcome', msg);
        } else {
          this._emit(msg.type, msg);
        }
      } catch (e) { console.error('Signal parse error:', e); }
    };

    this.ws.onclose = () => {
      this._emit('disconnected', null);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    };

    this.ws.onerror = () => {};
  }

  send(msg: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  on(type: string, handler: (data: any) => void) {
    if (!this.handlers[type]) this.handlers[type] = [];
    this.handlers[type].push(handler);
  }

  _emit(type: string, data: any) {
    (this.handlers[type] || []).forEach(h => h(data));
  }
}

const signaling = new SignalingClient();
