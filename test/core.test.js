'use strict';
const test = require('node:test');
const assert = require('node:assert');
const NH = require('../src/core.js');

// ---- синтетический файл карты водителя (формат Gen1: EF 0520 + EF 0504)
function field(str, len) { const b = Buffer.alloc(len, 0x20); b.write(str, 'latin1'); return b; }
function tlvBlock(fid, type, data) { const h = Buffer.alloc(5); h.writeUInt16BE(fid, 0); h[2] = type; h.writeUInt16BE(data.length, 3); return Buffer.concat([h, data]); }
function makeCard({ first, last, card, days }) {
  const ident = Buffer.concat([Buffer.from([0x1a]), field(card, 16), Buffer.from([1]), field('AUTH', 35), Buffer.alloc(12),
    Buffer.from([1]), field(last, 35), Buffer.from([1]), field(first, 35), Buffer.alloc(6)]);
  const recs = [];
  let prevLen = 0;
  for (const d of days) {
    const body = Buffer.alloc(12 + 2 * d.changes.length);
    const len = body.length;
    body.writeUInt16BE(prevLen, 0); body.writeUInt16BE(len, 2);
    body.writeUInt32BE(Date.UTC(...d.date) / 1000, 4);
    d.changes.forEach(([act, minute, cardOut], i) => body.writeUInt16BE(((cardOut ? 1 : 0) << 13) | (act << 11) | minute, 12 + 2 * i));
    recs.push(body); prevLen = len;
  }
  const buf = Buffer.concat([...recs, Buffer.alloc(64)]);
  const newest = buf.length - 64 - recs[recs.length - 1].length;
  const act = Buffer.concat([Buffer.from([0, 0, newest >> 8, newest & 255]), buf]);
  return new Uint8Array(Buffer.concat([tlvBlock(0x0520, 0, ident), tlvBlock(0x0504, 0, act)]));
}
const REST = 0, AVAIL = 1, WORK = 2, DRIVE = 3;
const loc = (h, m = 0) => (h - 2) * 60 + m; // Прага летом = UTC+2, минуты от полуночи UTC

test('округление до получаса по правилам бухгалтерии', () => {
  const cases = { 66: 1, 74: 1, 77: 1.5, 80: 1.5, 100: 1.5, 103: 1.5, 107: 2, 115: 2, 0: 0, 14: 0, 15: 0.5, 45: 1, 480: 8 };
  for (const [min, h] of Object.entries(cases)) assert.strictEqual(NH.roundHours(+min), h, `${min} мин`);
});

test('разбор карты: имя, номер, активности', () => {
  const bytes = makeCard({ first: 'IVAN', last: 'TESTENKO', card: 'UA00000000001234', days: [
    { date: [2026, 8, 10], changes: [[REST, 0], [DRIVE, 600], [REST, 900]] },
  ] });
  const c = NH.parseDriverCard(bytes);
  assert.strictEqual(c.firstName, 'IVAN');
  assert.strictEqual(c.surname, 'TESTENKO');
  assert.strictEqual(c.cardNumber, 'UA00000000001234');
  assert.strictEqual(c.days.length, 1);
  assert.deepStrictEqual(c.days[0].changes.map((x) => [x.act, x.minute]), [[0, 0], [3, 600], [0, 900]]);
});

test('ночь 22:00–05:59 делится между двумя датами (местное время)', () => {
  // Едет 10.09 с 21:00 до 11.09 03:10 по Праге
  const card = NH.parseDriverCard(makeCard({ first: 'A', last: 'B', card: 'X', days: [
    { date: [2026, 8, 10], changes: [[REST, 0], [DRIVE, loc(21)]] },
    { date: [2026, 8, 11], changes: [[DRIVE, 0], [REST, loc(3, 10)]] },
    { date: [2026, 8, 12], changes: [[REST, 0]] },
  ] }));
  const r = NH.nightHours(card, 2026, 9, { timeZone: 'Europe/Prague' });
  assert.strictEqual(r[9].hours, 2);    // 10.09: 22:00–24:00
  assert.strictEqual(r[10].hours, 3);   // 11.09: 00:00–03:10 -> 3:10 -> 3
  assert.strictEqual(r[10].status, 'ok');
});

test('короткая пауза между работой идёт в зачёт, длинная — нет', () => {
  const card = NH.parseDriverCard(makeCard({ first: 'A', last: 'B', card: 'X', days: [
    { date: [2026, 8, 14], changes: [[REST, 0], [DRIVE, loc(2)], [REST, loc(3)], [WORK, loc(3, 40)], [REST, loc(4)], [DRIVE, loc(5, 30)], [REST, loc(6)]] },
    { date: [2026, 8, 15], changes: [[REST, 0]] },
  ] }));
  // вождение 1:00 + пауза 0:40 (в зачёт) + работа 0:20 + пауза 1:30 (нет) + вождение 0:30 = 2:30
  const r = NH.nightHours(card, 2026, 9, { timeZone: 'Europe/Prague', maxPaidPauseMin: 90 });
  assert.strictEqual(r[13].paidMin, 150);
  assert.strictEqual(r[13].hours, 2.5);
  const r0 = NH.nightHours(card, 2026, 9, { timeZone: 'Europe/Prague', maxPaidPauseMin: 0 });
  assert.strictEqual(r0[13].paidMin, 110);
});

test('готовность (ожидание) оплачивается', () => {
  const card = NH.parseDriverCard(makeCard({ first: 'A', last: 'B', card: 'X', days: [
    { date: [2026, 8, 20], changes: [[REST, 0], [AVAIL, loc(3)], [REST, loc(5)]] },
    { date: [2026, 8, 21], changes: [[REST, 0]] },
  ] }));
  assert.strictEqual(NH.nightHours(card, 2026, 9)[19].hours, 2);
});

test('день без записей на карте — «нет данных»', () => {
  const card = NH.parseDriverCard(makeCard({ first: 'A', last: 'B', card: 'X', days: [
    { date: [2026, 8, 1], changes: [[REST, 0]] },
    { date: [2026, 8, 5], changes: [[REST, 0]] },
  ] }));
  const r = NH.nightHours(card, 2026, 9);
  assert.strictEqual(r[2].status, 'nodata');
  assert.strictEqual(r[2].hours, null);
});

test('объединение выгрузок и сопоставление имён', () => {
  const a = { firstName: 'TARAS', surname: 'TESTENKO', cardNumber: 'C1', days: [{ date: 1, changes: [1] }] };
  const b = { firstName: 'TARAS', surname: 'TESTENKO', cardNumber: 'C1', days: [{ date: 1, changes: [1, 2] }, { date: 2, changes: [] }] };
  const m = NH.mergeCards([a, b]);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].days.length, 2);
  assert.strictEqual(m[0].days[0].changes.length, 2);
  assert.strictEqual(NH.normName('Taras                        Testenko'), NH.normName('TESTENKO TARAS'));
  assert.strictEqual(NH.normName('Oleh Prykladov NO EXP'), NH.normName('Oleh Prykladov '));
});

test('таблица доплат и диспетчерский план', () => {
  const bonus = NH.parseBonusTable(',,Имя:,01.09,02.09,Итого:\nCZ,1,Ivan Test,2,"4,5",\nCZ,2,Petro Test,off,off,\n');
  assert.strictEqual(bonus.month, 9);
  assert.strictEqual(bonus.rows[0].values[2], '4,5');
  const hdr = ['KW 39', 'pondělí, září 21, 2026', ...Array(23).fill(''), 'úterý, zá?í 22, 2026', ...Array(23).fill('')].join(';');
  const hours = ['', '24', ...Array.from({ length: 23 }, (_, i) => i + 1), '24', ...Array.from({ length: 23 }, (_, i) => i + 1)].join(';');
  const cells = Array(49).fill(''); cells[0] = 'Ivan Test'; cells[1 + 20] = 'AAA-BBB'; cells[25 + 3] = 'REST';
  const plan = NH.parseDispatchPlan([hdr, hours, cells.join(';')].join('\n'));
  assert.deepStrictEqual(plan.dates.map((d) => [d.m, d.d]), [[9, 21], [9, 22]]);
  const drv = plan.drivers.get(NH.normName('Ivan Test'));
  assert.ok(NH.planHint(drv, 2026, 9, 21).includes('22–24: 21.09 20:00 «AAA-BBB»'));
  assert.ok(NH.planHint(drv, 2026, 9, 22).includes('00–06: 22.09 03:00 «REST»'));
});
