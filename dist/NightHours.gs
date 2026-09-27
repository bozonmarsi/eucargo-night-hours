// Ночные часы водителей — Google Apps Script. Собрано из src/core.js и apps-script/main.js.
/*
 * Ядро расчёта ночных часов водителей.
 *
 * Работает и в браузере (window.NightHours), и в Node (module.exports).
 * Никаких внешних зависимостей: файлы водителей не покидают компьютер.
 *
 *  - readZip()          — распаковка .zip (DecompressionStream)
 *  - parseDriverCard()  — разбор .DDD файла карты водителя (Gen1 и Gen2)
 *  - mergeCards()       — объединение нескольких выгрузок одного водителя
 *  - nightHours()       — ночные часы по датам за месяц
 *  - roundHours()       — округление до получаса по правилам бухгалтерии
 *  - parseDispatchPlan()— диспетчерский план (CSV из Google Sheets)
 *  - parseBonusTable()  — таблица доплат (CSV), для порядка строк и сверки
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- настройки
  const DEFAULTS = {
    timeZone: 'Europe/Prague',
    nightStartHour: 22, // 22:00–23:59 относится к этой дате
    nightEndHour: 6,    // 00:00–05:59 относится к этой дате
    // Пауза (REST) внутри ночной смены короче этого порога считается рабочим
    // временем (короткая стоянка на погрузке/ожидание). Длинная пауза — нет.
    maxPaidPauseMin: 90,
    // Сколько минут ночи без данных тахографа делают день «нет данных».
    unknownFlagMin: 60,
  };

  const ACT = ['REST', 'AVAILABILITY', 'WORK', 'DRIVING'];

  // ---------------------------------------------------------------- zip
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Возвращает [{name, data: Uint8Array}] для всех файлов архива. */
  async function readZip(buf) {
    const b = new Uint8Array(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Это не zip-архив');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Повреждён zip-архив');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const loc = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      if (name.endsWith('/')) continue;
      const lnlen = dv.getUint16(loc + 26, true);
      const lelen = dv.getUint16(loc + 28, true);
      const start = loc + 30 + lnlen + lelen;
      const raw = b.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error(`${name}: неподдерживаемое сжатие (${method})`);
      out.push({ name, data });
    }
    return out;
  }

  // ---------------------------------------------------------------- DDD
  function tlv(b) {
    const out = new Map();
    let i = 0;
    while (i + 5 <= b.length) {
      const fid = (b[i] << 8) | b[i + 1];
      const type = b[i + 2];
      const len = (b[i + 3] << 8) | b[i + 4];
      if (i + 5 + len > b.length) break;
      const key = fid * 256 + type;
      if (!out.has(key)) out.set(key, b.subarray(i + 5, i + 5 + len));
      i += 5 + len;
    }
    return out;
  }

  function latin1(b) {
    let s = '';
    for (const c of b) s += String.fromCharCode(c);
    return s.replace(/\0/g, ' ').trim();
  }

  // Поле имени: 1 байт кодовой страницы + 35 байт текста.
  function nameField(b) {
    const cp = b[0];
    const text = b.subarray(1);
    const enc = { 1: 'iso-8859-1', 2: 'iso-8859-2', 3: 'iso-8859-3', 5: 'iso-8859-5',
      7: 'iso-8859-7', 9: 'iso-8859-9', 13: 'iso-8859-13', 15: 'iso-8859-15',
      16: 'iso-8859-16', 80: 'koi8-r', 85: 'koi8-u' }[cp];
    try { if (enc) return new TextDecoder(enc).decode(text).replace(/\0/g, ' ').trim(); } catch (e) { /* ignore */ }
    return latin1(text);
  }

  /**
   * Разбор файла карты водителя.
   * Возвращает {surname, firstName, cardNumber, days: [{date: ms UTC полночь, changes: [...]}]}
   * changes: {slot, crew, cardOut, act (0..3), minute (0..1439 UTC)}.
   */
  function parseDriverCard(bytes) {
    const t = tlv(bytes);
    const pick = (fid) => t.get(fid * 256 + 2) || t.get(fid * 256 + 0);
    const ident = pick(0x0520);
    const act = pick(0x0504);
    if (!ident || !act) throw new Error('Не файл карты водителя (нет блоков 0520/0504)');

    const cardNumber = latin1(ident.subarray(1, 17));
    const surname = nameField(ident.subarray(65, 101));
    const firstName = nameField(ident.subarray(101, 137));

    const oldest = (act[0] << 8) | act[1];
    const newest = (act[2] << 8) | act[3];
    const buf = act.subarray(4);
    const n = buf.length;
    const rd = (p, k) => { const r = new Uint8Array(k); for (let i = 0; i < k; i++) r[i] = buf[(p + i) % n]; return r; };

    const days = [];
    let p = newest;
    let seen = 0;
    while (n > 0) {
      const h = rd(p, 4);
      const prev = (h[0] << 8) | h[1];
      const len = (h[2] << 8) | h[3];
      if (len < 12 || len > n) break;
      const rec = rd(p, len);
      const ts = ((rec[4] << 24) >>> 0) + (rec[5] << 16) + (rec[6] << 8) + rec[7];
      const changes = [];
      for (let k = 12; k + 1 < len; k += 2) {
        const w = (rec[k] << 8) | rec[k + 1];
        changes.push({ slot: w >> 15, crew: (w >> 14) & 1, cardOut: (w >> 13) & 1, act: (w >> 11) & 3, minute: w & 0x7ff });
      }
      if (ts > 0) days.push({ date: ts * 1000, changes });
      seen += len;
      if (p === oldest || prev === 0 || seen >= n) break;
      p = ((p - prev) % n + n) % n;
    }
    days.reverse();
    // EF Card_Download (050E): момент выгрузки карты. Позже него данных нет.
    const dl = pick(0x050E);
    let downloadedAt = dl && dl.length >= 4 ? (((dl[0] << 24) >>> 0) + (dl[1] << 16) + (dl[2] << 8) + dl[3]) * 1000 : 0;
    const lastDay = days.length ? days[days.length - 1].date : 0;
    if (!downloadedAt || downloadedAt < lastDay) {
      // нет отметки — считаем данные полными до последнего изменения активности
      const d = days[days.length - 1];
      downloadedAt = d ? d.date + (d.changes.length ? d.changes[d.changes.length - 1].minute : 0) * 60000 : 0;
    }
    return { surname, firstName, cardNumber, days, downloadedAt };
  }

  /** Объединяет выгрузки одной карты: по каждой дате берём самую полную запись. */
  function mergeCards(cards) {
    const byCard = new Map();
    for (const c of cards) {
      const key = c.cardNumber || `${c.firstName} ${c.surname}`;
      if (!byCard.has(key)) byCard.set(key, { surname: c.surname, firstName: c.firstName, cardNumber: c.cardNumber, byDate: new Map(), files: [], downloadedAt: 0 });
      const m = byCard.get(key);
      m.downloadedAt = Math.max(m.downloadedAt, c.downloadedAt || 0);
      if (c.fileName) m.files.push(c.fileName);
      for (const d of c.days) {
        const old = m.byDate.get(d.date);
        if (!old || d.changes.length >= old.changes.length) m.byDate.set(d.date, d);
      }
    }
    return [...byCard.values()].map((m) => ({
      surname: m.surname, firstName: m.firstName, cardNumber: m.cardNumber, files: m.files, downloadedAt: m.downloadedAt,
      days: [...m.byDate.values()].sort((a, b) => a.date - b.date),
    }));
  }

  // ---------------------------------------------------------------- время
  const dtfCache = new Map();
  function tzOffsetMs(ts, timeZone) {
    let f = dtfCache.get(timeZone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
      dtfCache.set(timeZone, f);
    }
    const parts = {};
    for (const x of f.formatToParts(new Date(ts))) parts[x.type] = +x.value;
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return asUtc - Math.floor(ts / 1000) * 1000;
  }

  /** Местное время (год, месяц 1..12, день, час) -> ms UTC. */
  function localToUtc(y, mo, d, h, timeZone) {
    const guess = Date.UTC(y, mo - 1, d, h);
    let ts = guess - tzOffsetMs(guess, timeZone);
    ts = guess - tzOffsetMs(ts, timeZone);
    return ts;
  }

  // ---------------------------------------------------------------- расчёт
  const PAID = 'paid', PAUSE = 'pause', UNKNOWN = 'unknown';

  /** Интервалы активности [{start, end, kind, act}] в ms UTC. */
  function segments(card) {
    const segs = [];
    const days = card.days;
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      const ch = d.changes;
      for (let k = 0; k < ch.length; k++) {
        const c = ch[k];
        const s = d.date + c.minute * 60000;
        let e = d.date + (k + 1 < ch.length ? ch[k + 1].minute : 1440) * 60000;
        if (card.downloadedAt && e > card.downloadedAt) e = card.downloadedAt;
        if (e <= s) continue;
        let kind;
        if (c.act === 0) kind = c.cardOut ? UNKNOWN : PAUSE;
        else kind = PAID; // AVAILABILITY / WORK / DRIVING (в т.ч. ручной ввод)
        segs.push({ start: s, end: e, kind, act: ACT[c.act], cardOut: !!c.cardOut });
      }
    }
    return segs;
  }

  /** Склеивает соседние интервалы одного типа; дыры между днями — UNKNOWN. */
  function blocks(segs) {
    const out = [];
    for (const s of segs) {
      const last = out[out.length - 1];
      if (last && s.start > last.end) out.push({ start: last.end, end: s.start, kind: UNKNOWN });
      const l2 = out[out.length - 1];
      if (l2 && l2.kind === s.kind && l2.end === s.start) l2.end = s.end;
      else out.push({ start: s.start, end: s.end, kind: s.kind });
    }
    return out;
  }

  /** Короткие паузы между двумя рабочими блоками считаем рабочим временем. */
  function applyPauseRule(bl, maxPaidPauseMin) {
    const out = bl.map((b) => ({ ...b }));
    for (let i = 1; i + 1 < out.length; i++) {
      const b = out[i];
      if (b.kind === PAUSE && out[i - 1].kind === PAID && out[i + 1].kind === PAID &&
          (b.end - b.start) < maxPaidPauseMin * 60000) b.kind = PAID;
    }
    return out;
  }

  function overlap(bl, a, b, kind) {
    let m = 0;
    for (const x of bl) {
      if (x.end <= a) continue;
      if (x.start >= b) break;
      if (x.kind === kind) m += Math.min(b, x.end) - Math.max(a, x.start);
    }
    return m / 60000;
  }

  function coverage(bl, a, b) {
    let m = 0;
    for (const x of bl) {
      if (x.end <= a) continue;
      if (x.start >= b) break;
      m += Math.min(b, x.end) - Math.max(a, x.start);
    }
    return m / 60000;
  }

  /**
   * 1:06, 1:14 -> 1 · 1:17 … 1:43 -> 1,5 · 1:47, 1:55 -> 2
   * Граница: остаток < 15 мин — вниз, 15…44 — полчаса, ≥ 45 — вверх.
   */
  function roundHours(minutes) {
    const m = Math.round(minutes);
    const h = Math.floor(m / 60);
    const r = m - h * 60;
    return h + (r < 15 ? 0 : r < 45 ? 0.5 : 1);
  }

  /**
   * Ночные часы водителя по датам месяца.
   * Возвращает [{day, paidMin, unknownMin, hours, status}] где status:
   *   'ok' | 'partial' (часть ночи без данных) | 'nodata'
   */
  function nightHours(card, year, month, opts) {
    const o = { ...DEFAULTS, ...(opts || {}) };
    const bl = applyPauseRule(blocks(segments(card)), o.maxPaidPauseMin);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const res = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const windows = [
        [localToUtc(year, month, d, 0, o.timeZone), localToUtc(year, month, d, o.nightEndHour, o.timeZone)],
        [localToUtc(year, month, d, o.nightStartHour, o.timeZone), localToUtc(year, month, d + 1, 0, o.timeZone)],
      ];
      let paid = 0, unknown = 0, total = 0;
      for (const [a, b] of windows) {
        paid += overlap(bl, a, b, PAID);
        unknown += overlap(bl, a, b, UNKNOWN) + ((b - a) / 60000 - coverage(bl, a, b));
        total += (b - a) / 60000;
      }
      let status = 'ok';
      if (unknown >= total - 1) status = 'nodata';
      else if (unknown >= o.unknownFlagMin) status = 'partial';
      res.push({ day: d, paidMin: Math.round(paid), unknownMin: Math.round(unknown), hours: status === 'nodata' ? null : roundHours(paid), status });
    }
    return res;
  }

  /** Подробная лента активности за ночи вокруг даты — для ручной проверки. */
  function nightTimeline(card, year, month, day, opts) {
    const o = { ...DEFAULTS, ...(opts || {}) };
    const a = localToUtc(year, month, day, 0, o.timeZone) - 2 * 3600000;
    const b = localToUtc(year, month, day + 1, 0, o.timeZone) + 2 * 3600000;
    return segments(card).filter((s) => s.end > a && s.start < b);
  }

  // ---------------------------------------------------------------- имена
  const NOTE_WORDS = /\b(NO|EXP|ADR|PINK|ON|PART|TIME)\b/g;
  function normName(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/[^A-Z\s]/g, ' ')
      .replace(NOTE_WORDS, ' ')
      .split(/\s+/).filter(Boolean).sort().join(' ');
  }

  // ---------------------------------------------------------------- CSV
  function parseCsv(text, delim) {
    if (!delim) {
      const first = text.slice(0, 2000);
      delim = (first.split(';').length > first.split(',').length) ? ';' : ',';
    }
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function decodeText(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder('windows-1250').decode(u8); }
  }

  function czMonth(tok) {
    const t = tok.toLowerCase();
    if (/^led/.test(t)) return 1;
    if (/^.?nor/.test(t)) return 2;
    if (/^b.?.?ez/.test(t)) return 3;
    if (/^dub/.test(t)) return 4;
    if (/^kv/.test(t)) return 5;
    if (/^.?.?erven(ec|ce)/.test(t)) return 7;
    if (/^.?.?erv/.test(t)) return 6;
    if (/^srp/.test(t)) return 8;
    if (/^z/.test(t)) return 9;
    if (/^.?.?.?j(en|na)/.test(t)) return 10;
    if (/^list/.test(t)) return 11;
    if (/^pros/.test(t)) return 12;
    return 0;
  }

  // Названия месяцев на разных языках (Google может показать дату плана на языке таблицы).
  const MONTHS = [
    [1, /^(led|янв|січ|jan)/], [2, /^(.?nor|фев|лют|feb)/], [3, /^(b.?.?ez|мар|бер|m.?r)/], [4, /^(dub|апр|кві|apr)/],
    [5, /^(kv|мая|май|тра|ma[iy])/], [7, /^(.?.?erven(ec|ce)|июл|лип|jul)/], [6, /^(.?.?erv|июн|чер|jun)/], [8, /^(srp|авг|сер|aug)/],
    [9, /^(z|сен|вер|sep)/], [10, /^(.?.?.?j(en|na)|окт|жов|o[ck]t)/], [11, /^(list|ноя|лис|nov)/], [12, /^(pros|дек|гру|de[cz])/],
  ];
  function monthByName(tok) {
    const t = String(tok || '').toLowerCase().normalize('NFC');
    for (const [n, re] of MONTHS) if (re.test(t)) return n;
    return 0;
  }
  /**
   * Дата из заголовка дня недели в плане: «pondělí, září 21, 2026», «понедельник, сентябрь 21, 2026»,
   * «21. září 2026», «21.09.2026», «2026-09-21», «9/21/2026». Возвращает Date.UTC или null.
   */
  function headerDate(text, refNow) {
    const t = String(text || '').trim();
    if (!t) return null;
    let m;
    if ((m = /([^\s,.\d]+)\s+(\d{1,2}),\s*(\d{4})/.exec(t)) && monthByName(m[1])) return Date.UTC(+m[3], monthByName(m[1]) - 1, +m[2]);
    if ((m = /(\d{1,2})\.?\s+([^\s,.\d]+)\.?,?\s+(\d{4})/.exec(t)) && monthByName(m[2])) return Date.UTC(+m[3], monthByName(m[2]) - 1, +m[1]);
    if ((m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t))) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if ((m = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/.exec(t))) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    if ((m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(t))) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
    // «21.09» без года: год текущий (или из refYear); декабрь в январе — прошлый год
    if ((m = /^(?:[^\d]*\s)?(\d{1,2})\.(\d{1,2})\.?$/.exec(t)) && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
      const now = new Date(refNow || Date.now());
      let y = now.getUTCFullYear();
      if (+m[2] - (now.getUTCMonth() + 1) > 6) y--;
      else if ((now.getUTCMonth() + 1) - +m[2] > 6) y++;
      return Date.UTC(y, +m[2] - 1, +m[1]);
    }
    return null;
  }

  /**
   * Диспетчерский план: 7 дней × 24 часовые колонки, строки «машина / водитель».
   * Возвращает {dates: [{y,m,d,col}], drivers: Map(normName -> {name, cells: [{y,m,d,hour,text}]})}.
   * В CSV теряются заливка и объединение ячеек, поэтому видно только,
   * в каком часу запись начинается.
   */
  function parseDispatchPlan(text) {
    const rows = parseCsv(text, ';');
    const header = rows[0] || [];
    const dates = [];
    for (let c = 1; c < header.length; c++) {
      const h = header[c];
      const m = /([^\s,]+)\s+(\d{1,2}),\s*(\d{4})/.exec(h || '');
      if (m) dates.push({ y: +m[3], m: czMonth(m[1]), d: +m[2], col: c });
    }
    const plate = /^\s*\d?[A-Z]{2,4}\s?\d{3,4}/;
    const drivers = new Map();
    for (let r = 2; r < rows.length; r++) {
      const row = rows[r];
      const label = (row[0] || '').replace(/\s+/g, ' ').trim();
      if (!label || plate.test(label)) continue;
      const cells = [];
      for (const dt of dates) {
        for (let h = 0; h < 24; h++) {
          const v = (row[dt.col + h] || '').replace(/\s+/g, ' ').trim();
          if (v) cells.push({ y: dt.y, m: dt.m, d: dt.d, hour: h, text: v });
        }
      }
      const key = normName(label);
      if (!drivers.has(key)) drivers.set(key, { name: label, cells: [] });
      drivers.get(key).cells.push(...cells);
    }
    return { dates, drivers };
  }

  /** Подсказка из плана для ночи даты: последняя запись до/во время ночных окон. */
  function planHint(planDriver, y, m, d) {
    if (!planDriver) return '';
    const key = (c) => Date.UTC(c.y, c.m - 1, c.d, c.hour);
    const cells = planDriver.cells.slice().sort((a, b) => key(a) - key(b));
    const at = (ts) => { let best = null; for (const c of cells) { if (key(c) <= ts) best = c; else break; } return best; };
    const early = at(Date.UTC(y, m - 1, d, 5));
    const late = at(Date.UTC(y, m - 1, d, 23));
    const lo = Date.UTC(y, m - 1, d - 1, 12), hi = Date.UTC(y, m - 1, d + 1, 0);
    if (!cells.some((c) => key(c) >= lo && key(c) < hi) && !early) return '';
    const fmt = (c) => c ? `${String(c.d).padStart(2, '0')}.${String(c.m).padStart(2, '0')} ${String(c.hour).padStart(2, '0')}:00 «${c.text}»` : '—';
    return `00–06: ${fmt(early)}; 22–24: ${fmt(late)}`;
  }

  /**
   * Таблица доплат: строка с «Имя:» и колонками dd.mm.
   * Возвращает {month, year?, rows: [{group, no, name, values: [str по дням]}]}.
   */
  function parseBonusTable(text) {
    const rows = parseCsv(text);
    let hdr = -1, nameCol = -1;
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const c = rows[r].findIndex((x) => /^\s*(Имя|Name|Jméno)\s*:?\s*$/i.test(x));
      if (c >= 0) { hdr = r; nameCol = c; break; }
    }
    if (hdr < 0) throw new Error('В таблице доплат не найдена колонка «Имя:»');
    const dayCols = [];
    let month = 0;
    rows[hdr].forEach((x, i) => {
      const m = /^\s*(\d{1,2})\.(\d{1,2})\s*$/.exec(x);
      if (m) { dayCols.push({ col: i, day: +m[1] }); month = +m[2]; }
    });
    const out = [];
    for (let r = hdr + 1; r < rows.length; r++) {
      const row = rows[r];
      const name = (row[nameCol] || '').trim();
      if (!name) continue;
      const values = [];
      for (const dc of dayCols) values[dc.day] = (row[dc.col] || '').trim();
      out.push({ group: (row[0] || '').trim(), no: (row[1] || '').trim(), name, values });
    }
    return { month, rows: out };
  }

  function parseNum(s) {
    const v = parseFloat(String(s).replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  }

  function fmtNum(v) {
    return v == null ? '' : String(v).replace('.', ',');
  }

  // ================================================================ XML
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unescapeXml(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));
  }
  function attrs(s) {
    const a = {};
    const re = /([\w:.-]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(s))) a[m[1]] = unescapeXml(m[2]);
    return a;
  }
  /** Потоковый разбор XML: вызывает on(type, name, attrs|text). type: 'open' | 'close' | 'text'. */
  function scanXml(xml, on) {
    const re = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|([^<]+)/g;
    let m;
    while ((m = re.exec(xml))) {
      if (m[5] !== undefined) { on('text', null, m[5]); continue; }
      if (!m[2]) continue;
      if (m[1]) on('close', m[2]);
      else {
        on('open', m[2], attrs(m[3] || ''));
        if (m[4]) on('close', m[2]);
      }
    }
  }
  const utf8 = (b) => new TextDecoder('utf-8').decode(b);

  // ================================================================ ODS
  /**
   * Разбор .ods: [{name, rows: [[{t, bg, span, cov}]]}].
   * Хвостовые пустые повторы строк/колонок обрезаются.
   */
  async function readOds(buf) {
    const files = await readZip(buf);
    const content = files.find((f) => f.name === 'content.xml');
    if (!content) throw new Error('Это не файл .ods (нет content.xml)');
    return parseOdsXml(utf8(content.data));
  }

  /** Разбор content.xml из .ods (без распаковки — её делает вызывающий). */
  function parseOdsXml(xml) {
    const bg = {};
    const sheets = [];
    let styleName = null, sheet = null, row = null, rowRep = 1, cell = null, colDefaults = [];
    let inAnn = 0, inP = false, para = '';
    const MAXC = 400;
    scanXml(xml, (type, name, a) => {
      if (type === 'text') { if (cell && inP && !inAnn) para += unescapeXml(a); return; }
      if (type === 'open') {
        switch (name) {
          case 'style:style': styleName = a['style:name']; break;
          case 'style:table-cell-properties': if (styleName && a['fo:background-color']) bg[styleName] = a['fo:background-color']; break;
          case 'table:table': sheet = { name: a['table:name'], rows: [] }; colDefaults = []; break;
          case 'table:table-column': {
            const n = Math.min(+(a['table:number-columns-repeated'] || 1), MAXC);
            for (let i = 0; i < n && colDefaults.length < MAXC; i++) colDefaults.push(a['table:default-cell-style-name']);
            break;
          }
          case 'table:table-row': row = []; rowRep = +(a['table:number-rows-repeated'] || 1); break;
          case 'table:table-cell': case 'table:covered-table-cell': {
            const col = row.length;
            const st = a['table:style-name'] || colDefaults[col];
            cell = { t: '', bg: bg[st] || null, span: +(a['table:number-columns-spanned'] || 1), cov: name === 'table:covered-table-cell',
              rep: Math.min(+(a['table:number-columns-repeated'] || 1), Math.max(0, MAXC - col)) };
            const dv = /^(\d{4})-(\d{2})-(\d{2})/.exec(a['office:date-value'] || '');
            if (dv) cell.d = Date.UTC(+dv[1], +dv[2] - 1, +dv[3]);
            break;
          }
          case 'office:annotation': inAnn++; break;
          case 'text:p': inP = true; para = ''; break;
          case 'text:s': if (cell && inP && !inAnn) para += ' '.repeat(+(a['text:c'] || 1)); break;
          case 'text:line-break': if (cell && inP && !inAnn) para += '\n'; break;
          case 'text:tab': if (cell && inP && !inAnn) para += '\t'; break;
        }
      } else {
        switch (name) {
          case 'style:style': styleName = null; break;
          case 'text:p': if (cell && !inAnn) cell.t += (cell.t ? '\n' : '') + para; inP = false; break;
          case 'office:annotation': inAnn--; break;
          case 'table:table-cell': case 'table:covered-table-cell':
            if (cell) { const { rep, ...c } = cell; for (let i = 0; i < rep; i++) row.push(c); }
            cell = null; break;
          case 'table:table-row': {
            // хвост пустых ячеек обрезаем
            while (row.length && !row[row.length - 1].t && !row[row.length - 1].cov && row[row.length - 1].span === 1) row.pop();
            const n = row.length ? Math.min(rowRep, 50) : Math.min(rowRep, 1);
            for (let i = 0; i < n; i++) sheet.rows.push(row);
            row = null; break;
          }
          case 'table:table':
            while (sheet.rows.length && !sheet.rows[sheet.rows.length - 1].length) sheet.rows.pop();
            sheets.push(sheet); sheet = null; break;
        }
      }
    });
    return sheets;
  }

  // ================================================================ XLSX (таблица доплат)
  function colIndex(ref) { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
  /** .xlsx -> [{name, rows: [[value]]}]; числа как Number, строки как String. */
  async function readXlsx(buf) {
    const files = await readZip(buf);
    const get = (n) => { const f = files.find((x) => x.name === n); return f ? utf8(f.data) : null; };
    const shared = [];
    const ss = get('xl/sharedStrings.xml');
    if (ss) {
      let cur = null, inT = false;
      scanXml(ss, (type, name, a) => {
        if (type === 'open' && name === 'si') cur = '';
        else if (type === 'open' && name === 't') inT = true;
        else if (type === 'close' && name === 't') inT = false;
        else if (type === 'close' && name === 'si') { shared.push(cur); cur = null; }
        else if (type === 'text' && inT && cur !== null) cur += unescapeXml(a);
      });
    }
    const wb = get('xl/workbook.xml') || '';
    const rels = get('xl/_rels/workbook.xml.rels') || '';
    const relMap = {};
    scanXml(rels, (type, name, a) => { if (type === 'open' && name === 'Relationship') relMap[a.Id] = a.Target; });
    const sheets = [];
    scanXml(wb, (type, name, a) => {
      if (type === 'open' && name === 'sheet') {
        const target = relMap[a['r:id']] || '';
        sheets.push({ name: a.name, path: 'xl/' + target.replace(/^\/?xl\//, '') });
      }
    });
    return sheets.map((s) => {
      const xml = get(s.path) || '';
      const rows = [];
      let r = null, ref = null, t = null, val = null, inV = false, inIs = false;
      scanXml(xml, (type, name, a) => {
        if (type === 'open') {
          if (name === 'row') r = []; else if (name === 'c') { ref = a.r; t = a.t; val = ''; }
          else if (name === 'v') inV = true; else if (name === 't' && t === 'inlineStr') inIs = true;
        } else if (type === 'close') {
          if (name === 'v') inV = false; else if (name === 't') inIs = false;
          else if (name === 'c') {
            let v = val;
            if (t === 's') v = shared[+val]; else if (t === 'str' || t === 'inlineStr') v = val;
            else if (t === 'b') v = val === '1'; else if (val !== '' && val != null) v = +val; else v = null;
            r[colIndex(ref)] = v;
          } else if (name === 'row') { rows.push(r); r = null; }
        } else if (inV || inIs) val += unescapeXml(a);
      });
      return { name: s.name, rows };
    });
  }

  /** Таблицы доплат из .xlsx: по листу на месяц. */
  function bonusFromXlsx(sheets) {
    const out = [];
    for (const s of sheets) {
      const hdrIdx = s.rows.findIndex((r) => r && r.some((x) => typeof x === 'string' && /^\s*(Имя|Name|Jméno)\s*:?\s*$/i.test(x)));
      if (hdrIdx < 0) continue;
      const hdr = s.rows[hdrIdx];
      const nameCol = hdr.findIndex((x) => typeof x === 'string' && /^\s*(Имя|Name|Jméno)/i.test(x));
      const dayCols = [];
      let year = 0, month = 0;
      hdr.forEach((x, i) => {
        if (typeof x === 'number' && x > 30000 && x < 80000) {
          const d = new Date(Math.round((x - 25569) * 86400000));
          dayCols.push({ col: i, day: d.getUTCDate() }); year = d.getUTCFullYear(); month = d.getUTCMonth() + 1;
        } else if (typeof x === 'string') {
          const m = /^\s*(\d{1,2})\.(\d{1,2})\.?(\d{4})?\s*$/.exec(x);
          if (m) { dayCols.push({ col: i, day: +m[1] }); month = +m[2]; if (m[3]) year = +m[3]; }
        }
      });
      if (!dayCols.length) continue;
      const rows = [];
      for (let r = hdrIdx + 1; r < s.rows.length; r++) {
        const row = s.rows[r] || [];
        const name = row[nameCol];
        if (typeof name !== 'string' || !name.trim()) continue;
        const values = [];
        for (const dc of dayCols) { const v = row[dc.col]; values[dc.day] = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v).trim(); }
        rows.push({ group: row[0] == null ? '' : String(row[0]), no: row[1] == null ? '' : String(row[1]).replace(/\.0$/, ''), name: name.trim(), values });
      }
      out.push({ sheet: s.name, year, month, rows });
    }
    return out;
  }

  // ================================================================ план -> часы
  const PLAN_RULES = {
    // Не работа (подтверждено бухгалтерией): отдых, простой, больница, ангар, документы, поломка.
    nonWork: /NO\s*DRIVER|HANGAR|HOSPITAL|SERVICE|BROKEN|BROKE\s*DOWN|\bDOCS\b|URLAUB|VACATION|DOVOLEN|SICK|NEMOC|\bOFF\b/i,
    restColor: '#f79646',
    // Блок рейса длиннее — «длинный рейс».
    longBlockHours: 12,
    // Для проверки помечается ночь глубоко внутри длинного рейса: не меньше checkNightHours ночных часов
    // позже checkAfterHours от начала рейса (водитель мог стоять, а REST не отмечен).
    checkAfterHours: 16,
    checkNightHours: 4,
    // После REST в строке машины водитель отдыхает до отметки «s», если она не дальше чем через столько часов.
    startWaitHours: 24,
    // Пустота между рейсами длиннее — не считается работой.
    maxGapHours: 6,
  };
  const PLATE = /^\s*\d?[A-Z]{2,4}\s?\d{3,4}/;
  const isRestCell = (c) => {
    const t = (c.t || '').trim().toUpperCase();
    return (c.bg || '').toLowerCase() === PLAN_RULES.restColor || t.startsWith('REST') || /^R\d/.test(t);
  };
  const isBlank = (c) => !(c.t || '').trim() && (!c.bg || /^(transparent|#ffffff)$/i.test(c.bg));

  /**
   * Лента по часам для каждого водителя.
   * Map(normName -> {name, hours: Map(ts -> {kind, block, truck})})
   * ts — «местное» время как Date.UTC(y, m-1, d, h).
   * kind: 'work' | 'rest' | 'off' | 'empty'
   */
  function planTimelines(sheets) {
    const drivers = new Map();
    for (const sh of sheets) {
      const g = sh.rows;
      if (!g.length) continue;
      const hdr = g[0];
      let c0 = -1, start = 0;
      for (let j = 0; j < hdr.length; j++) {
        const d = hdr[j] && (hdr[j].d != null ? hdr[j].d : headerDate(hdr[j].t));
        if (d != null) { c0 = j; start = d; break; }
      }
      if (c0 < 0) continue;
      const walk = (row, fn) => {
        let j = c0;
        while (j < c0 + 168 && j < row.length) {
          const c = row[j];
          if (c.cov) { j++; continue; }
          const sp = Math.max(1, c.span);
          fn(c, start + (j - c0) * 3600000, sp);
          j += sp;
        }
      };
      for (let i = 2; i < g.length; i++) {
        const r = g[i];
        const label = (r[0]?.t || '').replace(/\s+/g, ' ').trim();
        if (!label || PLATE.test(label)) continue;
        const key = normName(label);
        if (!key) continue;
        if (!drivers.has(key)) drivers.set(key, { name: label.replace(/\s+(NO\s+\w+)+$/i, ''), hours: new Map() });
        const hours = drivers.get(key).hours;
        // строка водителя
        for (let h = 0; h < 168; h++) { const ts = start + h * 3600000; if (!hours.has(ts)) hours.set(ts, { kind: 'empty', block: null, truck: null }); }
        walk(r, (c, ts, sp) => {
          let kind = 'empty';
          if (isRestCell(c)) kind = 'rest';
          else if ((c.t || '').trim() && PLAN_RULES.nonWork.test(c.t)) kind = 'off';
          else if (!isBlank(c)) kind = 'work';
          const block = { start: ts, hours: sp, text: (c.t || '').trim(), bg: c.bg };
          for (let h = 0; h < sp; h++) { const t = ts + h * 3600000; if (t < start + 168 * 3600000) hours.set(t, { kind, block, truck: null }); }
        });
        // строка машины над водителем
        const tr = g[i - 1];
        if (tr && PLATE.test((tr[0]?.t || '').replace(/\s+/g, ' '))) {
          walk(tr, (c, ts, sp) => {
            const t = (c.t || '').trim();
            let mark = null;
            if (isRestCell(c) && (t || (c.bg || '').toLowerCase() === PLAN_RULES.restColor)) mark = 'rest';
            else if (/^s/i.test(t)) mark = 'start';
            if (!mark) return;
            for (let h = 0; h < (mark === 'rest' ? sp : 1); h++) {
              const e = hours.get(ts + h * 3600000);
              if (e) e.truck = { mark, text: t, start: ts, hours: sp };
            }
          });
        }
      }
    }
    return drivers;
  }

  /**
   * Водитель плана по имени из таблицы доплат. Находит и строки экипажей
   * («Andrii Kuziev Antonina Ivanchuk», «Holikov + Dekhkonov»): все слова имени должны быть в подписи.
   * Если водитель стоит в нескольких строках, часы объединяются (рейс важнее отдыха, отдых — пустоты).
   */
  function planDriverFor(drivers, name) {
    const key = normName(name);
    if (!key) return null;
    if (!drivers._byName) drivers._byName = new Map();
    if (drivers._byName.has(key)) return drivers._byName.get(key);
    const want = key.split(' ');
    const matches = [];
    for (const [k, d] of drivers) {
      if (k === key) { matches.unshift(d); continue; }
      const have = k.split(' ');
      if (have.length <= want.length) continue;
      const pool = [...have];
      if (want.every((w) => { const i = pool.indexOf(w); if (i < 0) return false; pool.splice(i, 1); return true; })) matches.push(d);
    }
    let res = null;
    if (matches.length === 1) res = matches[0];
    else if (matches.length > 1) {
      const rank = { work: 3, rest: 2, off: 1, empty: 0 };
      const hours = new Map();
      for (const d of matches) {
        for (const [t, e] of d.hours) {
          const cur = hours.get(t);
          if (!cur || rank[e.kind] > rank[cur.kind] || (!cur.truck && e.truck && rank[e.kind] === rank[cur.kind])) hours.set(t, e);
        }
      }
      res = { name: matches[0].name, hours };
    }
    drivers._byName.set(key, res);
    return res;
  }

  /** Итоговая классификация часа с учётом строки машины и правила «s». */
  function resolvePlan(hoursMap) {
    const ts = [...hoursMap.keys()].sort((a, b) => a - b);
    const H = 3600000;
    const res = new Map();
    for (const t of ts) {
      const e = hoursMap.get(t);
      let kind = e.kind;
      if (e.truck && e.truck.mark === 'rest') kind = 'rest';
      res.set(t, { kind, why: e.truck && e.truck.mark === 'rest' ? 'REST в строке машины' : null, e });
    }
    // пустые ячейки между двумя рейсами — работа (если пустота не длиннее maxGapHours)
    for (let i = 0; i < ts.length;) {
      if (res.get(ts[i]).kind !== 'empty') { i++; continue; }
      let j = i;
      while (j < ts.length && res.get(ts[j]).kind === 'empty' && (j === i || ts[j] - ts[j - 1] === H)) j++;
      const l = i > 0 && ts[i] - ts[i - 1] === H ? res.get(ts[i - 1]).kind : null;
      const rr = j < ts.length && ts[j] - ts[j - 1] === H ? res.get(ts[j]).kind : null;
      if (l === 'work' && rr === 'work' && j - i <= PLAN_RULES.maxGapHours) {
        for (let q = i; q < j; q++) { const r = res.get(ts[q]); r.kind = 'gap'; r.why = 'пусто между рейсами'; }
      }
      i = j;
    }
    // после REST в строке машины — отдых до отметки «s»
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = hoursMap.get(ts[i]), b = hoursMap.get(ts[i + 1]);
      if (!(a.truck && a.truck.mark === 'rest') || (b.truck && b.truck.mark === 'rest')) continue;
      let found = -1;
      for (let j = i + 1; j < ts.length && j - i <= PLAN_RULES.startWaitHours; j++) {
        const tj = hoursMap.get(ts[j]).truck;
        if (tj && tj.mark === 'rest') break;
        if (tj && tj.mark === 'start') { found = j; break; }
      }
      for (let q = i + 1; q < found; q++) {
        const r = res.get(ts[q]);
        if (r.kind === 'work' || r.kind === 'gap') { r.kind = 'wait'; r.why = 'отдых до отметки «s»'; }
      }
    }
    return res;
  }

  /**
   * Ночные часы по плану за месяц: [{day, hours, status, notes, detail}]
   * status: 'ok' | 'check' (длинный рейс ночью без отметок) | 'nodata'
   */
  function planNightHours(driver, year, month) {
    if (!driver._resolved) driver._resolved = resolvePlan(driver.hours);
    const res = driver._resolved;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const out = [];
    for (let d = 1; d <= days; d++) {
      const hrs = [0, 1, 2, 3, 4, 5, 22, 23].map((h) => Date.UTC(year, month - 1, d, h));
      const cells = hrs.map((t) => res.get(t));
      if (cells.every((c) => !c)) { out.push({ day: d, hours: null, status: 'nodata', notes: ['нет недели в плане'] }); continue; }
      let hours = 0, deep = 0, long = null;
      hrs.forEach((t, i) => {
        const c = cells[i];
        if (!c) return;
        if (c.kind === 'work' || c.kind === 'gap') {
          hours++;
          const b = c.e.block;
          if (b && b.text && b.hours > PLAN_RULES.longBlockHours) {
            long = b;
            if ((t - b.start) / 3600000 >= PLAN_RULES.checkAfterHours) deep++;
          }
        }
      });
      const check = deep >= PLAN_RULES.checkNightHours;
      const notes = [];
      if (check) notes.push(`${deep} ч ночью внутри рейса «${long.text.split('\n')[0]}» (${long.hours} ч), REST не отмечен — водитель мог стоять`);
      else if (long) notes.push(`длинный рейс ${long.hours} ч: «${long.text.split('\n')[0]}»`);
      out.push({ day: d, hours, status: check ? 'check' : 'ok', notes });
    }
    return out;
  }

  /**
   * Пояснение к ночи даты: «00–04 рейс «LGG-FRA» · 04–06 отдых: REST в строке машины · 22–24 рейс «…»».
   */
  function planNightExplain(driver, year, month, day) {
    if (!driver._resolved) driver._resolved = resolvePlan(driver.hours);
    const label = { work: 'рейс', gap: 'между рейсами (работа)', wait: 'не работа: ждёт старта «s», в плане', rest: 'REST', off: 'не работа', empty: 'пусто', none: 'нет в плане' };
    const parts = [];
    for (const [a, b] of [[0, 6], [22, 24]]) {
      let seg = null;
      for (let h = a; h <= b; h++) {
        const r = h < b ? driver._resolved.get(Date.UTC(year, month - 1, day, h)) : null;
        const kind = r ? r.kind : 'none';
        const text = r && r.e.block && (kind === 'work' || kind === 'off' || kind === 'wait') ? r.e.block.text.split('\n')[0].trim() : '';
        const why = r && r.why && kind !== 'gap' && kind !== 'wait' ? r.why : '';
        const id = kind + '|' + text + '|' + why;
        if (seg && seg.id === id && h < b) { seg.to = h + 1; continue; }
        if (seg && seg.kind !== 'empty' && seg.kind !== 'none') {
          parts.push(`${String(seg.from).padStart(2, '0')}–${String(seg.to).padStart(2, '0')} ${label[seg.kind]}${seg.text ? ` «${seg.text}»` : ''}${seg.why ? `: ${seg.why}` : ''}`);
        }
        seg = h < b ? { id, kind, text, why, from: h, to: h + 1 } : null;
      }
    }
    return parts.join(' · ');
  }

  /** Лента плана за сутки ± часы — для панели подробностей. */
  function planDay(driver, year, month, day) {
    if (!driver._resolved) driver._resolved = resolvePlan(driver.hours);
    const out = [];
    for (let h = -2; h < 24; h++) {
      const t = Date.UTC(year, month - 1, day, h);
      const r = driver._resolved.get(t);
      out.push({ t, hour: (h + 24) % 24, kind: r ? r.kind : 'none', why: r ? r.why : null,
        text: r && r.e.block ? r.e.block.text : '', truck: r && r.e.truck ? r.e.truck.text : '' });
    }
    return out;
  }

  const api = {
    DEFAULTS, ACT, readZip, parseDriverCard, mergeCards, nightHours, nightTimeline,
    roundHours, normName, parseCsv, decodeText, parseDispatchPlan, planHint, czMonth,
    parseBonusTable, parseNum, fmtNum, localToUtc, segments, blocks, applyPauseRule,
    readOds, parseOdsXml, readXlsx, bonusFromXlsx, headerDate, planTimelines, planDriverFor, resolvePlan, planNightHours, planNightExplain, planDay, PLAN_RULES,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NightHours = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

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
  let sheets;
  if (file.kind === 'ods') {
    // .ods читаем сами: распаковываем и разбираем content.xml — без конвертации Google
    nhProgress_(`1/3 Открываю «${file.name}»…`);
    const blob = DriveApp.getFileById(file.id).getBlob().setContentType('application/zip');
    const content = Utilities.unzip(blob).find((b) => b.getName() === 'content.xml');
    if (!content) throw new Error(`«${file.name}» не похож на файл .ods`);
    nhProgress_('2/3 Читаю недели плана…');
    sheets = NightHours.parseOdsXml(content.getDataAsString('UTF-8')).filter((sh) => {
      const hdr = sh.rows[0] || [];
      const d = hdr.map((c) => (c && (c.d != null ? c.d : NightHours.headerDate(c.t)))).find((x) => x != null);
      return d != null && d <= toTs && d + 7 * 86400000 >= fromTs;
    });
    if (!sheets.length) throw new Error(`В «${file.name}» нет недель за этот месяц (проверьте даты в первой строке листов).`);
  } else if (file.kind === 'gsheet') {
    nhProgress_('2/3 Читаю недели плана…');
    sheets = nhReadPlan_(file.id, fromTs, toTs);
  } else {
    // .xlsx — через временную Google-копию (Google иногда не может сконвертировать большой файл)
    nhProgress_(`1/3 Делаю временную копию «${file.name}»…`);
    let tmp;
    try {
      const blob = DriveApp.getFileById(file.id).getBlob();
      tmp = Drive.Files.create({ name: 'Ночные часы — временная копия плана', mimeType: 'application/vnd.google-apps.spreadsheet' }, blob);
    } catch (e) {
      throw new Error(`Google не смог открыть «${file.name}» (${e.message}). Сохраните план в формате .ods (Excel: Файл → Сохранить как → Скачать как ODS) и положите в папку.`);
    }
    try {
      nhProgress_('2/3 Читаю недели плана…');
      sheets = nhReadPlan_(tmp.id, fromTs, toTs);
    } finally {
      try { Drive.Files.remove(tmp.id); } catch (e) { /* удалить вручную */ }
    }
  }
  const drivers = NightHours.planTimelines(sheets);
  const ageDays = (Date.now() - file.updated.getTime()) / 86400000;
  return { drivers, file, stale: ageDays > 8 };
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
  const L = nhBonusLayout_(main);
  // сначала читаем план: если с ним проблема, пустой черновик не создаётся
  const plan = nhLoadPlan_(Date.UTC(L.year, L.month - 1, 1) - 8 * 86400000, Date.UTC(L.year, L.month, 1) + 2 * 86400000);
  const draft = nhDraftOf_(main);
  const st = nhFillSheet_(draft, { mode: 'auto', until: nhToday_(), main, plan });
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

function nhProgress_(msg) {
  try { SpreadsheetApp.getActive().toast(msg, 'Ночные часы', 60); } catch (e) { /* по расписанию окна нет */ }
  console.log(msg);
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
    nhProgress_(`2/3 Прочитан лист «${sh.getName()}»`);
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
  const plan = opt.plan || nhLoadPlan_(from, to);
  const drivers = plan.drivers;
  nhProgress_('3/3 Записываю черновик…');

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
