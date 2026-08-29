'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * List immediate subfolders of a directory on the machine this process runs
 * on. Only directories are returned (files and broken symlinks dropped).
 */
async function listLocalDirectories(requestedPath) {
  const input = String(requestedPath || os.homedir());
  if (!path.isAbsolute(input)) throw new Error('Directory path must be absolute');

  let current;
  try {
    current = await fs.promises.realpath(path.resolve(input));
  } catch (err) {
    throw new Error(`Cannot open directory: ${err.message}`);
  }

  let dirents;
  try {
    dirents = await fs.promises.readdir(current, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read directory: ${err.message}`);
  }

  const entries = (await Promise.all(dirents.map(async (entry) => {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) return { name: entry.name, path: entryPath };
    if (!entry.isSymbolicLink()) return null;
    try {
      const stat = await fs.promises.stat(entryPath);
      return stat.isDirectory() ? { name: entry.name, path: entryPath, symlink: true } : null;
    } catch {
      return null;
    }
  }))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const root = path.parse(current).root;
  return {
    path: current,
    root,
    parent: current === root ? null : path.dirname(current),
    entries,
  };
}

module.exports = { listLocalDirectories };