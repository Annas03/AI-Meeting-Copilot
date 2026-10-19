import { describe, expect, it } from 'vitest';
import { CreateMeetingRequestSchema, JoinMeetingResponseSchema, MeetingSummarySchema } from './api.js';
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

  it('accepts the bot lifecycle on agent status events', () => {
    const event = MeetingEventSchema.parse({ ...base, event: 'agent.status', status: 'connecting', detail: 'Admit the bot', botStatus: 'waiting_room' });
    expect(event.event === 'agent.status' && event.botStatus).toBe('waiting_room');
    expect(MeetingEventSchema.safeParse({ ...base, event: 'agent.status', status: 'connecting', botStatus: 'nope' }).success).toBe(false);
  });

  it('wraps events in the websocket envelope', () => {
    const message = WsServerMessageSchema.parse({ type: 'event', payload: { ...base, event: 'meeting.ended' } });
    expect(message.type).toBe('event');
  });
});

const summary = { meetingId: 'm-1', title: 't', projectId: 'default', status: 'live', createdAt: base.timestamp };

describe('MeetingSummarySchema', () => {
  it('carries the meeting link and bot state', () => {
    const parsed = MeetingSummarySchema.parse({
      ...summary,
      platform: 'google_meet',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      botStatus: 'waiting_room',
    });
    expect(parsed.platform).toBe('google_meet');
    expect(parsed.botStatus).toBe('waiting_room');
  });

  it('requires a meeting link when creating a meeting', () => {
    expect(CreateMeetingRequestSchema.safeParse({ title: 't' }).success).toBe(false);
    expect(CreateMeetingRequestSchema.safeParse({ title: 't', meetingUrl: 'not a url' }).success).toBe(false);
    expect(CreateMeetingRequestSchema.safeParse({ title: 't', meetingUrl: 'https://zoom.us/j/123' }).success).toBe(true);
  });
});

describe('JoinMeetingResponseSchema', () => {
  it('returns the session token for the companion panel', () => {
    const result = JoinMeetingResponseSchema.safeParse({
      meeting: summary,
      participant: { identity: 'alice-1', name: 'Alice', isAgent: false },
      sessionToken: 'abc',
      briefingPending: false,
    });
    expect(result.success).toBe(true);
  });
});
