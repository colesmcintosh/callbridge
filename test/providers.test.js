import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, ProviderError } from '../src/providers.js';
import { notes, call } from './helpers.js';
const config = { openaiKey: 'test-secret', hubspotToken: 'test-hubspot', model: 'test-model', transcriptionModel: 'test-transcribe' };
const response = body => new Response(JSON.stringify(body), { status: 200 });

test('OpenAI uses strict schema, server credentials, and disables response storage', async () => {
  let request;
  const providers = createProviders(config, async (url, options) => {
    request = { url, ...options };
    return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(notes()) }] }] });
  });
  const result = await providers.extract(call().transcript);
  assert.equal(result.fields[2].evidence, 'I work at Northstar.');
  const body = JSON.parse(request.body);
  assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
  assert.equal(body.input, call().transcript);
  assert.equal(request.headers.Authorization, 'Bearer test-secret');
});
test('refusals, incomplete responses and invalid outputs are explicit failures', async () => {
  for (const body of [
    { status: 'incomplete' },
    { status: 'completed', output: [{ content: [{ type: 'refusal' }] }] },
    { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{}' }] }] },
  ]) {
    await assert.rejects(createProviders(config, async () => response(body)).extract('text'));
  }
});
test('provider errors never forward sensitive upstream error bodies', async () => {
  const providers = createProviders(config, async () => new Response('test-secret private transcript', { status: 401 }));
  await assert.rejects(providers.extract('private transcript'), error => {
    assert.doesNotMatch(error.message, /test-secret|private transcript/);
    assert.match(error.message, /API key/); return true;
  });
});
test('network and 5xx failures are marked ambiguous; 4xx rejections are not', async () => {
  for (const [fetcher, ambiguous] of [
    [async () => { throw new Error('connection lost'); }, true],
    [async () => new Response('{}', { status: 503 }), true],
    [async () => new Response('{}', { status: 429 }), false],
  ]) {
    await assert.rejects(createProviders(config, fetcher).createNote(call(), '5'), error => error instanceof ProviderError && error.ambiguous === ambiguous);
  }
});
test('HubSpot requires a unique exact-email result', async () => {
  for (const total of [0, 2]) {
    const provider = createProviders(config, async () => response({ total, results: [] }));
    await assert.rejects(provider.findContact('maya@example.com'), /unique/);
  }
  const provider = createProviders(config, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.filterGroups[0].filters[0].operator, 'EQ');
    return response({ total: 1, results: [{ id: '5', properties: { email: 'maya@example.com' } }] });
  });
  assert.equal((await provider.findContact('maya@example.com')).id, '5');
});
test('note is associated with selected contact and HTML is escaped', async () => {
  const provider = createProviders(config, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.match(url, /\/notes$/);
    assert.equal(body.associations[0].to.id, '5');
    assert.equal(body.associations[0].types[0].associationTypeId, 202);
    assert.match(body.properties.hs_note_body, /&lt;script&gt;/);
    assert.doesNotMatch(body.properties.hs_note_body, /<script>/);
    return response({ id: '77' });
  });
  assert.equal(await provider.createNote(call({ title: '<script>' }), '5'), '77');
});
test('transcription uses multipart upload and keeps API token server-side', async () => {
  const provider = createProviders(config, async (url, options) => {
    assert.match(url, /audio\/transcriptions$/);
    assert.equal(options.body.get('model'), 'test-transcribe');
    assert.equal(options.body.get('file').name, 'recording.wav');
    return response({ text: 'Hello world' });
  });
  assert.equal(await provider.transcribe(Buffer.from('audio'), 'recording.wav', 'audio/wav'), 'Hello world');
});
test('missing credentials fail before any external request', async () => {
  const provider = createProviders({}, () => { assert.fail('must not fetch'); });
  await assert.rejects(provider.extract('text'), /OPENAI_API_KEY/);
  await assert.rejects(provider.findContact('maya@example.com'), /HUBSPOT_ACCESS_TOKEN/);
});

test('oversized escaped notes are rejected before writing to HubSpot', async () => {
  const large = notes({ summary: '&'.repeat(6000) });
  large.fields.forEach(field => { field.value = '&'.repeat(1500); });
  const provider = createProviders(config, () => { assert.fail('must not fetch'); });
  await assert.rejects(provider.createNote(call({ extraction: large }), '5'), /too long/);
});

test('GPT-6 Luna extraction uses the requested model and no reasoning delay', async () => {
  const provider = createProviders({ ...config, model: 'gpt-6-luna' }, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(body.text.format.strict, true);
    return response({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(notes()) }] }] });
  });
  await provider.extract(call().transcript);
});

test('OpenAI streams actual deltas before the complete validated result', async () => {
  const output = JSON.stringify(notes());
  const deltas = [output.slice(0, 24), output.slice(24)];
  const events = [
    ...deltas.map(delta => ({ type: 'response.output_text.delta', delta })),
    { type: 'response.completed', response: { status: 'completed', output: [{ content: [{ type: 'output_text', text: output }] }] } },
  ];
  const provider = createProviders(config, async (url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const received = [];
  const result = await provider.extract(call().transcript, { onDelta: delta => { received.push(delta); } });
  assert.deepEqual(received, deltas); assert.deepEqual(result, notes());
});
test('stream failures, missing completion and invalid final notes are rejected without exposing upstream details', async () => {
  for (const events of [
    [{ type: 'response.failed', response: { error: { message: 'private transcript test-secret' } } }],
    [{ type: 'response.output_text.delta', delta: '{"summary":"partial' }],
    [{ type: 'response.completed', response: { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{}' }] }] } }],
    [{ type: 'response.refusal.delta', delta: 'private transcript test-secret' }],
  ]) {
    const provider = createProviders(config, async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
    await assert.rejects(provider.extract('private transcript', { onDelta() {} }), error => {
      assert.doesNotMatch(error.message, /private transcript|test-secret/); return true;
    });
  }
});
