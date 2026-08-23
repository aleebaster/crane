# Crane — Signet Faucet Bot

Автоматизований бот для отримання тестового Bitcoin (Signet BTC) з faucet-сайту [Alt Signet Faucet](https://signet257.bublina.eu.org/).

## Що це робить

Бот послідовно обробляє до 10 Bitcoin Signet-адрес, відправляючи кожну у faucet і чекаючи фінального результату (успіх або помилку) перед переходом до наступної.

## Вимоги

- [Node.js](https://nodejs.org/) v20 або новіший
- Google Chrome (системний)
- Chrome Profile 2 з налаштованим Cloudflare

## Встановлення

```bash
# Клонувати репозиторій
git clone https://github.com/aleebaster/crane.git
cd crane

# Встановити залежності
npm install
```

## Налаштування

### 1. Створити конфігурацію

Скопіюйте приклад конфігурації:

```bash
cp config/wallets.example.json config/config.json
```

Відредагуйте `config/config.json`:

```json
{
  "wallets": [
    "tb1pYOUR_SIGNET_ADDRESS_1",
    "tb1pYOUR_SIGNET_ADDRESS_2",
    "tb1pYOUR_SIGNET_ADDRESS_3"
  ],
  "browser": {
    "userDataDir": "C:\\Users\\andre\\AppData\\Local\\Google\\Chrome\\User Data",
    "profileDirectory": "Profile 2",
    "headless": false
  },
  "faucet": {
    "url": "https://signet257.bublina.eu.org/",
    "walletTimeoutMs": 300000
  }
}
```

### 2. Налаштування Chrome Profile 2

Бот використовує ваш реальний профіль Chrome (`Profile 2`), щоб:
- Зберігати стан Cloudflare між запусками
- Не потребувати повторного проходження CAPTCHA

Важливо: перед запуском бота переконайтеся, що ви вже проходили Cloudflare у цьому профілі вручну.

### 3. (Опціонально) .env файл

```bash
cp .env.example .env
```

Налаштування:

| Змінна | Опис | За замовчуванням |
|--------|------|------------------|
| `CHROME_PATH` | Шлях до Chrome executable | Автовизначення |
| `WALLET_TIMEOUT_MS` | Timeout на один wallet (мс) | 300000 (5 хв) |

## Запуск

```bash
# Розробка (зtsx для hot-reload)
npm run dev

# Запуск зі збіркою
npm run start
```

Бот відкриє Chrome з вашим профілем і розпочне обробку адрес.

## Cloudflare

Якщо Cloudflare вимагає перевірку:

1. Бот відкриває сторінку faucet
2. Бачите повідомлення Cloudflare
3. **Вручну** проходите перевірку в браузері
4. Після успішного проходження бот продовжує роботу автоматично

Бот НЕ обходить Cloudflare автоматично. Не використовуйте CAPTCHA-solving сервіси або stealth-хаки.

## Стани wallet

Кожен wallet проходить через такі стани:

| Стан | Опис |
|------|------|
| `PENDING` | Адреса в черзі, ще не обробляється |
| `PROCESSING` | Адреса відправлена, чекаємо відповіді |
| `COMPLETED` | Faucet успішно надіслав кошти |
| `ERROR` | Faucet повернув помилку (повільне надсилання, невалідна адреса тощо) |
| `TIMEOUT` | Не вдалося отримати відповідь протягом `walletTimeoutMs` |

## Логи

Приклад виводу в консоль:

```
[20:40:12] Crane started
[20:40:15] Chrome Profile 2 connected
[20:40:21] Cloudflare check passed
[20:40:22] Wallet 1/3: submitting (tb1pexam...pleaddr)
[20:40:25] Wallet 1/3: processing
[20:41:08] Wallet 1/3: ERROR - Error: Please slow down
[20:41:10] Wallet 2/3: submitting (tb1pexam...pleaddr)
```

## Результати

Після завершення роботи:

1. У консолі виводиться `SUMMARY` зі статистикою
2. Результати зберігаються у `data/results.json`

Приклад `results.json`:

```json
[
  {
    "address": "tb1p...",
    "state": "COMPLETED",
    "message": "Sent 10000 sats",
    "startedAt": "2026-08-23T18:40:22.000Z",
    "completedAt": "2026-08-23T18:41:08.000Z",
    "durationMs": 46000
  }
]
```

## Тести

```bash
# Запуск тестів
npm test

# Watch mode
npm run test:watch
```

## Структура проєкту

```
crane/
├─ src/
│  ├─ browser.ts           # Запуск Chrome з профілем
│  ├─ faucet.js            # Взаємодія з faucet
│  ├─ wallet-manager.ts    # Послідовна обробка адрес
│  ├─ state-detector.ts    # Визначення стану сторінки
│  ├─ logger.ts            # Логування
│  └─ index.ts             # Точка входу
├─ config/
│  ├─ wallets.example.json # Приклад конфігурації
│  └─ config.json          # Ваша конфігурація
├─ tests/
│  └─ state-detector.test.ts
├─ data/
│  └─ results.json         # Результати (git ignored)
├─ .env.example
├─ .gitignore
├─ package.json
├─ tsconfig.json
└─ README.md
```

## Архітектура

Бот працює через реальний DOM сторінки за допомогою Playwright:

1. **Валідація адрес** — regex-перевірка Signet-адрес перед стартом
2. **Запуск Chrome** — `launchPersistentContext` з вашим профілем
3. **Cloudflare** — очікування ручного проходження
4. **Послідовна обробка** — почергово для кожної адреси
5. **DOM state detection** — `waitForFunction` для відстеження змін
6. **Timeout захист** — кожна адреса має обмеження за часом
7. **Baseline reset** — між адресами скидається стан сторінки

## Ліцензія

ISC
