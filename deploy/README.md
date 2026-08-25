# Деплой task-bot на прод

Пайплайн ([.gitea/workflows/deploy-prod.yml](../.gitea/workflows/deploy-prod.yml)) при push в `main`:
собирает образ → пушит `git.example.com/acme/task-bot:{latest,sha}` → по SSH зовёт
`sudo deploy.sh task-bot <image>`, который тянет образ и пересоздаёт контейнер.

> **Cloudflare 525.** Registry за Cloudflare иногда отдаёт `525` на pull. Не блокер: блок
> task-bot в `deploy.sh` ретраит `docker pull` до 5 раз — этого хватает (доезжает со 2–4 попытки).

> ⚠️ **Compose ДОЛЖЕН использовать `image: ${IMAGE}`, не `build:`.** Иначе deploy.sh скачает
> свежий образ, а контейнер поднимется из старого локального билда — и изменения «не доедут»
> (типичный симптом: в логе `Image: …task-bot:<sha>`, а `docker compose ps` показывает другой image).

Бот — **single-instance** (Telegram пускает один `getUpdates`; в webhook-режиме — один routed
слот). Поэтому он **не вписывается в blue-green** существующего `deploy.sh` — нужен простой
`recreate`.

## 1. Патч `/usr/local/bin/deploy.sh`

Вставить блок **после** определения функций `log()/err()` и **до** комментария
`# --- Маппинг сервис → директория, upstream ---`:

```bash
# --- Простые сервисы (single instance, без nginx/blue-green) ---
# task-bot: исходящий long-polling Telegram-бот. Нет HTTP-порта; нельзя держать
# два инстанса одновременно (Telegram пускает один getUpdates) → не blue-green,
# а обычный recreate (старый стоп → новый старт).
if [[ "$SERVICE" == "task-bot" ]]; then
    APP_DIR="/var/www/task-bot"
    COMPOSE_FILE="${APP_DIR}/docker-compose.yml"
    [[ ! -f "$COMPOSE_FILE" ]] && err "Не найден ${COMPOSE_FILE}"
    cd "$APP_DIR"
    log "=== ${SERVICE}: recreate (single instance) ==="
    log "Image: ${IMAGE}"
    # Образ приезжает по SSH (docker load) → он уже локально, pull не нужен.
    # Если вдруг нет (вернули registry) — тянем.
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then
        log "Образ уже локально (docker load), pull пропускаем"
    else
        for i in $(seq 1 5); do
            if docker pull "$IMAGE"; then break; fi
            [[ $i -eq 5 ]] && err "Не удалось скачать образ после 5 попыток."
            sleep 10
        done
    fi
    export IMAGE
    docker compose up -d --force-recreate
    sleep 5
    docker compose ps
    docker image prune -f --filter "until=48h" > /dev/null 2>&1 || true
    log "${SERVICE} деплой завершён"
    exit 0
fi
```

> Без этого блока `deploy.sh task-bot` упрётся в `err "Неизвестный сервис"`.

## 2. Серверный compose

```bash
sudo mkdir -p /var/www/task-bot
sudo cp docker-compose.prod.yml /var/www/task-bot/docker-compose.yml
```

(файл: [docker-compose.prod.yml](docker-compose.prod.yml) — `image: ${IMAGE}`, без портов, `restart: unless-stopped`.)

## 3. Секреты бота на хосте

`/var/www/task-bot/.env` (рантайм-секреты, в образ НЕ зашиты — см. [../.env.example](../.env.example)):

```
TELEGRAM_BOT_TOKEN=...
ALLOWED_CHAT_IDS=
PIN_ISSUES=true
OFFER_APPROVERS=...
TRACKER=trello
TRELLO_API_KEY=...
TRELLO_TOKEN=...
TRELLO_BOARD_ID=a1B2c3D4      # опционально: закрепить бота за одной доской
```

Для YouGile вместо трёх последних строк:
```
TRACKER=yougile
YOUGILE_BASE_URL=https://ru.yougile.com
YOUGILE_TOKEN=...
YOUGILE_TASK_URL=https://ru.yougile.com/.../{id}
```

(имена колонок берутся из дефолтов — переопределяй `LIST_TODO` / `LIST_DONE` / `LIST_CANCELLED` и `TRELLO_LABEL_OFFER` только если на доске они названы иначе. Перед первым запуском на новой доске — `npm run init "<имя доски>"`, либо кнопка «➕ Создать» прямо в чате.)

```bash
sudo chmod 600 /var/www/task-bot/.env
```

## 4. Доступ к registry

Хост должен уметь `docker pull` из `git.example.com` — авторизация в
`~/.docker/config.json` пользователя, под которым выполняется deploy.sh.

## 5. Секреты Gitea Actions

`CI_TOKEN`, `SSH_PRIVATE_KEY`, `SSH_HOST`, `SSH_USER` — должны быть доступны репо `task-bot`
(org-level на `acme` подхватятся; иначе добавить в Settings → Actions → Secrets).

## Проверка

После настройки — повторный push в `main` (или Re-run job в Actions). Деплой должен
закончиться `task-bot деплой завершён`, контейнер `task-bot` — `Up`.
Логи на хосте: `docker logs -f task-bot`.

---

## Webhook вместо polling (если polling через прокси флапает)

Polling держит долгий `getUpdates` через прокси — на дешёвом прокси это «долго
подключается». Webhook убирает приём через прокси: Telegram сам шлёт POST на прод.
**Но отправка (ответы/карточки/pin) всё равно идёт через прокси**, и webhook сработает,
только если **серверы Telegram достучатся до прода по HTTPS**. Сначала проверь это.

### Шаг 0 — проверить достижимость (без кода)

Telegram блокируется в обе стороны → этот шаг решает, есть ли смысл. Из `/var/www/task-bot`:

```bash
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-)
PROXY=$(grep '^TELEGRAM_PROXY=' .env | cut -d= -f2-)
URL="https://bot.example.com/tg-task-bot/$(openssl rand -hex 16)"   # секрет в пути

# поставить webhook (через прокси — исходящий вызов)
curl -x "$PROXY" -sS "https://api.telegram.org/bot${TOKEN}/setWebhook?url=${URL}"; echo
# подождать ~30с, пока кто-то напишет боту, и посмотреть, доходит ли Telegram до прода:
curl -x "$PROXY" -sS "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"; echo
```

В `getWebhookInfo` смотри `last_error_message`:
- пусто / `pending_update_count` падает → **Telegram достаёт прод, webhook жизнеспособен** → настраивай ниже.
- `Connection timed out` / `Connection refused` / растущий `pending_update_count` → **прод недостижим извне**, webhook не вариант, остаёмся на polling.

Снять тестовый webhook, чтобы вернуть polling: `curl -x "$PROXY" ".../deleteWebhook"`.

### Шаг 1 — env

В `/var/www/task-bot/.env`:

```
WEBHOOK_URL=https://bot.example.com/tg-task-bot/<тот_же_секрет_из_пути>
WEBHOOK_PORT=8090
WEBHOOK_SECRET=<любая_случайная_строка>   # доп. валидация заголовка
```

### Шаг 2 — порт контейнера

В `/var/www/task-bot/docker-compose.yml` раскомментируй (см. docker-compose.prod.yml):

```yaml
    ports:
      - "127.0.0.1:8090:8090"
```

### Шаг 3 — nginx на хосте

Внутрь существующего HTTPS-сервера (напр. `bot.example.com`) добавить location:

```nginx
location /tg-task-bot/ {
    proxy_pass http://127.0.0.1:8090;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
}
```

`sudo nginx -t && sudo nginx -s reload`.

### Шаг 4 — перезапуск

`docker compose up -d --force-recreate`. В логах: `[bot] webhook mode on :8090 → …`.
setWebhook бот вызовет сам на старте (через прокси). Переключиться обратно на polling —
убрать `WEBHOOK_URL` из `.env` и пересоздать (бот сам сделает `deleteWebhook`).
