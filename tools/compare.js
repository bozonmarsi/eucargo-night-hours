#!/usr/bin/env node
// Сверка расчёта с таблицей доплат, заполненной вручную.
//   node tools/compare.js <архив.zip|папка с .DDD> <доплаты.csv> [--year 2026] [--pause 90] [--details]
// Дни после последней выгрузки карты не сравниваются (данных ещё нет).
'use strict';
const fs = require('fs');
const path = require('path');
const NH = require('../src/core.js');

async function loadCards(src) {
  let files;
  if (fs.statSync(src).isDirectory()) {
    files = fs.readdirSync(src).filter((f) => /\.ddd$/i.test(f)).map((f) => ({ name: f, data: new Uint8Array(fs.readFileSync(path.join(src, f))) }));
  } else {
    files = (await NH.readZip(fs.readFileSync(src))).filter((f) => /\.ddd$/i.test(f.name));
  }
  const cards = [];
  for (const f of files) {
    try { cards.push({ ...NH.parseDriverCard(f.data), fileName: f.name }); }
    catch (e) { console.error(`${f.name}: ${e.message}`); }
  }
  return NH.mergeCards(cards);
}

(async () => {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const [src, bonusPath] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--details'));
  const year = +opt('--year', new Date().getFullYear());
  const pause = +opt('--pause', NH.DEFAULTS.maxPaidPauseMin);
  const details = args.includes('--details');

  const bonus = NH.parseBonusTable(NH.decodeText(fs.readFileSync(bonusPath)));
  const byName = new Map(bonus.rows.map((r) => [NH.normName(r.name), r]));
  const cards = await loadCards(src);

  let same = 0, total = 0, diff = 0;
  for (const c of cards) {
    const name = `${c.firstName} ${c.surname}`;
    const ref = byName.get(NH.normName(name));
    if (!ref) { console.log(`?? ${name}: нет в таблице доплат`); continue; }
    const lastDay = c.days.length ? c.days[c.days.length - 1].date : 0;
    const res = NH.nightHours(c, year, bonus.month, { maxPaidPauseMin: pause });
    const bad = [];
    for (const r of res) {
      const dayTs = Date.UTC(year, bonus.month - 1, r.day);
      if (dayTs >= lastDay) continue;
      const mv = NH.parseNum(ref.values[r.day]);
      if (mv == null || r.hours == null) continue;
      total++;
      if (mv === r.hours) same++;
      else { diff += r.hours - mv; bad.push(`${r.day}: расчёт ${NH.fmtNum(r.hours)} / вручную ${NH.fmtNum(mv)}`); }
    }
    console.log(`${name.padEnd(28)} ${bad.length ? bad.join(' · ') : 'всё совпало'}`);
    if (details) {
      for (const b of bad) {
        const d = +b.split(':')[0];
        const tl = NH.nightTimeline(c, year, bonus.month, d)
          .map((s) => `${new Date(s.start).toLocaleString('ru-RU', { timeZone: NH.DEFAULTS.timeZone, day: '2-digit', hour: '2-digit', minute: '2-digit' })} ${s.act}${s.cardOut ? '*' : ''}`);
        console.log(`     ${d}: ${tl.join(' | ')}`);
      }
    }
  }
  console.log(`\nСовпало ${same} из ${total} дней (${total ? Math.round(100 * same / total) : 0}%), сумма расхождений ${NH.fmtNum(diff)} ч`);
})().catch((e) => { console.error(e); process.exit(1); });
