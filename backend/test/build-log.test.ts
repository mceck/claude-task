import { describe, expect, it } from 'vitest';
import { BuildLogCompactor } from '../src/agents/build-log';

function compact(chunks: string[]) {
  const c = new BuildLogCompactor();
  return chunks.map((x) => c.push(x)).join('') + c.end();
}

describe('BuildLogCompactor', () => {
  it('drops progress bars, byte counters and bare Downloading lines', () => {
    const out = compact([
      '\u001b[0m\u001b[91mmise ✓ python@3.14.10  39.3s\n',
      '\u001b[0m\u001b[91mmise ███████░░░ 1/3 · 39.9s\n',
      ' claude@2.1.310   downloading  39.6s  43.2/130.3 MB · 1.1 MB/s\n',
      'Downloading\nDownloading\n',
      'Step 2/3 : RUN true\n',
    ]);
    expect(out).toBe('mise ✓ python@3.14.10  39.3s\nStep 2/3 : RUN true\n');
  });

  it('keeps the last carriage-return redraw and joins split chunks', () => {
    expect(compact(['10%\r50%\rdo', 'ne\nnext\n'])).toBe('done\nnext\n');
  });

  it('collapses repeated lines and blank runs', () => {
    expect(compact(['a\na\n\n\n\u001b[2K\nb'])).toBe('a\n\nb\n');
  });
});
