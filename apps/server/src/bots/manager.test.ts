import type { MeetingSummary, TranscriptSegment } from '@copilot/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.js';
import { BotMeetingManager, pairUtterance } from './manager.js';
import type { BotUtterance, MeetingBotProvider, ProviderEvent } from './provider.js';

const meeting: MeetingSummary = {
  meetingId: 'm-1',
  title: 'Sync',
  projectId: 'default',
  roomName: 'meeting-m-1',
  status: 'live',
  createdAt: '2026-10-19T10:00:00.000Z',
  source: 'recall',
  platform: 'google_meet',
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
};

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger;

function utterance(text: string, final: boolean, speakerId = 'recall-42', botId = 'bot-1'): BotUtterance {
  return { botId, speakerId, speakerName: 'Priya', text, final };
}

/** Provider stub: the webhook body is a JSON array of provider events, passed through verbatim. */
function makeProvider(overrides: Partial<MeetingBotProvider> = {}): MeetingBotProvider {
  return {
    name: 'stub',
    createBot: vi.fn(async () => ({ botId: 'bot-1' })),
    leaveCall: vi.fn(async () => {}),
    getBot: vi.fn(async (botId: string) => ({ botId, code: null })),
    verifyWebhook: () => ({ ok: true }),
    parseWebhook: (body: string) => JSON.parse(body) as ProviderEvent[],
    ...overrides,
  };
}

function makeMeetings(dbBotStatus?: MeetingSummary['botStatus']) {
  const ingested: TranscriptSegment[] = [];
  const meetings = {
    createMeeting: vi.fn(async () => meeting),
    getMeeting: vi.fn(async () => ({ ...meeting, botStatus: 'created' as const })),
    getMeetingByBot: vi.fn(async (botId: string) => (botId === 'bot-1' ? { ...meeting, ...(dbBotStatus ? { botStatus: dbBotStatus } : {}) } : null)),
    getBotId: vi.fn(async () => 'bot-1'),
    ingestSegment: vi.fn(async (segment: TranscriptSegment) => {
      ingested.push(segment);
      return segment;
    }),
    setAgentStatus: vi.fn(),
    endMeeting: vi.fn(async () => {}),
    updateBot: vi.fn(async () => {}),
  };
  return { meetings, ingested };
}

function makeManager(opts: { provider?: MeetingBotProvider; dbBotStatus?: MeetingSummary['botStatus'] } = {}) {
  const { meetings, ingested } = makeMeetings(opts.dbBotStatus);
  let t = Date.parse('2026-10-19T10:00:00.000Z');
  const manager = new BotMeetingManager({
    provider: opts.provider ?? makeProvider(),
    meetings,
    logger,
    realtimeEndpointUrl: 'https://example.test/api/recall/webhook/',
    botName: 'Meeting Copilot',
    // Each call advances a second so the partial throttle never interferes with ordering tests.
    now: () => new Date((t += 1000)),
  });
  return { manager, meetings, ingested };
}

const body = (events: ProviderEvent[]) => JSON.stringify(events);
const status = (code: string, botStatus: 'joining' | 'waiting_room' | 'recording' | 'ended' | 'failed', terminal = false): ProviderEvent => ({
  kind: 'status',
  change: { botId: 'bot-1', code, botStatus, agentStatus: botStatus === 'recording' ? 'listening' : 'connecting', detail: code, terminal },
});

describe('pairUtterance', () => {
  it('keeps one segment id across partials and rotates it after a final', () => {
    const now = new Date('2026-10-19T10:00:00.000Z');
    const first = pairUtterance(undefined, utterance('Can we', false), 'm-1', now, () => 'SG_1');
    expect(first.segment).toMatchObject({ segmentId: 'SG_1', final: false, startedAt: now.toISOString() });
    expect(first.segment.endedAt).toBeUndefined();
    const second = pairUtterance(first.nextSlot!, utterance('Can we add permissions?', true), 'm-1', new Date(now.getTime() + 2000), () => 'SG_2');
    expect(second.segment).toMatchObject({ segmentId: 'SG_1', final: true, startedAt: now.toISOString(), endedAt: '2026-10-19T10:00:02.000Z' });
    expect(second.nextSlot).toBeNull();
    const third = pairUtterance(second.nextSlot ?? undefined, utterance('Next', false), 'm-1', now, () => 'SG_3');
    expect(third.segment.segmentId).toBe('SG_3');
  });
});

describe('BotMeetingManager', () => {
  it('rejects unsupported links before creating anything', async () => {
    const { manager, meetings } = makeManager();
    await expect(manager.createExternalMeeting({ title: 't', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/x' })).rejects.toThrow(/Zoom and Google Meet/);
    expect(meetings.createMeeting).not.toHaveBeenCalled();
  });

  it('creates the meeting, sends the bot and records its id', async () => {
    const provider = makeProvider();
    const { manager, meetings } = makeManager({ provider });
    const created = await manager.createExternalMeeting({ title: 't', projectId: 'p', meetingUrl: meeting.meetingUrl! });
    expect(meetings.createMeeting).toHaveBeenCalledWith({ title: 't', projectId: 'p', source: 'recall', platform: 'google_meet', meetingUrl: meeting.meetingUrl });
    expect(provider.createBot).toHaveBeenCalledWith(expect.objectContaining({ botName: 'Meeting Copilot', metadata: { meetingId: 'm-1' } }));
    expect(meetings.updateBot).toHaveBeenCalledWith('m-1', { botId: 'bot-1', botStatus: 'created' });
    expect(meetings.setAgentStatus).toHaveBeenCalledWith('m-1', 'connecting', expect.any(String), 'created');
    expect(created.botStatus).toBe('created');
  });

  it('ends the meeting again when the provider refuses the bot', async () => {
    const provider = makeProvider({ createBot: vi.fn(async () => Promise.reject(new Error('recall down'))) });
    const { manager, meetings } = makeManager({ provider });
    await expect(manager.createExternalMeeting({ title: 't', meetingUrl: meeting.meetingUrl! })).rejects.toThrow('recall down');
    expect(meetings.endMeeting).toHaveBeenCalledWith('m-1');
  });

  it('pairs partials with their final and promotes the bot to listening on first transcript data', async () => {
    const { manager, meetings, ingested } = makeManager();
    await manager.handleWebhook(body([{ kind: 'utterance', utterance: utterance('Can we', false) }]), 'd1');
    await manager.handleWebhook(body([{ kind: 'utterance', utterance: utterance('Can we add', false) }]), 'd2');
    await manager.handleWebhook(body([{ kind: 'utterance', utterance: utterance('Can we add permissions?', true) }]), 'd3');
    await manager.handleWebhook(body([{ kind: 'utterance', utterance: utterance('Next topic', false) }]), 'd4');
    const first = ingested[0]!.segmentId;
    expect(ingested.map((s) => [s.segmentId, s.final, s.text])).toEqual([
      [first, false, 'Can we'],
      [first, false, 'Can we add'],
      [first, true, 'Can we add permissions?'],
      [ingested[3]!.segmentId, false, 'Next topic'],
    ]);
    expect(ingested[3]!.segmentId).not.toBe(first);
    expect(ingested[0]).toMatchObject({ meetingId: 'm-1', speakerId: 'recall-42', speakerName: 'Priya' });
    expect(meetings.setAgentStatus).toHaveBeenCalledWith('m-1', 'listening', expect.any(String), 'recording');
    expect(meetings.updateBot).toHaveBeenCalledTimes(1);
  });

  it('keeps speakers independent', async () => {
    const { manager, ingested } = makeManager();
    await manager.handleWebhook(body([{ kind: 'utterance', utterance: utterance('A one', false, 'recall-1') }, { kind: 'utterance', utterance: utterance('B one', false, 'recall-2') }]), 'd1');
    await manager.handleWebhook(body([{ kind: 'utterance', utterance: utterance('A one done', true, 'recall-1') }]), 'd2');
    const [a, b] = [ingested[0]!.segmentId, ingested[1]!.segmentId];
    expect(a).not.toBe(b);
    expect(ingested.map((s) => `${s.speakerId}:${s.segmentId}`)).toEqual([`recall-1:${a}`, `recall-2:${b}`, `recall-1:${a}`]);
  });

  it('ignores duplicate deliveries and unknown bots', async () => {
    const { manager, meetings, ingested } = makeManager();
    const payload = body([{ kind: 'utterance', utterance: utterance('hello', true) }]);
    await manager.handleWebhook(payload, 'same-id');
    await manager.handleWebhook(payload, 'same-id');
    expect(ingested).toHaveLength(1);
    await manager.handleWebhook(body([{ kind: 'utterance', utterance: utterance('ghost', true, 'recall-9', 'bot-unknown') }]), 'd9');
    expect(ingested).toHaveLength(1);
    expect(meetings.getMeetingByBot).toHaveBeenCalledWith('bot-unknown');
  });

  it('forwards status changes and ends the meeting once on terminal states', async () => {
    const { manager, meetings } = makeManager();
    await manager.handleWebhook(body([status('in_waiting_room', 'waiting_room')]), 'd1');
    expect(meetings.setAgentStatus).toHaveBeenLastCalledWith('m-1', 'connecting', 'in_waiting_room', 'waiting_room');
    expect(meetings.updateBot).toHaveBeenLastCalledWith('m-1', { botStatus: 'waiting_room' });
    await manager.handleWebhook(body([status('call_ended', 'ended', true)]), 'd2');
    await manager.handleWebhook(body([status('done', 'ended', true)]), 'd3');
    expect(meetings.endMeeting).toHaveBeenCalledTimes(1);
    expect(meetings.setAgentStatus).toHaveBeenCalledTimes(2);
    await manager.handleWebhook(body([{ kind: 'utterance', utterance: utterance('late', true) }]), 'd4');
    expect(meetings.ingestSegment).not.toHaveBeenCalled();
  });

  it('still ends the meeting when a terminal event follows a non-terminal failure', async () => {
    const { manager, meetings } = makeManager();
    await manager.handleWebhook(body([status('recording_permission_denied', 'failed')]), 'd1');
    await manager.handleWebhook(body([status('call_ended', 'ended', true)]), 'd2');
    expect(meetings.endMeeting).toHaveBeenCalledTimes(1);
  });

  it('seeds the bot state from the database after a restart', async () => {
    const { manager, meetings } = makeManager({ dbBotStatus: 'ended' });
    await manager.handleWebhook(body([{ kind: 'utterance', utterance: utterance('late', true) }]), 'd1');
    expect(meetings.ingestSegment).not.toHaveBeenCalled();
  });

  it('removes the bot and ends the meeting on request', async () => {
    const provider = makeProvider();
    const { manager, meetings } = makeManager({ provider });
    await manager.end('m-1');
    expect(provider.leaveCall).toHaveBeenCalledWith('bot-1');
    expect(meetings.updateBot).toHaveBeenCalledWith('m-1', { botStatus: 'ended' });
    expect(meetings.setAgentStatus).toHaveBeenCalledWith('m-1', 'disconnected', expect.any(String), 'ended');
    expect(meetings.endMeeting).toHaveBeenCalledWith('m-1');
  });
});
