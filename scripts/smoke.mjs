#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server (no LiveKit or microphone needed).
 * Creates a meeting, joins in text-only mode, opens the WebSocket, injects transcript lines through
 * the dev endpoint and reports which copilot events arrived.
 *
 *   node scripts/smoke.mjs                # uses http://127.0.0.1:8787 and project "copilot"
 *   SERVER_URL=... PROJECT_ID=... node scripts/smoke.mjs
 */
const base = (process.env.SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const projectId = process.env.PROJECT_ID ?? 'copilot';
const SESSION_HEADER = 'x-session-token';

const LINES = [
  ["Ahsan", "Let's go through the copilot backlog for this sprint."],
  ["Sara", "The indexing pipeline is done and the search CLI returns file references."],
  ["Ahsan", "We decided to run Qdrant as a local binary instead of Docker."],
  ["Priya", "Can we add organization-level permissions to the meeting API?"],
  ["Sara", "Also, who owns the LiveKit cloud setup? Ahsan will add the keys tomorrow."],
];

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

async function json(path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return body;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      return await json('/api/health');
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  fail(`server not reachable at ${base}`);
}

const health = await waitForServer();
log('health:', health);

const meeting = await json('/api/meetings', { method: 'POST', body: JSON.stringify({ title: 'Smoke test', projectId }) });
log('meeting:', meeting.meetingId, meeting.roomName);

const join = await json(`/api/meetings/${meeting.meetingId}/join`, { method: 'POST', body: JSON.stringify({ name: 'Smoke Tester' }) });
log('joined as', join.participant.identity, join.livekitUrl ? '(LiveKit token issued)' : '(text-only mode)');
const session = join.sessionToken;

const wsBase = base.replace(/^http/, 'ws');
const ws = new WebSocket(`${wsBase}/ws?meetingId=${meeting.meetingId}&session=${session}`);
const events = [];
let hello = null;
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.type === 'hello') hello = msg;
  if (msg.type === 'event') events.push(msg.payload);
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', (e) => reject(new Error(`websocket error: ${e.message ?? e}`)));
});
await new Promise((r) => setTimeout(r, 300));
if (!hello) fail('no hello message over the websocket');
log('websocket hello for', hello.participant.identity);

for (const [speaker, text] of LINES) {
  await json(`/api/meetings/${meeting.meetingId}/transcript`.replace('/meetings/', '/dev/meetings/'), {
    method: 'POST',
    headers: { [SESSION_HEADER]: session },
    body: JSON.stringify({ speakerName: speaker, text }),
  });
  await new Promise((r) => setTimeout(r, 150));
}

const deadline = Date.now() + 45_000;
const want = (name) => events.some((e) => e.event === name);
while (Date.now() < deadline) {
  const analysisDone = want('analysis.completed') || want('analysis.failed');
  if (want('analysis.started') && analysisDone && want('meeting.state.updated')) break;
  await new Promise((r) => setTimeout(r, 500));
}

const counts = events.reduce((acc, e) => ((acc[e.event] = (acc[e.event] ?? 0) + 1), acc), {});
log('events received:', counts);

const state = await json(`/api/meetings/${meeting.meetingId}/state`, { headers: { [SESSION_HEADER]: session } });
const transcript = await json(`/api/meetings/${meeting.meetingId}/transcript`, { headers: { [SESSION_HEADER]: session } });
log('transcript segments stored:', transcript.segments.length);
log('state version:', state.state.version, '| investigations:', state.state.investigations.map((i) => `${i.question} -> ${i.assessment ?? i.status}`));

const completed = events.find((e) => e.event === 'analysis.completed');
const failed = events.find((e) => e.event === 'analysis.failed');
if (completed) {
  log('\n--- answer ---');
  log(`assessment: ${completed.answer.assessment} | model: ${completed.answer.model} | first token ${completed.answer.latency.firstTokenMs} ms | total ${completed.answer.latency.totalMs} ms`);
  log(completed.answer.markdown);
  log('evidence:', completed.answer.evidence.map((e) => `${e.cited ? '*' : ' '} ${e.ref} ${e.filePath}:${e.startLine}-${e.endLine}`).join('\n          '));
} else if (failed) {
  log('analysis failed (expected without ANTHROPIC_API_KEY):', failed.error);
}

const briefing = await json(`/api/meetings/${meeting.meetingId}/briefing`, { headers: { [SESSION_HEADER]: session } }).catch((e) => ({ error: e.message }));
log('\nbriefing:', briefing.briefing ? briefing.briefing.markdown : briefing.error);

ws.close();
const ok = transcript.segments.length === LINES.length && want('transcript.final') && want('analysis.started') && want('meeting.state.updated');
if (!ok) fail('expected 5 stored segments plus transcript.final, analysis.started and meeting.state.updated events');
log('\nSMOKE OK');
process.exit(0);
