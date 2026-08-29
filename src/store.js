'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny JSON-file store with atomic writes (tmp + rename) and debounced saves.
 */
class JsonStore {
  constructor(dir, name) {
    this.file = path.join(dir, `${name}.json`);
    this.timer = null;
    this.data = { ...defaultData(name) };
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = { ...defaultData(name), ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[store] could not read ${this.file}: ${err.message}`);
      }
    }
  }

  get() {
    return this.data;
  }

  set(data) {
    this.data = data;
    this.scheduleSave();
  }

  update(mutator) {
    const next = structuredClone(this.data);
    mutator(next);
    this.data = next;
    this.scheduleSave();
    return next;
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, 150);
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[store] save failed for ${this.file}: ${err.message}`);
    }
  }

  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.saveNow();
  }
}

function defaultData(name) {
  switch (name) {
    case 'instances':
      return { instances: [], seq: 1 };
    case 'jobs':
      return { jobs: {}, order: {}, seq: 1 };
    default:
      return {};
  }
}

module.exports = { JsonStore };