import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createMockHubSpot } from '../src/mock-hubspot.js';
import { createStore } from '../src/store.js';
import { ProviderError } from '../src/providers.js';
import { call, notes } from './helpers.js';

async function fixture(t, overrides = {}, configOverrides = {}) {
  const store = createStore(':memory:');
  store.put(call());
  const writes = { notes: 0, updates: 0 };
  const providers = {
    extract: async () => notes(), getContact: async id => ({ id }),
    findContact: async () => ({ id: '5', properties: { email: 'maya@example.com' } }),
    createNote: async () => { writes.notes++; return '77'; },
    updateContact: async () => { writes.updates++; },
    transcribe: async () => 'Hello world', ...overrides,
  };
  const config = { port: 0, openaiKey: 'test-secret', hubspotToken: 'test-token', model: 'test-model', ...configOverrides };
  if (config.hubspotMode === 'mock') Object.assign(providers, createMockHubSpot(store));
  const server = createApp({ store, providers, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  const base = `http://127.0.0.1:${config.port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const request = async (route, method = 'GET', body, headers = {}) => {
    const result = await fetch(`${base}${route}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: result.status, data: await result.json() };
  };
  return { store, writes, request, base };
}
const approval = { revision: 1, approved: true, contact_id: '5', fields: ['company'] };

test('creates, extracts, edits and lists a call while checking revisions', async t => {
  const { request } = await fixture(t);
  const created = await request('/api/calls', 'POST', { title: 'New call', source: 'Attention', transcript: 'Maya: I work at Northstar.' });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal((await request(`/api/calls/${id}/extract`, 'POST', { revision: 1 })).status, 200);
  assert.equal((await request(`/api/calls/${id}`, 'PATCH', { revision: 1, extraction: notes() })).status, 409);
  const edited = await request(`/api/calls/${id}`, 'PATCH', { revision: 2, extraction: notes({ summary: 'Updated notes' }) });
  assert.equal(edited.status, 200); assert.equal(edited.data.revision, 3);
  const list = await request('/api/calls');
  assert.equal(list.data.find(item => item.id === id).summary, 'Updated notes');
  assert.equal((await request(`/api/calls/${id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/calls/${id}`)).status, 404);
});
test('repeated approved sync creates one note and updates only selected fields', async t => {
  const { request, writes } = await fixture(t);
  const first = await request('/api/calls/test-call/sync', 'POST', approval);
  assert.equal(first.status, 200); assert.equal(first.data.sync.state, 'synced');
  assert.equal((await request('/api/calls/test-call/sync', 'POST', approval)).status, 200);
  assert.deepEqual(writes, { notes: 1, updates: 1 });
  assert.equal((await request('/api/calls/test-call', 'PATCH', { revision: 1, extraction: notes() })).status, 409);
});
test('sync without approval, invalid property or stale revision never writes', async t => {
  const { request, writes } = await fixture(t);
  for (const [body, status] of [
    [{ ...approval, approved: false }, 400], [{ ...approval, fields: ['email'] }, 400],
    [{ ...approval, revision: 0 }, 409], [{ ...approval, contact_id: '../x' }, 400],
  ]) assert.equal((await request('/api/calls/test-call/sync', 'POST', body)).status, status);
  assert.deepEqual(writes, { notes: 0, updates: 0 });
});
test('saving a note without selected properties does not update the contact', async t => {
  const { request, writes } = await fixture(t);
  assert.equal((await request('/api/calls/test-call/sync', 'POST', { ...approval, fields: [] })).status, 200);
  assert.deepEqual(writes, { notes: 1, updates: 0 });
});
test('partial failure retries approved properties without recreating the note', async t => {
  let attempts = 0;
  const { request, store, writes } = await fixture(t, { updateContact: async (id, properties) => {
    attempts++; assert.equal(id, '5'); assert.deepEqual(properties, { company: 'Northstar' });
    if (attempts === 1) throw new ProviderError(502, 'HubSpot unavailable', { ambiguous: true });
  } });
  assert.equal((await request('/api/calls/test-call/sync', 'POST', approval)).status, 502);
  assert.equal(store.get('test-call').sync.state, 'partial');
  assert.equal((await request('/api/calls/test-call/sync', 'POST', { revision: 1, fields: [], contact_id: '999' })).status, 200);
  assert.equal(writes.notes, 1); assert.equal(attempts, 2);
});
test('ambiguous note writes block retries until manual reconciliation', async t => {
  let attempts = 0;
  const { request, store } = await fixture(t, { createNote: async () => { attempts++; throw new ProviderError(502, 'Connection lost', { ambiguous: true }); } });
  assert.equal((await request('/api/calls/test-call/sync', 'POST', approval)).status, 502);
  assert.equal(store.get('test-call').sync.state, 'uncertain');
  assert.equal((await request('/api/calls/test-call/sync', 'POST', approval)).status, 409);
  assert.equal((await request('/api/calls/test-call', 'DELETE')).status, 409);
  assert.equal((await request('/api/calls/test-call/reconcile', 'POST', { revision: 1, confirmed_absent: false })).status, 400);
  assert.equal((await request('/api/calls/test-call/reconcile', 'POST', { revision: 1, confirmed_absent: true })).status, 200);
  assert.equal(store.get('test-call').sync.state, 'idle'); assert.equal(attempts, 1);
});
test('concurrent syncs never create duplicates', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const { request } = await fixture(t, { createNote: async () => { await wait; return '77'; } });
  const first = request('/api/calls/test-call/sync', 'POST', approval);
  // Wait for the request to acquire the lock, without a timing-dependent sleep.
  let second;
  for (let i = 0; i < 20; i++) {
    second = await request('/api/calls/test-call/sync', 'POST', { ...approval, approved: false });
    if (second.status === 409) break;
  }
  release();
  assert.equal(second.status, 409); assert.equal((await first).status, 200);
});
test('blocks foreign hosts, origins, cross-site requests and secret paths', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/api/config', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/config`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await request('/api/config', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const route of ['/.env.local', '/data/callbridge.sqlite', '/src/server.js']) assert.equal((await request(route)).status, 404);
  const result = await request('/api/config');
  assert.doesNotMatch(JSON.stringify(result.data), /test-secret|test-token/);
  const html = await fetch(base); assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('validates malformed bodies and call limits', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/api/calls', 'POST', { title: '', source: 'x', transcript: 'x' })).status, 400);
  assert.equal((await request('/api/calls', 'POST', { title: 'x', source: 'x', transcript: 'x'.repeat(180001) })).status, 400);
  const bad = await fetch(`${base}/api/calls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  const wrongType = await fetch(`${base}/api/calls`, { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
});
test('transcribes supported uploads and rejects empty or unsupported files', async t => {
  const { base } = await fixture(t);
  const upload = (name, body) => fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'X-File-Name': name, 'Content-Type': 'audio/wav' }, body });
  assert.equal((await upload('recording.wav', 'audio')).status, 200);
  assert.equal((await upload('recording.exe', 'audio')).status, 400);
  assert.equal((await upload('recording.wav', '')).status, 400);
});

test('a definite note rejection is retryable without claiming success', async t => {
  let attempts = 0;
  const { request, store } = await fixture(t, { createNote: async () => {
    if (++attempts === 1) throw new ProviderError(502, 'HubSpot: permission denied');
    return '77';
  } });
  assert.equal((await request('/api/calls/test-call/sync', 'POST', approval)).status, 502);
  assert.equal(store.get('test-call').sync.state, 'idle');
  assert.equal((await request('/api/calls/test-call/sync', 'POST', approval)).status, 200);
  assert.equal(attempts, 2);
});
test('unexpected write failures conservatively block automatic retries', async t => {
  const { request, store } = await fixture(t, { createNote: async () => { throw new Error('unexpected'); } });
  assert.equal((await request('/api/calls/test-call/sync', 'POST', approval)).status, 500);
  assert.equal(store.get('test-call').sync.state, 'uncertain');
});

test('mock HubSpot exercises the full sync and exposes the resulting contact and note', async t => {
  const { request, writes } = await fixture(t, {}, { hubspotMode: 'mock', hubspotToken: undefined });
  const config = await request('/api/config');
  assert.equal(config.data.hubspot, true); assert.equal(config.data.hubspotMode, 'mock');
  const before = await request('/api/mock-hubspot');
  assert.equal(before.data.contacts[0].properties.company, 'Northstar');
  assert.equal(before.data.notes.length, 0);
  const found = await request('/api/hubspot/contact', 'POST', { email: 'maya.chen@example.com' });
  assert.equal(found.data.id, '1001');
  const result = await request('/api/calls/test-call/sync', 'POST', { ...approval, contact_id: '1001' });
  assert.equal(result.status, 200); assert.equal(result.data.sync.destination, 'mock');
  const after = await request('/api/mock-hubspot');
  assert.equal(after.data.contacts[0].properties.company, 'Northstar');
  assert.equal(after.data.notes[0].contact_id, '1001');
  assert.match(after.data.notes[0].body, /Send proposal/);
  assert.deepEqual(writes, { notes: 0, updates: 0 });
  await request('/api/calls/test-call/sync', 'POST', { ...approval, contact_id: '1001' });
  assert.equal((await request('/api/mock-hubspot')).data.notes.length, 1);
});
test('mock notes cannot be retried against the live destination', async t => {
  const { request, store, writes } = await fixture(t);
  store.put(call({ sync: { state: 'partial', destination: 'mock', contact_id: '1001', note_id: '1', properties: { company: 'Northstar' } } }));
  assert.equal((await request('/api/calls/test-call/sync', 'POST', approval)).status, 409);
  assert.deepEqual(writes, { notes: 0, updates: 0 });
});
test('live mode hides the mock CRM endpoint', async t => {
  const { request } = await fixture(t, {}, { hubspotMode: 'live' });
  assert.equal((await request('/api/mock-hubspot')).status, 404);
});

test('streaming sends a preview before completion, locks the call, and saves only final notes', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const full = JSON.stringify(notes());
  const { base, store, request } = await fixture(t, { extract: async (transcript, { onDelta }) => {
    await onDelta(full.slice(0, 24));
    await gate;
    await onDelta(full.slice(24));
    return notes();
  } });
  store.put(call({ extraction: null }));
  const response = await fetch(`${base}/api/calls/test-call/extract`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ revision: 1 }),
  });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const { readEventStream } = await import('../public/stream.js');
  const reader = readEventStream(response.body);
  assert.equal((await reader.next()).value.type, 'status');
  const preview = (await reader.next()).value;
  assert.equal(preview.type, 'preview'); assert.ok(preview.preview.summary.length > 0);
  assert.equal(store.get('test-call').extraction, null);
  assert.equal((await request('/api/calls/test-call/sync', 'POST', approval)).status, 409);
  release();
  const remaining = [];
  for await (const event of reader) remaining.push(event);
  const complete = remaining.find(event => event.type === 'complete');
  assert.deepEqual(complete.call.extraction, notes()); assert.equal(complete.call.revision, 2);
  assert.deepEqual(store.get('test-call').extraction, notes());
});
test('failed streams keep the saved transcript without persisting a partial preview', async t => {
  const { base, store } = await fixture(t, { extract: async (transcript, { onDelta }) => {
    await onDelta('{"summary":"partial'); throw new Error('private upstream details');
  } });
  store.put(call({ extraction: null }));
  const response = await fetch(`${base}/api/calls/test-call/extract`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ revision: 1 }),
  });
  const { readEventStream } = await import('../public/stream.js');
  const events = [];
  for await (const event of readEventStream(response.body)) events.push(event);
  assert.equal(events.at(-1).type, 'error');
  assert.doesNotMatch(events.at(-1).message, /private upstream/);
  assert.equal(store.get('test-call').extraction, null);
  assert.equal(store.get('test-call').revision, 1);
});
test('stopping a stream aborts the provider and does not save its unfinished output', { timeout: 5000 }, async t => {
  let observedAbort;
  const aborted = new Promise(resolve => { observedAbort = resolve; });
  const { base, store } = await fixture(t, { extract: async (transcript, { signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', () => { observedAbort(); resolve(); }, { once: true }));
    return notes();
  } });
  store.put(call({ extraction: null }));
  const controller = new AbortController();
  const response = await fetch(`${base}/api/calls/test-call/extract`, {
    method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ revision: 1 }),
  });
  controller.abort();
  await aborted;
  assert.equal(store.get('test-call').extraction, null);
  assert.equal(store.get('test-call').revision, 1);
});
