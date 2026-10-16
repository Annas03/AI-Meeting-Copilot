import { createServer } from 'node:http';
import { Knowledge } from '@copilot/knowledge';
import { WsClientMessageSchema, type WsServerMessage } from '@copilot/shared';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { BriefingService } from './copilot/briefing.js';
import { QuestionDetector } from './copilot/detector.js';
import { InvestigationManager } from './copilot/investigations.js';
import { MeetingMemory } from './copilot/memory.js';
import { openDatabase } from './db/index.js';
import { EventHub } from './events/hub.js';
import { createApp } from './http/app.js';
import { logger } from './logger.js';
import { MeetingService } from './meetings/service.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  if (config.internalSecretIsDefault) logger.warn('INTERNAL_API_SECRET is the default value; set a random secret in .env');
  if (!config.livekitConfigured) logger.warn('LiveKit is not configured; joining meetings will fail until LIVEKIT_* are set');
  if (!config.anthropicConfigured) logger.warn('ANTHROPIC_API_KEY is not set; answers and memory run in degraded mode');

  const { db, close } = await openDatabase(config.dataDir);
  logger.info({ dataDir: config.dataDir }, 'database ready');

  const knowledge = Knowledge.fromEnv();
  const health = await knowledge.health();
  if (!health.qdrant) logger.warn({ url: process.env.QDRANT_URL ?? 'http://127.0.0.1:6333' }, 'Qdrant is not reachable; retrieval will return no evidence (start it with: npm run qdrant)');
  else logger.info({ embeddings: health.embeddings }, 'knowledge store ready');

  const hub = new EventHub(logger);
  const memory = new MeetingMemory({ db, hub, logger });
  const briefings = new BriefingService({ db, hub, memory, logger });
  const detector = new QuestionDetector({ logger });

  // Circular wiring: investigations need meeting context, the meeting service starts investigations.
  let meetingsRef: MeetingService | null = null;
  const investigations = new InvestigationManager({
    db,
    hub,
    knowledge,
    memory,
    logger,
    getContext: (meetingId) => {
      if (!meetingsRef) throw new Error('meeting service not ready');
      return meetingsRef.getContext(meetingId);
    },
  });
  const meetings = new MeetingService({ db, hub, knowledge, memory, briefings, detector, investigations, logger });
  meetingsRef = meetings;

  const app = createApp({ meetings, investigations, memory, briefings, knowledge, logger, version: VERSION });
  const server = createServer(app);

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const meetingId = url.searchParams.get('meetingId');
      const session = await meetings.resolveSession(url.searchParams.get('session') ?? undefined);
      if (!meetingId || !session || session.meetingId !== meetingId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { ws, meetingId, identity: session.identity };
        hub.subscribe(client);
        const hello: WsServerMessage = {
          type: 'hello',
          meetingId,
          participant: { identity: session.identity, name: session.name, isAgent: false },
          serverTime: new Date().toISOString(),
        };
        ws.send(JSON.stringify(hello));
        ws.on('message', (data) => {
          try {
            const parsed = WsClientMessageSchema.safeParse(JSON.parse(data.toString()));
            if (parsed.success && parsed.data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' } satisfies WsServerMessage));
          } catch {
            // ignore malformed client messages
          }
        });
        ws.on('close', () => hub.unsubscribe(client));
        ws.on('error', (err) => logger.warn({ err, identity: session.identity }, 'websocket error'));
      });
    } catch (err) {
      logger.warn({ err }, 'websocket upgrade failed');
      socket.destroy();
    }
  });

  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT, livekit: config.livekitConfigured, anthropic: config.anthropicConfigured, models: { answer: config.ANSWER_MODEL, classifier: config.CLASSIFIER_MODEL, memory: config.MEMORY_MODEL } }, 'server listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    wss.clients.forEach((c) => c.close());
    server.close();
    await close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'server failed to start');
  process.exit(1);
});
