import type { Briefing, MeetingState } from '@copilot/shared';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MemoryView({ state, briefing }: { state?: MeetingState; briefing?: Briefing }) {
  if (!state) {
    return <p className="muted small">Meeting memory appears after the first few transcript lines.</p>;
  }
  return (
    <div className="memory">
      <section>
        <h4>Current topic</h4>
        <p>{state.currentTopic || <span className="muted">not yet identified</span>}</p>
      </section>
      <section>
        <h4>Summary</h4>
        <p>{state.rollingSummary || <span className="muted">—</span>}</p>
      </section>
      <section>
        <h4>Decisions</h4>
        <List items={state.decisions.map((d) => `${d.status === 'confirmed' ? '✅' : '🟡'} ${d.text}`)} empty="No decisions yet" />
      </section>
      <section>
        <h4>Open questions</h4>
        <List items={state.openQuestions.map((q) => q.text)} empty="None" />
      </section>
      <section>
        <h4>Action items</h4>
        <List
          items={state.actionItems.map((a) => `${a.status === 'done' ? '☑' : '☐'} ${a.text}${a.owner ? ` (${a.owner})` : ''}`)}
          empty="None"
        />
      </section>
      <section>
        <h4>Investigations</h4>
        <List items={state.investigations.map((i) => `${i.question} — ${i.assessment ?? i.status}`)} empty="None" />
      </section>
      <section>
        <h4>Evidence surfaced</h4>
        <List items={state.evidence.map((e) => `${e.filePath}: ${e.note}`)} empty="None" />
      </section>
      {briefing && (
        <section>
          <h4>Latest briefing (state v{briefing.stateVersion})</h4>
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{briefing.markdown}</Markdown>
          </div>
        </section>
      )}
      <p className="muted small">state v{state.version} · updated {new Date(state.updatedAt).toLocaleTimeString()}</p>
    </div>
  );
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
