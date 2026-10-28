import { once } from 'node:events';
import { extractionPreview } from './extraction-preview.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, FIELD_DEFINITIONS, text, validateExtraction, contactProperties } from './domain.js';
import { createMockHubSpot } from './mock-hubspot.js';
import { createStore } from './store.js';
import { createProviders, ProviderError } from './providers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/stream.js', ['stream.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError(413, `Upload exceeds the ${Math.round(limit / 1_000_000)} MB limit.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new AppError(415, 'Use an application/json request.');
  }
  try {
    const body = JSON.parse((await readBody(req, 1_000_000)).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'Request body must be a JSON object.');
  }
}

const assertEditable = call => {
  if (call.sync.state !== 'idle') throw new AppError(409, 'This call has a HubSpot sync in progress or on record. Create a new call for different notes.');
};
const assertRevision = (call, revision) => {
  if (revision !== call.revision) throw new AppError(409, 'These notes changed in another tab. Reload the call before continuing.');
};

export function createApp({ store, providers, config }) {
  const busy = new Set();
  function reply(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }
  async function locked(id, action) {
    if (busy.has(id)) throw new AppError(409, 'This call is being processed. Please wait.');
    busy.add(id);
    try { return await action(); } finally { busy.delete(id); }
  }
  async function syncCall(id, body) {
    const call = store.get(id);
    assertRevision(call, body.revision);
    const destination = config.hubspotMode || 'live';
    const recordedDestination = call.sync.destination || (call.sync.state !== 'idle' ? 'live' : null);
    if (recordedDestination && recordedDestination !== destination) throw new AppError(409, 'This call was synced to a different HubSpot mode. Create a new call to use the current destination.');
    if (call.sync.state === 'synced') return call;
    if (!call.extraction) throw new AppError(400, 'Extract and review notes before syncing.');
    if (['sending', 'uncertain'].includes(call.sync.state)) {
      throw new AppError(409, 'The previous sync may have reached HubSpot. Check the contact timeline before reconciling.');
    }
    const retry = call.sync.state === 'partial';
    let properties;
    let contactId;
    if (retry) {
      properties = call.sync.properties;
      contactId = call.sync.contact_id;
    } else {
      if (body.approved !== true) throw new AppError(400, 'Review and approve the notes before syncing.');
      contactId = text(body.contact_id, 'HubSpot contact ID', 30);
      if (!/^\d+$/.test(contactId)) throw new AppError(400, 'HubSpot contact ID must be numeric.');
      properties = contactProperties(call.extraction, body.fields);
      await providers.getContact(contactId);
    }
    const sync = { ...call.sync, destination, state: 'sending', contact_id: contactId, properties, error: null };
    store.put({ ...call, sync });
    try {
      if (!sync.note_id) {
        sync.note_id = await providers.createNote(call, contactId);
        // Persist the note ID before attempting contact updates; a retry must not recreate it.
        store.put({ ...call, sync: { ...sync } });
      }
      if (Object.keys(properties).length) await providers.updateContact(contactId, properties);
      return store.put({ ...call, sync: { ...sync, state: 'synced', synced_at: new Date().toISOString() } });
    } catch (error) {
      let state = 'uncertain';
      if (sync.note_id) state = 'partial';
      else if (error instanceof AppError && !(error instanceof ProviderError && error.ambiguous)) state = 'idle';
      store.put({ ...call, sync: { ...sync, state, error: error instanceof AppError ? error.message : 'Sync failed.' } });
      throw error;
    }
  }
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host;
      const allowed = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
      if (!allowed.includes(host)) throw new AppError(403, 'This server only accepts local requests.');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new AppError(403, 'Cross-origin requests are not allowed.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'Cross-site requests are not allowed.');
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      if (req.method === 'GET' && publicFiles.has(route)) {
        const [filename, type] = publicFiles.get(route);
        const contents = await readFile(path.join(root, 'public', filename));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(contents);
      }
      if (route === '/api/config' && req.method === 'GET') {
        return reply(res, 200, { openai: Boolean(config.openaiKey), hubspot: config.hubspotMode === 'mock' || Boolean(config.hubspotToken), hubspotMode: config.hubspotMode || 'live', model: config.model, fields: FIELD_DEFINITIONS });
      }
      if (route === '/api/mock-hubspot' && req.method === 'GET') {
        if (config.hubspotMode !== 'mock') throw new AppError(404, 'Mock HubSpot is disabled in live mode.');
        return reply(res, 200, { contacts: store.mockContacts(), notes: store.mockNotes() });
      }
      if (route === '/api/calls' && req.method === 'GET') return reply(res, 200, store.list());
      if (route === '/api/calls' && req.method === 'POST') {
        const body = await jsonBody(req);
        const call = {
          id: randomUUID(), title: text(body.title, 'Call title', 160),
          source: text(body.source, 'Source', 60), transcript: text(body.transcript, 'Transcript', 180_000),
          created_at: new Date().toISOString(), revision: 1, extraction: null, sync: { state: 'idle' },
        };
        return reply(res, 201, store.put(call));
      }
      if (route === '/api/transcribe' && req.method === 'POST') {
        if (!config.openaiKey) throw new AppError(503, 'Configure an OpenAI API key first.');
        const filename = text(req.headers['x-file-name'], 'Filename', 200);
        if (!/\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i.test(filename)) throw new AppError(400, 'Use MP3, MP4, MPEG, MPGA, M4A, WAV, or WebM audio.');
        const buffer = await readBody(req, 24_000_000);
        if (!buffer.length) throw new AppError(400, 'The recording is empty.');
        const transcript = await providers.transcribe(buffer, filename, req.headers['content-type'] || 'application/octet-stream');
        return reply(res, 200, { transcript });
      }
      if (route === '/api/hubspot/contact' && req.method === 'POST') {
        const body = await jsonBody(req);
        const email = text(body.email, 'Email', 254);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'Enter a valid contact email.');
        return reply(res, 200, await providers.findContact(email));
      }
      const match = /^\/api\/calls\/([\w-]+)(?:\/(extract|sync|reconcile))?$/.exec(route);
      if (match) {
        const [, id, action] = match;
        if (req.method === 'GET' && !action) return reply(res, 200, store.get(id));
        if (req.method === 'DELETE' && !action) {
          await locked(id, async () => {
            const call = store.get(id);
            if (['sending', 'uncertain', 'partial'].includes(call.sync.state)) throw new AppError(409, 'Resolve this call’s sync before deleting its local record.');
            store.delete(id);
          });
          return reply(res, 200, { deleted: true });
        }
        if (req.method === 'PATCH' && !action) {
          const body = await jsonBody(req);
          const result = await locked(id, async () => {
            const call = store.get(id);
            assertEditable(call);
            assertRevision(call, body.revision);
            if (!call.extraction) throw new AppError(400, 'Extract notes before editing.');
            return store.put({ ...call, extraction: validateExtraction(body.extraction), revision: call.revision + 1 });
          });
          return reply(res, 200, result);
        }
        if (req.method === 'POST' && action) {
          const body = await jsonBody(req);
          if (action === 'extract' && req.headers.accept?.includes('text/event-stream')) {
            await locked(id, async () => {
              const call = store.get(id);
              assertRevision(call, body.revision);
              assertEditable(call);
              const controller = new AbortController();
              const stop = () => controller.abort();
              res.on('close', stop);
              res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'X-Accel-Buffering': 'no',
              });
              res.flushHeaders();
              const send = async event => {
                if (controller.signal.aborted) throw new AppError(499, 'Extraction stopped.');
                if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, 'drain', { signal: controller.signal });
              };
              const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
              let source = '';
              let previous = '';
              try {
                await send({ type: 'status', message: 'Reading your transcript…' });
                const extraction = await providers.extract(call.transcript, {
                  signal: controller.signal,
                  onDelta: async delta => {
                    source += delta;
                    if (source.length > 250000) throw new AppError(502, 'Generated notes exceeded the size limit. Try a shorter transcript.');
                    const preview = extractionPreview(source, call.transcript);
                    const serialized = JSON.stringify(preview);
                    if (serialized !== previous) {
                      previous = serialized;
                      await send({ type: 'preview', preview });
                    }
                  },
                });
                if (controller.signal.aborted) return;
                const saved = store.put({ ...call, extraction, extraction_model: config.model, revision: call.revision + 1 });
                await send({ type: 'complete', call: saved });
              } catch (error) {
                if (!controller.signal.aborted) await send({ type: 'error', message: error instanceof AppError ? error.message : 'Extraction failed. Your transcript is saved; try again.' });
              } finally {
                clearInterval(heartbeat);
                res.off('close', stop);
                res.end();
              }
            });
            return;
          }
          const result = await locked(id, async () => {
            if (action === 'sync') return syncCall(id, body);
            const call = store.get(id);
            assertRevision(call, body.revision);
            if (action === 'reconcile') {
              if (call.sync.state !== 'uncertain' || call.sync.note_id || body.confirmed_absent !== true) throw new AppError(400, 'Confirm that no note with this call reference exists in HubSpot.');
              return store.put({ ...call, revision: call.revision + 1, sync: { state: 'idle' } });
            }
            assertEditable(call);
            const extraction = await providers.extract(call.transcript);
            return store.put({ ...call, extraction, extraction_model: config.model, revision: call.revision + 1 });
          });
          return reply(res, 200, result);
        }
      }
      throw new AppError(404, 'Page or endpoint not found.');
    } catch (error) {
      if (res.headersSent) return res.end();
      reply(res, error instanceof AppError ? error.status : 500, {
        error: error instanceof AppError ? error.message : 'An unexpected server error occurred. Your saved calls are still available.',
      });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
  const config = {
    port,
    openaiKey: process.env.OPENAI_API_KEY?.trim(), hubspotToken: process.env.HUBSPOT_ACCESS_TOKEN?.trim(),
    model: process.env.OPENAI_MODEL || 'gpt-6-luna',
    hubspotMode: process.env.HUBSPOT_MODE || 'mock',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-transcribe',
  };
  const store = createStore(path.resolve(root, process.env.DATA_DIR || 'data', 'callbridge.sqlite'));
  if (!['mock', 'live'].includes(config.hubspotMode)) throw new Error('HUBSPOT_MODE must be mock or live.');
  const providers = createProviders(config);
  if (config.hubspotMode === 'mock') Object.assign(providers, createMockHubSpot(store));
  const server = createApp({ store, providers, config });
  server.requestTimeout = 180_000;
  server.on('error', error => { console.error(`Could not start Callbridge: ${error.code || 'server error'}.`); process.exitCode = 1; store.close(); });
  server.listen(port, '127.0.0.1', () => console.log(`Callbridge is ready at http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
