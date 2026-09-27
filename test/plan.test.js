'use strict';
const test = require('node:test');
const assert = require('node:assert');
const NH = require('../src/core.js');

// ---- минимальный zip (без сжатия) для синтетического .ods / .xlsx
function zip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data); central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

// ---- недельный лист: столбец 0 — подписи, дальше 168 часовых колонок с понедельника 00:00
function cell(text, { span = 1, style } = {}) {
  const a = [style ? ` table:style-name="${style}"` : '', span > 1 ? ` table:number-columns-spanned="${span}"` : ''].join('');
  const body = text ? text.split('\n').map((t) => `<text:p>${t}</text:p>`).join('') : '';
  const cov = span > 1 ? `<table:covered-table-cell table:number-columns-repeated="${span - 1}"/>` : '';
  return `<table:table-cell${a}>${body}</table:table-cell>${cov}`;
}
function rowXml(label, items) {
  // items: [{h, span, text, style}] по возрастанию часа
  let out = cell(label), col = 0;
  for (const it of items) {
    if (it.h > col) out += `<table:table-cell table:number-columns-repeated="${it.h - col}"/>`;
    out += cell(it.text, { span: it.span, style: it.style });
    col = it.h + (it.span || 1);
  }
  return `<table:table-row>${out}</table:table-row>`;
}
function ods(rows) {
  const days = ['pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota', 'neděle'];
  const hdr = cell('KW 36') + days.map((d, i) => cell(`${d}, září ${String(7 + i).padStart(2, '0')}, 2026`, { span: 24 })).join('');
  const hours = cell('') + Array.from({ length: 7 }, () => cell('24') + Array.from({ length: 23 }, (_, i) => cell(String(i + 1))).join('')).join('');
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x" xmlns:style="s" xmlns:fo="f">
<office:automatic-styles><style:style style:name="rest" style:family="table-cell"><style:table-cell-properties fo:background-color="#F79646"/></style:style>
<style:style style:name="blue" style:family="table-cell"><style:table-cell-properties fo:background-color="#00B0F0"/></style:style>
<style:style style:name="grey" style:family="table-cell"><style:table-cell-properties fo:background-color="#C0C0C0"/></style:style></office:automatic-styles>
<office:body><office:spreadsheet><table:table table:name="KW_37"><table:table-row>${hdr}</table:table-row><table:table-row>${hours}</table:table-row>${rows.join('')}</table:table></office:spreadsheet></office:body></office:document-content>`;
  return zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'content.xml': content });
}
const H = (day, hour) => (day - 7) * 24 + hour; // колонка часа для даты 07..13.09

test('план: рейс ночью, REST, деление ночи между датами', async () => {
  const sheets = await NH.readOds(ods([
    rowXml('1ABC 123\n9XX 0001', []),
    rowXml('Ivan\nTestenko', [
      { h: H(7, 20), span: 8, text: 'AAA-BBB\nX1', style: 'blue' },   // 07.09 20:00 → 08.09 04:00
      { h: H(8, 4), span: 11, text: 'REST', style: 'rest' },
    ]),
  ]));
  const drv = NH.planTimelines(sheets).get(NH.normName('Ivan Testenko'));
  assert.ok(drv, 'водитель найден');
  const r = NH.planNightHours(drv, 2026, 9);
  assert.strictEqual(r[6].hours, 2);   // 07.09: 22–24
  assert.strictEqual(r[7].hours, 4);   // 08.09: 00–04
  assert.strictEqual(r[8].hours, 0);
  assert.strictEqual(r[20].status, 'nodata'); // недели нет в плане
});

test('план: REST в строке машины отменяет рейс, отдых до отметки «s»', async () => {
  const sheets = await NH.readOds(ods([
    rowXml('1ABC 123\n9XX 0001', [
      { h: H(8, 2), span: 11, text: 'REST', style: 'rest' },   // 08.09 02:00–13:00
      { h: H(9, 17), span: 9, text: 'REST1', style: 'rest' },  // 09.09 17:00 → 10.09 02:00
      { h: H(10, 5), text: 's', style: 'grey' },               // старт 10.09 05:00
    ]),
    rowXml('Mykola\nTestov', [
      { h: H(7, 15), span: 24, text: 'CCC-DDD-AAA', style: 'blue' }, // 07.09 15:00 → 08.09 15:00
      { h: H(9, 10), span: 24, text: 'EEE-FFF', style: 'blue' },          // 09.09 10:00 → 10.09 10:00
    ]),
  ]));
  const drv = NH.planTimelines(sheets).get(NH.normName('Mykola Testov'));
  const r = NH.planNightHours(drv, 2026, 9);
  assert.strictEqual(r[6].hours, 2);   // 07.09 22–24 рейс
  assert.strictEqual(r[7].hours, 2);   // 08.09 00–02 рейс, дальше REST в строке машины
  assert.strictEqual(r[9].hours, 1);   // 10.09: REST до 02:00, отдых до «s» в 05:00, работа 05–06
  assert.strictEqual(r[8].hours, 0);   // 09.09 22–24 — REST1 в строке машины
});

test('план: пусто между рейсами — работа; NO DRIVER, Docs — нет; empty to load — работа', async () => {
  const sheets = await NH.readOds(ods([
    rowXml('1ABC 123\n9XX 0001', []),
    rowXml('Petro\nTestiv', [
      { h: H(7, 18), span: 5, text: 'BBB-AAA', style: 'blue' },   // до 23:00
      { h: H(8, 0), span: 2, text: 'empty to load' },             // 23:00 пусто, 00–02 empty to load
      { h: H(8, 2), span: 3, text: 'AAA-EEE', style: 'blue' },    // 02–05
      { h: H(8, 5), span: 20, text: 'REST', style: 'rest' },
      { h: H(9, 1), span: 24, text: 'NO DRIVER' },
      { h: H(10, 22), span: 2, text: 'XXX\nDocs' },
    ]),
  ]));
  const drv = NH.planTimelines(sheets).get(NH.normName('Petro Testiv'));
  const r = NH.planNightHours(drv, 2026, 9);
  assert.strictEqual(r[6].hours, 2);   // 07.09: 22 рейс + 23 пусто между рейсами
  assert.strictEqual(r[7].hours, 5);   // 08.09: 00–05
  assert.strictEqual(r[9].hours, 0);   // NO DRIVER
  assert.strictEqual(r[10].hours, 0);  // Docs
});

test('таблица доплат из .xlsx: даты-числа в заголовке', async () => {
  const sheet = `<worksheet><sheetData>
<row r="1"><c r="C1" t="s"><v>0</v></c><c r="D1"><v>46235</v></c><c r="E1"><v>46236</v></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1</v></c><c r="C2" t="s"><v>2</v></c><c r="D2"><v>2</v></c><c r="E2"><v>4.5</v></c></row>
</sheetData></worksheet>`;
  const buf = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Август" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Имя:</t></si><si><t>CZ</t></si><si><t>Ivan Testenko</t></si></sst>',
    'xl/worksheets/sheet1.xml': sheet,
  });
  const [m] = NH.bonusFromXlsx(await NH.readXlsx(buf));
  assert.strictEqual(m.year, 2026);
  assert.strictEqual(m.month, 8);
  assert.strictEqual(m.rows[0].name, 'Ivan Testenko');
  assert.strictEqual(m.rows[0].values[1], '2');
  assert.strictEqual(m.rows[0].values[2], '4,5');
});
