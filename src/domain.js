export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const FIELD_DEFINITIONS = [
  { key: 'contact_name', label: 'Contact name' },
  { key: 'email', label: 'Email' },
  { key: 'company', label: 'Company', property: 'company' },
  { key: 'job_title', label: 'Job title', property: 'jobtitle' },
  { key: 'phone', label: 'Phone', property: 'phone' },
  { key: 'budget', label: 'Budget' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'pain_points', label: 'Pain points' },
];

export function text(value, name, max, { optional = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    throw new AppError(400, `${name} must be ${optional ? 'a string' : 'non-empty text'} of at most ${max.toLocaleString()} characters.`);
  }
  return value.trim();
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new AppError(400, `${label} has an invalid structure.`);
  }
}

export function validateExtraction(value) {
  exactKeys(value, ['summary', 'fields', 'next_steps'], 'Notes');
  const summary = text(value.summary, 'Summary', 6000);
  if (!Array.isArray(value.fields) || value.fields.length !== FIELD_DEFINITIONS.length) {
    throw new AppError(400, 'Notes must contain all eight CRM fields.');
  }
  const fields = FIELD_DEFINITIONS.map(definition => {
    const matches = value.fields.filter(field => field?.key === definition.key);
    if (matches.length !== 1) throw new AppError(400, `Invalid or duplicate field: ${definition.key}.`);
    const field = matches[0];
    exactKeys(field, ['key', 'value', 'evidence'], 'Field');
    return {
      key: definition.key,
      value: field.value === null ? null : text(field.value, definition.label, 1500, { optional: true }) || null,
      evidence: field.evidence === null ? null : text(field.evidence, 'Source quote', 2000, { optional: true }) || null,
    };
  });
  if (!Array.isArray(value.next_steps) || value.next_steps.length > 20) {
    throw new AppError(400, 'Notes may contain at most 20 next steps.');
  }
  const next_steps = value.next_steps.map(step => {
    exactKeys(step, ['task', 'owner', 'due_date'], 'Next step');
    return {
      task: text(step.task, 'Task', 1000),
      owner: step.owner === null ? null : text(step.owner, 'Owner', 200, { optional: true }) || null,
      due_date: step.due_date === null ? null : text(step.due_date, 'Due date', 200, { optional: true }) || null,
    };
  });
  return { summary, fields, next_steps };
}

const nullableString = { type: ['string', 'null'] };
export const extractionSchema = {
  type: 'object', additionalProperties: false, required: ['summary', 'fields', 'next_steps'],
  properties: {
    summary: { type: 'string' },
    fields: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['key', 'value', 'evidence'],
        properties: {
          key: { type: 'string', enum: FIELD_DEFINITIONS.map(field => field.key) },
          value: nullableString, evidence: nullableString,
        },
      },
    },
    next_steps: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['task', 'owner', 'due_date'],
        properties: { task: { type: 'string' }, owner: nullableString, due_date: nullableString },
      },
    },
  },
};

// Quotes that cannot be located in the transcript are never presented as verified evidence.
export function verifyEvidence(extraction, transcript) {
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  const source = normalize(transcript);
  return {
    ...extraction,
    fields: extraction.fields.map(field => ({
      ...field,
      evidence: field.evidence && source.includes(normalize(field.evidence)) ? field.evidence : null,
    })),
  };
}

export function contactProperties(extraction, selected) {
  if (!Array.isArray(selected) || selected.length > 3 || new Set(selected).size !== selected.length) {
    throw new AppError(400, 'Select unique contact fields to update.');
  }
  const properties = {};
  for (const key of selected) {
    const definition = FIELD_DEFINITIONS.find(field => field.key === key && field.property);
    const value = extraction.fields.find(field => field.key === key)?.value;
    if (!definition || !value) throw new AppError(400, `Field cannot be synced: ${key}.`);
    properties[definition.property] = value;
  }
  return properties;
}

export function plainNote(call) {
  const notes = call.extraction;
  return [
    call.title, '', notes.summary, '', 'CALL DETAILS',
    ...FIELD_DEFINITIONS.map(definition => {
      const field = notes.fields.find(item => item.key === definition.key);
      return `${definition.label}: ${field.value ?? 'Not mentioned'}`;
    }),
    '', 'NEXT STEPS',
    ...notes.next_steps.map(step => `• ${step.task}${step.owner ? ` — ${step.owner}` : ''}${step.due_date ? ` (${step.due_date})` : ''}`),
    '', `Source: ${call.source}. Reviewed in Callbridge. Reference: ${call.id}`,
  ].join('\n');
}

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
