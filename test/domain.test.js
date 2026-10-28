import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExtraction, verifyEvidence, contactProperties, plainNote, escapeHtml } from '../src/domain.js';
import { notes, call } from './helpers.js';

test('preserves absent facts as null and agreed relative dates as stated', () => {
  const result = validateExtraction(notes());
  assert.equal(result.fields.find(field => field.key === 'email').value, null);
  assert.equal(result.next_steps[0].due_date, 'Friday');
});
test('rejects missing and duplicate fields, unknown keys and malformed next steps', () => {
  const missing = notes(); missing.fields.pop();
  const duplicate = notes(); duplicate.fields[1] = duplicate.fields[0];
  const extra = notes({ secret: 'bad' });
  for (const value of [missing, duplicate, extra, notes({ next_steps: [{}] }), notes({ summary: '' })]) {
    assert.throws(() => validateExtraction(value));
  }
});
test('validates source quotes against the transcript, allowing whitespace normalization', () => {
  const input = notes();
  assert.equal(verifyEvidence(input, 'I work\nat Northstar.').fields[2].evidence, 'I work at Northstar.');
  assert.equal(verifyEvidence(input, 'Something different.').fields[2].evidence, null);
});
test('only explicit, populated, allowlisted contact properties can be updated', () => {
  assert.deepEqual(contactProperties(notes(), []), {});
  assert.deepEqual(contactProperties(notes(), ['company']), { company: 'Northstar' });
  for (const fields of [['budget'], ['email'], ['phone'], ['company', 'company'], ['__proto__'], 'company']) {
    assert.throws(() => contactProperties(notes(), fields));
  }
});
test('note preserves reviewed details, missing values and a reconciliation reference', () => {
  const output = plainNote(call());
  assert.match(output, /Company: Northstar/);
  assert.match(output, /Budget: Not mentioned/);
  assert.match(output, /Send proposal — Alex \(Friday\)/);
  assert.match(output, /Reference: test-call/);
});
test('escapes user-supplied HTML before sending a note to HubSpot', () => {
  assert.equal(escapeHtml('<img src="x" onerror=\'alert(1)\'> &'), '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt; &amp;');
});
