import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import { config } from '../config.js';

export const ROOM_PREFIX = 'meeting-';

export function roomNameFor(meetingId: string): string {
  return `${ROOM_PREFIX}${meetingId}`;
}

export function meetingIdFromRoom(roomName: string): string | null {
  return roomName.startsWith(ROOM_PREFIX) ? roomName.slice(ROOM_PREFIX.length) : null;
}

export interface ParticipantTokenOptions {
  roomName: string;
  identity: string;
  name: string;
  /** Seconds or a duration string such as "2h". */
  ttl?: string | number;
}

/** Mints a LiveKit access token for a human participant. Credentials never leave the server. */
export async function createParticipantToken(options: ParticipantTokenOptions): Promise<string> {
  if (!config.LIVEKIT_API_KEY || !config.LIVEKIT_API_SECRET) {
    throw new Error('LiveKit is not configured (LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing)');
  }
  const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: options.identity,
    name: options.name,
    ttl: options.ttl ?? '2h',
  });
  const grant: VideoGrant = {
    room: options.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  };
  token.addGrant(grant);
  return token.toJwt();
}
