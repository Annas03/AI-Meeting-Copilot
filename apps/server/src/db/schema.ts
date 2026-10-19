import type { Answer, BotStatus, MeetingPlatform, MeetingSource, MeetingState } from '@copilot/shared';
import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const meetings = pgTable('meetings', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  projectId: text('project_id').notNull(),
  roomName: text('room_name').notNull().unique(),
  status: text('status').$type<'scheduled' | 'live' | 'ended'>().notNull().default('live'),
  createdAt: ts('created_at').notNull().defaultNow(),
  endedAt: ts('ended_at'),
  /** 'livekit' for our own rooms; 'recall' when a meeting bot sits in an external Zoom / Google Meet call. */
  source: text('source').$type<MeetingSource>().notNull().default('livekit'),
  platform: text('platform').$type<MeetingPlatform>(),
  meetingUrl: text('meeting_url'),
  botId: text('bot_id'),
  botStatus: text('bot_status').$type<BotStatus>(),
  botUpdatedAt: ts('bot_updated_at'),
});

export const participants = pgTable('participants', {
  identity: text('identity').primaryKey(),
  meetingId: text('meeting_id')
    .notNull()
    .references(() => meetings.id),
  name: text('name').notNull(),
  isAgent: boolean('is_agent').notNull().default(false),
  sessionToken: text('session_token').unique(),
  joinedAt: ts('joined_at').notNull().defaultNow(),
  leftAt: ts('left_at'),
});

export const transcriptSegments = pgTable('transcript_segments', {
  segmentId: text('segment_id').primaryKey(),
  meetingId: text('meeting_id')
    .notNull()
    .references(() => meetings.id),
  speakerId: text('speaker_id').notNull(),
  speakerName: text('speaker_name'),
  sequence: integer('sequence').notNull(),
  text: text('text').notNull(),
  language: text('language'),
  startedAt: ts('started_at'),
  endedAt: ts('ended_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const investigations = pgTable('investigations', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id')
    .notNull()
    .references(() => meetings.id),
  question: text('question').notNull(),
  status: text('status').$type<'queued' | 'running' | 'completed' | 'failed'>().notNull(),
  triggerSegmentId: text('trigger_segment_id'),
  askedBy: text('asked_by'),
  answer: jsonb('answer').$type<Answer>(),
  error: text('error'),
  startedAt: ts('started_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
});

export const meetingStates = pgTable('meeting_states', {
  meetingId: text('meeting_id')
    .primaryKey()
    .references(() => meetings.id),
  version: integer('version').notNull(),
  state: jsonb('state').$type<MeetingState>().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const briefings = pgTable(
  'briefings',
  {
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id),
    stateVersion: integer('state_version').notNull(),
    markdown: text('markdown').notNull(),
    generatedAt: ts('generated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.stateVersion] })],
);

export const schema = { meetings, participants, transcriptSegments, investigations, meetingStates, briefings };

/** Hand-maintained DDL mirroring the tables above; executed at boot (idempotent). */
export const DDL = `
CREATE TABLE IF NOT EXISTS meetings (
  id text PRIMARY KEY,
  title text NOT NULL,
  project_id text NOT NULL,
  room_name text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'live',
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  source text NOT NULL DEFAULT 'livekit',
  platform text,
  meeting_url text,
  bot_id text,
  bot_status text,
  bot_updated_at timestamptz
);
CREATE TABLE IF NOT EXISTS participants (
  identity text PRIMARY KEY,
  meeting_id text NOT NULL REFERENCES meetings(id),
  name text NOT NULL,
  is_agent boolean NOT NULL DEFAULT false,
  session_token text UNIQUE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz
);
CREATE INDEX IF NOT EXISTS participants_meeting_idx ON participants(meeting_id);
CREATE TABLE IF NOT EXISTS transcript_segments (
  segment_id text PRIMARY KEY,
  meeting_id text NOT NULL REFERENCES meetings(id),
  speaker_id text NOT NULL,
  speaker_name text,
  sequence integer NOT NULL,
  text text NOT NULL,
  language text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, sequence)
);
CREATE TABLE IF NOT EXISTS investigations (
  id text PRIMARY KEY,
  meeting_id text NOT NULL REFERENCES meetings(id),
  question text NOT NULL,
  status text NOT NULL,
  trigger_segment_id text,
  asked_by text,
  answer jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS investigations_meeting_idx ON investigations(meeting_id);
CREATE TABLE IF NOT EXISTS meeting_states (
  meeting_id text PRIMARY KEY REFERENCES meetings(id),
  version integer NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS briefings (
  meeting_id text NOT NULL REFERENCES meetings(id),
  state_version integer NOT NULL,
  markdown text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, state_version)
);
-- Columns added after the first release; keeps existing data directories working without migrations.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'livekit';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_url text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS bot_id text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS bot_status text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS bot_updated_at timestamptz;
CREATE INDEX IF NOT EXISTS meetings_bot_id_idx ON meetings(bot_id);
`;
