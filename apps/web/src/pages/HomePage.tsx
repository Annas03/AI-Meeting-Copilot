import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { navigate } from '../App';

export function HomePage() {
  const [title, setTitle] = useState('Engineering sync');
  const [projectId, setProjectId] = useState('');
  const [joinId, setJoinId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<string>('checking server...');

  useEffect(() => {
    api
      .health()
      .then((h) =>
        setHealth(
          `server ok · qdrant ${h.qdrant} · livekit ${h.livekit} · anthropic ${h.anthropic} · embeddings ${h.embeddings}`,
        ),
      )
      .catch((e: Error) => setHealth(`server unreachable: ${e.message}`));
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const meeting = await api.createMeeting({ title, ...(projectId.trim() ? { projectId: projectId.trim() } : {}) });
      navigate(`/m/${meeting.meetingId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onJoin(e: FormEvent) {
    e.preventDefault();
    const id = joinId.trim().replace(/^.*\/m\//, '');
    if (id) navigate(`/m/${id}`);
  }

  return (
    <main className="home">
      <section className="home-card">
        <h1>Meeting Copilot</h1>
        <p className="muted">
          Start a LiveKit meeting with an AI participant that listens for engineering questions and answers them
          with evidence from your indexed codebase.
        </p>

        <form onSubmit={onCreate} className="stack">
          <label>
            Meeting title
            <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
          </label>
          <label>
            Knowledge project (index name, optional)
            <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="default" />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Creating...' : 'Create meeting'}
          </button>
        </form>

        <form onSubmit={onJoin} className="stack">
          <label>
            Join an existing meeting
            <input value={joinId} onChange={(e) => setJoinId(e.target.value)} placeholder="meeting id or link" />
          </label>
          <button type="submit" className="secondary">
            Join
          </button>
        </form>

        {error && <p className="error">{error}</p>}
        <p className="muted small">{health}</p>
      </section>
    </main>
  );
}
