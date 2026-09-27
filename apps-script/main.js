/*
 * Google Apps Script для таблицы доплат: заполняет ночные часы по диспетчерскому плану.
 * Логика расчёта — та же, что в src/core.js (подключается при сборке, см. tools/build.js).
 *
 * Установка: Расширения → Apps Script → вставить dist/NightHours.gs целиком → Сохранить.
 * После обновления таблицы появится меню «Ночные часы». Еженедельный запуск включается из этого меню.
 */

/* global SpreadsheetApp, PropertiesService, Session, Utilities, ScriptApp, LockService, MailApp, DriveApp, Drive, NightHours */
/*
 * В черновике: наведите на ячейку — пояснение, откуда цифра.
 * Жёлтая ячейка — ночь глубоко внутри длинного рейса без REST (проверить), оранжевая — план изменили задним числом.
 */

const NH_DRAFT = ' — черновик';
const NH_YELLOW = '#fff2cc';   // ночь глубоко внутри длинного рейса без REST — проверить
const NH_ORANGE = '#f9cb9c';   // план поменяли задним числом, цифра изменилась
const NH_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Ночные часы')
    .addItem('Обновить черновик этого месяца сейчас', 'nhFillNow')
    .addItem('Перенести черновик в основную таблицу', 'nhTransfer')
    .addSeparator()
    .addItem('Включить еженедельный расчёт', 'nhEnableWeekly')
    .addItem('Выключить еженедельный расчёт', 'nhDisableWeekly')
    .addItem('Указать ссылку на диспетчерский план', 'nhSetPlan')
    .addToUi();
}

function nhSetPlan() {
  const ui = SpreadsheetApp.getUi();
  const cur = nhPlanSourceSetting_();
  const r = ui.prompt('Диспетчерский план',
    'Вставьте ссылку на ПАПКУ Google Диска, куда раз в неделю кладётся файл плана (.xlsx или .ods) — скрипт возьмёт самый новый.\n' +
    'Или ссылку на Google Таблицу с планом.' + (cur ? '\nСейчас: ' + cur.type + ' ' + cur.id : ''), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = r.getResponseText().trim();
  let src = null, m;
  if ((m = /\/folders\/([a-zA-Z0-9_-]+)/.exec(t))) src = { type: 'folder', id: m[1] };
  else if ((m = /\/d\/([a-zA-Z0-9_-]+)/.exec(t))) src = { type: 'sheet', id: m[1] };
  if (!src) { ui.alert('Не похоже на ссылку на папку Google Диска или Google Таблицу.'); return; }
  PropertiesService.getDocumentProperties().setProperty('PLAN_SRC', JSON.stringify(src));
  let msg = 'Сохранено.';
  try { const f = nhPlanFile_(src); msg += `\nСейчас будет использоваться: «${f.name}» от ${Utilities.formatDate(f.updated, Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm')}.`; }
  catch (e) { msg += '\nНо файл плана пока не найден: ' + e.message; }
  ui.alert(msg);
}

function nhPlanSourceSetting_() {
  const p = PropertiesService.getDocumentProperties();
  const s = p.getProperty('PLAN_SRC');
  if (s) return JSON.parse(s);
  const old = p.getProperty('PLAN_ID');                      // старая настройка — ссылка на таблицу
  return old ? { type: 'sheet', id: old } : null;
}

const NH_PLAN_TYPES = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.google-apps.spreadsheet': 'gsheet',
};

/** Файл плана: самый новый .xlsx/.ods/Google Таблица в папке, либо указанная таблица. */
function nhPlanFile_(src) {
  if (src.type === 'sheet') {
    const f = DriveApp.getFileById(src.id);
    return { id: src.id, name: f.getName(), updated: f.getLastUpdated(), kind: NH_PLAN_TYPES[f.getMimeType()] || 'gsheet' };
  }
  const it = DriveApp.getFolderById(src.id).getFiles();
  let best = null;
  while (it.hasNext()) {
    const f = it.next();
    const kind = NH_PLAN_TYPES[f.getMimeType()];
    if (!kind) continue;
    if (!best || f.getLastUpdated() > best.updated) best = { id: f.getId(), name: f.getName(), updated: f.getLastUpdated(), kind };
  }
  if (!best) throw new Error('в папке нет файлов .xlsx, .ods или Google Таблиц');
  return best;
}

/**
 * Читает план и возвращает водителей. Excel/ODS не трогается: из его копии делается
 * временная Google Таблица, читается и сразу удаляется.
 */
function nhLoadPlan_(fromTs, toTs) {
  const src = nhPlanSourceSetting_();
  if (!src) throw new Error('Не указан диспетчерский план (меню «Ночные часы → Указать ссылку на диспетчерский план»).');
  const file = nhPlanFile_(src);
  let sheetId = file.id, tmp = null;
  if (file.kind !== 'gsheet') {
    const blob = DriveApp.getFileById(file.id).getBlob();
    tmp = Drive.Files.create({ name: 'Ночные часы — временная копия плана', mimeType: 'application/vnd.google-apps.spreadsheet' }, blob);
    sheetId = tmp.id;
  }
  try {
    const drivers = NightHours.planTimelines(nhReadPlan_(sheetId, fromTs, toTs));
    const ageDays = (Date.now() - file.updated.getTime()) / 86400000;
    return { drivers, file, stale: ageDays > 8 };
  } finally {
    if (tmp) { try { Drive.Files.remove(tmp.id); } catch (e) { /* временная копия удалится при следующем запуске вручную */ } }
  }
}

/** Основной лист месяца для активного листа (активный может быть черновиком). */
function nhMainOf_(sheet) {
  const name = sheet.getName();
  if (!name.endsWith(NH_DRAFT)) return sheet;
  const main = sheet.getParent().getSheetByName(name.slice(0, -NH_DRAFT.length));
  if (!main) throw new Error('Не найден основной лист «' + name.slice(0, -NH_DRAFT.length) + '».');
  return main;
}

/** Черновик месяца: копия основного листа рядом с ним. Создаётся при первом расчёте. */
function nhDraftOf_(main) {
  const ss = main.getParent();
  const name = main.getName() + NH_DRAFT;
  let draft = ss.getSheetByName(name);
  if (draft) return draft;
  draft = main.copyTo(ss).setName(name);
  ss.setActiveSheet(draft);
  ss.moveActiveSheet(main.getIndex() + 1);
  // в черновике дни с числами очищаем — их заполнит расчёт; off, уволен остаются
  const L = nhBonusLayout_(draft);
  const c0 = Math.min(...L.days.map((d) => d.col)), c1 = Math.max(...L.days.map((d) => d.col));
  const n = draft.getLastRow() - 1;
  if (n > 0) {
    const rng = draft.getRange(2, c0 + 1, n, c1 - c0 + 1);
    rng.setValues(rng.getValues().map((row) => row.map((v) => (typeof v === 'number' ? '' : v))));
  }
  draft.setTabColor('#9aa6b2');
  return draft;
}

function nhFillNow() {
  const ui = SpreadsheetApp.getUi();
  const main = nhMainOf_(SpreadsheetApp.getActiveSheet());
  nhBonusLayout_(main);
  const draft = nhDraftOf_(main);
  const st = nhFillSheet_(draft, { mode: 'auto', until: nhToday_(), main });
  SpreadsheetApp.getActive().setActiveSheet(draft);
  ui.alert('Ночные часы', `«${draft.getName()}»: ` + nhReport_(st), ui.ButtonSet.OK);
}

/** Перенос проверенного черновика в основной лист: дни по именам водителей. */
function nhTransfer() {
  const ui = SpreadsheetApp.getUi();
  const main = nhMainOf_(SpreadsheetApp.getActiveSheet());
  const draft = main.getParent().getSheetByName(main.getName() + NH_DRAFT);
  if (!draft) { ui.alert('Черновика для «' + main.getName() + '» ещё нет.'); return; }
  const r = ui.alert('Перенести «' + draft.getName() + '» в «' + main.getName() + '»?',
    'Часы по дням из черновика заменят числа в основном листе. Текст (off, уволен) в основном листе останется. Скрипт больше не будет менять этот месяц.', ui.ButtonSet.OK_CANCEL);
  if (r !== ui.Button.OK) return;
  const n = nhCopyDays_(draft, main);
  const props = PropertiesService.getDocumentProperties();
  props.setProperty('APPROVED_' + main.getSheetId(), new Date().toISOString());
  ui.alert('Перенесено ячеек: ' + n + '. Месяц закрыт для автоматического расчёта.');
}

function nhCopyDays_(from, to) {
  const A = nhBonusLayout_(from), B = nhBonusLayout_(to);
  const rows = (sh, L) => {
    const n = sh.getLastRow() - 1;
    const names = sh.getRange(2, L.nameCol + 1, n, 1).getDisplayValues().map((x) => NightHours.normName(x[0]));
    const c0 = Math.min(...L.days.map((d) => d.col)), c1 = Math.max(...L.days.map((d) => d.col));
    const rng = sh.getRange(2, c0 + 1, n, c1 - c0 + 1);
    return { names, c0, rng, vals: rng.getValues() };
  };
  const src = rows(from, A), dst = rows(to, B);
  const srcRow = new Map(src.names.map((k, i) => [k, i]));
  let count = 0;
  dst.names.forEach((k, i) => {
    if (!k || !srcRow.has(k)) return;
    const si = srcRow.get(k);
    for (const d of B.days) {
      const sd = A.days.find((x) => x.day === d.day);
      if (!sd) continue;
      const v = src.vals[si][sd.col - src.c0], cur = dst.vals[i][d.col - dst.c0];
      if (typeof cur === 'string' && cur.trim()) continue;       // off, уволен
      if (typeof v !== 'number') continue;
      if (cur !== v) { dst.vals[i][d.col - dst.c0] = v; count++; }
    }
  });
  dst.rng.setValues(dst.vals);
  return count;
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
    // текущий месяц; прошлый — только в первую неделю нового месяца (дописать последние дни)
    const want = [[now.getFullYear(), now.getMonth() + 1]];
    if (now.getDate() <= 7) want.push(now.getMonth() === 0 ? [now.getFullYear() - 1, 12] : [now.getFullYear(), now.getMonth()]);
    const lines = [];
    const flagged = [];
    const created = nhEnsureMonthSheet_(ss, now.getFullYear(), now.getMonth() + 1);
    if (created) lines.push(`Создан лист «${created.getName()}» по образцу прошлого месяца. Проверьте служебные колонки (доплата, уборка ангара и т.п.).`);
    for (const sheet of ss.getSheets()) {
      if (sheet.getName().endsWith(NH_DRAFT)) continue;
      let L;
      try { L = nhBonusLayout_(sheet); } catch (e) { continue; }
      if (!want.some(([y, m]) => y === L.year && m === L.month)) continue;
      if (props.getProperty('APPROVED_' + sheet.getSheetId())) { lines.push(sheet.getName() + ': перенесён в основную таблицу, не менялся.'); continue; }
      const draft = nhDraftOf_(sheet);
      const st = nhFillSheet_(draft, { mode: 'auto', until: nhToday_(), main: sheet });
      flagged.push(...st.flagged);
      lines.push(draft.getName() + ': ' + nhReport_(st));
    }
    if (flagged.length) {
      lines.push('Проверьте (в черновике подсвечены):\n' + flagged.slice(0, 60).map((f) => '• ' + f).join('\n') +
        (flagged.length > 60 ? `\n… и ещё ${flagged.length - 60}` : ''));
    } else lines.push('Спорных ячеек за неделю нет.');
    if (!lines.length) lines.push('Не найден лист текущего месяца (строка «Имя:» с датами). Создайте лист месяца, как обычно.');
    const email = Session.getEffectiveUser().getEmail();
    if (email) MailApp.sendEmail(email, 'Ночные часы: еженедельный расчёт', lines.join('\n\n') + '\n\nТаблица: ' + ss.getUrl());
  } finally { lock.releaseLock(); }
}

/**
 * Лист месяца, если его ещё нет: копия последнего листа, где хватает колонок-дней.
 * Даты — новые, часы очищены («уволен» на весь месяц переносится), разовые значения
 * справа от дней очищены, формулы (Итого, Доплата) сохраняются.
 */
function nhEnsureMonthSheet_(ss, year, month) {
  const need = new Date(year, month, 0).getDate();
  const sheets = [];
  for (const sh of ss.getSheets()) {
    if (sh.getName().endsWith(NH_DRAFT)) continue;
    let L;
    try { L = nhBonusLayout_(sh); } catch (e) { continue; }
    if (L.year === year && L.month === month) return null;     // уже есть
    sheets.push({ sh, L, n: L.year * 12 + L.month });
  }
  const prev = sheets.filter((x) => x.n < year * 12 + month).sort((a, b) => b.n - a.n);
  if (!prev.length || prev[0].n < year * 12 + month - 2) return null;  // нет недавнего образца
  const tpl = prev.find((x) => x.L.days.length >= need) || null;
  if (!tpl) return null;
  let name = NH_MONTHS[month - 1];
  if (ss.getSheetByName(name)) name += ' ' + year;
  const sh = tpl.sh.copyTo(ss).setName(name);
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(prev[0].sh.getIndex() + 1);
  const L = tpl.L;
  const cols = L.days.map((d) => d.col).sort((a, b) => a - b);
  const lastCol = sh.getLastColumn();
  const head = sh.getRange(1, 1, 1, lastCol).getValues();
  cols.forEach((c, i) => { head[0][c] = i < need ? new Date(year, month - 1, i + 1) : ''; });
  sh.getRange(1, 1, 1, lastCol).setValues(head);
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    const rng = sh.getRange(2, 1, n, lastCol);
    const vals = rng.getValues(), f = rng.getFormulas();
    const c1 = cols[cols.length - 1];
    vals.forEach((row, r) => {
      const fired = cols.every((c) => String(row[c]).trim().toLowerCase() === 'уволен');
      cols.forEach((c, i) => { row[c] = fired && i < need ? 'уволен' : ''; });
      for (let c = 0; c < lastCol; c++) {
        if (f[r][c]) row[c] = f[r][c];                 // формулы как были
        else if (c > c1) row[c] = '';                  // разовые значения справа от дней
      }
    });
    rng.setValues(vals);
    const dayRng = sh.getRange(2, cols[0] + 1, n, c1 - cols[0] + 1);
    dayRng.clearNote();
  }
  return sh;
}

function nhToday_() { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }

function nhReport_(st) {
  let msg = `записано ${st.filled}, обновлено ${st.updated}, оставлено как есть ${st.kept} (ручные правки и off), подсвечено для проверки ${st.flagged ? st.flagged.length : 0}.`;
  if (st.missing.length) msg += ` Нет в плане: ${st.missing.join(', ')}.`;
  if (st.plan) msg += ` План: «${st.plan.name}» от ${Utilities.formatDate(st.plan.updated, Session.getScriptTimeZone(), 'dd.MM.yyyy')}.`;
  if (st.stale) msg += ' ⚠ Файл плана старше недели — положите свежий в папку.';
  return msg;
}

/**
 * Сетка листа плана в формате NightHours.planTimelines: [[{t, bg, span, cov, d?}]].
 * dates — даты ячеек (ms UTC) там, где в ячейке настоящая дата (заголовки дней).
 */
function nhGridFromSheet(display, backgrounds, merges, dates) {
  const g = display.map((row, i) => row.map((t, j) => {
    const c = { t: String(t || ''), bg: (backgrounds[i] && backgrounds[i][j]) || null, span: 1, cov: false };
    if (dates && dates[i] && dates[i][j] != null) c.d = dates[i][j];
    return c;
  }));
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

/** Дата ячейки: настоящая дата -> ms UTC полночи; иначе разбор текста. */
function nhCellDate_(value, text, tz) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    const [y, m, d] = Utilities.formatDate(value, tz, 'yyyy-M-d').split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  return NightHours.headerDate(text);
}

function nhReadPlan_(planId, fromTs, toTs) {
  const ss = SpreadsheetApp.openById(planId);
  const tz = ss.getSpreadsheetTimeZone ? ss.getSpreadsheetTimeZone() : Session.getScriptTimeZone();
  const sheets = [], seen = [];
  for (const sh of ss.getSheets()) {
    const lastCol = Math.min(sh.getLastColumn(), 400), lastRow = sh.getLastRow();
    if (lastRow < 3 || lastCol < 25) { seen.push(sh.getName() + ' (пустой)'); continue; }
    // первая дата в первой строке — понедельник недели
    const hr = sh.getRange(1, 1, 1, lastCol);
    const hv = hr.getValues()[0], ht = hr.getDisplayValues()[0];
    const hdates = hv.map((v, j) => nhCellDate_(v, ht[j], tz));
    const weekStart = hdates.find((d) => d != null);
    if (weekStart == null) { seen.push(sh.getName() + ' (нет дат в 1-й строке: «' + (ht[1] || ht[0] || '') + '»)'); continue; }
    seen.push(sh.getName());
    if (weekStart > toTs || weekStart + 7 * 86400000 < fromTs) continue;
    const range = sh.getRange(1, 1, lastRow, lastCol);
    const merges = range.getMergedRanges().map((r) => ({ row: r.getRow() - 1, col: r.getColumn() - 1, rows: r.getNumRows(), cols: r.getNumColumns() }));
    const dates = [hdates];
    sheets.push({ name: sh.getName(), rows: nhGridFromSheet(range.getDisplayValues(), range.getBackgrounds(), merges, dates) });
  }
  if (!sheets.length) {
    throw new Error('В файле плана нет недель за этот месяц. Листы в файле: ' + seen.slice(0, 12).join('; ') +
      '. Проверьте, что в первой строке листа стоят даты дней.');
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
    } else if (typeof v === 'string' && /^\s*\d{1,2}\.\d{1,2}\.?(\d{4})?\s*$/.test(v)) {
      // дата текстом «01.09» или «01.09.2026»; год — из текста, названия листа или текущий
      const m = /^\s*(\d{1,2})\.(\d{1,2})\.?(\d{4})?/.exec(v);
      const y = m[3] ? +m[3] : +((/(20\d\d)/.exec(sheet.getName()) || [])[1] || new Date().getFullYear());
      days.push({ col: i, day: +m[1] }); year = y; month = +m[2];
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
  const L = nhBonusLayout_(sheet);
  const from = Date.UTC(L.year, L.month - 1, 1) - 8 * 86400000;
  const to = Date.UTC(L.year, L.month, 1) + 2 * 86400000;
  const plan = nhLoadPlan_(from, to);
  const drivers = plan.drivers;

  const props = PropertiesService.getDocumentProperties();
  const autoKey = 'AUTO_' + sheet.getSheetId();
  const auto = nhAutoDecode_(props.getProperty(autoKey));      // "водитель:день" -> значение

  const lastRow = sheet.getLastRow();
  const names = sheet.getRange(2, L.nameCol + 1, lastRow - 1, 1).getDisplayValues().map((r) => r[0]);
  const c0 = Math.min(...L.days.map((d) => d.col)), c1 = Math.max(...L.days.map((d) => d.col));
  const block = sheet.getRange(2, c0 + 1, lastRow - 1, c1 - c0 + 1);
  const values = block.getValues();
  const notes = block.getNotes();
  const colors = block.getBackgrounds();
  // исходный цвет ячеек берём из основного листа (черновик — его копия)
  const main = opt.main || null;
  const base = main ? main.getRange(2, c0 + 1, lastRow - 1, c1 - c0 + 1).getBackgrounds() : null;
  const baseAt = (r, c) => (base && base[r] && base[r][c]) || '#ffffff';
  const st = { filled: 0, updated: 0, kept: 0, missing: [], flagged: [], plan: plan.file, stale: plan.stale };
  names.forEach((name, r) => {
    if (!name.trim()) return;
    const drv = NightHours.planDriverFor(drivers, name);
    if (!drv) { if (!values[r].some((v) => typeof v === 'string' && v.trim())) st.missing.push(name.trim()); return; }
    const key = NightHours.normName(name);
    const res = NightHours.planNightHours(drv, L.year, L.month);
    for (const d of L.days) {
      const c = d.col - c0;
      if (Date.UTC(L.year, L.month - 1, d.day) >= opt.until) continue;
      const x = res[d.day - 1];
      if (!x || x.hours == null) continue;
      const cur = values[r][c];
      const ak = key + ':' + d.day;
      if (typeof cur === 'string' && cur.trim()) { st.kept++; continue; }               // off, уволен
      const empty = cur === '' || cur === null;
      const wasAuto = !empty && Object.prototype.hasOwnProperty.call(auto, ak) && auto[ak] === cur;
      if (!empty && !wasAuto && opt.mode !== 'all') {                                  // ручная правка: без подсветки
        st.kept++; delete auto[ak];
        if (colors[r][c] === NH_YELLOW || colors[r][c] === NH_ORANGE) colors[r][c] = baseAt(r, c);
        continue;
      }
      const changed = !empty && cur !== x.hours;
      if (changed || empty) { values[r][c] = x.hours; if (empty) st.filled++; else st.updated++; }
      auto[ak] = x.hours;
      // пояснение: откуда цифра
      const why = NightHours.planNightExplain(drv, L.year, L.month, d.day);
      notes[r][c] = why ? 'По плану: ' + why + (changed ? '\nБыло ' + cur + ', план изменили.' : '') : '';
      // подсветка: изменилось задним числом (держится до вашей правки) или длинный рейс
      let color = baseAt(r, c);
      if (changed || colors[r][c] === NH_ORANGE) color = NH_ORANGE;
      else if (x.status === 'check' && x.hours > 0) color = NH_YELLOW;
      colors[r][c] = color;
      if (changed) st.flagged.push(`${name.trim()}, ${d.day}.${L.month}: было ${cur}, стало ${x.hours} (план изменили)`);
      else if (empty && x.status === 'check' && x.hours > 0) st.flagged.push(`${name.trim()}, ${d.day}.${L.month}: ${x.hours} ч, ${x.notes.join('; ')}`);
    }
  });
  block.setValues(values);
  block.setNotes(notes);
  block.setBackgrounds(colors);
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
