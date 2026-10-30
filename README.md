<div align="center">

<img src="assets/banner.png" alt="Runa Messenger" width="100%"/>

# 🚀 Runa Messenger

**Твой приватный чат, который ты контролируешь сам · Your private chat, fully under your control**

[![Node.js](https://img.shields.io/badge/Node.js-18+-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![WebSocket](https://img.shields.io/badge/WebSocket-real--time-9B4DCA?style=for-the-badge&logo=socket.io&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/License-Custom%20(see%20README)-F9A03C?style=for-the-badge)](#-лицензия--license)

**[🌐 Живой пример / Live demo](https://runachat.duckdns.org/)**

[🇷🇺 Русская версия](#-русская-версия) · [🇬🇧 English version](#-english-version)

</div>

---

## 🇷🇺 Русская версия

Runa — это минималистичный мессенджер с открытым исходным кодом, построенный на стеке Node.js + WebSocket. Проект создан для тех, кто хочет иметь свой собственный чат без зависимости от сторонних серверов и лишних настроек.

### ✨ Возможности

- 🔒 **Полная приватность данных** — все сообщения хранятся только в твоей локальной базе данных (SQLite). Ты полностью контролируешь, где и как хранятся данные.
- ⚡ **Мгновенные сообщения** — чат работает в реальном времени благодаря WebSocket-соединению.
- 🪶 **Минималистичность** — лёгкий код без лишних зависимостей. Идеально для изучения архитектуры чатов.
- ✨ **NFT-фразы** — создавайте коллекционные фразы за общение и продавайте их на маркете за рубины.
- ⏱️ **Быстрый старт** — запуск занимает меньше минуты после установки зависимостей.

### ✨ NFT-фразы

- Общайтесь в личных чатах, группах и каналах, где есть хотя бы ещё один участник. После трёх непустых текстовых сообщений за 10 минут каждое следующее подходящее сообщение (включая третье) даёт **1% шанс** получить предложение. Для защиты от спама учитываются сообщения с интервалом не менее 5 секунд и без одинакового текста подряд. «Избранное», сообщения самому себе, стикеры и вложения без текста не учитываются.
- Предложение действует 24 часа и сохраняется при переподключении. Введите фразу длиной до 120 символов и запустите прокрутку: «Да» и «Нет» выпадают с равной вероятностью. При «Да» фраза попадает в профиль, при «Нет» введённый текст сбрасывается. Пропущенный шанс также исчезает. Количество фраз не ограничено.
- Во вкладке «Фразы» профиля можно выставить предмет на маркет или снять с продажи. Покупка переводит фразу новому владельцу, рубины — продавцу, а операции сохраняются в истории кошелька. Автор фразы остаётся указан после продажи.
- Название NFT используется в интерфейсе Runa: это **внутренние коллекционные объекты в SQLite, не токены блокчейна**. Шанс, результат и передача собственности проверяются сервером.

### 🚀 Быстрый старт

1. **Клонируй репозиторий:**
   ```bash
   git clone https://github.com/veter6298/Runa.git
   cd Runa
   ```
2. **Установи зависимости:**
   ```bash
   npm install
   ```
3. **Запусти сервер:**
   ```bash
   npm start
   ```
4. **Открой в браузере:** перейди по адресу `http://localhost:3001` (или порту из переменной `PORT`).

> ⚠️ **Важно про базу данных:** файл базы данных не хранится в репозитории из соображений безопасности и чистоты кода. При первом запуске сервер автоматически создаст пустую базу и необходимые таблицы. Путь к ней можно задать через `DATABASE_PATH`; по умолчанию используется `database.sqlite` в корне проекта.

Для запуска автоматических тестов: `npm test`.

### 🛠️ Стек технологий

| Технология | Роль |
| :--- | :--- |
| **Node.js** | Основная среда выполнения |
| **Express** | Веб-фреймворк для обработки HTTP-запросов |
| **WebSocket** | Протокол для чата в реальном времени |
| **SQLite** | Лёгкая встраиваемая СУБД для истории и пользователей |
| **HTML / CSS / JS** | Клиентская часть |

### 📁 Структура проекта

```text
Runa/
├── public/          # Статические файлы (HTML, CSS, JS клиента)
├── server.js        # Точка входа сервера и логика WebSocket
├── qa_user.js       # Логика авторизации и работы с пользователями
├── .gitignore       # Правила игнорирования файлов для Git
├── package.json     # Зависимости проекта
└── README.md        # Этот файл
```

### 📄 Лицензия и авторские права

Проект **Runa Messenger** является интеллектуальной собственностью автора (@XiroPlush).

1. ✅ **Создание копий разрешено** — ты можешь свободно копировать, форкать и разворачивать этот код на своих серверах для личного использования или обучения.
2. ✅ **Модификация разрешена** — можешь изменять код под свои нужды.
3. ⚠️ **Коммерческое использование** — если планируешь использовать этот код как основу для коммерческого продукта, обязательно укажи авторство и дай ссылку на оригинальный репозиторий.
4. ⚠️ **Распространение** — при публикации модифицированной версии обязан сохранить ссылку на этот репозиторий и указать автора.

> 💡 **Дисклеймер:** проект находится в стадии разработки (Beta). Не предназначен для хранения критически важных данных в продакшене без дополнительной настройки безопасности.

### 🤝 Как внести вклад

1. Сделай **Fork** этого репозитория.
2. Создай ветку для своей фичи: `git checkout -b feature/my-awesome-feature`
3. Сделай коммит: `git commit -m "Добавляет крутую фичу"`
4. Отправь изменения: `git push origin feature/my-awesome-feature`
5. Открой **Pull Request**.

### 💬 Связь с автором

- Telegram: **[@XiroPlush](https://t.me/XiroPlush)**
- Живой пример: **[runachat.duckdns.org](https://runachat.duckdns.org/)**
- Или оставь Issue в этом репозитории.

---

## 🇬🇧 English version

Runa is a minimalist open-source messenger built on the Node.js + WebSocket stack. It is made for those who want their own chat without depending on third-party servers or complicated setup.

### ✨ Features

- 🔒 **Full data privacy** — all messages are stored only in your local SQLite database. You fully control where and how your data lives.
- ⚡ **Real-time messaging** — instant chat powered by WebSockets.
- 🪶 **Minimalist** — lightweight code with no bloated dependencies. Great for learning chat architecture.
- ✨ **NFT phrases** — create collectible phrases by chatting and sell them for rubies on the market.
- ⏱️ **Quick start** — up and running in under a minute after installing dependencies.

### ✨ NFT phrases

Chat in a direct conversation, group, or channel with at least one other member. After three qualifying text messages in ten minutes, each qualifying message (including the third) has a 1% chance of granting an offer. Messages must be at least five seconds apart and not repeat the preceding text; saved messages and media without text do not count. The offer lasts 24 hours and survives reconnection. Enter a phrase of up to 120 characters and spin: “Yes” and “No” are equally likely. A win adds the phrase to your profile; a loss or a skipped offer resets the chance. There is no collection limit.

Owners can list or unlist phrases on the market for rubies. Purchases transfer ownership and funds atomically, retain the creator attribution, and appear in wallet history. These are **in-app SQLite collectibles, not blockchain tokens**; the server controls the offers and outcomes.

### 🚀 Getting started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/veter6298/Runa.git
   cd Runa
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Start the server:**
   ```bash
   npm start
   ```
4. **Open in your browser:** go to `http://localhost:3001` (or the port set in `PORT`).

> ⚠️ **Note about the database:** the database file is not stored in this repository for security and code cleanliness reasons. On first launch, the server automatically creates an empty database with the required tables. Set `DATABASE_PATH` to override the default `database.sqlite` path.

Run the automated tests with `npm test`.

### 🛠️ Tech stack

| Technology | Role |
| :--- | :--- |
| **Node.js** | Runtime |
| **Express** | Web framework for HTTP requests |
| **WebSocket** | Real-time communication protocol |
| **SQLite** | Lightweight embedded database for history and users |
| **HTML / CSS / JS** | Client side |

### 📁 Project structure

```text
Runa/
├── public/          # Static files (client HTML, CSS, JS)
├── server.js        # Server entry point and WebSocket logic
├── qa_user.js       # Authentication and user management logic
├── .gitignore       # Git ignore rules
├── package.json     # Project dependencies
└── README.md        # This file
```

### 📄 License & copyright

The **Runa Messenger** project is the intellectual property of its author (@XiroPlush).

1. ✅ **Copying is allowed** — you are free to copy, fork, and deploy this code on your own servers for personal use or learning.
2. ✅ **Modification is allowed** — feel free to adapt the code to your needs.
3. ⚠️ **Commercial use** — if you plan to use this code as a basis for a commercial product, you must credit the author and link to the original repository.
4. ⚠️ **Redistribution** — when publishing a modified version, you must keep the link to this repository and credit the author.

> 💡 **Disclaimer:** the project is in development (Beta). It is not intended for storing mission-critical data in production without additional security hardening.

### 🤝 Contributing

1. **Fork** this repository.
2. Create a feature branch: `git checkout -b feature/my-awesome-feature`
3. Commit your changes: `git commit -m "Add awesome feature"`
4. Push your branch: `git push origin feature/my-awesome-feature`
5. Open a **Pull Request**.

### 💬 Contact

- Telegram: **[@XiroPlush](https://t.me/XiroPlush)**
- Live demo: **[runachat.duckdns.org](https://runachat.duckdns.org/)**
- Or open an issue in this repository.

---

<div align="center">

**Runa Messenger** · © 2026 @XiroPlush · Made with 💙 and Node.js

</div>
