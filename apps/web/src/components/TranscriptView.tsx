import type { TranscriptSegment } from '@copilot/shared';
import { useEffect, useRef } from 'react';

export function TranscriptView({ segments }: { segments: TranscriptSegment[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [segments.length, segments[segments.length - 1]?.text]);

  if (segments.length === 0) {
    return <p className="muted small">Nothing transcribed yet. Unmute and start talking.</p>;
  }

  return (
    <ol className="transcript">
      {segments.map((s) => (
        <li key={s.segmentId} className={s.final ? 'final' : 'partial'}>
          <span className="speaker">{s.speakerName ?? s.speakerId}</span>
          <span className="text">{s.text}</span>
        </li>
      ))}
      <div ref={endRef} />
    </ol>
  );
}
