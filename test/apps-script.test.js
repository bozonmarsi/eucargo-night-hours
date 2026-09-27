'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/main.js'), 'utf8'), ctx);
  return ctx;
}

test('Apps Script: объединённые ячейки листа превращаются в блоки плана', () => {
  const ctx = load();
  const hdr = ['KW 37', 'pondělí, září 07, 2026', ...Array(23).fill(''), 'úterý, září 08, 2026', ...Array(23).fill('')];
  const hours = ['', ...Array.from({ length: 48 }, (_, i) => String(i % 24 || 24))];
  const truck = ['1ABC 123\n9XX 0001', ...Array(48).fill('')];
  const drv = ['Ivan\nTestenko', ...Array(48).fill('')];
  drv[1 + 20] = 'AAA-BBB';   // 07.09 20:00, 8 ч
  drv[1 + 28] = 'REST';      // 08.09 04:00
  const display = [hdr, hours, truck, drv];
  const bg = display.map((r) => r.map(() => '#ffffff'));
  bg[3][21] = '#00b0f0'; bg[3][29] = '#f79646';
  const merges = [{ row: 3, col: 21, rows: 1, cols: 8 }, { row: 3, col: 29, rows: 1, cols: 11 }];
  const grid = ctx.nhGridFromSheet(display, bg, merges);
  assert.strictEqual(grid[3][21].span, 8);
  assert.strictEqual(grid[3][22].cov, true);
  const d = ctx.NightHours.planTimelines([{ name: 'KW_37', rows: grid }]).get(ctx.NightHours.normName('Ivan Testenko'));
  const r = ctx.NightHours.planNightHours(d, 2026, 9);
  assert.strictEqual(r[6].hours, 2);
  assert.strictEqual(r[7].hours, 4);
});
