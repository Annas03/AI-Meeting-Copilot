import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { navigate } from '../App';

export function HomePage() {
  const [title, setTitle] = useState('Engineering sync');
  const [projectId, setProjectId] = useState('');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [recallAvailable, setRecallAvailable] = useState(false);
  const [joinId, setJoinId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<string>('checking server...');

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setRecallAvailable(h.recall === 'configured');
        setHealth(
          `server ok · qdrant ${h.qdrant} · livekit ${h.livekit} · anthropic ${h.anthropic} · recall ${h.recall} · embeddings ${h.embeddings}`,
        );
      })
      .catch((e: Error) => setHealth(`server unreachable: ${e.message}`));
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const meeting = await api.createMeeting({
        title,
        ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
        ...(meetingUrl.trim() ? { meetingUrl: meetingUrl.trim() } : {}),
      });
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
          Start a meeting with an AI participant that listens for engineering questions and answers them with
          evidence from your indexed codebase{recallAvailable ? ', or attach it to an existing Zoom / Google Meet call' : ''}.
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
          {recallAvailable && (
            <label>
              Zoom / Google Meet link (optional)
              <input value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} placeholder="https://meet.google.com/abc-defg-hij" />
              <span className="small">The copilot bot joins that meeting instead of a LiveKit room; admit it from the lobby.</span>
            </label>
          )}
          <button type="submit" disabled={busy}>
            {busy ? 'Creating...' : meetingUrl.trim() ? 'Create and send the bot' : 'Create meeting'}
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
