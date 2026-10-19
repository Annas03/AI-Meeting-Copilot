import type { BotStatus, MeetingSummary } from '@copilot/shared';
import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../App';
import { platformLabel } from '../copilot/platform';
import type { CopilotSession } from '../copilot/useCopilot';

interface Props {
  meeting: MeetingSummary;
  session: CopilotSession;
  botStatus?: BotStatus;
  /** Latest hint from the server's agent.status event, when one has arrived. */
  detail?: string;
}

const MESSAGES: Record<BotStatus, string> = {
  created: 'Sending the copilot bot to the meeting…',
  joining: 'The copilot bot is joining the meeting…',
  waiting_room: 'Admit the copilot bot from the meeting lobby to start transcription',
  in_call: 'The copilot bot is in the meeting, waiting for recording to start…',
  recording: 'Listening to the meeting',
  ended: 'The copilot bot has left this meeting',
  failed: 'The copilot bot could not join the meeting',
};

/** Shown above the tabs for external meetings: where the bot is in its lifecycle, and a way to pull it out. */
export function BotStatusBar({ meeting, session, botStatus, detail }: Props) {
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = botStatus ?? 'created';
  const finished = ended || status === 'ended' || status === 'failed';
  const tone = status === 'waiting_room' ? 'waiting' : status === 'failed' ? 'failed' : status === 'recording' ? 'live' : '';
  const message = detail ?? MESSAGES[status];

  async function end() {
    setBusy(true);
    setError(null);
    try {
      await api.endMeeting(meeting.meetingId, session.sessionToken);
      setEnded(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`bot-bar ${tone}`}>
      <div className="bot-bar-text">
        <div>
          <strong>{platformLabel(meeting.platform)}</strong>
          {meeting.meetingUrl && (
            <>
              {' · '}
              <a href={meeting.meetingUrl} target="_blank" rel="noreferrer">
                open meeting
              </a>
            </>
          )}
        </div>
        <div className={status === 'failed' ? 'error' : 'muted'}>{message}</div>
        {error && <div className="error">{error}</div>}
      </div>
      {finished ? (
        <button className="secondary" onClick={() => navigate('/')}>
          Back to home
        </button>
      ) : (
        <button className="secondary" onClick={end} disabled={busy}>
          {busy ? 'Ending…' : 'End & remove bot'}
        </button>
      )}
    </div>
  );
}
