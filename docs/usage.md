# Usage and architecture

A simple local call-to-CRM workspace with GPT-6 Luna and a working mock HubSpot: import a conversation, extract structured notes, review the evidence, and send the approved result to an existing HubSpot contact.

## Run locally

Requires **Node.js 24 or newer**. There are no third-party runtime or development dependencies and no installation step.

```sh
cp .env.example .env.local
# Set your credentials in .env.local using your editor.
npm start
```

Open [http://localhost:3000](http://localhost:3000). If `.env.local` already exists, keep it; do not overwrite it with the example. `npm run dev` restarts the server when server files change; refresh your browser after frontend edits.

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI credential. Required for extraction and audio transcription. |
| `OPENAI_MODEL` | Extraction model supporting Responses API strict structured outputs. Defaults to `gpt-6-luna`, with reasoning disabled for faster extraction. |
| `OPENAI_TRANSCRIPTION_MODEL` | File transcription model. Defaults to `gpt-transcribe`. |
| `HUBSPOT_MODE` | `mock` by default. Use `live` only to connect a real HubSpot account. |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot private-app token, required only in live mode. |
| `PORT` | Local port; defaults to `3000`. |
| `DATA_DIR` | Directory for the SQLite database; defaults to `./data`. Relative paths resolve from this project. |

Restart the server after changing credentials. OpenAI API use is billed to your API project. Configure a key belonging to your own project and rotate it according to your account policy.

## Try the full flow

1. Click **Try a sample**, then **Create notes**. GPT-6 Luna streams the summary as it is written, then CRM fields and next steps appear as their structured values complete. No artificial typewriter delay is added.
2. Review or edit the notes. **View source** expands the exact quote behind each field; the original transcript is available below. A located quote does not guarantee the extracted fact is correct.
3. Choose a sample contact, optionally check company, job title, or phone to overwrite, and click **Approve & send**. Edits are saved before sending.
4. The app opens **Mock HubSpot** with the contact's updated properties and the actual saved note in its timeline. Switch between sample contacts to inspect their records. Contacts and notes persist locally across restarts.

Mock HubSpot is the default and makes **no HubSpot network requests**, even if a real token is configured. It uses the same provider contract and approval/sync workflow as live mode. Sample contacts are Maya Chen (`maya.chen@example.com`) and Jordan Lee (`jordan.lee@example.com`). All three property update checkboxes start unchecked.

Paste a transcript or import `.txt`, `.vtt`, or `.srt` exports from any recorder. Audio supports MP3, MP4, MPEG, MPGA, M4A, WAV, and WebM, limited to 24 MB. Transcripts are limited to 180,000 characters. Large recordings must be split or compressed. Relative dates remain as stated rather than guessed.

Saved calls are in the expandable list below the input form. **Save draft** saves local review edits; **Export JSON** includes the transcript and notes. No dashboard, sidebar, connection screen, or separate approval dialog is needed.

### Streaming and stopping

The browser requests server-sent events from the extraction endpoint. The server forwards display-only previews from OpenAI's live output while buffering the complete structured response for validation. Summary tokens are rendered in browser animation frames; completed fields and next steps reveal with short opacity/transform transitions. Reduced-motion preferences disable the animations. No added SDK or UI runtime is required.

Previews cannot be edited or sent to a CRM. Only the complete, schema-validated notes are saved and opened for review. Unmatched source quotes are removed. The Stop button aborts the browser request and upstream extraction; the saved transcript remains available for retry. If completion won the race with Stop, the completed saved notes are recovered. An interrupted or invalid stream returns to the saved call without persisting partial notes.

The JSON extraction endpoint remains compatible with existing clients. Request `Accept: text/event-stream` to receive `status`, `preview`, `complete`, or `error` events. Once the stream starts, failures use an `error` event, not a new HTTP status. Consumers must wait for `complete` rather than treating an HTTP 200 or a preview as success.

The interaction pass follows [Vercel's Web Interface Guidelines](https://vercel.com/design/guidelines): keyboard focus, live status announcements, mobile input sizing, reduced motion, and compositor-friendly transitions.

### Real HubSpot (optional)

Set `HUBSPOT_MODE=live` and `HUBSPOT_ACCESS_TOKEN` in `.env.local`, then restart. The UI clearly labels the destination as a live CRM. A HubSpot private app needs `crm.objects.contacts.read` and `crm.objects.contacts.write` scopes. Find an existing contact by exact email, review the returned identity, and approve the note and selected property updates. No contacts or deals are created automatically. Use a test HubSpot account for initial write testing.

Sync records remember their destination. A mock sync or partial sync cannot be retried against live HubSpot (and vice versa). Imported legacy sync records are treated as live. Create a new call if a different destination is intended. The mock CRM endpoint is unavailable in live mode.

### Sync recovery

A persisted sync record prevents concurrent and repeated sends from creating duplicate notes **for the same local call**. Importing the same transcript as a new call is a separate operation and can create another note.

- **Partial sync:** if the note was created but the contact update failed, retry sends only the originally approved contact properties. The known note ID is retained.
- **Uncertain sync:** if a note write times out, loses its connection, or is interrupted before its ID is saved, the app blocks automatic retry. Check the contact timeline for the call reference shown in the warning. If the note exists, leave the call blocked; this version does not adopt existing notes. If it does not exist, the explicit “I checked: no note was created” action unlocks another reviewed send. A false confirmation can create a duplicate.
- **Restart:** interrupted writes with a known note ID become partial syncs. Writes without a known note ID become uncertain.

Contact updates and note creation are separate HubSpot operations, not a distributed transaction. Synced and partially synced calls are read only to keep recovery consistent. The local deletion API never deletes remote notes, and blocks deletion of calls with unresolved syncs.

## Privacy and security

- The server binds only to `127.0.0.1`, rejects foreign hosts and origins, and does not expose `.env` files, source files, or the database through HTTP. No hosted deployment is created.
- Credentials remain in the server environment and are never sent to the browser or stored in the database. `.env.local` and `data/` are ignored by version control.
- Drafts and transcripts are stored **unencrypted** in `data/callbridge.sqlite` on this device. SQLite WAL files and backups may also contain call data. Protect the device and its backups. Deleting a record is not a forensic secure erase.
- Extraction sends the transcript to OpenAI with `store: false`. This disables Responses API application-state storage; it does not imply zero data retention or override the API account's retention policy. Uploaded audio is forwarded for transcription and is not written to disk by the app.
- In mock mode, CRM writes stay in local SQLite. In live mode, HubSpot receives the reviewed note and only the contact properties explicitly selected. The original full transcript is not included in the HubSpot note. JSON exports include it.
- There is no application login or multi-user isolation. Other local processes can access the loopback API. This is a single-user development tool; do not expose it through a public tunnel or deploy it as a shared service without adding authentication and an appropriate data model.
- Provider error responses are sanitized. Transcript content is treated as untrusted data, model output is validated, note HTML is escaped, and contact property writes use an allowlist. Human review is required because extraction can still be wrong.

## Development

```sh
npm run check
npm test
```

Tests use Node's built-in runner, in-memory and temporary SQLite databases, mocked provider responses, and real temporary loopback HTTP servers. They do not require credentials or send data to external services. Tests cover UTF-8/SSE chunk boundaries, partial JSON projections, preview-before-completion delivery, cancellation propagation, final-only persistence, extraction validation, evidence matching, HTML escaping, persistence, stale revisions, approval enforcement, selected property updates, duplicate prevention, partial failure, ambiguous writes, and local HTTP restrictions.

```
public/             Browser interface; no build step
src/domain.js       Validation, extraction contract, reviewed note formatting
src/providers.js    OpenAI streaming and HubSpot HTTP clients
src/extraction-preview.js  Display-only projection of partial structured output
public/stream.js    Shared browser/server SSE decoder
src/store.js        SQLite persistence and restart recovery
src/mock-hubspot.js  Local sample contacts, notes, and contact updates
src/server.js       Local HTTP boundary and workflow orchestration
test/               Offline unit and integration tests
```

## Scope and release status

This is a local prototype of the complete manual review workflow, with real AI extraction and a local mock CRM. Mock HubSpot is a simulation, not a pixel-for-pixel copy of HubSpot. Direct recorder integrations, webhooks, bulk processing, background scheduling, custom HubSpot property mappings, deal updates, CRM task creation, multi-user authentication, retention automation, and automated extraction evaluation are not implemented. Next steps are written into the note, not created as HubSpot tasks. Test extraction against your own representative transcripts before considering unattended use.

Callbridge is distributed under the [MIT license](../LICENSE). Never commit local credentials, SQLite files, recordings, exported calls, or real customer transcripts.

API references: [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [HubSpot notes](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/notes/guide), [HubSpot contacts](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide).
