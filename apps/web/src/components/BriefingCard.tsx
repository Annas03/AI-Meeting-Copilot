import type { Briefing } from '@copilot/shared';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function BriefingCard({ briefing, onDismiss }: { briefing: Briefing; onDismiss: () => void }) {
  return (
    <article className="briefing">
      <header>
        <strong>Catch-up briefing</strong>
        <button className="link" onClick={onDismiss}>
          dismiss
        </button>
      </header>
      <div className="markdown">
        <Markdown remarkPlugins={[remarkGfm]}>{briefing.markdown}</Markdown>
      </div>
    </article>
  );
}
