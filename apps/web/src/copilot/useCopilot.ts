import { useCallback, useEffect, useReducer, useRef } from 'react';
import { api, wsUrl } from '../api';
import { CopilotSocket } from './socket';
import { copilotReducer, initialCopilotState, type CopilotState } from './state';

export interface CopilotSession {
  meetingId: string;
  sessionToken: string;
  participantIdentity: string;
  participantName: string;
}

export interface CopilotApi {
  state: CopilotState;
  ask: (question: string) => Promise<void>;
  markBriefingSeen: () => void;
}

/** Connects to the server's event stream for a meeting and keeps the side-panel state. */
export function useCopilot(session: CopilotSession): CopilotApi {
  const [state, dispatch] = useReducer(copilotReducer, initialCopilotState);
  const socketRef = useRef<CopilotSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    const socket = new CopilotSocket(wsUrl(session.meetingId, session.sessionToken), {
      onEvent: (event) => dispatch({ type: 'event', event }),
      onStatus: (status) => dispatch({ type: 'socket', status }),
    });
    socketRef.current = socket;
    socket.connect();

    // Hydrate with what happened before we connected.
    (async () => {
      try {
        const [stateRes, transcriptRes] = await Promise.all([
          api.getState(session.meetingId, session.sessionToken),
          api.getTranscript(session.meetingId, session.sessionToken),
        ]);
        if (cancelled) return;
        dispatch({ type: 'hydrate', state: stateRes.state, answers: stateRes.answers, transcript: transcriptRes.segments });
      } catch (err) {
        console.warn('Failed to hydrate copilot state', err);
      }
    })();

    return () => {
      cancelled = true;
      socket.close();
      socketRef.current = null;
    };
  }, [session.meetingId, session.sessionToken]);

  const ask = useCallback(
    async (question: string) => {
      const res = await api.ask(session.meetingId, session.sessionToken, { question });
      dispatch({ type: 'ask.local', investigationId: res.investigationId, question, askedBy: session.participantName });
    },
    [session.meetingId, session.sessionToken, session.participantName],
  );

  const markBriefingSeen = useCallback(() => dispatch({ type: 'briefing.seen' }), []);

  return { state, ask, markBriefingSeen };
}
