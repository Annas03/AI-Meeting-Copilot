import { describe, expect, it } from 'vitest';
import { JoinMeetingResponseSchema } from './api.js';
import { MeetingEventSchema, WsServerMessageSchema } from './events.js';

const base = { eventId: 'evt-1', meetingId: 'm-1', timestamp: '2026-10-16T10:00:00.000Z' };

describe('MeetingEventSchema', () => {
  it('accepts the blueprint transcript event shape', () => {
    const event = MeetingEventSchema.parse({
      ...base,
      event: 'transcript.final',
      segment: { segmentId: 's1', meetingId: 'm-1', speakerId: 'participant-42', sequence: 15, text: 'Can we add organization-level permissions?', final: true },
    });
    expect(event.event).toBe('transcript.final');
  });

  it('rejects unknown events and malformed payloads', () => {
    expect(MeetingEventSchema.safeParse({ ...base, event: 'nope' }).success).toBe(false);
    expect(MeetingEventSchema.safeParse({ ...base, event: 'analysis.failed', investigationId: 'i1' }).success).toBe(false);
  });

  it('wraps events in the websocket envelope', () => {
    const message = WsServerMessageSchema.parse({ type: 'event', payload: { ...base, event: 'meeting.ended' } });
    expect(message.type).toBe('event');
  });
});

describe('JoinMeetingResponseSchema', () => {
  it('requires the LiveKit connection details', () => {
    const result = JoinMeetingResponseSchema.safeParse({
      meeting: { meetingId: 'm-1', title: 't', projectId: 'default', roomName: 'meeting-m-1', status: 'live', createdAt: base.timestamp },
      participant: { identity: 'alice-1', name: 'Alice', isAgent: false },
      livekitUrl: 'wss://x.livekit.cloud',
      livekitToken: 'jwt',
      sessionToken: 'abc',
      briefingPending: false,
    });
    expect(result.success).toBe(true);
  });
});
