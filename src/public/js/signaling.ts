/* ─── Signaling Client — WebSocket connection to signaling server ─── */
class SignalingClient {
  ws: WebSocket | null;
  peerId: string | null;
  handlers: Record<string, ((data: any) => void)[]>;
  reconnectDelay: number;
  maxReconnectDelay: number;
  wsUrls: string[];
  currentUrlIndex: number;

  constructor() {
    this.ws = null;
    this.peerId = null;
    this.handlers = {};
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 16000;
    this.wsUrls = [];
    this.currentUrlIndex = 0;
  }

  connect() {
    if (this.wsUrls.length === 0) {
      let defaultUrl = '';
      if ((window as any).api || location.protocol === 'file:') {
        defaultUrl = 'ws://localhost:3000';
      } else {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        defaultUrl = `${protocol}//${location.host}`;
      }
      this.wsUrls = [defaultUrl];
    }

    if (this.currentUrlIndex >= this.wsUrls.length) {
      this.currentUrlIndex = 0;
    }
    const wsUrl = this.wsUrls[this.currentUrlIndex];
    console.log(`[Signaling] Connecting to ${wsUrl} (index ${this.currentUrlIndex}/${this.wsUrls.length})...`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log(`[Signaling] Connected to ${wsUrl}`);
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
      console.log(`[Signaling] Connection closed for ${wsUrl}`);
      this._emit('disconnected', null);
      setTimeout(() => {
        // Move to next URL
        this.currentUrlIndex = (this.currentUrlIndex + 1) % this.wsUrls.length;
        this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    };

    this.ws.onerror = (err) => {
      console.error(`[Signaling] Connection error for ${wsUrl}:`, err);
    };
  }

  setUrls(urls: string[]) {
    const cleanUrls = urls.map(u => u.trim()).filter(u => u.length > 0);
    if (cleanUrls.length === 0) return;

    const isSame = this.wsUrls.length === cleanUrls.length && this.wsUrls.every((val, index) => val === cleanUrls[index]);
    if (isSame) return;

    console.log('[Signaling] Updating signaling URLs:', cleanUrls);
    this.wsUrls = cleanUrls;
    this.currentUrlIndex = 0;
    this.reconnectDelay = 1000;

    if (this.ws) {
      this.ws.onclose = () => {};
      this.ws.close();
    }
    this.connect();
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
