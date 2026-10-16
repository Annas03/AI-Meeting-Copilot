import { randomUUID } from 'node:crypto';
import type { stt } from '@livekit/agents';
import { AudioStream, type LocalParticipant, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from '@livekit/rtc-node';
import type { TranscriptSegment } from '@copilot/shared';
import type { AgentLogger, ServerClient } from './server-client.ts';

/** Mirrors TOPICS.transcription from @copilot/shared. LiveKit clients render this topic as captions. */
const TRANSCRIPTION_TOPIC = 'lk.transcription';
const PARTIAL_THROTTLE_MS = 350;
/** Flush an utterance if the provider never signals end-of-speech after the last final chunk. */
const UTTERANCE_IDLE_MS = 1500;
const SAMPLE_RATE = 16_000;

export interface TranscriberDeps {
  engine: stt.STT;
  eventTypes: { interim: stt.SpeechEventType; final: stt.SpeechEventType; endOfSpeech: stt.SpeechEventType };
  localParticipant: LocalParticipant;
  server: ServerClient;
  meetingId: string;
  language: string;
  log: AgentLogger;
}

/**
 * Transcribes one participant's audio track. Each spoken utterance becomes one segment: interim
 * results stream as partial updates and the finalised text is sent once, so the server sees whole
 * questions instead of fragments.
 */
export class TrackTranscriber {
  private closed = false;
  private segmentId = newSegmentId();
  private startedAt: string | undefined;
  private committed = '';
  private lastPartialAt = 0;
  private lastPartialText = '';
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly deps: TranscriberDeps;
  private readonly participant: RemoteParticipant;
  private readonly publication: RemoteTrackPublication;
  private readonly track: RemoteTrack;

  constructor(deps: TranscriberDeps, participant: RemoteParticipant, publication: RemoteTrackPublication, track: RemoteTrack) {
    this.deps = deps;
    this.participant = participant;
    this.publication = publication;
    this.track = track;
  }

  get identity(): string {
    return this.participant.identity;
  }

  async run(): Promise<void> {
    const { engine, eventTypes, log } = this.deps;
    const speech = engine.stream();
    const audio = new AudioStream(this.track, { sampleRate: SAMPLE_RATE, numChannels: 1 });
    log.info('transcribing track', { identity: this.identity, track: this.publication.sid });

    const pump = (async () => {
      try {
        for await (const frame of audio) {
          if (this.closed) break;
          speech.pushFrame(frame);
        }
      } catch (err) {
        log.warn('audio stream ended with error', { identity: this.identity, err: String(err) });
      } finally {
        speech.endInput();
      }
    })();

    try {
      for await (const event of speech) {
        if (this.closed) break;
        const text = event.alternatives?.[0]?.text ?? '';
        if (event.type === eventTypes.interim) {
          if (text.trim()) await this.onInterim(text);
        } else if (event.type === eventTypes.final) {
          if (text.trim()) await this.onFinalChunk(text);
        } else if (event.type === eventTypes.endOfSpeech) {
          await this.flush();
        }
      }
    } catch (err) {
      log.warn('speech stream failed', { identity: this.identity, err: String(err) });
    } finally {
      await this.flush();
      this.closed = true;
      await pump.catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
  }

  private async onInterim(text: string): Promise<void> {
    this.startedAt ??= new Date().toISOString();
    const now = Date.now();
    const combined = `${this.committed} ${text}`.trim();
    if (combined === this.lastPartialText || now - this.lastPartialAt < PARTIAL_THROTTLE_MS) return;
    this.lastPartialAt = now;
    this.lastPartialText = combined;
    await this.publish(combined, false);
    void this.deps.server.sendTranscript(this.segment(combined, false));
  }

  private async onFinalChunk(text: string): Promise<void> {
    this.startedAt ??= new Date().toISOString();
    this.committed = `${this.committed} ${text}`.trim();
    await this.publish(this.committed, false);
    void this.deps.server.sendTranscript(this.segment(this.committed, false));
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.flush(), UTTERANCE_IDLE_MS);
  }

  /** Emits the finished utterance (if any) and starts a new segment. */
  private async flush(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const text = this.committed.trim();
    const segment = this.segment(text, true);
    this.committed = '';
    this.lastPartialText = '';
    this.startedAt = undefined;
    this.segmentId = newSegmentId();
    if (!text) return;
    await this.publish(text, true, segment.segmentId);
    await this.deps.server.sendTranscript(segment);
  }

  private segment(text: string, final: boolean): TranscriptSegment {
    const now = new Date().toISOString();
    return {
      segmentId: this.segmentId,
      meetingId: this.deps.meetingId,
      speakerId: this.participant.identity,
      speakerName: this.participant.name || this.participant.identity,
      text,
      final,
      language: this.deps.language,
      startedAt: this.startedAt ?? now,
      ...(final ? { endedAt: now } : {}),
    };
  }

  /** Publishes the text to the room on the standard transcription topic, attributed to the speaker. */
  private async publish(text: string, final: boolean, segmentId = this.segmentId): Promise<void> {
    try {
      const writer = await this.deps.localParticipant.streamText({
        topic: TRANSCRIPTION_TOPIC,
        senderIdentity: this.participant.identity,
        attributes: {
          'lk.segment_id': segmentId,
          'lk.transcription_final': String(final),
          'lk.transcribed_track_id': this.publication.sid ?? '',
        },
      });
      await writer.write(text);
      await writer.close();
    } catch (err) {
      this.deps.log.warn('failed to publish transcription to room', { err: String(err) });
    }
  }
}

function newSegmentId(): string {
  return `SG_${randomUUID()}`;
}
