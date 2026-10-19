import type { JoinMeetingResponse, MeetingSummary } from '@copilot/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { navigate } from '../App';
import { CopilotPanel } from '../components/CopilotPanel';
import { platformLabel } from '../copilot/platform';

interface Props {
  meetingId: string;
}

/** The call itself runs in Zoom / Google Meet; this page is the companion panel people keep open next to it. */
export function MeetingPage({ meetingId }: Props) {
  const [meeting, setMeeting] = useState<MeetingSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [join, setJoin] = useState<JoinMeetingResponse | null>(null);

  useEffect(() => {
    api
      .getMeeting(meetingId)
      .then(setMeeting)
      .catch((e: Error) => setLoadError(e.message));
  }, [meetingId]);

  if (loadError) {
    return (
      <main className="centered">
        <p className="error">Could not load meeting: {loadError}</p>
        <button onClick={() => navigate('/')}>Back</button>
      </main>
    );
  }

  if (!meeting) return <main className="centered muted">Loading meeting...</main>;

  if (!join) {
    return (
      <main className="prejoin">
        <header className="prejoin-header">
          <h1>{meeting.title}</h1>
          <p className="muted small">
            project <code>{meeting.projectId}</code> · {platformLabel(meeting.platform)}
            {meeting.meetingUrl && (
              <>
                {' '}
                <a href={meeting.meetingUrl} target="_blank" rel="noreferrer">
                  open meeting
                </a>
              </>
            )}{' '}
            · share link <code>{window.location.href}</code>
          </p>
        </header>
        <JoinForm meetingId={meetingId} platform={platformLabel(meeting.platform)} onJoined={setJoin} />
        <p className="muted small notice">
          The AI copilot joins the call as a visible bot participant that transcribes and analyses the conversation. Let
          the other participants know.
        </p>
      </main>
    );
  }

  const session = {
    meetingId,
    sessionToken: join.sessionToken,
    participantIdentity: join.participant.identity,
    participantName: join.participant.name,
  };

  return (
    <div className="meeting-layout">
      <CopilotPanel session={session} meeting={join.meeting} />
    </div>
  );
}

function JoinForm({ meetingId, platform, onJoined }: { meetingId: string; platform: string; onJoined: (join: JoinMeetingResponse) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onJoined(await api.joinMeeting(meetingId, { name: name.trim() }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack home-card">
      <p className="muted small">
        This is the companion panel for a {platform} meeting: keep it open next to the call to follow the transcript and
        answers.
      </p>
      <label>
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
      </label>
      <button type="submit" disabled={busy || !name.trim()}>
        {busy ? 'Opening...' : 'Open companion panel'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
