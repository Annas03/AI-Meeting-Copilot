import { timingSafeEqual } from 'node:crypto';
import {
  AskRequestSchema,
  CreateMeetingRequestSchema,
  DevTranscriptRequestSchema,
  INTERNAL_SECRET_HEADER,
  InternalAgentStatusRequestSchema,
  InternalTranscriptRequestSchema,
  JoinMeetingRequestSchema,
  SESSION_HEADER,
} from '@copilot/shared';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebhookReceiver } from 'livekit-server-sdk';
import { nanoid } from 'nanoid';
import type { ZodType } from 'zod';
import type { BotMeetingManager } from '../bots/manager.js';
import { BotProviderError, UnsupportedMeetingUrlError } from '../bots/provider.js';
import { config } from '../config.js';
import type { Knowledge } from '@copilot/knowledge';
import type { BriefingService } from '../copilot/briefing.js';
import type { InvestigationManager } from '../copilot/investigations.js';
import type { MeetingMemory } from '../copilot/memory.js';
import { meetingIdFromRoom } from '../livekit/tokens.js';
import type { Logger } from '../logger.js';
import { MeetingService, NotFoundError, slug, type Session } from '../meetings/service.js';

export interface AppDeps {
  meetings: MeetingService;
  investigations: InvestigationManager;
  memory: MeetingMemory;
  briefings: BriefingService;
  knowledge: Knowledge;
  /** Present only when Recall.ai is configured. */
  bots?: BotMeetingManager;
  logger: Logger;
  version: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, 'Invalid request body', result.error.issues);
  return result.data;
}

/** Express 5 types route params as string | string[]; our routes only use single segments. */
function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.WEB_ORIGIN ?? true }));

  // LiveKit webhooks need the raw body for signature verification.
  app.post('/api/livekit/webhook', express.raw({ type: 'application/webhook+json' }), async (req, res) => {
    if (!config.LIVEKIT_API_KEY || !config.LIVEKIT_API_SECRET) throw new HttpError(503, 'LiveKit not configured');
    const receiver = new WebhookReceiver(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
    const event = await receiver.receive((req.body as Buffer).toString('utf8'), req.header('authorization'));
    const roomName = event.room?.name;
    const meetingId = roomName ? meetingIdFromRoom(roomName) : null;
    if (meetingId) {
      if (event.event === 'participant_left' && event.participant) {
        await deps.meetings.participantLeft(meetingId, event.participant.identity, event.participant.name);
      } else if (event.event === 'room_finished') {
        await deps.meetings.endMeeting(meetingId);
      }
    }
    res.json({ ok: true });
  });

  // Recall.ai webhooks (bot status from the dashboard, real-time transcript from the bot) are verified on the raw body.
  app.post('/api/recall/webhook', express.raw({ type: 'application/json', limit: '2mb' }), (req, res) => {
    if (!deps.bots) throw new HttpError(503, 'Recall.ai is not configured');
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    const verdict = deps.bots.verifyWebhook({
      body,
      ...(token ? { token } : {}),
      headers: { id: req.header('svix-id'), timestamp: req.header('svix-timestamp'), signature: req.header('svix-signature') },
    });
    if (!verdict.ok) throw new HttpError(401, `Webhook rejected: ${verdict.reason}`);
    // Acknowledge first: the provider retries anything that is not a fast 2xx.
    res.json({ ok: true });
    void deps.bots.handleWebhook(body, req.header('svix-id')).catch((err) => deps.logger.warn({ err }, 'recall webhook processing failed'));
  });

  app.use(express.json({ limit: '1mb' }));

  const requireSession = async (req: Request, res: Response, next: NextFunction) => {
    const session = await deps.meetings.resolveSession(req.header(SESSION_HEADER));
    if (!session) return next(new HttpError(401, 'Missing or invalid session token'));
    const meetingId = param(req, 'id');
    if (meetingId && session.meetingId !== meetingId) return next(new HttpError(403, 'Session does not belong to this meeting'));
    res.locals.session = session;
    next();
  };

  const requireInternal = (req: Request, _res: Response, next: NextFunction) => {
    if (!secretsMatch(req.header(INTERNAL_SECRET_HEADER), config.INTERNAL_API_SECRET)) return next(new HttpError(401, 'Invalid internal secret'));
    next();
  };

  app.get('/api/health', async (_req, res) => {
    const health = await deps.knowledge.health();
    res.json({
      ok: true,
      version: deps.version,
      qdrant: health.qdrant ? 'ok' : 'unavailable',
      livekit: config.livekitConfigured ? 'configured' : 'missing',
      anthropic: config.anthropicConfigured ? 'configured' : 'missing',
      recall: config.recallConfigured ? 'configured' : 'missing',
      embeddings: health.embeddings,
    });
  });

  app.get('/api/projects', async (_req, res) => {
    const manifests = await deps.knowledge.projects();
    res.json({
      projects: manifests.map((m) => ({
        projectId: m.projectId,
        repository: m.repository,
        revision: m.revision,
        files: Object.keys(m.files).length,
        chunks: Object.values(m.files).reduce((acc, f) => acc + f.chunkCount, 0),
        lastRun: m.lastRun ?? null,
      })),
    });
  });

  app.post('/api/meetings', async (req, res) => {
    const { meetingUrl, ...body } = parseBody(CreateMeetingRequestSchema, req.body);
    if (meetingUrl) {
      if (!deps.bots) throw new HttpError(400, 'Attaching to Zoom / Google Meet requires RECALL_API_KEY and PUBLIC_SERVER_URL on the server');
      res.status(201).json(await deps.bots.createExternalMeeting({ ...body, meetingUrl }));
      return;
    }
    const meeting = await deps.meetings.createMeeting(body);
    res.status(201).json(meeting);
  });

  app.get('/api/meetings/:id', async (req, res) => {
    res.json(await deps.meetings.getMeeting(param(req, 'id')));
  });

  app.post('/api/meetings/:id/join', async (req, res) => {
    const body = parseBody(JoinMeetingRequestSchema, req.body);
    res.json(await deps.meetings.join(param(req, 'id'), body.name));
  });

  app.post('/api/meetings/:id/ask', requireSession, async (req, res) => {
    const body = parseBody(AskRequestSchema, req.body);
    const session = res.locals.session as Session;
    const result = await deps.investigations.start({ meetingId: param(req, 'id'), question: body.question, askedBy: session.name });
    res.status(202).json(result);
  });

  app.get('/api/meetings/:id/state', requireSession, async (req, res) => {
    const meetingId = param(req, 'id');
    const [state, answers] = await Promise.all([deps.memory.getState(meetingId), deps.investigations.listAnswers(meetingId)]);
    res.json({ state, answers });
  });

  app.get('/api/meetings/:id/transcript', requireSession, async (req, res) => {
    const meetingId = param(req, 'id');
    res.json({ meetingId, segments: await deps.meetings.getTranscript(meetingId) });
  });

  app.get('/api/meetings/:id/briefing', requireSession, async (req, res) => {
    const briefing = await deps.briefings.getOrGenerate(param(req, 'id'));
    if (!briefing) throw new HttpError(404, 'No briefing yet: the meeting has no memory to summarise');
    res.json({ briefing });
  });

  app.post('/api/meetings/:id/end', requireSession, async (req, res) => {
    const meetingId = param(req, 'id');
    const meeting = await deps.meetings.getMeeting(meetingId);
    if (meeting.source === 'recall' && deps.bots) await deps.bots.end(meetingId);
    else await deps.meetings.endMeeting(meetingId);
    res.json({ ok: true });
  });

  app.post('/api/meetings/:id/leave', requireSession, async (req, res) => {
    const session = res.locals.session as Session;
    await deps.meetings.participantLeft(param(req, 'id'), session.identity, session.name);
    res.json({ ok: true });
  });

  // ---- internal API used by the agent ----
  app.post('/api/internal/transcript', requireInternal, async (req, res) => {
    const body = parseBody(InternalTranscriptRequestSchema, req.body);
    const segment = await deps.meetings.ingestSegment(body.segment);
    res.json({ ok: true, sequence: segment.sequence ?? null });
  });

  app.post('/api/internal/agent-status', requireInternal, async (req, res) => {
    const body = parseBody(InternalAgentStatusRequestSchema, req.body);
    deps.meetings.setAgentStatus(body.meetingId, body.status, body.detail);
    res.json({ ok: true });
  });

  app.get('/api/internal/rooms/:roomName', requireInternal, async (req, res) => {
    const meeting = await deps.meetings.getMeetingByRoom(param(req, 'roomName'));
    if (!meeting) throw new HttpError(404, 'Unknown room');
    res.json(meeting);
  });

  app.post('/api/internal/participant-left', requireInternal, async (req, res) => {
    const { meetingId, identity, name } = req.body as { meetingId?: string; identity?: string; name?: string };
    if (!meetingId || !identity) throw new HttpError(400, 'meetingId and identity are required');
    await deps.meetings.participantLeft(meetingId, identity, name);
    res.json({ ok: true });
  });

  // ---- dev helpers (disabled in production): inject transcript lines without audio ----
  if (config.devRoutes) {
    app.post('/api/dev/meetings/:id/transcript', async (req, res, next) => {
      const meetingId = param(req, 'id');
      const internalOk = secretsMatch(req.header(INTERNAL_SECRET_HEADER), config.INTERNAL_API_SECRET);
      const session = internalOk ? null : await deps.meetings.resolveSession(req.header(SESSION_HEADER));
      if (!internalOk && (!session || session.meetingId !== meetingId)) return next(new HttpError(401, 'Provide the internal secret or a session token'));
      const body = parseBody(DevTranscriptRequestSchema, req.body);
      await deps.meetings.getMeeting(meetingId);
      const segment = await deps.meetings.ingestSegment({
        segmentId: `dev-${nanoid(8)}`,
        meetingId,
        speakerId: `dev-${slug(body.speakerName)}`,
        speakerName: body.speakerName,
        text: body.text,
        final: true,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });
      res.status(202).json({ segmentId: segment.segmentId, sequence: segment.sequence });
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof UnsupportedMeetingUrlError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof BotProviderError) {
      deps.logger.warn({ err, path: req.path }, 'meeting bot provider request failed');
      res.status(502).json({ error: `Recall.ai rejected the request: ${err.message}` });
      return;
    }
    const message = err instanceof Error ? err.message : 'Internal error';
    deps.logger.error({ err, path: req.path }, 'request failed');
    res.status(500).json({ error: message });
  });

  return app;
}
