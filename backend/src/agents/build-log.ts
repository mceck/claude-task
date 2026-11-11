// Matches CSI (colors, cursor moves, erases) and OSC escape sequences.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const BAR = /[█▉▊▋▌▍▎▏▒░▓]/;
const TRANSFER = /\b(?:downloading|extracting)\b.*\d\s*[kMGT]?i?B\b/i;
const BARE_PROGRESS = /^\s*(?:downloading|extracting|waiting)\s*$/i;

/**
 * Turns raw image build output into a compact log: strips terminal escapes, keeps only the last
 * `\r` redraw of a line, and drops transient progress lines (progress bars, byte counters, bare
 * "Downloading") that would otherwise fill the log with repeated updates.
 */
export class BuildLogCompactor {
  private pending = '';
  private last: string | null = null;

  /** Feeds a raw chunk and returns the compact text of the lines it completed. */
  push(chunk: string): string {
    const parts = (this.pending + chunk).split('\n');
    this.pending = parts.pop() ?? '';
    return parts.map((line) => this.line(line)).join('');
  }

  /** Returns what is still buffered, at the end of the output. */
  end(): string {
    const rest = this.pending;
    this.pending = '';
    return rest ? this.line(rest) : '';
  }

  private line(raw: string): string {
    const redrawn = raw.split('\r').filter((s) => s.replace(ANSI, '').trim()).pop() ?? '';
    const text = redrawn.replace(ANSI, '').trimEnd();
    if (!text.trim()) return this.last === '' || this.last === null ? '' : this.emit('');
    if (BAR.test(text) || TRANSFER.test(text) || BARE_PROGRESS.test(text)) return '';
    if (text === this.last) return '';
    return this.emit(text);
  }

  private emit(text: string): string {
    this.last = text;
    return `${text}\n`;
  }
}
