import {
  AskResponseSchema,
  BriefingResponseSchema,
  HealthResponseSchema,
  JoinMeetingResponseSchema,
  MeetingSummarySchema,
  SESSION_HEADER,
  StateResponseSchema,
  TranscriptResponseSchema,
  type AskRequest,
  type CreateMeetingRequest,
  type JoinMeetingRequest,
} from '@copilot/shared';
import type { ZodType } from 'zod';

/** Base URL of the server. Empty means "same origin" (Vite proxies /api and /ws in dev). */
export const SERVER_BASE = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export function wsUrl(meetingId: string, sessionToken: string): string {
  const base = SERVER_BASE
    ? SERVER_BASE.replace(/^http/, 'ws')
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
  const params = new URLSearchParams({ meetingId, session: sessionToken });
  return `${base}/ws?${params.toString()}`;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, schema: ZodType<T>, init: RequestInit & { session?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body) headers['content-type'] = 'application/json';
  if (init.session) headers[SESSION_HEADER] = init.session;
  const res = await fetch(`${SERVER_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message);
  }
  return schema.parse(json);
}

export const api = {
  health: () => request('/api/health', HealthResponseSchema),
  createMeeting: (body: CreateMeetingRequest) =>
    request('/api/meetings', MeetingSummarySchema, { method: 'POST', body: JSON.stringify(body) }),
  getMeeting: (meetingId: string) => request(`/api/meetings/${meetingId}`, MeetingSummarySchema),
  joinMeeting: (meetingId: string, body: JoinMeetingRequest) =>
    request(`/api/meetings/${meetingId}/join`, JoinMeetingResponseSchema, { method: 'POST', body: JSON.stringify(body) }),
  ask: (meetingId: string, session: string, body: AskRequest) =>
    request(`/api/meetings/${meetingId}/ask`, AskResponseSchema, { method: 'POST', body: JSON.stringify(body), session }),
  getState: (meetingId: string, session: string) => request(`/api/meetings/${meetingId}/state`, StateResponseSchema, { session }),
  getTranscript: (meetingId: string, session: string) =>
    request(`/api/meetings/${meetingId}/transcript`, TranscriptResponseSchema, { session }),
  getBriefing: (meetingId: string, session: string) =>
    request(`/api/meetings/${meetingId}/briefing`, BriefingResponseSchema, { session }),
};
