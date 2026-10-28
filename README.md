# Callbridge

[![CI](https://github.com/colesmcintosh/callbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/colesmcintosh/callbridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Turn a call transcript into reviewed CRM notes. Stream the results, check the source quotes, and send only what you approve.

Callbridge runs locally, uses **GPT-6 Luna** for extraction, and includes a persistent **mock HubSpot** so you can try the full flow without connecting a real CRM.

- Paste transcripts or import text and audio recordings.
- Watch summaries, CRM details, and next steps stream in.
- Edit notes and inspect the quotes behind extracted fields.
- Approve one note and optional company, job title, or phone updates.
- Keep drafts in local SQLite and export calls as JSON.

## Quick start

Requires **Node.js 24 or newer**. No third-party dependencies or build step.

```sh
git clone https://github.com/colesmcintosh/callbridge.git
cd callbridge
cp .env.example .env.local
```

On Windows PowerShell, use `Copy-Item .env.example .env.local` for the last command. If the file already exists, keep it rather than overwriting your settings.

Set `OPENAI_API_KEY` in `.env.local` using your editor, then run:

```sh
npm start
```

Open [localhost:3000](http://localhost:3000). Click **Try a sample → Create notes**, review the results, and **Approve & send** to see the saved note in mock HubSpot.

**Mock CRM writes stay local. AI extraction and audio transcription still call OpenAI and use your API account's billing.** Without a key, you can open the app and inspect the mock CRM, but cannot generate notes.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required for extraction and transcription; server only. |
| `OPENAI_MODEL` | `gpt-6-luna` | Extraction model supporting strict structured output. |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-transcribe` | Audio transcription model. |
| `HUBSPOT_MODE` | `mock` | Use `live` only when connecting a real HubSpot account. |
| `HUBSPOT_ACCESS_TOKEN` | — | Required only in live mode. |
| `PORT` | `3000` | Local server port. |
| `DATA_DIR` | `./data` | Directory for the private SQLite database. |

Restart the server after changing settings. [Detailed usage, API streaming, sync recovery, and architecture](docs/usage.md).

### Real HubSpot

Set `HUBSPOT_MODE=live` and provide a HubSpot private-app token with contact read/write permissions. Find an existing contact by exact email, review its identity, and approve the note. Property updates are opt-in and show current and proposed values.

Calls remember their destination. A mock sync cannot be retried against live HubSpot. Test with a non-production HubSpot account before using real customer records.

## Development

```sh
npm run check
npm test
npm run dev
```

Tests require no credentials and make no external API requests. They cover validation, source quotes, streaming, cancellation, SQLite persistence, CRM approval, duplicate prevention, partial failures, and local HTTP boundaries. CI checks Node.js 24 and 26 on Linux, plus Node.js 24 on macOS and Windows.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and contribution workflow.

## Data and limitations

Callbridge is a **single-user local tool**, not a shared hosted service. It has no app login and binds only to the loopback interface. Other processes on your device can access its local API. Do not expose it through a public tunnel.

- Transcripts and drafts are stored **unencrypted** on your device. Protect the device and its backups.
- OpenAI receives transcript/audio content for processing. Responses use `store: false`; your account's retention policy still applies.
- Live HubSpot receives the reviewed note and checked properties, not the full original transcript. JSON exports include the transcript.
- Text is limited to 180,000 characters and audio to 24 MB. Larger recordings must be split or compressed.
- Quotes support review; they do not prove that extracted facts are correct. Relative dates stay as stated.

Direct recorder integrations, webhooks, bulk/background processing, deal updates, and CRM task creation are not implemented. Next steps are written into the note. [Full scope and recovery details](docs/usage.md).

## Feedback and security reports

Use [issues](https://github.com/colesmcintosh/callbridge/issues) for reproducible bugs and focused feature requests. Share synthetic examples, never customer transcripts, credentials, or database files.

For potential vulnerabilities, use [GitHub private vulnerability reporting](https://github.com/colesmcintosh/callbridge/security/advisories/new). Do not disclose sensitive details in a public issue.

## License

[MIT](LICENSE) © 2026 Cole McIntosh. HubSpot and OpenAI are third-party services; this project is independently maintained.
