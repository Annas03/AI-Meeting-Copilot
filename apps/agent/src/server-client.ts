import type { AgentStatus, TranscriptSegment } from '@copilot/shared';

/** Mirrors INTERNAL_SECRET_HEADER from @copilot/shared (kept local so the agent has no runtime workspace imports). */
const INTERNAL_SECRET_HEADER = 'x-internal-secret';

export interface AgentLogger {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
}

/** Small HTTP client for the server's internal API (transcripts, agent status, participant events). */
export class ServerClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly log: AgentLogger;

  constructor(baseUrl: string, secret: string, log: AgentLogger) {
    this.baseUrl = baseUrl;
    this.secret = secret;
    this.log = log;
  }

  async resolveMeetingId(roomName: string): Promise<string | null> {
    try {
      const res = await this.request('GET', `/api/internal/rooms/${encodeURIComponent(roomName)}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { meetingId?: string };
      return body.meetingId ?? null;
    } catch (err) {
      this.log.warn('could not resolve meeting for room', { roomName, err: String(err) });
      return null;
    }
  }

  async sendTranscript(segment: TranscriptSegment, attempts = segment.final ? 3 : 1): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.request('POST', '/api/internal/transcript', { segment });
        if (res.ok) return;
        const text = await res.text().catch(() => '');
        this.log.warn('server rejected transcript', { status: res.status, text: text.slice(0, 200), final: segment.final });
        if (res.status < 500) return;
      } catch (err) {
        this.log.warn('transcript post failed', { attempt, err: String(err) });
      }
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  async agentStatus(meetingId: string, roomName: string, status: AgentStatus, detail?: string): Promise<void> {
    try {
      await this.request('POST', '/api/internal/agent-status', { meetingId, roomName, status, ...(detail ? { detail } : {}) });
    } catch (err) {
      this.log.warn('agent status post failed', { err: String(err) });
    }
  }

  async participantLeft(meetingId: string, identity: string, name?: string): Promise<void> {
    try {
      await this.request('POST', '/api/internal/participant-left', { meetingId, identity, name });
    } catch (err) {
      this.log.warn('participant-left post failed', { err: String(err) });
    }
  }

  private request(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', [INTERNAL_SECRET_HEADER]: this.secret },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8000),
    });
  }
}
