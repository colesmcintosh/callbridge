import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { call } from './helpers.js';

test('persists calls across restarts; lists omit full transcript; deletion is local', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'callbridge-test-'));
  const filename = path.join(dir, 'db.sqlite');
  try {
    const first = createStore(filename); first.put(call()); first.close();
    const second = createStore(filename);
    assert.equal(second.get('test-call').transcript, call().transcript);
    assert.equal(second.list()[0].transcript, undefined);
    assert.equal(second.list()[0].summary, call().extraction.summary);
    second.delete('test-call'); assert.throws(() => second.get('test-call'), /not found/); second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('recovers interrupted writes with known note IDs as retryable partial syncs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'callbridge-test-'));
  const filename = path.join(dir, 'db.sqlite');
  try {
    const first = createStore(filename);
    first.put(call({ sync: { state: 'sending', note_id: '123' } })); first.close();
    const second = createStore(filename);
    assert.equal(second.get('test-call').sync.state, 'partial');
    assert.equal(second.get('test-call').sync.note_id, '123'); second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('interrupted note writes without a known ID block retry after restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'callbridge-test-'));
  const filename = path.join(dir, 'db.sqlite');
  try {
    const first = createStore(filename); first.put(call({ sync: { state: 'sending' } })); first.close();
    const second = createStore(filename);
    assert.equal(second.get('test-call').sync.state, 'uncertain'); second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
