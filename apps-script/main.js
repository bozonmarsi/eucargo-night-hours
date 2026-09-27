/*
 * Google Apps Script для таблицы доплат: заполняет ночные часы по диспетчерскому плану.
 * Логика расчёта — та же, что в src/core.js (подключается при сборке, см. tools/build.js).
 *
 * Установка: Расширения → Apps Script → вставить dist/NightHours.gs целиком → Сохранить.
 * После обновления таблицы появится меню «Ночные часы». Еженедельный запуск включается из этого меню.
 */

/* global SpreadsheetApp, PropertiesService, Session, Utilities, ScriptApp, LockService, MailApp, NightHours */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Ночные часы')
    .addItem('Заполнить этот лист сейчас', 'nhFillNow')
    .addItem('Пересчитать лист (заменить все числа)', 'nhFillAll')
    .addItem('Утвердить этот лист (больше не менять)', 'nhApprove')
    .addSeparator()
    .addItem('Включить еженедельный расчёт', 'nhEnableWeekly')
    .addItem('Выключить еженедельный расчёт', 'nhDisableWeekly')
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
  ui.alert('Сохранено. Теперь можно заполнить лист или включить еженедельный расчёт.');
}

/** Заполнить активный лист: пустые ячейки и ранее заполненные скриптом (ручные правки не трогаются). */
function nhFillNow() {
  const ui = SpreadsheetApp.getUi();
  const st = nhFillSheet_(SpreadsheetApp.getActiveSheet(), { mode: 'auto', until: nhToday_() });
  ui.alert('Ночные часы', nhReport_(st), ui.ButtonSet.OK);
}

function nhFillAll() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.alert('Пересчитать лист?', 'Все числа в днях будут заменены расчётом по плану, в том числе исправленные вручную. Текст (off, уволен) останется.', ui.ButtonSet.OK_CANCEL);
  if (r !== ui.Button.OK) return;
  const st = nhFillSheet_(SpreadsheetApp.getActiveSheet(), { mode: 'all', until: nhToday_() });
  ui.alert('Ночные часы', nhReport_(st), ui.ButtonSet.OK);
}

/** Утвердить лист: еженедельный расчёт его больше не меняет. */
function nhApprove() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  nhBonusLayout_(sheet); // проверка, что это лист месяца
  const r = ui.alert('Утвердить «' + sheet.getName() + '»?', 'После утверждения скрипт больше не будет менять этот лист автоматически.', ui.ButtonSet.OK_CANCEL);
  if (r !== ui.Button.OK) return;
  const props = PropertiesService.getDocumentProperties();
  props.setProperty('APPROVED_' + sheet.getSheetId(), new Date().toISOString());
  props.deleteProperty('AUTO_' + sheet.getSheetId());
  ui.alert('Лист утверждён.');
}

// ---------------------------------------------------------------- расписание
function nhEnableWeekly() {
  nhDisableWeekly_(true);
  ScriptApp.newTrigger('nhWeekly').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  SpreadsheetApp.getUi().alert('Готово: расчёт будет запускаться каждый понедельник около 6:00 и присылать отчёт на почту.');
}
function nhDisableWeekly() { nhDisableWeekly_(false); }
function nhDisableWeekly_(silent) {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === 'nhWeekly') ScriptApp.deleteTrigger(t);
  if (!silent) SpreadsheetApp.getUi().alert('Еженедельный расчёт выключен.');
}

/** Запуск по расписанию: текущий и прошлый месяц, если они не утверждены. */
function nhWeekly() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(60000)) return;
  try {
    const ss = SpreadsheetApp.getActive();
    const props = PropertiesService.getDocumentProperties();
    const now = new Date();
    const want = [[now.getFullYear(), now.getMonth() + 1], now.getMonth() === 0 ? [now.getFullYear() - 1, 12] : [now.getFullYear(), now.getMonth()]];
    const lines = [];
    for (const sheet of ss.getSheets()) {
      let L;
      try { L = nhBonusLayout_(sheet); } catch (e) { continue; }
      if (!want.some(([y, m]) => y === L.year && m === L.month)) continue;
      if (props.getProperty('APPROVED_' + sheet.getSheetId())) { lines.push(sheet.getName() + ': утверждён, не менялся.'); continue; }
      const st = nhFillSheet_(sheet, { mode: 'auto', until: nhToday_() });
      lines.push(sheet.getName() + ': ' + nhReport_(st));
    }
    if (!lines.length) lines.push('Не найден лист текущего месяца (строка «Имя:» с датами).');
    const email = Session.getEffectiveUser().getEmail();
    if (email) MailApp.sendEmail(email, 'Ночные часы: еженедельный расчёт', lines.join('\n\n') + '\n\nТаблица: ' + ss.getUrl());
  } finally { lock.releaseLock(); }
}

function nhToday_() { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }

function nhReport_(st) {
  let msg = `записано ${st.filled}, обновлено ${st.updated}, оставлено как есть ${st.kept} (ручные правки и off).`;
  if (st.missing.length) msg += ` Нет в плане: ${st.missing.join(', ')}.`;
  return msg;
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

/**
 * Заполняет лист месяца по плану.
 * mode: 'auto' — пустые ячейки и ранее записанные скриптом (если их не правили вручную);
 *       'all'  — все числа.
 * until: заполняются только даты раньше этого дня (ночь должна закончиться).
 * Какие ячейки записал скрипт, хранится в свойствах документа (AUTO_<id листа>).
 */
function nhFillSheet_(sheet, opt) {
  const planId = PropertiesService.getDocumentProperties().getProperty('PLAN_ID');
  if (!planId) throw new Error('Не указана ссылка на диспетчерский план (меню «Ночные часы»).');
  const L = nhBonusLayout_(sheet);
  const from = Date.UTC(L.year, L.month - 1, 1) - 8 * 86400000;
  const to = Date.UTC(L.year, L.month, 1) + 2 * 86400000;
  const drivers = NightHours.planTimelines(nhReadPlan_(planId, from, to));

  const props = PropertiesService.getDocumentProperties();
  const autoKey = 'AUTO_' + sheet.getSheetId();
  const auto = nhAutoDecode_(props.getProperty(autoKey));      // "водитель:день" -> значение

  const lastRow = sheet.getLastRow();
  const names = sheet.getRange(2, L.nameCol + 1, lastRow - 1, 1).getDisplayValues().map((r) => r[0]);
  const c0 = Math.min(...L.days.map((d) => d.col)), c1 = Math.max(...L.days.map((d) => d.col));
  const block = sheet.getRange(2, c0 + 1, lastRow - 1, c1 - c0 + 1);
  const values = block.getValues();
  const st = { filled: 0, updated: 0, kept: 0, missing: [] };
  names.forEach((name, r) => {
    if (!name.trim()) return;
    const drv = drivers.get(NightHours.normName(name));
    if (!drv) { if (values[r].some((v) => v === '')) st.missing.push(name.trim()); return; }
    const key = NightHours.normName(name);
    const res = NightHours.planNightHours(drv, L.year, L.month);
    for (const d of L.days) {
      if (Date.UTC(L.year, L.month - 1, d.day) >= opt.until) continue;
      const x = res[d.day - 1];
      if (!x || x.hours == null) continue;
      const cur = values[r][d.col - c0];
      const ak = key + ':' + d.day;
      if (typeof cur === 'string' && cur.trim()) { st.kept++; continue; }               // off, уволен
      const empty = cur === '' || cur === null;
      const wasAuto = !empty && Object.prototype.hasOwnProperty.call(auto, ak) && auto[ak] === cur;
      if (!empty && !wasAuto && opt.mode !== 'all') { st.kept++; delete auto[ak]; continue; } // ручная правка
      if (!empty && cur === x.hours) { auto[ak] = x.hours; continue; }
      values[r][d.col - c0] = x.hours;
      auto[ak] = x.hours;
      if (empty) st.filled++; else st.updated++;
    }
  });
  block.setValues(values);
  props.setProperty(autoKey, nhAutoEncode_(auto));
  return st;
}

// Компактная запись «что записал скрипт»: на водителя строка из 31 символа
// ('.' — не записано, 'a'+2·часы — значение с шагом 0,5). Лимит свойства — 9 КБ.
function nhAutoEncode_(auto) {
  const rows = {};
  for (const k of Object.keys(auto)) {
    const i = k.lastIndexOf(':'), name = k.slice(0, i), day = +k.slice(i + 1);
    const arr = rows[name] || (rows[name] = Array(31).fill('.'));
    arr[day - 1] = String.fromCharCode(97 + Math.round(auto[k] * 2));
  }
  return JSON.stringify(Object.fromEntries(Object.entries(rows).map(([n, a]) => [n, a.join('')])));
}
function nhAutoDecode_(str) {
  const auto = {};
  if (!str) return auto;
  let rows;
  try { rows = JSON.parse(str); } catch (e) { return auto; }
  for (const [name, code] of Object.entries(rows)) {
    for (let i = 0; i < code.length; i++) if (code[i] !== '.') auto[name + ':' + (i + 1)] = (code.charCodeAt(i) - 97) / 2;
  }
  return auto;
}
