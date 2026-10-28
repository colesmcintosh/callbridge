import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createMockHubSpot } from '../src/mock-hubspot.js';
import { call } from './helpers.js';

test('mock contacts and actual note writes persist across restarts without reseeding changes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'callbridge-mock-'));
  const filename = path.join(dir, 'db.sqlite');
  try {
    const first = createStore(filename);
    const mock = createMockHubSpot(first);
    await mock.updateContact('1001', { company: 'Northstar Logistics', jobtitle: 'VP of Revenue Operations' });
    const id = await mock.createNote(call(), '1001');
    assert.equal(await mock.createNote(call(), '1001'), id);
    first.close();
    const second = createStore(filename);
    const reopened = createMockHubSpot(second);
    assert.equal((await reopened.getContact('1001')).properties.company, 'Northstar Logistics');
    assert.equal((await reopened.getContact('1001')).properties.jobtitle, 'VP of Revenue Operations');
    assert.equal(second.mockNotes().length, 1);
    assert.match(second.mockNotes()[0].body, /Reference: test-call/);
    assert.equal((await reopened.getContact('1002')).properties.company, 'Acme Studio');
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('mock rejects unknown contacts, unsupported properties and re-associating a sent call', async () => {
  const store = createStore(':memory:');
  try {
    const mock = createMockHubSpot(store);
    await assert.rejects(mock.getContact('999'), /not found/);
    await assert.rejects(mock.findContact('unknown@example.com'), /No mock contact/);
    await assert.rejects(mock.updateContact('1001', { email: 'new@example.com' }), /Unsupported/);
    await mock.createNote(call(), '1001');
    await assert.rejects(mock.createNote(call(), '1002'), /another contact/);
    assert.equal(store.mockNotes().length, 1);
  } finally { store.close(); }
});
