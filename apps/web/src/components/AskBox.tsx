import { useState, type FormEvent } from 'react';

interface Props {
  onAsk: (question: string) => Promise<void>;
}

export function AskBox({ onAsk }: Props) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await onAsk(q);
      setQuestion('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ask-box" onSubmit={submit}>
      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask the copilot about the codebase..."
        maxLength={2000}
        disabled={busy}
      />
      <button type="submit" disabled={busy || question.trim().length < 3}>
        {busy ? '...' : 'Ask'}
      </button>
      {error && <span className="error small">{error}</span>}
    </form>
  );
}
