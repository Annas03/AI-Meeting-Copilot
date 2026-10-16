import { fileURLToPath } from 'node:url';
import { AutoSubscribe, ServerOptions, cli, defineAgent, inference, stt, type JobContext } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import { RoomEvent, TrackKind, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from '@livekit/rtc-node';
import { loadEnv } from './env.ts';
import { ServerClient, type AgentLogger } from './server-client.ts';
import { TrackTranscriber } from './transcriber.ts';

const ROOM_PREFIX = 'meeting-';

const log: AgentLogger = {
  info: (msg, data) => console.log(`[agent] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`),
  warn: (msg, data) => console.warn(`[agent] WARN ${msg}${data ? ' ' + JSON.stringify(data) : ''}`),
};

function createStt(env: ReturnType<typeof loadEnv>): stt.STT {
  if (env.STT_PROVIDER === 'deepgram') {
    if (!env.DEEPGRAM_API_KEY) throw new Error('STT_PROVIDER=deepgram but DEEPGRAM_API_KEY is not set');
    return new deepgram.STT({
      apiKey: env.DEEPGRAM_API_KEY,
      model: env.STT_MODEL as 'nova-3',
      language: env.STT_LANGUAGE === 'en' ? 'en-US' : env.STT_LANGUAGE,
      interimResults: true,
      sampleRate: 16_000,
      numChannels: 1,
      endpointing: 300,
    });
  }
  // LiveKit Inference: billed through the LiveKit Cloud project, no provider key needed.
  return new inference.STT({ model: env.STT_MODEL as 'deepgram/nova-3', language: env.STT_LANGUAGE });
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const env = loadEnv();
    const server = new ServerClient(env.SERVER_URL, env.INTERNAL_API_SECRET, log);
    const roomName = ctx.job.room?.name ?? '';

    let meetingId = roomName.startsWith(ROOM_PREFIX) ? roomName.slice(ROOM_PREFIX.length) : null;
    if (!meetingId) meetingId = await server.resolveMeetingId(roomName);
    if (!meetingId) {
      log.warn('room is not a copilot meeting; leaving', { roomName });
      return;
    }
    log.info('joining meeting', { meetingId, roomName, stt: `${env.STT_PROVIDER}:${env.STT_MODEL}` });
    await server.agentStatus(meetingId, roomName, 'connecting');

    let engine: stt.STT;
    try {
      engine = createStt(env);
    } catch (err) {
      await server.agentStatus(meetingId, roomName, 'error', String(err));
      throw err;
    }

    const transcribers = new Map<string, TrackTranscriber>();
    const startTranscriber = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      const key = publication.sid ?? `${participant.identity}:${track.sid}`;
      if (transcribers.has(key)) return;
      const transcriber = new TrackTranscriber(
        {
          engine,
          eventTypes: {
            interim: stt.SpeechEventType.INTERIM_TRANSCRIPT,
            final: stt.SpeechEventType.FINAL_TRANSCRIPT,
            endOfSpeech: stt.SpeechEventType.END_OF_SPEECH,
          },
          localParticipant: ctx.room.localParticipant!,
          server,
          meetingId,
          language: env.STT_LANGUAGE,
          log,
        },
        participant,
        publication,
        track,
      );
      transcribers.set(key, transcriber);
      void transcriber
        .run()
        .catch((err) => log.warn('transcriber crashed', { identity: participant.identity, err: String(err) }))
        .finally(() => transcribers.delete(key));
    };

    ctx.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => startTranscriber(track, publication, participant));
    ctx.room.on(RoomEvent.TrackUnsubscribed, (_track, publication) => {
      const key = publication.sid ?? '';
      const t = transcribers.get(key);
      if (t) void t.close();
    });
    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      void server.participantLeft(meetingId, participant.identity, participant.name);
    });
    ctx.room.on(RoomEvent.Disconnected, () => {
      void server.agentStatus(meetingId, roomName, 'disconnected');
      for (const t of transcribers.values()) void t.close();
    });

    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

    // Tracks that were already published before we joined.
    for (const participant of ctx.room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track && publication.subscribed) startTranscriber(publication.track as RemoteTrack, publication, participant);
      }
    }

    await server.agentStatus(meetingId, roomName, 'listening', `stt ${env.STT_PROVIDER}:${env.STT_MODEL}`);
    log.info('listening', { meetingId, participants: ctx.room.remoteParticipants.size });
  },
});

const env = loadEnv();
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    ...(env.AGENT_NAME ? { agentName: env.AGENT_NAME } : {}),
  }),
);
