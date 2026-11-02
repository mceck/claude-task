/** `<name> (copy)`, then `(copy 2)`, … : the first one not taken (ignoring case), within the 100-character limit. */
export function copyName(source: string, taken: string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    const candidate = `${source.slice(0, 100 - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
