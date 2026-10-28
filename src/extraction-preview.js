import { FIELD_DEFINITIONS, verifyEvidence } from './domain.js';

// Read only complete JSON objects; the summary string can be shown before its closing quote.
// This projection is display-only. The complete response still goes through strict validation.
function stringPrefix(source, start) {
  let cursor = start + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '"') return JSON.parse(source.slice(start, cursor + 1));
    if (char === '\\') {
      const escape = source[cursor + 1];
      if (!escape) break;
      if (escape === 'u') {
        if (!/^[0-9a-f]{4}$/i.test(source.slice(cursor + 2, cursor + 6))) break;
        cursor += 6;
      } else cursor += 2;
    } else cursor++;
  }
  return JSON.parse(source.slice(start, cursor) + '"');
}
function arrayObjects(source, key, max) {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(source);
  if (!match) return [];
  const objects = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  for (let i = match.index + match[0].length; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '\\') i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') { if (depth++ === 0) start = i; }
    else if (char === '}' && depth > 0 && --depth === 0) {
      objects.push(JSON.parse(source.slice(start, i + 1)));
      if (objects.length === max) break;
    } else if (char === ']' && depth === 0) break;
  }
  return objects;
}
export function extractionPreview(source, transcript) {
  const summaryMatch = /"summary"\s*:\s*"/.exec(source);
  let summary = '';
  try { if (summaryMatch) summary = stringPrefix(source, summaryMatch.index + summaryMatch[0].length - 1).slice(0, 6000); }
  catch { /* Incomplete escape sequences wait for the next model delta. */ }
  let fields = [];
  let next_steps = [];
  try {
    fields = arrayObjects(source, 'fields', 8).filter(field =>
      FIELD_DEFINITIONS.some(def => def.key === field.key) &&
      (field.value === null || typeof field.value === 'string' && field.value.length <= 1500) &&
      (field.evidence === null || typeof field.evidence === 'string' && field.evidence.length <= 2000));
    next_steps = arrayObjects(source, 'next_steps', 20).filter(step =>
      typeof step.task === 'string' && step.task.length <= 1000 &&
      (step.owner === null || typeof step.owner === 'string' && step.owner.length <= 200) &&
      (step.due_date === null || typeof step.due_date === 'string' && step.due_date.length <= 200));
  } catch { /* A partial object never replaces the last good preview. */ }
  return { summary, fields: verifyEvidence({ fields }, transcript).fields, next_steps };
}
