import { readEventStream } from './stream.js';

const $ = selector => document.querySelector(selector);
const main = $('#main');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let config;
let current = null;
let contacts = [];
let selectedContact = null;
let busy = false;
let dirty = false;
let toastTimer;
let extractionController = null;
let draft = { title: '', transcript: '', source: 'Paste / text file' };

const sample = `Alex: Thanks for making time, Maya. What needs to change?
Maya Chen: I lead revenue operations at Northstar Logistics. My title is VP of Revenue Operations. Our 18 account executives spend 30 minutes after every call updating HubSpot, and important details still fall through the cracks.
Alex: Where are your recordings?
Maya: Mostly Attention, and some Fathom. We need consistent CRM notes and a clear next step, with a human review before anything goes into HubSpot.
Alex: What is your budget and timeline?
Maya: We've allocated $24,000 per year. We'd like a pilot by the end of November. Full rollout depends on the pilot results and our security team's approval.
Alex: I'll send a pilot proposal by Friday. Can you share your current CRM fields?
Maya: Yes, I'll send our HubSpot fields tomorrow. My email is maya.chen@example.com. My phone number is +1 202-555-0142. Let's meet next Tuesday to review the proposal.
Alex: Agreed. I'll send an invitation for next Tuesday.`;

async function api(path, { body, ...options } = {}) {
  const response = await fetch(path, { ...options, ...(body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed. Try again.');
  return data;
}
function notify(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').className = `toast${error ? ' error' : ''}`;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 10000 : 4500);
}
function setBusy(value, message) {
  busy = value;
  document.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = value; });
  const primary = $('#primary-action');
  if (primary) {
    primary.classList.toggle('button-busy', value);
    if (value && message) primary.setAttribute('aria-label', `${primary.textContent} (${message})`);
    else primary.removeAttribute('aria-label');
  }
  main.setAttribute('aria-busy', String(value));
}
function canLeave() {
  return !busy && (!dirty || window.confirm('Leave without saving your edits?'));
}
function steps(active) {
  return `<ol class="steps" aria-label="Progress"><li class="${active === 1 ? 'active' : 'done'}">1 <span>Add a call</span></li><li class="${active === 2 ? 'active' : active > 2 ? 'done' : ''}">2 <span>Review notes</span></li><li class="${active === 3 ? 'active' : ''}">3 <span>${config.hubspotMode === 'mock' ? 'Mock HubSpot' : 'HubSpot'}</span></li></ol>`;
}
function fitTextareas() {
  if (CSS.supports('field-sizing', 'content')) return;
  const inputs = [...main.querySelectorAll('textarea.auto-size')];
  inputs.forEach(input => { input.style.height = 'auto'; });
  const heights = inputs.map(input => input.scrollHeight + 2);
  inputs.forEach((input, index) => { input.style.height = `${heights[index]}px`; });
}
function captureDraft() {
  if ($('#transcript')) draft = { title: $('#call-title').value, transcript: $('#transcript').value, source: draft.source };
}
async function renderHome() {
  document.title = 'Callbridge — Call to CRM';
  main.dataset.view = 'input';
  current = null; dirty = false;
  main.innerHTML = `${steps(1)}<div class="intro"><h1>From call to CRM.</h1><p>Bring the conversation. We’ll take care of the notes.</p></div>
    <form id="call-form" class="card">
      <div class="section-heading"><h2>Add your transcript</h2><button class="text-button" type="button" id="sample-button">Try a sample ↗</button></div>
      <label for="call-title">Call name <span class="muted">(optional)</span></label><input id="call-title" name="call-title" autocomplete="off" maxlength="160" placeholder="e.g. Northstar · Discovery" value="${escape(draft.title)}">
      <label for="transcript">Transcript</label><textarea id="transcript" name="transcript" rows="10" maxlength="180000" required placeholder="Paste your call transcript here…">${escape(draft.transcript)}</textarea>
      <div class="form-bottom"><label class="file-button">↑ Import text or audio<input type="file" id="file-input" aria-label="Import text or audio" accept=".txt,.vtt,.srt,.mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm"></label><button id="primary-action" class="primary" type="submit">Create notes →</button></div>
      <p class="fine-print">Transcripts and audio are sent to OpenAI for processing. Drafts stay on this device.${config.hubspotMode === 'mock' ? ' Mock HubSpot makes no real CRM changes.' : ''}</p>
      <p class="form-error" id="form-error" role="alert" hidden></p>
    </form><details class="history"><summary>Saved calls <span id="history-count"></span></summary><div id="history-list"></div></details>`;
  window.scrollTo(0, 0);
  $('#sample-button').onclick = () => {
    $('#call-title').value = 'Northstar Logistics · Discovery'; $('#transcript').value = sample;
    draft.source = 'Sample transcript'; captureDraft();
  };
  $('#file-input').onchange = importFile;
  $('#call-form').onsubmit = createCall;
  $('#transcript').onkeydown = event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); $('#call-form').requestSubmit(); }
  };
  try {
    const calls = await api('/api/calls');
    if (!$('#history-list')) return;
    $('#history-count').textContent = `(${calls.length})`;
    $('#history-list').innerHTML = calls.length ? calls.map(call => `<button class="history-row" data-call="${escape(call.id)}"><span>${escape(call.title)}</span><small>${call.sync.state === 'synced' ? `Sent to ${call.sync.destination === 'mock' ? 'mock HubSpot' : 'HubSpot'}` : call.summary ? 'Ready for review' : 'Transcript saved'} →</small></button>`).join('') : '<p class="muted">Your calls will appear here.</p>';
    main.querySelectorAll('[data-call]').forEach(button => { button.onclick = () => openCall(button.dataset.call); });
  } catch (error) { notify(error.message, true); }
}
async function createCall(event) {
  event.preventDefault(); if (busy) return;
  captureDraft(); setBusy(true, 'Saving transcript…');
  $('#form-error').hidden = true;
  try {
    current = await api('/api/calls', { method: 'POST', body: { ...draft, title: draft.title.trim() || 'Untitled call' } });
    draft = { title: '', transcript: '', source: 'Paste / text file' };
    await streamExtraction();
  } catch (error) {
    setBusy(false); $('#primary-action').textContent = 'Create notes →';
    $('#form-error').textContent = error.message; $('#form-error').hidden = false;
  }
}
function renderStreaming() {
  document.title = 'Creating notes — Callbridge';
  main.dataset.view = 'streaming';
  main.innerHTML = `${steps(2)}<div class="intro"><p class="eyebrow">${escape(current.title)}</p><h1 tabindex="-1">Your notes, coming together.</h1><p>Results appear as they’re ready.</p></div>
    <div class="stream-toolbar"><p id="stream-status" role="status" aria-live="polite">Reading your transcript…</p><button id="stop-extraction" class="text-button" type="button">Stop</button></div>
    <div class="stream-shell" aria-busy="true" aria-label="Notes being generated">
      <section class="card"><div class="section-heading"><h2>Summary</h2><span class="stream-label">LIVE</span></div><div id="stream-summary" class="stream-prose"><span class="skeleton-text" aria-hidden="true"></span><span class="skeleton-text short" aria-hidden="true"></span></div>
        <h2 class="spaced">CRM details</h2><div class="fields">${config.fields.map(field => `<div class="field"><span class="preview-label">${field.label}</span><div class="stream-value pending" id="preview-${field.key}"><span class="skeleton-text" aria-hidden="true"></span></div><span class="stream-source-space" aria-hidden="true"></span></div>`).join('')}</div>
        <div class="section-heading spaced"><h2>Next steps</h2><span id="stream-count" class="muted small">0 of 8 fields</span></div><div id="stream-next-steps"><p id="steps-placeholder" class="muted small">Looking for agreed next steps…</p></div>
      </section>
      <p class="fine-print stream-disclosure">Preview only. You can edit and send once the complete notes and source quotes have been checked.</p>
    </div>`;
  setBusy(true);
  // Live status stays outside the busy result region so assistive technology can announce it.
  main.setAttribute('aria-busy', 'false');
  $('#stop-extraction').disabled = false;
  $('#stop-extraction').onclick = () => {
    $('#stop-extraction').disabled = true;
    $('#stream-status').textContent = 'Stopping…';
    extractionController?.abort();
  };
  window.scrollTo(0, 0);
  main.querySelector('h1').focus({ preventScroll: true });
}
async function streamExtraction() {
  const controller = new AbortController();
  extractionController = controller;
  renderStreaming();
  let pending = null;
  let frame = null;
  let completed = false;
  const revealed = new Set();
  let stepCount = 0;
  const paint = () => {
    frame = null;
    if (!pending || !$('#stream-summary')) return;
    const preview = pending;
    if (preview.summary) $('#stream-summary').textContent = preview.summary;
    for (const field of preview.fields) {
      const node = document.getElementById(`preview-${field.key}`);
      if (!node) continue;
      const value = field.value || 'Not mentioned';
      if (node.textContent !== value) node.textContent = value;
      node.classList.remove('pending');
      if (!revealed.has(field.key)) {
        node.classList.add('result-arrive');
        revealed.add(field.key);
      }
    }
    for (let i = stepCount; i < preview.next_steps.length; i++) {
      $('#steps-placeholder')?.remove();
      const step = preview.next_steps[i];
      const row = document.createElement('div');
      row.className = 'stream-step result-arrive';
      const task = document.createElement('p'); task.textContent = step.task;
      const meta = document.createElement('small');
      meta.textContent = [step.owner, step.due_date].filter(Boolean).join(' · ') || 'Owner and date not stated';
      row.append(task, meta); $('#stream-next-steps').append(row);
    }
    stepCount = preview.next_steps.length;
    $('#stream-count').textContent = `${revealed.size} of 8 fields`;
    const status = revealed.size === 8 ? 'Finishing next steps and checking source quotes…'
      : revealed.size ? 'Finding CRM details…' : preview.summary ? 'Writing your summary…' : 'Reading your transcript…';
    if ($('#stream-status').textContent !== status) $('#stream-status').textContent = status;
  };
  try {
    const response = await fetch(`/api/calls/${current.id}/extract`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ revision: current.revision }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'Could not start extraction. Try again.');
    }
    for await (const event of readEventStream(response.body)) {
      if (controller.signal.aborted) break;
      if (event.type === 'preview') {
        pending = event.preview;
        if (frame === null) frame = requestAnimationFrame(paint);
      } else if (event.type === 'complete') { current = event.call; completed = true; break; }
      else if (event.type === 'error') throw new Error(event.message);
      else if (event.type === 'status') $('#stream-status').textContent = event.message;
    }
    if (!completed && !controller.signal.aborted) throw new Error('The stream ended early. Your transcript is saved; try again.');
    if (controller.signal.aborted && !completed) {
      current = await api(`/api/calls/${current.id}`);
      notify('Stopped. Your transcript is saved.');
    }
  } catch (error) {
    notify(controller.signal.aborted ? 'Stopped. Your transcript is saved.' : error.message, !controller.signal.aborted);
    try { current = await api(`/api/calls/${current.id}`); }
    catch { notify('Could not refresh the saved call. Reload when the local server is available.', true); }
  } finally {
    if (frame !== null) cancelAnimationFrame(frame);
    extractionController = null;
    setBusy(false);
    await renderReview();
    main.querySelector('h1')?.focus({ preventScroll: true });
  }
}
async function importFile(event) {
  const file = event.target.files[0]; if (!file || busy) return;
  const extension = file.name.split('.').pop().toLowerCase();
  try {
    if (['txt', 'vtt', 'srt'].includes(extension)) {
      if (file.size > 720000) throw new Error('Text files must be under 720 KB.');
      const text = await file.text();
      if (text.length > 180000) throw new Error('Transcripts must be under 180,000 characters.');
      $('#transcript').value = text; draft.source = 'Text file';
    } else {
      if (!['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'].includes(extension)) throw new Error('Choose a text transcript or a supported recording.');
      if (file.size > 24000000) throw new Error('Audio must be under 24 MB. Compress or split the recording.');
      setBusy(true, 'Transcribing…');
      const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': `recording.${extension}` }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (result.transcript.length > 180000) throw new Error('This recording is too long. Split it into smaller calls.');
      $('#transcript').value = result.transcript; draft.source = 'Audio recording';
    }
    if (!$('#call-title').value) $('#call-title').value = file.name.replace(/\.[^.]+$/, '').slice(0, 160);
    captureDraft();
  } catch (error) { notify(error.message, true); }
  finally { setBusy(false); $('#primary-action').textContent = 'Create notes →'; }
}
async function openCall(id) {
  if (!canLeave()) return;
  captureDraft();
  try { current = await api(`/api/calls/${id}`); dirty = false; await renderReview(); }
  catch (error) { notify(error.message, true); }
}
async function renderReview() {
  document.title = 'Review notes — Callbridge';
  main.dataset.view = 'review';
  const call = current;
  const readonly = call.sync.state !== 'idle';
  const notes = call.extraction;
  main.innerHTML = `${steps(2)}<div class="intro review-intro"><div><p class="eyebrow">${escape(call.title)}</p><h1 tabindex="-1">${notes ? 'A quick review.' : 'Your call is saved.'}</h1><p>${notes ? 'Check the details before they reach your CRM.' : 'Create notes whenever you’re ready.'}</p></div><button id="new-call" class="text-button">New call</button></div>
    ${call.sync.state === 'synced' ? `<div class="success">✓ Saved to ${call.sync.destination === 'mock' ? 'mock HubSpot' : 'HubSpot'}. ${call.sync.destination === 'mock' ? '<button id="view-result" class="text-button">View contact & note →</button>' : ''}</div>` : ''}
    ${['partial', 'uncertain'].includes(call.sync.state) ? `<div class="warning">${call.sync.state === 'partial' ? 'The note was saved. Only the approved contact fields need retrying.' : `The write may have reached HubSpot. Check the contact timeline for reference ${escape(call.id)} before retrying.`}${call.sync.state === 'uncertain' ? '<button id="reconcile" class="text-button">I checked: no note exists</button>' : ''}</div>` : ''}
    ${notes ? `<form id="review-form"><section class="card"><h2>Summary</h2><label class="sr-only" for="summary">Call summary</label><textarea id="summary" name="summary" class="auto-size" rows="3" maxlength="6000" required ${readonly ? 'readonly' : ''}>${escape(notes.summary)}</textarea>
      <h2 class="spaced">CRM details</h2><div class="fields">${notes.fields.map(field => {
        const def = config.fields.find(item => item.key === field.key);
        return `<div class="field"><label for="field-${field.key}">${def.label}</label><input id="field-${field.key}" name="${field.key}" autocomplete="off" type="${field.key === 'email' ? 'email' : field.key === 'phone' ? 'tel' : 'text'}" spellcheck="${field.key !== 'email' && field.key !== 'phone'}" data-field="${field.key}" maxlength="1500" value="${escape(field.value)}" placeholder="Not mentioned" ${readonly ? 'readonly' : ''}>${field.evidence ? `<details class="source"><summary>View source</summary><blockquote>${escape(field.evidence)}</blockquote></details>` : `<small class="muted">${field.value ? 'Review against the transcript' : 'No fact inferred'}</small>`}</div>`;
      }).join('')}</div>
      <div class="section-heading spaced"><h2>Next steps</h2>${readonly ? '' : '<button id="add-step" class="text-button" type="button">+ Add</button>'}</div><div id="next-steps"></div>
      <details class="original"><summary>Original transcript</summary><pre>${escape(call.transcript)}</pre></details>
      <p class="fine-print">Source quotes are matched to the transcript. Review is still needed for accuracy.</p>
    </section>
    ${readonly ? '' : `<section class="card send-card"><div class="section-heading"><h2>Send to ${config.hubspotMode === 'mock' ? 'mock HubSpot' : 'HubSpot'}</h2>${config.hubspotMode === 'mock' ? '<span class="demo-tag">LOCAL DEMO</span>' : '<span class="live-tag">LIVE CRM</span>'}</div><div id="contact-picker"></div><div id="property-options"></div><div class="send-footer"><p class="muted small">Creates one note.<br>Only checked contact fields are overwritten.</p><button id="primary-action" class="primary" type="submit">Approve & send →</button></div></section>`}
    </form>` : `<div class="card"><p>Your transcript is saved. Try extraction again when you’re ready.</p><button id="retry-extract" class="primary">Create notes →</button></div>`}
    ${call.sync.state === 'partial' ? '<button id="retry-sync" class="primary">Retry contact fields →</button>' : ''}
    <div class="review-bottom">${notes ? '<button id="export-call" class="text-button">Export JSON</button>' : ''}${!readonly && notes ? '<button id="save-notes" class="text-button">Save draft</button>' : ''}<span id="save-status" class="muted small">Saved locally</span></div>`;
  window.scrollTo(0, 0);
  $('#new-call').onclick = () => { if (canLeave()) renderHome(); };
  if ($('#view-result')) $('#view-result').onclick = () => showCRM(call.sync.contact_id, true);
  if ($('#reconcile')) $('#reconcile').onclick = reconcile;
  if ($('#retry-sync')) $('#retry-sync').onclick = () => sendCall({ revision: current.revision });
  if ($('#retry-extract')) $('#retry-extract').onclick = retryExtraction;
  if (!notes) return;
  renderNextSteps(); fitTextareas();
  main.querySelectorAll('#summary,[data-field]').forEach(input => { input.oninput = () => {
    if (input.dataset.field) {
      const field = current.extraction.fields.find(field => field.key === input.dataset.field);
      field.evidence = null; field.value = input.value.trim() || null;
      input.closest('.field').querySelector('.source')?.remove();
      renderPropertyOptions();
    }
    markDirty(); fitTextareas();
  }; });
  if ($('#add-step')) $('#add-step').onclick = () => {
    captureNotes();
    if (current.extraction.next_steps.length >= 20) return notify('Use 20 or fewer next steps.', true);
    current.extraction.next_steps.push({ task: '', owner: null, due_date: null }); renderNextSteps(); markDirty();
  };
  if ($('#save-notes')) $('#save-notes').onclick = () => saveNotes().then(() => notify('Draft saved.')).catch(error => notify(error.message, true));
  $('#export-call').onclick = exportCall;
  $('#review-form').onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    if (!selectedContact) return notify('Choose a contact first.', true);
    const fields = [...main.querySelectorAll('[data-property]:checked')].map(input => input.dataset.property);
    try {
      await saveNotes();
      await sendCall({ revision: current.revision, approved: true, contact_id: selectedContact.id, fields });
    } catch (error) { notify(error.message, true); }
  };
  if (!readonly) await renderContactPicker();
}
function markDirty() {
  dirty = true;
  if ($('#save-status')) $('#save-status').textContent = 'Unsaved edits';
}
function renderNextSteps() {
  const readonly = current.sync.state !== 'idle';
  $('#next-steps').innerHTML = current.extraction.next_steps.map((step, i) => `<div class="next-step" data-step="${i}"><div class="task-line"><label class="sr-only" for="task-${i}">Next step ${i + 1}</label><input id="task-${i}" data-task value="${escape(step.task)}" maxlength="1000" placeholder="Agreed next step" required ${readonly ? 'readonly' : ''}>${readonly ? '' : `<button class="remove-step" type="button" data-remove="${i}" aria-label="Remove next step ${i + 1}">×</button>`}</div><div class="step-meta"><input data-owner value="${escape(step.owner)}" maxlength="200" aria-label="Owner for step ${i + 1}" placeholder="Owner not stated" ${readonly ? 'readonly' : ''}><input data-due value="${escape(step.due_date)}" maxlength="200" aria-label="Due date for step ${i + 1}" placeholder="Date not stated" ${readonly ? 'readonly' : ''}></div></div>`).join('') || '<p class="muted small">No next steps were agreed.</p>';
  $('#next-steps').querySelectorAll('input').forEach(input => { input.oninput = markDirty; });
  $('#next-steps').querySelectorAll('[data-remove]').forEach(button => { button.onclick = () => {
    captureNotes(); current.extraction.next_steps.splice(Number(button.dataset.remove), 1); renderNextSteps(); markDirty();
  }; });
}
function captureNotes() {
  if (!$('#summary')) return;
  current.extraction.summary = $('#summary').value.trim();
  main.querySelectorAll('[data-field]').forEach(input => {
    current.extraction.fields.find(field => field.key === input.dataset.field).value = input.value.trim() || null;
  });
  current.extraction.next_steps = [...main.querySelectorAll('[data-step]')].map(row => ({
    task: row.querySelector('[data-task]').value.trim(), owner: row.querySelector('[data-owner]').value.trim() || null,
    due_date: row.querySelector('[data-due]').value.trim() || null,
  }));
}
async function saveNotes() {
  if (!dirty) return;
  captureNotes(); setBusy(true, 'Saving…');
  try {
    current = await api(`/api/calls/${current.id}`, { method: 'PATCH', body: { revision: current.revision, extraction: current.extraction } });
    dirty = false; $('#save-status').textContent = 'Saved locally';
  } finally { setBusy(false); if ($('#primary-action')) $('#primary-action').textContent = 'Approve & send →'; }
}
async function renderContactPicker() {
  selectedContact = null;
  try {
    if (config.hubspotMode === 'mock') {
      contacts = (await api('/api/mock-hubspot')).contacts;
      const email = current.extraction.fields.find(field => field.key === 'email')?.value;
      selectedContact = contacts.find(contact => contact.properties.email.toLowerCase() === email?.toLowerCase()) || null;
      $('#contact-picker').innerHTML = `<label for="contact-select">Contact</label><select id="contact-select" required><option value="">Choose a sample contact</option>${contacts.map(contact => `<option value="${escape(contact.id)}" ${selectedContact?.id === contact.id ? 'selected' : ''}>${escape(contact.properties.firstname)} ${escape(contact.properties.lastname)} · ${escape(contact.properties.email)}</option>`).join('')}</select><p class="fine-print">Sample contacts only. No HubSpot account needed.</p>`;
      $('#contact-select').onchange = event => { selectedContact = contacts.find(contact => contact.id === event.target.value); $('#property-options').innerHTML = ''; renderPropertyOptions(); };
    } else {
      $('#contact-picker').innerHTML = `<label for="contact-email">Existing contact’s email</label><div class="contact-search"><input id="contact-email" type="email" value="${escape(current.extraction.fields.find(field => field.key === 'email')?.value)}" placeholder="name@company.com"><button type="button" class="secondary" id="find-contact">Find contact</button></div><p id="contact-result" class="small muted"></p>`;
      $('#contact-email').oninput = () => { selectedContact = null; $('#contact-result').textContent = ''; renderPropertyOptions(); };
      $('#find-contact').onclick = async () => {
        const email = $('#contact-email').value.trim(); setBusy(true);
        try { selectedContact = await api('/api/hubspot/contact', { method: 'POST', body: { email } }); $('#contact-result').textContent = `Selected: ${selectedContact.properties.email} · Contact #${selectedContact.id}`; }
        catch (error) { selectedContact = null; notify(error.message, true); }
        finally { setBusy(false); renderPropertyOptions(); }
      };
    }
    renderPropertyOptions();
  } catch (error) { $('#contact-picker').innerHTML = '<p class="warning">Could not load contacts. Reload to try again.</p>'; notify(error.message, true); }
}
function renderPropertyOptions() {
  const checked = new Set([...main.querySelectorAll('[data-property]:checked')].map(input => input.dataset.property));
  const element = $('#property-options'); if (!element) return;
  element.innerHTML = !selectedContact ? '' : `<p class="small spaced">Also update contact fields <span class="muted">(optional)</span></p>${config.fields.filter(def => def.property).map(def => {
    const field = current.extraction.fields.find(item => item.key === def.key);
    if (!field.value) return '';
    return `<label class="property-option"><input type="checkbox" data-property="${def.key}" ${checked.has(def.key) ? 'checked' : ''}><span>${def.label}<small>${escape(selectedContact.properties[def.property] || 'Empty')} → ${escape(field.value)}</small></span></label>`;
  }).join('')}`;
}
async function sendCall(body) {
  setBusy(true, 'Sending…');
  try {
    current = await api(`/api/calls/${current.id}/sync`, { method: 'POST', body });
    dirty = false; setBusy(false);
    if (config.hubspotMode === 'mock') await showCRM(current.sync.contact_id, true);
    else { await renderReview(); notify('Saved to HubSpot.'); }
  } catch (error) {
    setBusy(false); notify(error.message, true);
    try { current = await api(`/api/calls/${current.id}`); await renderReview(); }
    catch { notify('Could not refresh this call. Reload to check its sync status before retrying.', true); }
  }
}
async function retryExtraction() {
  if (!busy) await streamExtraction();
}
async function reconcile() {
  if (!window.confirm(`Have you checked the contact timeline and confirmed there is NO note with reference ${current.id}? Only continue if absent, to avoid a duplicate.`)) return;
  try { current = await api(`/api/calls/${current.id}/reconcile`, { method: 'POST', body: { revision: current.revision, confirmed_absent: true } }); await renderReview(); }
  catch (error) { notify(error.message, true); }
}
async function showCRM(contactId, sent = false) {
  if (!canLeave()) return;
  captureDraft();
  try {
    const crm = await api('/api/mock-hubspot');
    document.title = 'Mock HubSpot — Callbridge';
    main.dataset.view = 'crm';
    const contact = crm.contacts.find(item => item.id === contactId) || crm.contacts[0];
    const p = contact.properties;
    const notes = crm.notes.filter(note => note.contact_id === contact.id);
    main.innerHTML = `${steps(3)}<div class="intro"><div class="section-heading"><h1>Mock HubSpot</h1><span class="demo-tag">LOCAL DEMO</span></div><p>A working local CRM. Nothing is sent to a real HubSpot account.</p></div>
      ${sent ? '<div class="success" role="status">✓ Your reviewed note is saved. Selected contact fields are updated below.</div>' : ''}
      <div class="crm-grid"><section class="card contact-card"><label for="crm-contact">Contact</label><select id="crm-contact">${crm.contacts.map(item => `<option value="${escape(item.id)}" ${item.id === contact.id ? 'selected' : ''}>${escape(item.properties.firstname)} ${escape(item.properties.lastname)}</option>`).join('')}</select><div class="avatar">${escape(p.firstname[0] + p.lastname[0])}</div><h2>${escape(p.firstname)} ${escape(p.lastname)}</h2><p class="small muted">${escape(p.email)}</p><dl>${[['Company',p.company],['Job title',p.jobtitle],['Phone',p.phone]].map(([label,value]) => `<dt>${label}</dt><dd>${escape(value || 'Empty')}</dd>`).join('')}</dl></section>
      <section><div class="section-heading timeline-heading"><h2>Contact timeline</h2><span class="muted small">${notes.length} ${notes.length === 1 ? 'note' : 'notes'}</span></div>${notes.length ? notes.map(note => `<article class="card timeline-note"><div class="section-heading"><strong>Call note</strong><time class="muted small">${escape(new Date(note.created_at).toLocaleString())}</time></div><pre>${escape(note.body)}</pre></article>`).join('') : '<div class="card empty-timeline"><p>No notes yet.</p><p class="muted small">Create notes from a call, then send them here.</p></div>'}</section></div>
      <div class="result-actions"><button id="another-call" class="primary">Add another call →</button>${current ? '<button id="back-review" class="text-button">Back to reviewed notes</button>' : ''}</div>`;
    window.scrollTo(0, 0);
    $('#crm-contact').onchange = event => showCRM(event.target.value);
    $('#another-call').onclick = renderHome;
    if ($('#back-review')) $('#back-review').onclick = renderReview;
  } catch (error) { notify(error.message, true); }
}
function exportCall() {
  if (dirty) captureNotes();
  const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `callbridge-${current.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Call exported, including the transcript.');
}
$('#home-link').onclick = () => { if (canLeave()) { captureDraft(); renderHome(); } };
$('#crm-link').onclick = () => showCRM();
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
try {
  config = await api('/api/config');
  $('#model-label').textContent = config.model === 'gpt-6-luna' ? 'Powered by GPT-6 Luna' : `Model: ${config.model}`;
  $('#mode-label').textContent = config.hubspotMode === 'mock' ? 'Mock HubSpot · no real CRM writes' : 'Live HubSpot · local workspace';
  $('#crm-link').hidden = config.hubspotMode !== 'mock';
  await renderHome();
} catch (error) { main.innerHTML = `<div class="card"><h1>Couldn’t open Callbridge.</h1><p>${escape(error.message)}</p><button id="reload" class="primary">Try again</button></div>`; $('#reload').onclick = () => location.reload(); }
