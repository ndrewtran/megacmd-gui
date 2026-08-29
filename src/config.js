'use strict';

const path = require('path');

function load() {
  return {
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 3000),
    dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
    accessToken: process.env.ACCESS_TOKEN || '',
  };
}

module.exports = { load };