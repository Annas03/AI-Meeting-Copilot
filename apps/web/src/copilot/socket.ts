import { WsServerMessageSchema, type MeetingEvent } from '@copilot/shared';
import type { SocketStatus } from './state';

export interface CopilotSocketHandlers {
  onEvent: (event: MeetingEvent) => void;
  onStatus: (status: SocketStatus) => void;
}

/** WebSocket client with exponential-backoff reconnect and keepalive pings. */
export class CopilotSocket {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;

  constructor(private readonly url: string, private readonly handlers: CopilotSocketHandlers) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.handlers.onStatus('closed');
  }

  private open(): void {
    this.handlers.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatus('open');
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 25_000);
    };

    ws.onmessage = (msg) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      const result = WsServerMessageSchema.safeParse(parsed);
      if (!result.success) {
        console.warn('Ignoring malformed server message', result.error.issues);
        return;
      }
      if (result.data.type === 'event') this.handlers.onEvent(result.data.payload);
    };

    ws.onclose = () => {
      this.clearTimers();
      if (this.closedByUser) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempt);
      this.attempt += 1;
      this.handlers.onStatus('reconnecting');
      this.reconnectTimer = window.setTimeout(() => this.open(), delay);
    };

    ws.onerror = () => {
      // onclose follows and handles reconnect
    };
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }
}
