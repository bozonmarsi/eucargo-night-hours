#!/usr/bin/env node
// Собирает одну HTML-страницу: src/app.html + src/core.js -> dist/night-hours.html
// Файл открывается двойным щелчком, интернет нужен только для шрифтов.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/app.html'), 'utf8');
const core = fs.readFileSync(path.join(root, 'src/core.js'), 'utf8');
const body = app.replace('/*CORE*/', () => core);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
// Фрагмент без <html>/<head> — для публикации как Artifact.
fs.writeFileSync(path.join(root, 'dist/fragment.html'), body);
// Полный документ — для открытия с диска.
const full = `<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
fs.writeFileSync(path.join(root, 'dist/night-hours.html'), full);
// index.html — для GitHub Pages.
fs.writeFileSync(path.join(root, 'dist/index.html'), full);
// Скрипт для Google Таблицы: ядро + меню.
const gs = `// Ночные часы водителей — Google Apps Script. Собрано из src/core.js и apps-script/main.js.\n${core}\n${fs.readFileSync(path.join(root, 'apps-script/main.js'), 'utf8')}`;
fs.writeFileSync(path.join(root, 'dist/NightHours.gs'), gs);
console.log('dist/night-hours.html', full.length, 'байт; dist/NightHours.gs', gs.length, 'байт');
