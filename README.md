# CodeDash

Браузерный дашборд для сессий Claude Code и Codex. Смотри, ищи, возобновляй и управляй всеми своими AI-сессиями.

https://github.com/user-attachments/assets/15c45659-365b-49f8-86a3-9005fa155ca6

![npm](https://img.shields.io/npm/v/codedash-app?style=flat-square) ![Node](https://img.shields.io/badge/node-%3E%3D16-green?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

## Быстрый старт

```bash
npx codedash-app run
```

Откроется `http://localhost:3847` в браузере.

```bash
npx codedash-app run --port=4000    # свой порт
npx codedash-app run --no-browser   # без авто-открытия
npx codedash-app list               # список сессий в терминале
npx codedash-app stats              # статистика
```

## Возможности

**Сессии**
- Grid и List вид с группировкой по проектам
- Trigram нечёткий поиск по содержимому и проектам (опечатки не страшны)
- Фильтры по инструменту (Claude/Codex), тегам, диапазону дат
- Звёздочки/закрепление важных сессий (всегда вверху списка)
- Теги: bug, feature, research, infra, deploy, review
- Heatmap активности в стиле GitHub
- Оценка стоимости сессии

**Запуск**
- Возобновление сессий в iTerm2, Terminal.app, Warp, Kitty, Alacritty
- Авто `cd` в директорию проекта перед запуском
- Копирование команды resume в буфер обмена
- Выбор терминала сохраняется между сессиями

**Управление**
- Удаление сессий (файл + история + env)
- Массовое выделение и удаление
- Экспорт переписки в Markdown
- Связанные git-коммиты для каждой сессии
- Авто-проверка обновлений

**Темы**
- Dark (по умолчанию), Light, System

**Горячие клавиши**
- `/` поиск, `j/k` навигация, `Enter` открыть
- `x` звезда, `d` удалить, `s` режим выделения, `g` группировка
- `r` обновить, `Escape` закрыть панели

## Как работает

Читает данные сессий из `~/.claude/` и `~/.codex/`:
- `history.jsonl` — индекс сессий
- `projects/*/<session-id>.jsonl` — данные переписки
- `sessions/` — файлы сессий Codex

Ноль зависимостей. Всё работает на `localhost`.

## Требования

- Node.js >= 16
- Claude Code или Codex CLI
- macOS / Linux / Windows

## Лицензия

MIT
