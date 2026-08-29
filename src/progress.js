'use strict';

/**
 * Parser for MEGAcmd's non-interactive (piped) output.
 *
 * Transfer progress updates look like:
 *   TRANSFERRING ||###.....||(36/726 KB:   4.98 %)
 * and are separated from the rest of the stream by NUL (\0) bytes.
 *
 * Other output is newline separated, e.g.:
 *   Download finished: /path/to/file
 *   [2026-08-29_01-43-43.880313 cmd ERR  Couldn't find ...]
 */

const UNIT_FACTORS = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
  PB: 1024 ** 5,
};

// TRANSFERRING ||<bar>||(<done>/<total> <unit>: <pct> %)
const PROGRESS_RE =
  /^TRANSFERRING\s+\|\|[\s\S]*?\|\|\(\s*(\d+)\s*\/\s*(\d+)\s+([A-Za-z]+B)\s*:\s*(\d+(?:\.\d+)?)\s*%\s*\)?$/;

function parseProgressLine(line) {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const factor = UNIT_FACTORS[m[3].toUpperCase()] || 1;
  const done = Number(m[1]) * factor;
  const total = Number(m[2]) * factor;
  const pct = Math.max(0, Math.min(100, Number(m[4])));
  return {
    doneBytes: done,
    totalBytes: total,
    pct,
    // finer sub-unit estimate derived from the percentage
    smoothDone: total > 0 ? (pct / 100) * total : done,
  };
}

class ProgressParser {
  constructor() {
    this.buf = '';
  }

  /**
   * Feed a raw chunk. Returns { progress: latest|updated progress or null,
   * lines: [non-progress lines] }.
   */
  push(chunk) {
    this.buf += chunk;
    const parts = this.buf.split(/\u0000|\r\n|\r|\n/);
    this.buf = parts.pop();
    const out = { progress: null, lines: [] };
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      const p = parseProgressLine(line);
      if (p) out.progress = p;
      else out.lines.push(line);
    }
    return out;
  }

  /** Flush anything left in the buffer (end of stream). */
  flush() {
    const out = { progress: null, lines: [] };
    if (this.buf) {
      const line = this.buf.trim();
      this.buf = '';
      if (line) {
        const p = parseProgressLine(line);
        if (p) out.progress = p;
        else out.lines.push(line);
      }
    }
    return out;
  }
}

function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function humanSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  return `${humanBytes(bytesPerSec)}/s`;
}

module.exports = { ProgressParser, parseProgressLine, humanBytes, humanSpeed };