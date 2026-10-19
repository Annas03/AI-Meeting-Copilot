import { describe, expect, it } from 'vitest';
import { parseRecallWebhook, recallBotEventToStatus, recallTranscriptEventToUtterance, RecallBotStatusEventSchema } from './mappers.js';

const bot = { id: 'bot-1', metadata: { meetingId: 'm-1' } };

function transcript(event: 'transcript.data' | 'transcript.partial_data', words: string[], participant: Record<string, unknown> = { id: 42, name: 'Priya' }) {
  return {
    event,
    data: {
      data: {
        words: words.map((text, i) => ({ text, start_timestamp: { relative: i }, end_timestamp: null })),
        participant,
        ...(event === 'transcript.data' ? { language_code: 'en' } : {}),
      },
      realtime_endpoint: { id: 'rt-1', metadata: {} },
      transcript: { id: 't-1', metadata: {} },
      recording: { id: 'r-1', metadata: {} },
      bot,
    },
  };
}

function status(code: string, sub_code: string | null = null) {
  return { event: `bot.${code}`, data: { data: { code, sub_code, updated_at: '2026-10-19T10:00:00Z' }, bot } };
}

describe('recallTranscriptEventToUtterance', () => {
  it('joins words into one utterance and marks partial vs final', () => {
    const events = parseRecallWebhook(JSON.stringify(transcript('transcript.partial_data', ['Can', 'we'])));
    expect(events).toEqual([{ kind: 'utterance', utterance: { botId: 'bot-1', speakerId: 'recall-42', speakerName: 'Priya', text: 'Can we', final: false } }]);
    const final = parseRecallWebhook(JSON.stringify(transcript('transcript.data', ['Can', 'we', 'add', 'permissions?'])));
    expect(final[0]).toMatchObject({ kind: 'utterance', utterance: { text: 'Can we add permissions?', final: true, language: 'en' } });
  });

  it('names anonymous participants by id and drops empty utterances', () => {
    const parsed = transcript('transcript.data', ['hi'], { id: 7, name: null, is_host: false });
    const events = parseRecallWebhook(JSON.stringify(parsed));
    expect(events[0]).toMatchObject({ kind: 'utterance', utterance: { speakerId: 'recall-7', speakerName: 'Speaker 7' } });
    expect(parseRecallWebhook(JSON.stringify(transcript('transcript.data', [' ', ''])))).toEqual([{ kind: 'ignored', event: 'transcript.data', botId: 'bot-1' }]);
  });

  it('is usable directly with a validated event', () => {
    const utterance = recallTranscriptEventToUtterance(transcript('transcript.data', ['ok']) as never);
    expect(utterance?.text).toBe('ok');
  });
});

describe('recallBotEventToStatus', () => {
  it('maps the per-state webhook format', () => {
    expect(parseRecallWebhook(JSON.stringify(status('in_waiting_room')))).toEqual([
      {
        kind: 'status',
        change: {
          botId: 'bot-1',
          code: 'in_waiting_room',
          botStatus: 'waiting_room',
          agentStatus: 'connecting',
          detail: 'Admit the copilot bot from the meeting lobby to start transcription',
          terminal: false,
        },
      },
    ]);
    expect(parseRecallWebhook(JSON.stringify(status('in_call_recording')))[0]).toMatchObject({ change: { botStatus: 'recording', agentStatus: 'listening' } });
  });

  it('maps the legacy status_change format identically', () => {
    const legacy = { event: 'bot.status_change', data: { bot_id: 'bot-1', status: { code: 'joining_call', sub_code: null, created_at: 'x' } } };
    const change = recallBotEventToStatus(RecallBotStatusEventSchema.parse(legacy));
    expect(change).toMatchObject({ botId: 'bot-1', code: 'joining_call', botStatus: 'joining', agentStatus: 'connecting' });
  });

  it('explains why a call ended and marks terminal states', () => {
    expect(parseRecallWebhook(JSON.stringify(status('call_ended', 'timeout_exceeded_waiting_room')))[0]).toMatchObject({
      change: { botStatus: 'ended', subCode: 'timeout_exceeded_waiting_room', detail: 'The copilot bot was not admitted from the lobby in time', terminal: true },
    });
    expect(parseRecallWebhook(JSON.stringify(status('call_ended', 'something_new')))[0]).toMatchObject({ change: { detail: 'The meeting ended' } });
    expect(parseRecallWebhook(JSON.stringify(status('fatal', 'zoom_sdk_error')))[0]).toMatchObject({
      change: { botStatus: 'failed', agentStatus: 'error', detail: 'The copilot bot failed (zoom_sdk_error)', terminal: true },
    });
    expect(parseRecallWebhook(JSON.stringify(status('done')))[0]).toMatchObject({ change: { botStatus: 'ended', terminal: true } });
  });

  it('ignores unknown codes, unrelated events and malformed bodies', () => {
    expect(parseRecallWebhook(JSON.stringify(status('breakout_room_entered')))).toEqual([{ kind: 'ignored', event: 'bot.breakout_room_entered', botId: 'bot-1' }]);
    expect(parseRecallWebhook(JSON.stringify({ event: 'participant_events.join', data: { bot } }))).toEqual([{ kind: 'ignored', event: 'participant_events.join', botId: 'bot-1' }]);
    expect(parseRecallWebhook('{not json')).toEqual([{ kind: 'ignored', event: 'invalid-json' }]);
    expect(parseRecallWebhook(JSON.stringify({ hello: 'world' }))).toEqual([{ kind: 'ignored', event: 'unknown' }]);
  });
});
