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
    const xml = utf8(content.data);
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
    // Блок рейса длиннее — «длинный рейс», если ночью нет отметки REST в строке машины, день помечается для проверки.
    longBlockHours: 12,
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
        const m = /([^\s,]+)\s+(\d{1,2}),\s*(\d{4})/.exec(hdr[j]?.t || '');
        if (m && czMonth(m[1])) { c0 = j; start = Date.UTC(+m[3], czMonth(m[1]) - 1, +m[2]); break; }
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
      let hours = 0; const notes = new Set(); let long = null;
      hrs.forEach((t, i) => {
        const c = cells[i];
        if (!c) return;
        if (c.kind === 'work' || c.kind === 'gap') {
          hours++;
          const b = c.e.block;
          if (b && b.text && b.hours > PLAN_RULES.longBlockHours) long = b;
        }
      });
      if (long) notes.add(`длинный рейс ${long.hours} ч: «${long.text.split('\n')[0]}»`);
      out.push({ day: d, hours, status: long ? 'check' : 'ok', notes: [...notes] });
    }
    return out;
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
    readOds, readXlsx, bonusFromXlsx, planTimelines, planDriverFor, resolvePlan, planNightHours, planDay, PLAN_RULES,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NightHours = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
