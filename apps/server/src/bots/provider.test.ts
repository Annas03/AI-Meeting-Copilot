import { describe, expect, it } from 'vitest';
import { platformFromUrl } from './provider.js';

describe('platformFromUrl', () => {
  it.each([
    ['https://zoom.us/j/123456789', 'zoom'],
    ['https://us02web.zoom.us/j/123456789?pwd=abc', 'zoom'],
    ['https://meet.google.com/abc-defg-hij', 'google_meet'],
    ['https://teams.microsoft.com/l/meetup-join/19%3ameeting', 'teams'],
    ['https://example.com/meet/abc', 'unknown'],
    ['not a url', 'unknown'],
  ])('%s -> %s', (url, platform) => {
    expect(platformFromUrl(url)).toBe(platform);
  });
});
