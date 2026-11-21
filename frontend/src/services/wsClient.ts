import { apiClient } from './apiClient';

export type WSEventHandler = (event: { type: string; payload: Record<string, unknown> }) => void;

class EventWebSocketClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<WSEventHandler>();
  private reconnectTimer: number | null = null;
  private closed = false;

  subscribe(handler: WSEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async connect(): Promise<void> {
    this.closed = false;
    const conn = await apiClient.init();
    const tokenQ = conn.token ? `?token=${encodeURIComponent(conn.token)}` : '';
    const url = `${conn.wsUrl}/ws/events${tokenQ}`;

    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type: string;
          payload: Record<string, unknown>;
        };
        for (const h of this.handlers) {
          h(msg);
        }
      } catch {
        // Ignore malformed message
      }
    };
    this.ws.onclose = () => {
      if (!this.closed) {
        this.reconnectTimer = window.setTimeout(() => {
          void this.connect();
        }, 2000);
      }
    };
    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

export const wsClient = new EventWebSocketClient();
