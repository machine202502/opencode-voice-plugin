# OpenCode Voice

Голосовой ввод для [OpenCode](https://opencode.ai) без зависимости от WSL.

Плагин объединяет две части:

- **логику записи и распознавания** из расширения VS Code `vscode-russion-dictate` — перечисление микрофонов, захват через ffmpeg, разбиение на фразы по паузам, GigaAM-v3 / sherpa-onnx, whisper.cpp, OpenAI-совместимый API;
- **идею встраивания** из `OpenCode-Voice` — микрофон в интерфейсе, push-to-talk, всплывающие подсказки, локальный HTTP-сервер для веб-интерфейса.

Всё работает нативно на Windows, macOS и Linux. Node.js не нужен отдельно: OpenCode запускает плагин своим встроенным рантаймом.

---

## Что умеет

| Возможность | Где |
|---|---|
| Запись с микрофона по горячей клавише и вставка текста в промпт | TUI OpenCode |
| `/voice`, `/voice-submit`, `/voice-stop`, `/voice-settings`, `/voice-doctor`, `/voice-reload`, `/voice-warmup` | TUI OpenCode |
| Автоматическая остановка после паузы (одно нажатие — одна фраза) | TUI, HTTP |
| Тёплый sherpa-onnx сервер: модель загружается один раз, фраза распознаётся за ~1 с | `lib/stt/sherpa.js` |
| Локальный HTTP-сервер: `transcribe`, запись с микрофона машины, диагностика | `lib/server/http.js` |
| Кнопка 🎤 и push-to-talk на странице веб-интерфейса | `extension/` |
| Команда `/voice-send` для клиентов без TUI (desktop/web) | `index.js` |

> **Важно про OpenCode 2.** В TUI API версии 2 нет метода, который вставляет текст прямо в композер. Поэтому `/voice` копирует распознанный текст в буфер обмена и показывает подсказку «вставьте Ctrl+V». `/voice-submit` и `/voice-send` отправляют текст в активную сессию сразу через `client.session.prompt()`. В OpenCode 1.x текст по-прежнему вставляется прямо в промпт.

---

## Требования

1. **OpenCode 1.x или 2.x** (проверено на 2.1.4).
2. **ffmpeg** в `PATH` либо путь в `audio.ffmpegPath`.
   - Windows: `winget install Gyan.FFmpeg` или распакуйте сборку и укажите полный путь к `ffmpeg.exe`.
   - macOS: `brew install ffmpeg`.
   - Linux: пакет `ffmpeg` из репозитория.
3. **Движок распознавания** — любой из:
   - **sherpa-onnx + GigaAM-v3** (рекомендуется для русского, офлайн, быстро);
   - **whisper.cpp** (офлайн, много языков);
   - **OpenAI-совместимый HTTP** (OpenAI, LocalAI, faster-whisper-server, LM Studio и т. п.);
   - **SaluteSpeech** (облако Сбера);
   - **своя команда** (любой CLI, читающий WAV).

Никакого WSL, Docker и Python не требуется.

---

## Установка

### 1. Положите плагин в любое место

Например: `C:\shared-data\reps\opencode-voice` (этот репозиторий).

### 2. Зарегистрируйте плагин в `opencode.json`

Глобальный файл: `~/.config/opencode/opencode.json` (Windows: `C:\Users\<вы>\.config\opencode\opencode.json`).

```json
{
  "plugins": [
    "file:///C:/shared-data/reps/opencode-voice"
  ]
}
```

Путь можно задавать и относительно проекта, но `file:///` надёжнее. Если в списке уже есть другие плагины — просто добавьте строку.

После изменения перезапустите OpenCode.

### 3. Создайте `voice.json`

Скопируйте `voice.example.json` в `~/.config/opencode/voice.json` и настройте под себя. Минимальный вариант для GigaAM:

```json
{
  "provider": "local-onnx",
  "language": "ru",
  "onnx": {
    "modelPath": "C:/shared-data/reps/vscode-russion-dictate/.models/gigaam-v3",
    "executablePath": "C:/shared-data/reps/vscode-russion-dictate/.models/sherpa/bin/sherpa-onnx-offline.exe",
    "mode": "server",
    "threads": 2
  },
  "audio": {
    "ffmpegPath": "ffmpeg"
  }
}
```

`provider: "auto"` сам выберет `local-onnx`, если путь к модели существует, затем `local-whisper`, затем OpenAI-совместимый endpoint.

Файлы конфигурации читаются в таком порядке (поздние перекрывают ранние):

1. `~/.config/opencode/voice.json` (или `.jsonc`);
2. `<проект>/.opencode/voice.json` (или `.jsonc`);
3. путь из `OPENCODE_VOICE_CONFIG`.

JSONC поддерживается: комментарии `//`, `/* */` и висячие запятые разрешены.

### 4. Проверьте

В OpenCode выполните `/voice-doctor`. Команда покажет найденный ffmpeg, микрофоны, модель, sherpa-бинарник, адрес HTTP-сервера и последние ошибки.

Если всё хорошо — нажмите `<leader>v` (по умолчанию `<leader>` — пробел, то есть `Space`, затем `v`), произнесите фразу и сделайте паузу.

---

## Горячие клавиши и команды

| Действие | По умолчанию |
|---|---|
| Начать/остановить запись | `<leader>v` (`hotkey` в конфиге) |
| Записать и скопировать текст (desktop/web) | `/voice` |
| Записать и сразу отправить | `/voice-submit` или `/voice-send` |
| Отменить запись без распознавания | `/voice-stop` |
| Настройки (провайдер, язык, микрофон, клавиша) | `/voice-settings` |
| Диагностика | `/voice-doctor` |
| Перечитать `voice.json` | `/voice-reload` |
| Прогреть движок вручную | `/voice-warmup` |
| Записать и отправить (клиенты без TUI) | `/voice-send` |

Запись останавливается сама после `audio.oneShotSilenceMs` тишины (по умолчанию 1400 мс), но только если речь уже была. Страховочный таймаут — `audio.autoStopSilenceMs` (60 с).

**Desktop-приложение и веб-интерфейс** не загружают TUI-плагин, поэтому для них команды регистрирует серверная часть (`index.js`): `/voice` записывает и копирует текст в буфер обмена, `/voice-submit` и `/voice-send` отправляют его в текущую сессию, `/voice-settings` и `/voice-doctor` показывают настройки и диагностику сообщением в сессии.

---

## Конфигурация

Все поля необязательны: значения по умолчанию перечислены в `lib/config.js`.

### Корень

| Ключ | По умолчанию | Описание |
|---|---|---|
| `provider` | `auto` | `auto`, `local-onnx`, `local-whisper`, `openai-compatible`, `salute`, `command` |
| `language` | `auto` | Код языка (`ru`, `en`, …) или `auto` |
| `hotkey` | `<leader>v` | Клавиша записи в TUI |
| `insert.autoSubmit` | `false` | Отправлять текст сразу после распознавания |
| `insert.trailingSpace` | `true` | Добавлять пробел в конце |

### `audio`

| Ключ | По умолчанию | Описание |
|---|---|---|
| `ffmpegPath` | `ffmpeg` | Имя в `PATH` или абсолютный путь |
| `inputFormat` | `auto` | `auto`, `dshow` (Windows), `avfoundation` (macOS), `pulse`, `alsa` |
| `device` | `""` | Имя, индекс, `@device_...` или пусто = первый вход |
| `cues.start` / `cues.end` | `true` | Звуковые сигналы начала/конца |
| `cues.volume` | `15` | Громкость сигналов, 0–100 |
| `silenceMs` | `600` | Пауза, закрывающая фразу |
| `minSegmentMs` | `400` | Всё короче считается шумом |
| `maxSegmentMs` | `15000` | Принудительная нарезка длинной речи |
| `noiseThreshold` | `0` | `0` = адаптивный порог; `0.01` ≈ −40 dBFS |
| `autoStopSilenceMs` | `60000` | Страховочная остановка, `0` отключает |
| `oneShotSilenceMs` | `1400` | Автостоп после речи в режиме одной фразы |

Узнать имена микрофонов:

```powershell
ffmpeg -hide_banner -list_devices true -f dshow -i dummy
```

На Windows лучше указывать `Alternative name` (`@device_cm_...`): локализованные имена могут биться в кодировке. Плагин делает это автоматически при выборе микрофона через `/voice-settings`.

### `onnx` — sherpa-onnx / GigaAM

| Ключ | По умолчанию | Описание |
|---|---|---|
| `modelPath` | `""` | Папка с `*.onnx` + `tokens.txt` или путь к `.onnx` |
| `executablePath` | `""` | `sherpa-onnx-offline.exe`; пусто = поиск рядом с моделью и в `PATH` |
| `precision` | `auto` | `auto`, `int8`, `fp32` |
| `mode` | `auto` | `server` — тёплый websocket-сервер; `cli` — запуск на каждую фразу; `auto` = server при наличии бинарника |
| `threads` | `2` | Потоки CPU для тёплого сервера |
| `extraArgs` | `""` | Дополнительные аргументы sherpa |

Тёплый сервер поднимается лениво при первом распознавании и переиспользуется. Перезапуск — `/voice-reload` или `POST /heal`.

### `local` — whisper.cpp

| Ключ | По умолчанию | Описание |
|---|---|---|
| `modelPath` | `""` | `.bin`-модель или папка с моделями |
| `executablePath` | `""` | `whisper-cli`; пусто = автопоиск |
| `extraArgs` | `""` | Например, `--beam-size 3` |

### `openai` — OpenAI-совместимый API

| Ключ | По умолчанию | Описание |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8000/v1` | База; `/audio/transcriptions` добавляется автоматически |
| `model` | `whisper-1` | Имя модели |
| `apiKey` | `""` | Токен (можно задать через `OPENAI_API_KEY`) |
| `prompt` | `""` | Подсказка-контекст для модели |
| `sendContextPrompt` | `true` | Подмешивать контекст из предыдущего текста |
| `requestTimeoutMs` | `60000` | Таймаут запроса |

### `salute` — SaluteSpeech

`clientId`, `clientSecret` или `authorizationKey`, плюс `tokenUrl`, `recognizeUrl`, `scope`, `insecureTLS`.

### `command` — своя команда

| Ключ | Описание |
|---|---|
| `capture` | Команда записи; должна писать raw `s16le`, 16 кГц, моно в stdout |
| `transcribe` | Команда распознавания; `${file}` — WAV, `${out}` — необязательный текстовый файл |

Пример:

```json
{
  "provider": "command",
  "command": {
    "capture": "arecord -q -f S16_LE -r 16000 -c 1 -t raw",
    "transcribe": "my-stt --input ${file} --output ${out}"
  }
}
```

### `server` — HTTP-сервер для веб-интерфейса

| Ключ | По умолчанию | Описание |
|---|---|---|
| `enabled` | `true` | Запускать сервер вместе с OpenCode |
| `host` | `127.0.0.1` | Слушать только локально; `0.0.0.0` — на свой риск |
| `port` | `8765` | Если занят, берётся следующий свободный |
| `token` | `""` | Если задан, все маршруты кроме `/health` требуют `X-Voice-Token` |
| `maxUploadMb` | `25` | Лимит загрузки |
| `maxAudioSeconds` | `300` | Лимит длительности |
| `concurrency` | `1` | Одновременных распознаваний, 1–8 |
| `allowedOrigins` | `[]` | Дополнительные Origin; localhost и `chrome-extension://` разрешены всегда |
| `warmup` | `true` | Греть движок после старта |

### `ui`

`language`: `auto`, `ru` или `en` — язык подсказок TUI.

### Переменные окружения

Перекрывают файл:

`OPENCODE_VOICE_PROVIDER`, `OPENCODE_VOICE_LANGUAGE`, `OPENCODE_VOICE_HOTKEY`, `OPENCODE_VOICE_CONFIG`, `OPENCODE_VOICE_LOG`,
`OPENCODE_VOICE_FFMPEG`, `OPENCODE_VOICE_INPUT_FORMAT`, `OPENCODE_VOICE_DEVICE`, `OPENCODE_VOICE_SILENCE_MS`,
`OPENCODE_VOICE_ONE_SHOT_SILENCE_MS`, `OPENCODE_VOICE_AUTO_STOP_SILENCE_MS`,
`OPENCODE_VOICE_ONNX_MODEL`, `OPENCODE_VOICE_ONNX_EXE`, `OPENCODE_VOICE_ONNX_MODE`, `OPENCODE_VOICE_ONNX_PRECISION`, `OPENCODE_VOICE_ONNX_EXTRA_ARGS`,
`OPENCODE_VOICE_WHISPER_MODEL`, `OPENCODE_VOICE_WHISPER_EXE`, `OPENCODE_VOICE_WHISPER_ARGS`,
`OPENCODE_VOICE_OPENAI_BASE_URL`, `OPENCODE_VOICE_OPENAI_MODEL`, `OPENAI_API_KEY`, `OPENCODE_VOICE_OPENAI_PROMPT`,
`OPENCODE_VOICE_COMMAND_CAPTURE`, `OPENCODE_VOICE_COMMAND_TRANSCRIBE`,
`OPENCODE_VOICE_SERVER`, `OPENCODE_VOICE_HOST`, `OPENCODE_VOICE_PORT`, `OPENCODE_VOICE_TOKEN`, `OPENCODE_VOICE_MAX_UPLOAD_MB`, `OPENCODE_VOICE_ALLOWED_ORIGINS`,
`OPENCODE_VOICE_UI_LANG`.

---

## HTTP API

Сервер поднимается вместе с плагином. Базовый адрес по умолчанию — `http://127.0.0.1:8765`.

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | Статус, провайдер, устройство, лимиты. Доступен без токена |
| `POST` | `/transcribe` | Multipart (`audio`) или сырое тело; возвращает `{ ok, text, duration_ms }` |
| `POST` | `/record/start` | Начать запись с микрофона машины (`?oneShot=1`) |
| `POST` | `/record/stop` | Остановить и распознать |
| `GET` | `/record/status` | Идёт ли запись |
| `POST` | `/record/cancel` | Отменить |
| `GET` | `/beep?freq=880` | Короткий сигнал |
| `GET` | `/config` | Безопасный срез конфигурации (без секретов) |
| `GET` | `/doctor` | Текстовый отчёт диагностики |
| `POST` | `/warmup` | Прогреть движок |
| `POST` | `/reload` | Перечитать `voice.json` |
| `POST` | `/heal` | Отменить запись, перечитать конфиг, перезапустить движок |

Пример:

```powershell
curl.exe -s http://127.0.0.1:8765/health
curl.exe -s -F "audio=@sample.wav" http://127.0.0.1:8765/transcribe
```

Если задан `server.token`, добавьте заголовок `X-Voice-Token: <token>`.

CORS: разрешены `localhost`, `127.0.0.1`, `[::1]`, `chrome-extension://*` и всё из `server.allowedOrigins`.

---

## Расширение для Chrome

Папка `extension/` — MV3-расширение без сборки.

1. Откройте `chrome://extensions`.
2. Включите «Режим разработчика».
3. «Загрузить распакованное расширение» → выберите `C:\shared-data\reps\opencode-voice\extension`.
4. Откройте веб-интерфейс OpenCode (обычно `http://localhost:28894`).
5. В попапе расширения нажмите «Проверить» — он найдёт порт сервера (8765, 8766, …).

Что делает расширение:

- добавляет кнопку 🎤 рядом с полем ввода;
- `Alt+Z` — push-to-talk, `Alt+X` — записать и сразу отправить;
- звуковые сигналы, настройки порта/токена/языка, кнопка «Перезапустить движок» (`POST /heal`);
- если браузер не даёт доступ к микрофону, запись идёт через ffmpeg на машине (`/record/start` + `/record/stop`).

Расширение работает только на локальных страницах (`localhost`, `127.0.0.1`, `[::1]`) и не запрашивает доступ ко всем сайтам.

---

## Безопасность

- Сервер по умолчанию слушает `127.0.0.1` — снаружи недоступен.
- Токен `server.token` защищает все маршруты, кроме `/health`. Задавайте его, если меняете `host` на `0.0.0.0` или используете расширение на другой машине.
- Загрузки ограничены `maxUploadMb`, длительность — `maxAudioSeconds`, одновременность — `concurrency`.
- Секреты (`apiKey`, `token`, `clientSecret`) никогда не возвращаются через `/config` и `/health`.
- Записи и временные WAV лежат в `~/.local/share/opencode/voice` (на Windows — `C:\Users\<вы>\.local\share\opencode\voice`) и удаляются после распознавания. Лог — `voice.log` там же (переопределяется `OPENCODE_VOICE_LOG`).

---

## Диагностика

**`/voice-doctor` показывает:**

- найден ли ffmpeg и его версию;
- формат захвата и список микрофонов;
- модель, `tokens.txt`, sherpa-бинарник и запущенные тёплые серверы;
- endpoint и доступность OpenAI-совместимого API;
- адрес HTTP-сервера и лимиты.

**Типичные проблемы**

| Симптом | Что делать |
|---|---|
| «ffmpeg not found» | Установите ffmpeg или укажите `audio.ffmpegPath` полностью |
| Запись идёт, текст пустой | Проверьте микрофон в `audio.device`, уровень в системе, `noiseThreshold` |
| Модель не найдена | Убедитесь, что в папке есть `*.onnx` и `tokens.txt`; для GigaAM — `gigaam_v3_e2e_ctc_int8.onnx` |
| sherpa падает при старте | Проверьте, что `sherpa-onnx-offline-websocket-server.exe` лежит рядом с `sherpa-onnx-offline.exe`; уменьшите `threads` |
| Порт 8765 занят | Плагин возьмёт следующий; в попапе расширения нажмите «Проверить» |
| 401 от сервера | Задайте тот же `server.token` в попапе расширения |
| В TUI текст не вставился | В OpenCode 2 текст копируется в буфер — нажмите Ctrl+V; либо используйте `/voice-submit` |
| Горячая клавиша не срабатывает | Смените `hotkey` в `/voice-settings`; проверьте конфликт с другими плагинами |

Лог: `~/.local/share/opencode/voice/voice.log` (на Windows — `C:\Users\<вы>\.local\share\opencode\voice\voice.log`).

---

## Тесты

```powershell
# Юнит- и интеграционные тесты без модели
node --test "test/*.test.js"

# Реальная проверка GigaAM (нужны модель, sherpa и WAV)
$env:OPENCODE_VOICE_TEST_SHERPA = "1"
$env:OPENCODE_VOICE_TEST_ONNX_MODEL = "C:/path/to/gigaam-v3"
$env:OPENCODE_VOICE_TEST_ONNX_EXE = "C:/path/to/sherpa-onnx-offline.exe"
$env:OPENCODE_VOICE_TEST_AUDIO = "C:/path/to/russian.wav"
node --test test/sherpa.integration.test.js
```

Если Node.js не установлен, тот же код запускается встроенным рантаймом OpenCode:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:LOCALAPPDATA\Programs\@opencodedesktop\OpenCode.exe" --test test\config.test.js
```

`test/smoke.mjs` распознаёт файл целиком, `test/mic-smoke.mjs` проверяет реальный захват с микрофона.

---

## Структура

```
index.js                 серверный плагин: HTTP-сервер + команда /voice-send
tui.js                   TUI-плагин: OpenCode 1.x (tui) и 2.x (setup)
lib/tui-v2.js            реализация TUI для OpenCode 2.x
lib/runtime.js           общий рантайм: запись, распознавание, диагностика
lib/config.js            конфигурация, значения по умолчанию, env
lib/paths.js             кроссплатформенные пути (без WSL)
lib/clipboard.js         буфер обмена: PowerShell / pbcopy / wl-copy / xclip
lib/audio/               ffmpeg-захват, устройства, WAV, VAD, сигналы
lib/pipeline/            нарезка на фразы, сессия записи
lib/stt/                 sherpa-onnx, whisper.cpp, OpenAI API, Salute, команды
lib/server/http.js       HTTP API и CORS
extension/               Chrome MV3: кнопка 🎤, push-to-talk, попап
voice.example.json       пример конфигурации
test/                    unit + интеграционные тесты
sources/                 исходные проекты (в git не входят)
```

---

## Лицензия

MIT.
