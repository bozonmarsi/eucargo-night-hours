#!/usr/bin/env node
// Сверка расчёта по диспетчерскому плану с ручной таблицей доплат.
//   node tools/compare-plan.js <план.ods> <доплаты.xlsx> [--details]
'use strict';
const fs = require('fs');
const NH = require('../src/core.js');

(async () => {
  const [odsPath, xlsxPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const details = process.argv.includes('--details');
  const t0 = Date.now();
  const drivers = NH.planTimelines(await NH.readOds(fs.readFileSync(odsPath)));
  const months = NH.bonusFromXlsx(await NH.readXlsx(fs.readFileSync(xlsxPath)));
  console.log(`план: ${drivers.size} водителей, таблица: ${months.map((m) => `${m.sheet} (${m.rows.length})`).join(', ')} · ${Date.now() - t0} мс`);
  const tot = { n: 0, ok: 0, near: 0, half: 0, check: 0, checkOk: 0 };
  const missing = new Set();
  for (const mo of months) {
    const s = { n: 0, ok: 0, near: 0 };
    for (const row of mo.rows) {
      const drv = drivers.get(NH.normName(row.name));
      if (!drv) { missing.add(row.name); continue; }
      const res = NH.planNightHours(drv, mo.year, mo.month);
      for (const r of res) {
        const mv = NH.parseNum(row.values[r.day]);
        if (mv == null || r.hours == null) continue;
        s.n++; tot.n++;
        const ok = r.hours === mv;
        s.ok += ok; tot.ok += ok;
        s.near += Math.abs(r.hours - mv) <= 1; tot.near += Math.abs(r.hours - mv) <= 1;
        tot.half += Math.abs(r.hours - mv) === 0.5;
        if (r.status === 'check') { tot.check++; tot.checkOk += ok; }
        if (details && Math.abs(r.hours - mv) > 1) console.log(`   ${row.name} ${r.day}.${mo.month}: план ${r.hours}, вручную ${mv} ${r.notes.join('; ')}`);
      }
    }
    if (s.n) console.log(`${mo.sheet}: дней ${s.n}, точно ${(100 * s.ok / s.n).toFixed(1)}%, ±1 ч ${(100 * s.near / s.n).toFixed(1)}%`);
  }
  const pct = (a) => (100 * a / tot.n).toFixed(1) + '%';
  console.log(`ВСЕГО: дней ${tot.n}, точно ${pct(tot.ok)}, ±1 ч ${pct(tot.near)}, ровно полчаса ${pct(tot.half)}`);
  console.log(`помечено «проверить» ${tot.check} дней (${pct(tot.check)}), из них совпало ${tot.check ? (100 * tot.checkOk / tot.check).toFixed(0) : 0}%`);
  if (missing.size) console.log('нет в плане:', [...missing].join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
