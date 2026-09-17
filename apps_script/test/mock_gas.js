// Minimal Google Apps Script runtime mock, just enough to execute apps_script/Code.gs
// unmodified and drive it through the real login/status/logout/kick/expiry flows.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeSheet {
  constructor(headers, rows) {
    this.headers = headers.slice();
    this.rows = rows.map(r => r.slice());
  }
  getDataRange() {
    return { getValues: () => [this.headers, ...this.rows] };
  }
  getLastColumn() { return this.headers.length; }
  getRange(a, b, c, d) {
    // getRange(1,1,1,lastCol) -> header row read; getRange(row,1,1,N) -> data
    // row read (row > 1); getRange(row, col) -> single cell write.
    if (c !== undefined && d !== undefined) {
      const self = this;
      return {
        getValues: () => {
          if (a === 1) return [self.headers.slice(b - 1, b - 1 + d)];
          const dataRow = self.rows[a - 2] || [];
          return [dataRow.slice(b - 1, b - 1 + d)];
        },
      };
    }
    const rowIdx = a - 1;
    const colIdx = b - 1;
    const self = this;
    return {
      setValue(v) {
        if (rowIdx === 0) { self.headers[colIdx] = v; return; }
        const dataRow = rowIdx - 1;
        while (self.rows.length <= dataRow) self.rows.push(new Array(self.headers.length).fill(''));
        self.rows[dataRow][colIdx] = v;
      },
      getValue() {
        if (rowIdx === 0) return self.headers[colIdx];
        return self.rows[rowIdx - 1][colIdx];
      }
    };
  }
  appendRow(row) { this.rows.push(row.slice()); }
  deleteRow(sheetRow) { this.rows.splice(sheetRow - 2, 1); } // sheetRow is 1-based incl. header
}

function buildSandbox({ sharedSecret, sheets, active }) {
  const props = { SHARED_SECRET: sharedSecret };
  const alerts = [];
  const scriptCacheStore = {};
  // `active` = { sheetName, row } - what the fake "admin cursor" is on,
  // mirroring getActiveSheet()/getActiveRange() in the real Sheets UI.
  const activeState = active || { sheetName: null, row: 0 };
  const ui = {
    ButtonSet: { OK: 'OK' },
    alert: (...args) => { alerts.push(args.join(' | ')); },
  };

  const sandbox = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => props[k] || null,
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => sheets[name] || null,
        insertSheet: (name) => {
          sheets[name] = new FakeSheet([], []);
          return sheets[name];
        },
      }),
      getUi: () => ui,
      getActiveSheet: () => {
        const sheet = sheets[activeState.sheetName];
        if (!sheet) return { getName: () => activeState.sheetName || '' };
        sheet._name = activeState.sheetName;
        sheet.getName = () => activeState.sheetName;
        sheet.getActiveRange = () =>
          activeState.row ? { getRow: () => activeState.row } : null;
        return sheet;
      },
    },
    Utilities: {
      getUuid: () => 'uuid-' + Math.random().toString(36).slice(2, 10),
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
    },
    // Ignores the TTL argument entirely (no wall-clock in this test harness);
    // tests that care about expiry call scriptCacheStore.clear() themselves
    // to simulate it, via the `cache` object returned from buildSandbox().
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in scriptCacheStore ? scriptCacheStore[k] : null),
        put: (k, v) => { scriptCacheStore[k] = v; },
        remove: (k) => { delete scriptCacheStore[k]; },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({
        _text: text,
        setMimeType() { return this; },
      }),
    },
    Date: Date,
    JSON: JSON,
    String: String,
    Math: Math,
    Object: Object,
    isNaN: isNaN,
  };
  sandbox.global = sandbox;
  return { sandbox, alerts, activeState, scriptCacheStore };
}

function loadCode(sandbox, codePath) {
  const code = fs.readFileSync(codePath, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'Code.gs' });
  return sandbox;
}

function call(sandbox, fnName, arg) {
  const fn = sandbox[fnName];
  const result = fn(arg);
  return JSON.parse(result._text);
}

module.exports = { FakeSheet, buildSandbox, loadCode, call };
