# investments_app

Сводка, графики и ведение учёта инвестиционного портфеля. Данных в этом репозитории нет:
приложение читает и записывает CSV в **отдельном приватном** репозитории (формат — ниже).
Поделиться этим репозиторием можно спокойно: без вашего токена до ваших данных не добраться.

```
investments_app (этот, можно публичный)          investments_db (приватный)
  index.html  — страница: сводка, графики,  ──►    portfolios.csv
                ввод и удаление операций            portfolios/<id>/*.csv
  cli/        — то же для терминала и агентов
  src/core/   — расчёты, общие для страницы и CLI
```

## Страница

Статическая, без сборки и зависимостей. Хостится на GitHub Pages
(Settings → Pages → Deploy from a branch → `main` / root) или открывается локально:

```sh
python3 -m http.server 8000   # затем http://localhost:8000
```

При первом открытии страница просит владельца, репозиторий с данными и токен.
Нужен **fine-grained token** (GitHub → Settings → Developer settings → Fine-grained tokens):

- Repository access: *Only select repositories* → только репозиторий с данными;
- Permissions → Repository → **Contents: Read and write**;
- срок действия — ограниченный.

Токен хранится только в этом браузере (`localStorage`, либо до закрытия вкладки, если снять галочку
«Запомнить»). Запросы идут напрямую из браузера в `api.github.com`, сторонних серверов нет.

Все ваши сайты на GitHub Pages живут на одном адресе `<логин>.github.io`, поэтому скрипт любого из них
может прочитать сохранённый токен. Если на Pages есть что-то ещё, подключите приложению свой домен
или не ставьте галочку «Запомнить».

Каждое изменение — один атомарный коммит в репозиторий с данными. Если данные поменялись после
загрузки страницы (например, агент закоммитил), запись отклоняется — нужно нажать «Обновить».

## CLI

Node 18+, зависимостей нет.

```sh
node cli/invest.js list                --data ../investments_db
node cli/invest.js summary ipoteka     --data ../investments_db          # сводка текстом
node cli/invest.js summary ipoteka     --data ../investments_db --json   # всё посчитанное в JSON
node cli/invest.js prices  ipoteka     --data ../investments_db          # предпросмотр новых цен
node cli/invest.js prices  ipoteka     --data ../investments_db --write --commit
GITHUB_TOKEN=… node cli/invest.js summary ipoteka --github <логин>/investments_db
```

`prices` берёт цены и НКД облигаций по ISIN с Московской биржи (ISS API), ставит `prices_date`
и добавляет снимок в `history.csv`.

Автоматическая актуализация по расписанию — `examples/update-prices.yml`, кладётся в репозиторий
с данными в `.github/workflows/`.

## Формат данных

Описан в `AGENTS.md` репозитория с данными. Новый портфель — строка в `portfolios.csv`
и папка `portfolios/<id>/` с файлами `settings.csv`, `operations.csv`, `securities.csv`,
`target_classes.csv`, `target_issues.csv`, `history.csv`.

## Разработка

```sh
npm test    # node --test, на выдуманных данных
```

Расчёты — `src/core/model.js`, чистые функции. Страница и CLI используют их одинаково.
