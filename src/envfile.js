import { VaultError, parseEnv } from './utils.js';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ASSIGNMENT = /^(\s*(?:export\s+)?)([\w.-]+)\s*(?:=|:\s)\s*(.*)$/;
const QUOTES = ["'", '"', '`'];

export function isValidKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

export function assertValidKey(key) {
  if (!isValidKey(key)) {
    throw new VaultError(`Invalid variable name "${key}". Use letters, digits and _ (not starting with a digit).`, {
      code: 'INVALID_INPUT',
    });
  }
}

/** Formats a value so dotenv parses it back to exactly the same string. */
export function formatEnvValue(key, value) {
  const candidates = [];
  if (/^[A-Za-z0-9_\-.,/:@%+]*$/.test(value) && value !== '') candidates.push(value);
  if (value.includes('\n') || value.includes('\r')) {
    candidates.push(`"${value.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`);
  }
  for (const quote of QUOTES) candidates.push(`${quote}${value}${quote}`);
  const fits = candidates.find((candidate) => parseEnv(`${key}=${candidate}\n`)[key] === value);
  if (fits === undefined) {
    throw new VaultError(`The value for ${key} contains a combination of quotes and line breaks that .env files cannot store.`, {
      code: 'INVALID_INPUT',
    });
  }
  return fits;
}

/** Finds assignment spans [start, end] (line indexes), following quoted values across lines. */
function findAssignments(lines) {
  const spans = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = ASSIGNMENT.exec(lines[i]);
    if (!match) continue;
    const [, prefix, key, rest] = match;
    let end = i;
    const quote = rest[0];
    if (QUOTES.includes(quote) && !rest.slice(1).includes(quote)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].includes(quote)) j += 1;
      if (j < lines.length) end = j;
    }
    spans.push({ key, prefix, start: i, end });
    i = end;
  }
  return spans;
}

/**
 * Applies variable edits to .env content, keeping comments, order and formatting of other lines.
 * Existing keys are replaced in place (the last definition, which is the one dotenv uses);
 * new keys are appended; unset removes every definition.
 */
export function editEnvContent(content, { set = {}, unset = [] } = {}) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.length ? content.split(/\r?\n/) : [];
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();

  const spans = findAssignments(lines);
  const replacements = new Map();
  const appended = [];
  for (const [key, value] of Object.entries(set)) {
    assertValidKey(key);
    const line = `${key}=${formatEnvValue(key, value)}`;
    const last = spans.filter((span) => span.key === key).at(-1);
    if (last) replacements.set(last.start, { span: last, lines: [`${last.prefix}${line}`] });
    else appended.push(line);
  }
  for (const key of unset) {
    for (const span of spans) if (span.key === key) replacements.set(span.start, { span, lines: [] });
  }

  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const replacement = replacements.get(i);
    if (replacement) {
      out.push(...replacement.lines);
      i = replacement.span.end;
    } else {
      out.push(lines[i]);
    }
  }
  out.push(...appended);
  const result = out.length ? out.join(eol) + eol : '';

  const expected = { ...parseEnv(content), ...set };
  for (const key of unset) delete expected[key];
  const actual = parseEnv(result);
  const same =
    Object.keys(expected).length === Object.keys(actual).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
  if (!same) {
    throw new VaultError('Could not edit the file safely. Nothing was changed; edit it manually instead.', {
      code: 'EDIT_FAILED',
    });
  }
  return result;
}
