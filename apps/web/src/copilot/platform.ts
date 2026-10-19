import type { MeetingPlatform } from '@copilot/shared';

const LABELS: Record<MeetingPlatform, string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  teams: 'Microsoft Teams',
  unknown: 'External meeting',
};

export function platformLabel(platform?: MeetingPlatform): string {
  return platform ? LABELS[platform] : LABELS.unknown;
}
