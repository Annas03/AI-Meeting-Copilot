/** LiveKit text-stream topics used between the agent, the room and the clients. */
export const TOPICS = {
  /** Standard LiveKit transcription topic; `@livekit/components-react` renders it as captions. */
  transcription: 'lk.transcription',
  /** Copilot-specific events published into the room (status, answers) as JSON text. */
  copilot: 'copilot.events',
} as const;

/** Header carrying the shared secret on agent -> server internal requests. */
export const INTERNAL_SECRET_HEADER = 'x-internal-secret';

/** Header carrying a participant session token on client -> server requests. */
export const SESSION_HEADER = 'x-session-token';

/** Identity prefix used for the AI participant inside LiveKit rooms. */
export const AGENT_IDENTITY_PREFIX = 'copilot-agent';

/** Assessment labels the answer pipeline may produce. */
export const ASSESSMENTS = ['likely_feasible', 'uncertain', 'unsupported', 'not_applicable'] as const;
