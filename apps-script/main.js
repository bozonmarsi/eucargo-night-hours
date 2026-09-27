/*
 * Google Apps Script для таблицы доплат: заполняет ночные часы по диспетчерскому плану.
 * Логика расчёта — та же, что в src/core.js (подключается при сборке, см. tools/build.js).
 *
 * Установка: Расширения → Apps Script → вставить dist/NightHours.gs целиком → Сохранить.
 * После обновления таблицы появится меню «Ночные часы».
 */

/* global SpreadsheetApp, PropertiesService, Session, Utilities, NightHours */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Ночные часы')
    .addItem('Заполнить пустые ячейки этого листа', 'nhFillEmpty')
    .addItem('Пересчитать лист (заменить все числа)', 'nhFillAll')
    .addSeparator()
    .addItem('Указать ссылку на диспетчерский план', 'nhSetPlan')
    .addToUi();
}

function nhSetPlan() {
  const ui = SpreadsheetApp.getUi();
  const cur = PropertiesService.getDocumentProperties().getProperty('PLAN_ID') || '';
  const r = ui.prompt('Диспетчерский план', 'Вставьте ссылку на Google Таблицу с планом (листы KW..).' + (cur ? '\nСейчас: ' + cur : ''), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const m = /\/d\/([a-zA-Z0-9_-]+)/.exec(r.getResponseText()) || /^([a-zA-Z0-9_-]{20,})$/.exec(r.getResponseText().trim());
  if (!m) { ui.alert('Не похоже на ссылку Google Таблицы.'); return; }
  PropertiesService.getDocumentProperties().setProperty('PLAN_ID', m[1]);
  ui.alert('Сохранено. Теперь откройте лист месяца и выберите «Ночные часы → Заполнить».');
}

function nhFillEmpty() { nhFill_(false); }
function nhFillAll() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.alert('Пересчитать лист?', 'Все числа в днях будут заменены расчётом по плану, в том числе исправленные вручную. Текст (off, уволен) останется.', ui.ButtonSet.OK_CANCEL);
  if (r === ui.Button.OK) nhFill_(true);
}

/** Сетка листа плана в формате NightHours.planTimelines: [[{t, bg, span, cov}]]. */
function nhGridFromSheet(display, backgrounds, merges) {
  const g = display.map((row, i) => row.map((t, j) => ({ t: String(t || ''), bg: (backgrounds[i] && backgrounds[i][j]) || null, span: 1, cov: false })));
  for (const m of merges) {
    // m: {row, col, rows, cols} — от нуля
    const top = g[m.row] && g[m.row][m.col];
    if (!top) continue;
    top.span = m.cols;
    for (let r = m.row; r < m.row + m.rows; r++) {
      for (let c = m.col; c < m.col + m.cols; c++) {
        if ((r !== m.row || c !== m.col) && g[r] && g[r][c]) g[r][c].cov = true;
      }
    }
  }
  return g;
}

function nhReadPlan_(planId, fromTs, toTs) {
  const ss = SpreadsheetApp.openById(planId);
  const sheets = [];
  for (const sh of ss.getSheets()) {
    if (!/KW/i.test(sh.getName())) continue;
    const lastCol = Math.min(sh.getLastColumn(), 400), lastRow = sh.getLastRow();
    if (lastRow < 3 || lastCol < 25) continue;
    // по заголовку решаем, нужна ли неделя
    const hdr = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    let weekStart = null;
    for (const h of hdr) {
      const m = /([^\s,]+)\s+(\d{1,2}),\s*(\d{4})/.exec(h || '');
      if (m && NightHours.czMonth(m[1])) { weekStart = Date.UTC(+m[3], NightHours.czMonth(m[1]) - 1, +m[2]); break; }
    }
    if (weekStart === null || weekStart > toTs || weekStart + 7 * 86400000 < fromTs) continue;
    const range = sh.getRange(1, 1, lastRow, lastCol);
    const merges = range.getMergedRanges().map((r) => ({ row: r.getRow() - 1, col: r.getColumn() - 1, rows: r.getNumRows(), cols: r.getNumColumns() }));
    sheets.push({ name: sh.getName(), rows: nhGridFromSheet(range.getDisplayValues(), range.getBackgrounds(), merges) });
  }
  return sheets;
}

/** Колонки листа доплат: имя и дни месяца (даты в первой строке). */
function nhBonusLayout_(sheet) {
  const tz = sheet.getParent().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  const lastCol = sheet.getLastColumn();
  const head = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  let nameCol = -1, year = 0, month = 0;
  const days = [];
  head.forEach((v, i) => {
    if (typeof v === 'string' && /^\s*(Имя|Name|Jméno)\s*:?\s*$/i.test(v)) nameCol = i;
    else if (Object.prototype.toString.call(v) === '[object Date]') {
      const [y, m, d] = Utilities.formatDate(v, tz, 'yyyy-M-d').split('-').map(Number);
      days.push({ col: i, day: d }); year = y; month = m;
    }
  });
  if (nameCol < 0 || !days.length) throw new Error('На этом листе нет строки «Имя:» с датами. Откройте лист месяца.');
  return { nameCol, year, month, days };
}

function nhFill_(overwrite) {
  const ui = SpreadsheetApp.getUi();
  const planId = PropertiesService.getDocumentProperties().getProperty('PLAN_ID');
  if (!planId) { nhSetPlan(); return; }
  const sheet = SpreadsheetApp.getActiveSheet();
  const L = nhBonusLayout_(sheet);
  const from = Date.UTC(L.year, L.month - 1, 1) - 8 * 86400000;
  const to = Date.UTC(L.year, L.month, 1) + 2 * 86400000;
  SpreadsheetApp.getActive().toast('Читаю диспетчерский план…', 'Ночные часы', 30);
  const drivers = NightHours.planTimelines(nhReadPlan_(planId, from, to));

  const lastRow = sheet.getLastRow();
  const names = sheet.getRange(2, L.nameCol + 1, lastRow - 1, 1).getDisplayValues().map((r) => r[0]);
  const c0 = Math.min(...L.days.map((d) => d.col)), c1 = Math.max(...L.days.map((d) => d.col));
  const block = sheet.getRange(2, c0 + 1, lastRow - 1, c1 - c0 + 1);
  const values = block.getValues();
  let filled = 0, kept = 0, missing = [];
  names.forEach((name, r) => {
    if (!name.trim()) return;
    const drv = drivers.get(NightHours.normName(name));
    if (!drv) { if (values[r].some((v) => v === '' )) missing.push(name.trim()); return; }
    const res = NightHours.planNightHours(drv, L.year, L.month);
    for (const d of L.days) {
      const cur = values[r][d.col - c0];
      const x = res[d.day - 1];
      if (!x || x.hours == null) continue;
      if (typeof cur === 'string' && cur.trim()) { kept++; continue; }          // off, уволен и т.п.
      if (cur !== '' && cur !== null && !overwrite) { kept++; continue; }      // уже внесено
      values[r][d.col - c0] = x.hours;
      filled++;
    }
  });
  block.setValues(values);
  let msg = `Записано ячеек: ${filled}. Оставлено без изменений: ${kept}.`;
  if (missing.length) msg += `\nНет в плане (не заполнены): ${missing.join(', ')}.`;
  msg += '\nЗадержки на полчаса исправьте вручную.';
  ui.alert('Ночные часы', msg, ui.ButtonSet.OK);
}
