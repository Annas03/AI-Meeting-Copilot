import type { MeetingEvent, MeetingEventName, MeetingEventOf, WsServerMessage } from '@copilot/shared';
import { nanoid } from 'nanoid';
import type { WebSocket } from 'ws';
import type { Logger } from '../logger.js';

export interface HubClient {
  ws: WebSocket;
  meetingId: string;
  identity: string;
}

type EventData<N extends MeetingEventName> = Omit<MeetingEventOf<N>, 'event' | 'eventId' | 'meetingId' | 'timestamp'>;

const PENDING_TTL_MS = 5 * 60_000;

/**
 * Routes application events to the WebSocket clients of a meeting. Targeted events (for example
 * a late-joiner briefing) are queued briefly when the recipient has not connected yet.
 */
export class EventHub {
  private readonly byMeeting = new Map<string, Set<HubClient>>();
  private readonly pending = new Map<string, { event: MeetingEvent; expiresAt: number }[]>();
  private readonly listeners = new Set<(event: MeetingEvent) => void>();

  constructor(private readonly logger: Logger) {}

  subscribe(client: HubClient): void {
    let set = this.byMeeting.get(client.meetingId);
    if (!set) {
      set = new Set();
      this.byMeeting.set(client.meetingId, set);
    }
    set.add(client);
    const key = `${client.meetingId}:${client.identity}`;
    const queued = this.pending.get(key);
    if (queued) {
      this.pending.delete(key);
      const now = Date.now();
      for (const item of queued) if (item.expiresAt > now) this.send(client, { type: 'event', payload: item.event });
    }
  }

  unsubscribe(client: HubClient): void {
    const set = this.byMeeting.get(client.meetingId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) this.byMeeting.delete(client.meetingId);
  }

  connectedIdentities(meetingId: string): string[] {
    return [...(this.byMeeting.get(meetingId) ?? [])].map((c) => c.identity);
  }

  /** Observe every broadcast event (used by tests and by the room publisher). */
  onEvent(listener: (event: MeetingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit<N extends MeetingEventName>(meetingId: string, event: N, data: EventData<N>): MeetingEventOf<N> {
    const full = this.build(meetingId, event, data);
    this.broadcast(full);
    return full;
  }

  emitTo<N extends MeetingEventName>(meetingId: string, identity: string, event: N, data: EventData<N>): MeetingEventOf<N> {
    const full = this.build(meetingId, event, data);
    this.sendTo(meetingId, identity, full);
    return full;
  }

  broadcast(event: MeetingEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn({ err }, 'event listener failed');
      }
    }
    const set = this.byMeeting.get(event.meetingId);
    if (!set) return;
    const message: WsServerMessage = { type: 'event', payload: event };
    for (const client of set) this.send(client, message);
  }

  sendTo(meetingId: string, identity: string, event: MeetingEvent): void {
    const set = this.byMeeting.get(meetingId);
    const targets = [...(set ?? [])].filter((c) => c.identity === identity);
    if (targets.length === 0) {
      const key = `${meetingId}:${identity}`;
      const queue = this.pending.get(key) ?? [];
      queue.push({ event, expiresAt: Date.now() + PENDING_TTL_MS });
      this.pending.set(key, queue);
      return;
    }
    for (const client of targets) this.send(client, { type: 'event', payload: event });
  }

  send(client: HubClient, message: WsServerMessage): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    try {
      client.ws.send(JSON.stringify(message));
    } catch (err) {
      this.logger.warn({ err, identity: client.identity }, 'failed to send websocket message');
    }
  }

  private build<N extends MeetingEventName>(meetingId: string, event: N, data: EventData<N>): MeetingEventOf<N> {
    return { ...(data as object), event, eventId: nanoid(12), meetingId, timestamp: new Date().toISOString() } as MeetingEventOf<N>;
  }
}
