export interface ShellSegment {
  /** The operator joining this segment to the previous one; empty for the first. */
  op: '' | '&&' | '||' | '|' | ';';
  text: string;
}

/**
 * Splits a shell command at its top-level `&&`, `||`, `|`, `;` and newlines, so a long chain reads one step per line.
 * Quotes, escapes, `$(...)`, backticks and brackets are respected; after a heredoc the rest is kept whole.
 */
export function splitShellCommand(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let op: ShellSegment['op'] = '';
  let cur = '';
  let quote: '' | "'" | '"' | '`' = '';
  let depth = 0;
  const push = (next: ShellSegment['op']) => {
    if (cur.trim()) {
      segments.push({ op, text: cur.trim() });
      op = next;
    }
    cur = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const two = command.slice(i, i + 2);
    if (c === '\\' && quote !== "'") {
      cur += c + (command[i + 1] ?? '');
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      cur += c;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if ((c === ')' || c === '}' || c === ']') && depth > 0) depth--;
    if (two === '<<' && command[i + 2] !== '<') {
      cur += command.slice(i);
      break;
    }
    if (depth === 0) {
      if (two === '&&' || two === '||') {
        push(two);
        i++;
        continue;
      }
      // `>|` and `|&` are redirections, not pipes.
      if (c === '|' && command[i - 1] !== '>') {
        push('|');
        continue;
      }
      if (c === ';' || c === '\n') {
        push(';');
        continue;
      }
    }
    cur += c;
  }
  push('');
  return segments;
}
