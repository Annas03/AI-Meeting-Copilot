import type { Assessment, EvidenceRef } from '@copilot/shared';
import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { InvestigationView } from '../copilot/state';

const ASSESSMENT_LABEL: Record<Assessment, string> = {
  likely_feasible: 'Likely feasible',
  uncertain: 'Uncertain',
  unsupported: 'Unsupported by current evidence',
  not_applicable: 'Not a codebase question',
};

export function InvestigationCard({ view }: { view: InvestigationView }) {
  const assessment = view.answer?.assessment;
  return (
    <article className={`investigation status-${view.status}`}>
      <header>
        <div className="question">{view.question}</div>
        <div className="meta small muted">
          {view.askedBy ? `${view.askedBy} · ` : ''}
          {view.status === 'running' && <span className="pulse">analysing…</span>}
          {view.status === 'failed' && <span className="error">failed</span>}
          {view.status === 'completed' && assessment && (
            <span className={`pill pill-${assessment}`}>{ASSESSMENT_LABEL[assessment]}</span>
          )}
          {view.answer?.insufficientEvidence && <span className="pill pill-uncertain">preliminary</span>}
        </div>
      </header>

      {view.error && <p className="error small">{view.error}</p>}

      {view.markdown && (
        <div className="markdown">
          <Markdown remarkPlugins={[remarkGfm]}>{view.markdown}</Markdown>
        </div>
      )}

      {view.answer && view.answer.evidence.length > 0 && <EvidenceList evidence={view.answer.evidence} />}

      {view.answer && (
        <footer className="small muted">
          {view.answer.model}
          {view.answer.latency.totalMs !== undefined ? ` · ${(view.answer.latency.totalMs / 1000).toFixed(1)}s` : ''}
          {view.answer.latency.firstTokenMs !== undefined ? ` · first token ${(view.answer.latency.firstTokenMs / 1000).toFixed(1)}s` : ''}
        </footer>
      )}
    </article>
  );
}

function EvidenceList({ evidence }: { evidence: EvidenceRef[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const cited = evidence.filter((e) => e.cited);
  const rest = evidence.filter((e) => !e.cited);
  const ordered = [...cited, ...rest];
  return (
    <div className="evidence">
      <div className="small muted">Evidence</div>
      <ul>
        {ordered.map((e) => (
          <li key={e.ref} className={e.cited ? 'cited' : 'uncited'}>
            <button className="link" onClick={() => setOpen(open === e.ref ? null : e.ref)} title={e.excerpt}>
              <span className="ref">{e.ref}</span> {e.filePath}:{e.startLine}-{e.endLine}
              {e.symbol ? <span className="muted"> · {e.symbol}</span> : null}
            </button>
            {open === e.ref && e.excerpt && <pre className="excerpt">{e.excerpt}</pre>}
          </li>
        ))}
      </ul>
    </div>
  );
}
