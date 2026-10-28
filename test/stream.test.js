import test from 'node:test';
import assert from 'node:assert/strict';
import { readEventStream } from '../public/stream.js';
import { extractionPreview } from '../src/extraction-preview.js';
import { notes, call } from './helpers.js';

function bytesStream(text, chunkSize = 3) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
}
test('SSE handles split UTF-8, CRLF, comments, multiple events and no final newline', async () => {
  const input = ': heartbeat\r\nevent: update\r\ndata: {"text":"Maya → café 🟢"}\r\n\r\ndata: {"done":true}\n\ndata: [DONE]';
  const events = [];
  for await (const event of readEventStream(bytesStream(input, 1))) events.push(event);
  assert.deepEqual(events, [{ text: 'Maya → café 🟢' }, { done: true }]);
});
test('SSE joins multiline data and releases its reader on early exit', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"a":\ndata: 1}\n\n')); },
    cancel() { cancelled = true; },
  });
  for await (const event of readEventStream(body)) { assert.deepEqual(event, { a: 1 }); break; }
  assert.equal(cancelled, true); assert.equal(body.locked, false);
});
test('SSE rejects malformed and oversized events', async () => {
  await assert.rejects(async () => { for await (const event of readEventStream(bytesStream('data: bad\n\n'))) void event; });
  await assert.rejects(async () => { for await (const event of readEventStream(bytesStream('data: ' + 'x'.repeat(1000001), 1000010))) void event; }, /size limit/);
});
test('preview streams a summary before the JSON string is finished', () => {
  assert.equal(extractionPreview('{"summary":"Maya needs', '').summary, 'Maya needs');
  assert.equal(extractionPreview('{"summary":"A \\"quote', '').summary, 'A "quote');
  assert.equal(extractionPreview('{"summary":"café \\u00', '').summary, 'café ');
  assert.equal(extractionPreview('{"summary":"trailing\\', '').summary, 'trailing');
});
test('preview reveals only complete fields and next steps, with real source evidence', () => {
  const full = JSON.stringify(notes());
  const midField = full.indexOf('"evidence"') + 5;
  assert.equal(extractionPreview(full.slice(0, midField), call().transcript).fields.length, 0);
  const beforeNextStep = full.indexOf('"next_steps"');
  assert.equal(extractionPreview(full.slice(0, beforeNextStep), call().transcript).fields.length, 8);
  const preview = extractionPreview(full, call().transcript);
  assert.deepEqual(preview, notes());
  assert.equal(extractionPreview(full, 'No quote here').fields[2].evidence, null);
});
test('JSON braces and escaped quotes in values cannot prematurely end a field', () => {
  const data = notes(); data.fields[2].value = 'Company { "Northstar" }';
  const preview = extractionPreview(JSON.stringify(data), call().transcript);
  assert.equal(preview.fields[2].value, 'Company { "Northstar" }');
  assert.equal(preview.fields.length, 8);
});
