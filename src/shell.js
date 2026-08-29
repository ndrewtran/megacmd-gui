'use strict';

// Conservative "safe" characters that need no quoting in a POSIX shell.
const SAFE_RE = /^[A-Za-z0-9_\-./=:@%^,]+$/;

function quoteArg(arg) {
  const s = String(arg);
  if (s.length === 0) return "''";
  if (SAFE_RE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function toShellCommand(parts) {
  return parts.map(quoteArg).join(' ');
}

module.exports = { quoteArg, toShellCommand };