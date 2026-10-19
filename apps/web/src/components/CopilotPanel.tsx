import type { MeetingSummary } from '@copilot/shared';
import { useState } from 'react';
import { useCopilot, type CopilotSession } from '../copilot/useCopilot';
import { AskBox } from './AskBox';
import { BotStatusBar } from './BotStatusBar';
import { BriefingCard } from './BriefingCard';
import { InvestigationCard } from './InvestigationCard';
import { MemoryView } from './MemoryView';
import { TranscriptView } from './TranscriptView';

type Tab = 'copilot' | 'transcript' | 'memory';

interface Props {
  session: CopilotSession;
  meeting: MeetingSummary;
}

export function CopilotPanel({ session, meeting }: Props) {
  const { state, ask, markBriefingSeen } = useCopilot(session);
  const [tab, setTab] = useState<Tab>('copilot');

  const running = state.investigationOrder.filter((id) => state.investigations[id]?.status === 'running').length;

  return (
    <aside className="copilot-panel">
      <header className="panel-header">
        <div>
          <strong>Copilot</strong>
          <span className="muted small"> · {meeting.projectId}</span>
        </div>
        <div className="status-row">
          <StatusDot label={`agent ${state.agentStatus}`} tone={agentTone(state.agentStatus)} title={state.agentDetail} />
          <StatusDot label={`events ${state.socket}`} tone={state.socket === 'open' ? 'ok' : 'warn'} />
        </div>
      </header>

      <BotStatusBar meeting={meeting} session={session} botStatus={state.botStatus ?? meeting.botStatus} detail={state.agentDetail} />

      <nav className="tabs">
        <button className={tab === 'copilot' ? 'active' : ''} onClick={() => setTab('copilot')}>
          Answers{running ? ` (${running} running)` : ''}
        </button>
        <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>
          Transcript
        </button>
        <button className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>
          Memory
        </button>
      </nav>

      <div className="panel-body">
        {tab === 'copilot' && (
          <>
            {state.briefing && !state.briefingSeen && <BriefingCard briefing={state.briefing} onDismiss={markBriefingSeen} />}
            {state.investigationOrder.length === 0 && (
              <p className="muted small">
                Ask a question out loud, for example “Can we add organisation-level permissions?”, or type one below.
              </p>
            )}
            {state.investigationOrder.map((id) => {
              const view = state.investigations[id];
              return view ? <InvestigationCard key={id} view={view} /> : null;
            })}
          </>
        )}
        {tab === 'transcript' && <TranscriptView segments={state.transcript} />}
        {tab === 'memory' && <MemoryView state={state.meetingState} briefing={state.briefing} />}
      </div>

      {tab === 'copilot' && <AskBox onAsk={ask} />}
    </aside>
  );
}

function agentTone(status: string): 'ok' | 'warn' | 'bad' | 'idle' {
  if (status === 'listening') return 'ok';
  if (status === 'connecting') return 'warn';
  if (status === 'error' || status === 'disconnected') return 'bad';
  return 'idle';
}

function StatusDot({ label, tone, title }: { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle'; title?: string }) {
  return (
    <span className={`status-dot tone-${tone}`} title={title}>
      {label}
    </span>
  );
}
