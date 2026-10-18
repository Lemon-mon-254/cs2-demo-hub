#!/usr/bin/env node
'use strict';

const {main} = require('../src/cli');

main(process.argv.slice(2)).catch((err) => {
  console.error(`错误：${err && err.message ? err.message : err}`);
  if (process.env.DEBUG && err && err.stack) {
    console.error(err.stack);
  }
  process.exitCode = 1;
});
