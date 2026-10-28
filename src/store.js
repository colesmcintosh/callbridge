import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './domain.js';

export function createStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mock_contacts (id TEXT PRIMARY KEY, properties TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mock_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id TEXT NOT NULL REFERENCES mock_contacts(id),
      call_id TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const get = id => {
    const row = db.prepare('SELECT body FROM calls WHERE id = ?').get(id);
    if (!row) throw new AppError(404, 'Call not found.');
    return JSON.parse(row.body);
  };
  const put = call => {
    db.prepare('INSERT INTO calls (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body')
      .run(call.id, JSON.stringify(call));
    return call;
  };
  // A stopped process may have written to HubSpot before it stopped. Never retry blindly.
  for (const row of db.prepare('SELECT body FROM calls').all()) {
    const call = JSON.parse(row.body);
    if (call.sync?.state === 'sending') put({ ...call, sync: { ...call.sync, state: call.sync.note_id ? 'partial' : 'uncertain' } });
  }
  return {
    get, put,
    seedMockContacts(contacts) {
      const insert = db.prepare('INSERT OR IGNORE INTO mock_contacts (id, properties) VALUES (?, ?)');
      for (const contact of contacts) insert.run(contact.id, JSON.stringify(contact.properties));
    },
    mockContacts: () => db.prepare('SELECT * FROM mock_contacts ORDER BY id').all()
      .map(row => ({ id: row.id, properties: JSON.parse(row.properties) })),
    mockContact(id) {
      const row = db.prepare('SELECT * FROM mock_contacts WHERE id = ?').get(id);
      if (!row) throw new AppError(404, 'Mock contact not found. Choose one of the sample contacts.');
      return { id: row.id, properties: JSON.parse(row.properties) };
    },
    updateMockContact(id, properties) {
      db.prepare('UPDATE mock_contacts SET properties = ? WHERE id = ?').run(JSON.stringify(properties), id);
    },
    addMockNote({ contactId, callId, body }) {
      const existing = db.prepare('SELECT id, contact_id FROM mock_notes WHERE call_id = ?').get(callId);
      if (existing) {
        if (existing.contact_id !== contactId) throw new AppError(409, 'This call already has a mock note on another contact.');
        return String(existing.id);
      }
      const result = db.prepare('INSERT INTO mock_notes (contact_id, call_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(contactId, callId, body, new Date().toISOString());
      return String(result.lastInsertRowid);
    },
    mockNotes: () => db.prepare('SELECT * FROM mock_notes ORDER BY id DESC').all(),
    list: () => db.prepare('SELECT body FROM calls').all().map(row => JSON.parse(row.body))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(({ transcript, extraction, ...call }) => ({ ...call, summary: extraction?.summary ?? null })),
    delete: id => db.prepare('DELETE FROM calls WHERE id = ?').run(id),
    close: () => db.close(),
  };
}
