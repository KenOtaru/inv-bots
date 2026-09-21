'use strict';

const fs = require('fs');
const path = require('path');

class BinanceOptionsStateStore {
  constructor(file = path.join(__dirname, '..', 'binance-options-state.json')) { this.file = file; }
  load() {
    try { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null; }
    catch (error) { console.error(`[STATE] Cannot load ${this.file}: ${error.message}`); return null; }
  }
  save(snapshot) {
    try {
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ savedAt: Date.now(), ...snapshot }, null, 2));
      fs.renameSync(temp, this.file);
    } catch (error) { console.error(`[STATE] Cannot save ${this.file}: ${error.message}`); }
  }
}
module.exports = { BinanceOptionsStateStore };
