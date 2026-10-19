/** Header carrying a participant session token on client -> server requests. */
export const SESSION_HEADER = 'x-session-token';

/** Assessment labels the answer pipeline may produce. */
export const ASSESSMENTS = ['likely_feasible', 'uncertain', 'unsupported', 'not_applicable'] as const;
