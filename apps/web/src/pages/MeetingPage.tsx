import { LiveKitRoom, PreJoin, RoomAudioRenderer, VideoConference, type LocalUserChoices } from '@livekit/components-react';
import type { JoinMeetingResponse, MeetingSummary } from '@copilot/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { navigate } from '../App';
import { CopilotPanel } from '../components/CopilotPanel';
import { platformLabel } from '../copilot/platform';

interface Props {
  meetingId: string;
}

export function MeetingPage({ meetingId }: Props) {
  const [meeting, setMeeting] = useState<MeetingSummary | null>(null);
  const [livekitAvailable, setLivekitAvailable] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [join, setJoin] = useState<JoinMeetingResponse | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMeeting(meetingId)
      .then(setMeeting)
      .catch((e: Error) => setLoadError(e.message));
    api
      .health()
      .then((h) => setLivekitAvailable(h.livekit === 'configured'))
      .catch(() => setLivekitAvailable(false));
  }, [meetingId]);

  async function doJoin(values: LocalUserChoices) {
    setJoinError(null);
    try {
      const res = await api.joinMeeting(meetingId, { name: values.username });
      setChoices(values);
      setJoin(res);
    } catch (err) {
      setJoinError((err as Error).message);
    }
  }

  if (loadError) {
    return (
      <main className="centered">
        <p className="error">Could not load meeting: {loadError}</p>
        <button onClick={() => navigate('/')}>Back</button>
      </main>
    );
  }

  if (!meeting || livekitAvailable === null) return <main className="centered muted">Loading meeting...</main>;

  // External meetings (a bot inside Zoom / Google Meet) never use LiveKit in the browser: this page is only the companion panel.
  const external = meeting.source === 'recall';

  if (!join || !choices) {
    return (
      <main className="prejoin">
        <header className="prejoin-header">
          <h1>{meeting.title}</h1>
          <p className="muted small">
            project <code>{meeting.projectId}</code> ·{' '}
            {external ? (
              <>
                {platformLabel(meeting.platform)}
                {meeting.meetingUrl && (
                  <>
                    {' '}
                    <a href={meeting.meetingUrl} target="_blank" rel="noreferrer">
                      open meeting
                    </a>
                  </>
                )}
              </>
            ) : (
              <>
                room <code>{meeting.roomName}</code>
              </>
            )}{' '}
            · share link <code>{window.location.href}</code>
          </p>
        </header>
        {livekitAvailable && !external ? (
          <PreJoin
            defaults={{ username: '', audioEnabled: true, videoEnabled: false }}
            onSubmit={doJoin}
            onError={(e) => setJoinError(e.message)}
            joinLabel="Join meeting"
          />
        ) : (
          <TextOnlyJoin onSubmit={doJoin} external={external} platform={platformLabel(meeting.platform)} />
        )}
        {joinError && <p className="error">{joinError}</p>}
        <p className="muted small notice">
          {external
            ? 'The AI copilot joins the call as a visible bot participant that transcribes and analyses the conversation. Let the other participants know.'
            : 'The AI copilot transcribes and analyses this meeting. Participants are informed by this notice.'}
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

  if (external) {
    return (
      <div className="meeting-layout companion">
        <CopilotPanel session={session} meeting={join.meeting} />
      </div>
    );
  }

  if (!join.livekitUrl || !join.livekitToken) {
    return (
      <div className="meeting-layout">
        <div className="meeting-video centered">
          <div className="muted">
            <p>
              <strong>Text-only mode.</strong> LiveKit is not configured on the server, so there is no audio or video.
            </p>
            <p className="small">
              Type questions in the panel, or inject transcript lines with the dev endpoint. Set LIVEKIT_* in .env to
              enable the real meeting.
            </p>
          </div>
        </div>
        <CopilotPanel session={session} meeting={join.meeting} />
      </div>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={join.livekitUrl}
      token={join.livekitToken}
      connect
      audio={choices.audioEnabled}
      video={choices.videoEnabled}
      options={{
        audioCaptureDefaults: choices.audioDeviceId ? { deviceId: choices.audioDeviceId } : undefined,
        videoCaptureDefaults: choices.videoDeviceId ? { deviceId: choices.videoDeviceId } : undefined,
      }}
      onDisconnected={() => {
        setJoin(null);
        setChoices(null);
      }}
      className="meeting-layout"
    >
      <div className="meeting-video">
        <VideoConference />
      </div>
      <CopilotPanel session={session} meeting={join.meeting} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function TextOnlyJoin({
  onSubmit,
  external = false,
  platform,
}: {
  onSubmit: (values: LocalUserChoices) => Promise<void>;
  external?: boolean;
  platform?: string;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSubmit({ username: name.trim(), audioEnabled: false, videoEnabled: false, audioDeviceId: '', videoDeviceId: '' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack home-card">
      <p className="muted small">
        {external
          ? `This is the companion panel for a ${platform ?? 'external'} meeting: keep it open next to the call to follow the transcript and answers.`
          : 'LiveKit is not configured on the server, so this meeting runs in text-only mode.'}
      </p>
      <label>
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
      </label>
      <button type="submit" disabled={busy || !name.trim()}>
        {busy ? 'Joining...' : external ? 'Open companion panel' : 'Join (text only)'}
      </button>
    </form>
  );
}
