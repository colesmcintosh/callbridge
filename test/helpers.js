import { FIELD_DEFINITIONS } from '../src/domain.js';

export function notes(overrides = {}) {
  return {
    summary: 'Maya needs accurate notes for Northstar.',
    fields: FIELD_DEFINITIONS.map(field => ({
      key: field.key,
      value: field.key === 'company' ? 'Northstar' : null,
      evidence: field.key === 'company' ? 'I work at Northstar.' : null,
    })),
    next_steps: [{ task: 'Send proposal', owner: 'Alex', due_date: 'Friday' }],
    ...overrides,
  };
}
export function call(overrides = {}) {
  return {
    id: 'test-call', title: 'Northstar discovery', source: 'Fathom',
    transcript: 'Maya: I work at Northstar. Alex: I will send a proposal Friday.',
    created_at: '2026-10-28T15:00:00.000Z', revision: 1,
    extraction: notes(), sync: { state: 'idle' }, ...overrides,
  };
}
