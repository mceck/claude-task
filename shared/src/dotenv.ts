// `.env` file parsing for a Project's env var import, run on import (backend) and while previewing (frontend).

import { ENV_VAR_NAME } from './api';

export interface DotenvEntry {
  name: string;
  value: string;
}

export type DotenvResult = { ok: true; entries: DotenvEntry[] } | { ok: false; errors: string[] };

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * Parses dotenv syntax: `KEY=value` lines with optional `export `, `#` comments, single, double
 * or backtick quotes (quoted values may span lines; double quotes expand `\n`, `\t`, `\"`, `\\`).
 * No `${VAR}` expansion. A name defined twice keeps its last value.
 */
export function parseDotenv(content: string): DotenvResult {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  const values = new Map<string, string>();
  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      errors.push(`Line ${lineNo}: expected NAME=value`);
      continue;
    }
    const name = match[1]!;
    // Re-read the value from the untrimmed line: spaces before a newline can be
    // inside a multiline quoted value, and trimming the line would erase them.
    const eq = lines[i]!.indexOf('=');
    let rest = lines[i]!.slice(eq + 1).replace(/^[ \t]*/, '');
    if (!ENV_VAR_NAME.test(name)) errors.push(`Line ${lineNo}: ${name} is not a valid variable name`);
    const quote = rest[0];
    let value: string;
    if (quote === '"' || quote === "'" || quote === '`') {
      // Collect lines until the closing quote, so quoted values can span lines.
      let body = rest.slice(1);
      let end = closingQuote(body, quote);
      while (end < 0 && i + 1 < lines.length) {
        body += `\n${lines[++i]!}`;
        end = closingQuote(body, quote);
      }
      if (end < 0) {
        errors.push(`Line ${lineNo}: unterminated ${quote} quote`);
        continue;
      }
      const trailing = body.slice(end + 1).trim();
      if (trailing !== '' && !trailing.startsWith('#')) {
        errors.push(`Line ${lineNo}: unexpected text after the closing quote`);
        continue;
      }
      value = body.slice(0, end);
      if (quote === '"') value = value.replace(/\\(.)/g, (m, c: string) => ESCAPES[c] ?? m);
    } else {
      // An unquoted value ends at a ` #` comment.
      rest = rest.replace(/\s+#.*$/, '');
      value = rest.startsWith('#') ? '' : rest.trim();
    }
    values.set(name, value);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, entries: [...values].map(([name, value]) => ({ name, value })) };
}

function closingQuote(body: string, quote: string): number {
  for (let j = 0; j < body.length; j++) {
    if (quote === '"' && body[j] === '\\') j++;
    else if (body[j] === quote) return j;
  }
  return -1;
}
