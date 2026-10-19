import type {
  AgentStatus,
  Answer,
  BotStatus,
  Briefing,
  MeetingEvent,
  MeetingState,
  Participant,
  TranscriptSegment,
} from '@copilot/shared';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface InvestigationView {
  investigationId: string;
  question: string;
  status: 'running' | 'completed' | 'failed';
  /** Markdown accumulated from analysis.delta events, replaced by the final answer on completion. */
  markdown: string;
  answer?: Answer;
  error?: string;
  askedBy?: string;
  startedAt: string;
}

export interface CopilotState {
  socket: SocketStatus;
  agentStatus: AgentStatus | 'unknown';
  agentDetail?: string;
  /** Lifecycle of the meeting bot, for external (Zoom / Google Meet) meetings. */
  botStatus?: BotStatus;
  participants: Participant[];
  /** Final segments in order plus the latest partial per segmentId. */
  transcript: TranscriptSegment[];
  investigations: Record<string, InvestigationView>;
  /** Newest first. */
  investigationOrder: string[];
  meetingState?: MeetingState;
  briefing?: Briefing;
  briefingSeen: boolean;
}

export const initialCopilotState: CopilotState = {
  socket: 'connecting',
  agentStatus: 'unknown',
  participants: [],
  transcript: [],
  investigations: {},
  investigationOrder: [],
  briefingSeen: false,
};

export type CopilotAction =
  | { type: 'socket'; status: SocketStatus }
  | { type: 'event'; event: MeetingEvent }
  | { type: 'hydrate'; state?: MeetingState; answers?: Answer[]; transcript?: TranscriptSegment[]; briefing?: Briefing }
  | { type: 'briefing.seen' }
  | { type: 'ask.local'; investigationId: string; question: string; askedBy: string };

const MAX_TRANSCRIPT = 500;

function upsertSegment(list: TranscriptSegment[], segment: TranscriptSegment): TranscriptSegment[] {
  const idx = list.findIndex((s) => s.segmentId === segment.segmentId);
  let next: TranscriptSegment[];
  if (idx === -1) {
    next = [...list, segment];
  } else {
    next = list.slice();
    next[idx] = segment;
  }
  return next.length > MAX_TRANSCRIPT ? next.slice(next.length - MAX_TRANSCRIPT) : next;
}

function answerToView(answer: Answer): InvestigationView {
  return {
    investigationId: answer.investigationId,
    question: answer.question,
    status: 'completed',
    markdown: answer.markdown,
    answer,
    startedAt: answer.createdAt,
  };
}

function withInvestigation(state: CopilotState, view: InvestigationView): CopilotState {
  const exists = state.investigationOrder.includes(view.investigationId);
  return {
    ...state,
    investigations: { ...state.investigations, [view.investigationId]: view },
    investigationOrder: exists ? state.investigationOrder : [view.investigationId, ...state.investigationOrder],
  };
}

export function copilotReducer(state: CopilotState, action: CopilotAction): CopilotState {
  switch (action.type) {
    case 'socket':
      return { ...state, socket: action.status };
    case 'briefing.seen':
      return { ...state, briefingSeen: true };
    case 'ask.local':
      return withInvestigation(state, {
        investigationId: action.investigationId,
        question: action.question,
        status: 'running',
        markdown: '',
        askedBy: action.askedBy,
        startedAt: new Date().toISOString(),
      });
    case 'hydrate': {
      let next: CopilotState = { ...state };
      if (action.state) next.meetingState = action.state;
      if (action.transcript) next.transcript = action.transcript.slice(-MAX_TRANSCRIPT);
      if (action.briefing) next.briefing = action.briefing;
      for (const answer of action.answers ?? []) {
        if (!next.investigations[answer.investigationId]) next = withInvestigation(next, answerToView(answer));
      }
      // Hydrated answers are appended oldest-first; keep newest first.
      next.investigationOrder = [...next.investigationOrder].sort((a, b) => {
        const ta = next.investigations[a]?.startedAt ?? '';
        const tb = next.investigations[b]?.startedAt ?? '';
        return tb.localeCompare(ta);
      });
      return next;
    }
    case 'event':
      return applyEvent(state, action.event);
    default:
      return state;
  }
}

function applyEvent(state: CopilotState, event: MeetingEvent): CopilotState {
  switch (event.event) {
    case 'agent.status':
      return { ...state, agentStatus: event.status, agentDetail: event.detail, botStatus: event.botStatus ?? state.botStatus };
    case 'participant.joined': {
      const others = state.participants.filter((p) => p.identity !== event.participant.identity);
      return { ...state, participants: [...others, event.participant] };
    }
    case 'participant.left':
      return { ...state, participants: state.participants.filter((p) => p.identity !== event.participant.identity) };
    case 'transcript.partial':
    case 'transcript.final':
      return { ...state, transcript: upsertSegment(state.transcript, event.segment) };
    case 'analysis.started':
      return withInvestigation(state, {
        investigationId: event.investigationId,
        question: event.question,
        status: 'running',
        markdown: '',
        askedBy: event.askedBy,
        startedAt: event.timestamp,
      });
    case 'analysis.delta': {
      const current = state.investigations[event.investigationId];
      if (!current) return state;
      return withInvestigation(state, { ...current, markdown: current.markdown + event.text });
    }
    case 'analysis.completed': {
      const current = state.investigations[event.answer.investigationId];
      return withInvestigation(state, { ...(current ?? answerToView(event.answer)), ...answerToView(event.answer), askedBy: current?.askedBy });
    }
    case 'analysis.failed': {
      const current = state.investigations[event.investigationId];
      if (!current) return state;
      return withInvestigation(state, { ...current, status: 'failed', error: event.error });
    }
    case 'meeting.state.updated':
      return { ...state, meetingState: event.state };
    case 'meeting.briefing.ready':
      return { ...state, briefing: event.briefing, briefingSeen: false };
    case 'meeting.started':
    case 'meeting.ended':
    default:
      return state;
  }
}
