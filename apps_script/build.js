#!/usr/bin/env node
// Concatenates apps_script/src/*.gs (filename order) into apps_script/Code.gs.
//
// Apps Script projects do support several .gs files, but every extra file is
// one more thing an admin has to create and keep in sync by hand in the web
// editor - and mismatched files there have already cost this project three
// broken deployments. So the source of truth is split for development, and
// the deployed artifact stays a single file to paste.
//
//   node apps_script/build.js          # regenerate Code.gs
//   node apps_script/build.js --check  # fail if Code.gs is out of date (CI)
'use strict';
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'Code.gs');

const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.gs')).sort();
if (files.length === 0) {
  console.error('No .gs sources in ' + SRC_DIR);
  process.exit(1);
}

const generated = files
    .map(f => fs.readFileSync(path.join(SRC_DIR, f), 'utf8').replace(/\n+$/, ''))
    .join('\n\n') + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== generated) {
    console.error('Code.gs is out of date with src/. Run: node apps_script/build.js');
    process.exit(1);
  }
  console.log('Code.gs is up to date with src/ (' + files.length + ' modules).');
  process.exit(0);
}

fs.writeFileSync(OUT, generated);
console.log('Wrote Code.gs from ' + files.length + ' modules: ' + files.join(', '));
