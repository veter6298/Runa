'use strict';

/* ================================================================== */
/*  СОСТОЯНИЕ                                                         */
/* ================================================================== */
const TOKEN_KEY = 'cc_token';
const LAST_CHAT_KEY = 'cc_last_chat';

let token = localStorage.getItem(TOKEN_KEY);
let currentUser = null;
let currentChat = null;
let chats = [];
let socket = null;
let isRegisterMode = false;
let typingTimeout = null;
let typingClearTimer = null;
let searchQuery = '';
let chatFilter = 'all';
let renderedIds = new Set();
let messageCache = new Map();
let lastTypingSent = 0;
let chatSearchTimer = null;
let currentMessages = [];
let hasMoreHistory = false;
let loadingOlder = false;
const HISTORY_PAGE = 80;
let onlineMap = new Map();
let deferredPrompt = null;
let swRegistration = null;
let swReloading = false;
let lastSwCheck = 0;
let pwaInstalledThisSession = false;
let restoringChat = false;
let replyTarget = null;
let reactionTarget = null;
let chatSettings = null;
let stickerPacks = null;
let stickerActivePack = 0;
let stickerPanelOpen = false;
let chatListSignature = '';
let chatDismissed = false;
let chatViewCloseToken = 0;

const STICKER_FALLBACK_PACK = {
  id: 'tiktok',
  title: 'TikTok You',
  cover: '/stickers/tiktok/001.webp',
  stickers: Array.from({ length: 29 }, (_, i) => `/stickers/tiktok/${String(i + 1).padStart(3, '0')}.webp`)
};

const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* Плавное закрытие окон: сначала анимация, потом display:none */
function closeAnimated(el, ms = 180) {
  if (!el || el.style.display === 'none' || el.classList.contains('is-closing')) return;
  el.classList.add('is-closing');
  const token = `${Date.now()}-${Math.random()}`;
  el.dataset.closeToken = token;
  setTimeout(() => {
    if (el.dataset.closeToken !== token) return;
    el.classList.remove('is-closing');
    el.style.display = 'none';
    delete el.dataset.closeToken;
  }, ms);
}

function openAnimated(el, display = 'flex') {
  if (!el) return;
  delete el.dataset.closeToken;
  el.classList.remove('is-closing');
  el.style.display = display;
}

/* ================================================================== */
/*  УТИЛИТЫ                                                           */
/* ================================================================== */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(value) { return escapeHtml(value); }

/* ---------- коллекционные юзернеймы и анонимные номера ---------- */
function nftChipHtml(n, extraClass = '') {
  const handle = typeof n === 'string' ? n : (n && n.username) || '';
  if (!handle) return '';
  const forSale = !!(n && n.forSale);
  const price = Number((n && n.price) || 0);
  return `<button type="button" class="identity-chip nft ${extraClass}" data-identity-kind="nft"
      data-identity-username="${escapeAttr(handle)}"
      data-identity-sale="${forSale ? '1' : '0'}" data-identity-price="${price}"
      title="Коллекционный юзернейм @${escapeAttr(handle)}">
      <span class="identity-star">✦</span><span class="identity-handle">@${escapeHtml(handle)}</span>
      ${forSale ? '<span class="identity-sale">на продаже</span>' : ''}
    </button>`;
}

function anonChipHtml(number) {
  if (!number) return '';
  return `<button type="button" class="identity-chip anon" data-identity-kind="anon"
      data-identity-number="${escapeAttr(number)}" title="Анонимный номер">
      <span class="identity-anon-icon">#</span><span class="identity-handle">${escapeHtml(number)}</span>
    </button>`;
}

function linkify(text) {
  return escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function parseDate(value) {
  if (!value) return new Date();
  if (value instanceof Date) return value;
  const s = String(value);
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
}
function fmtMops(value) {
  return Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTime(value) {
  const d = parseDate(value);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(value) {
  const d = parseDate(value);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Сегодня';
  if (same(d, yest)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
function dayKey(value) { return parseDate(value).toDateString(); }
function compareMessages(a, b) {
  const at = String(a && a.created_at || '');
  const bt = String(b && b.created_at || '');
  if (at !== bt) return at < bt ? -1 : 1;
  const as = Number(a && a.seq) || 0;
  const bs = Number(b && b.seq) || 0;
  if (as !== bs) return as - bs;
  const aid = String(a && a.id || '');
  const bid = String(b && b.id || '');
  return aid < bid ? -1 : aid > bid ? 1 : 0;
}
function fmtChatTime(value) {
  if (!value) return '';
  const d = parseDate(value);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return fmtTime(value);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}
function fmtLastSeen(value) {
  if (!value) return 'не в сети';
  const d = parseDate(value);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return 'был(а) только что';
  if (diff < 3600000) return `был(а) ${Math.floor(diff / 60000)} мин назад`;
  if (d.toDateString() === new Date().toDateString()) return `был(а) в ${fmtTime(value)}`;
  return `был(а) ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`;
}
function gradientFor(name) {
  const palettes = [
    'linear-gradient(135deg,#7b61ff,#5038ee)',
    'linear-gradient(135deg,#0A84FF,#0051d5)',
    'linear-gradient(135deg,#30D158,#0b8f3a)',
    'linear-gradient(135deg,#FF9F0A,#d97706)',
    'linear-gradient(135deg,#FF375F,#c81e45)',
    'linear-gradient(135deg,#BF5AF2,#7c3aed)',
    'linear-gradient(135deg,#64D2FF,#0891b2)'
  ];
  let sum = 0;
  for (const ch of String(name || '?')) sum += ch.charCodeAt(0);
  return palettes[sum % palettes.length];
}
function paintAvatar(el, avatar, name) {
  if (!el) return;
  if (avatar) {
    el.classList.add('has-img');
    el.innerHTML = `<img src="${escapeAttr(avatar)}" alt="">`;
  } else {
    el.classList.remove('has-img');
    el.textContent = String(name || '?').trim().charAt(0).toUpperCase() || '?';
    el.style.background = gradientFor(name);
  }
}
function paintAvatarEl(el, user) {
  if (!el) return;
  paintAvatar(el, user && user.avatar, user && (user.displayName || user.title || user.username));
}
function chatAvatarData(chat) {
  if (!chat) return { avatar: '', name: '?' };
  if (chat.type === 'dm' && chat.otherUser) {
    return { avatar: chat.otherUser.avatar, name: chat.otherUser.displayName };
  }
  return { avatar: chat.avatar, name: chat.title };
}
function chatName(chat) {
  if (!chat) return '';
  if (chat.type === 'dm' && chat.otherUser) return chat.otherUser.displayName;
  return chat.title || 'Без названия';
}

const CHAT_BADGE_META = {
  verified: { icon: 'badge-check', cls: 'chat-verified', title: 'Подтверждённый' },
  premium: { icon: 'star', cls: 'chat-premium', title: 'Premium' },
  crown: { icon: 'crown', cls: 'chat-crown', title: 'Корона' }
};

function chatBadgeHtml(chat) {
  if (!chat || chat.type === 'dm') return '';
  const meta = CHAT_BADGE_META[chat.badgeType || chat.badge_type || ''];
  if (!meta) return '';
  return `<i data-lucide="${meta.icon}" class="chat-badge-icon ${meta.cls}" title="${meta.title}"></i>`;
}

function setChatTitle(chat) {
  const el = $('opened-chat-title');
  if (!el) return;
  el.innerHTML = `${escapeHtml(chatName(chat))}${chatBadgeHtml(chat)}`;
  if (window.lucide) lucide.createIcons();
}
function badgeHtml(badge) {
  const icon = badge.icon && /^[a-z0-9-]+$/i.test(badge.icon)
    ? `<i data-lucide="${escapeAttr(badge.icon)}"></i>`
    : escapeHtml(badge.icon || '⭐');
  const bg = badge.color || '#24242c';
  return `<span class="apple-badge custom-badge badge-tip-target" style="background:${escapeAttr(bg)}" title="${escapeAttr(badge.title || '')}" data-badge-icon="${escapeAttr(badge.icon || '⭐')}" data-badge-title="${escapeAttr(badge.title || 'Значок Runa')}" data-badge-color="${escapeAttr(bg)}">${icon}</span>`;
}
function renderBadges(container, badges) {
  if (!container) return;
  if (!badges || !badges.length) {
    container.innerHTML = '<span class="muted-small">Пока нет значков</span>';
    return;
  }
  container.innerHTML = badges.map(badgeHtml).join('');
  if (window.lucide) lucide.createIcons();
}
function toast(message, type = 'info') {
  const box = $('toast-container');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.textContent = message;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 3200);
}
function beep() {
  if (!currentUser || !currentUser.sounds) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 820;
    gain.gain.value = 0.035;
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 110);
  } catch (e) { /* ignore */ }
}

/* ================================================================== */
/*  API                                                               */
/* ================================================================== */
async function api(path, options = {}) {
  const opts = { ...options };
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body = opts.body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { ...opts, headers, body });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401 && token && !path.startsWith('/api/auth/')) {
    clearSession();
    throw new Error('Сессия истекла');
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || `Ошибка ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LAST_CHAT_KEY);
  token = null;
}
function logoutLocal(reload = true) {
  clearSession();
  if (socket) { try { socket.disconnect(); } catch (e) { /* ignore */ } }
  if (reload) location.reload();
}

/* ================================================================== */
/*  СТАРТ                                                             */
/* ================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) lucide.createIcons();
  setupPwa();
  setupActivation();
  setupWorkspace();
  setupModalNavigation();
  setupNavigation();
  setupSettings();
  setupNewChat();
  setupLightbox();
  setupReactions();
  setupUserProfile();
  setupChatSettings();
  setupStickers();
  setupIdentitySheet();
  setupGifts();
  setupCreateChat();
  setupSwipeReply();
  setupCustomizationExtras();
  setupMessageLongPress();
  setupWalletCardUi();
  setupChatInfo();
  setupBadgeTooltips();

  if (token) {
    try {
      const me = await api('/api/auth/me');
      startMainApp(me);
    } catch (e) {
      clearSession();
      showActivation();
    }
  } else {
    showActivation();
  }
});

function showActivation() {
  document.body.classList.remove('app-ready');
  $('mac-activation-screen').style.display = 'flex';
  $('main-app').style.display = 'none';
}

function startMainApp(user) {
  currentUser = user;
  $('mac-activation-screen').style.display = 'none';
  $('main-app').style.display = 'block';
  document.body.classList.add('app-ready');
  updateUserUI();
  applyUserSettings();
  if (currentUser.isAdmin) {
    $('nav-admin').style.display = 'flex';
    const createChannel = $('btn-create-channel');
    if (createChannel) createChannel.style.display = 'flex';
  }
  connectSocket();
  api('/api/chats').then((list) => { chats = list; renderChats(); }).catch(() => {});
  maybeJoinFromUrl();
  handlePwaAction();
  if (window.onRunaMainReady) window.onRunaMainReady(user);
}

/* ================================================================== */
/*  PWA: установка, офлайн-режим, обновления                          */
/* ================================================================== */
function isStandalonePwa() {
  const mm = window.matchMedia ? window.matchMedia.bind(window) : null;
  return !!(
    (mm && (mm('(display-mode: standalone)').matches ||
      mm('(display-mode: fullscreen)').matches ||
      mm('(display-mode: minimal-ui)').matches)) ||
    window.navigator.standalone === true
  );
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroidDevice() {
  return /android/i.test(navigator.userAgent);
}

function syncInstallUi() {
  const standalone = isStandalonePwa() || pwaInstalledThisSession;
  document.body.classList.toggle('pwa-standalone', standalone);

  const navInstall = $('nav-install');
  if (navInstall) navInstall.style.display = standalone ? 'none' : 'flex';

  const downloadBtn = $('download-app-btn');
  if (downloadBtn) {
    downloadBtn.style.display = standalone ? 'none' : 'flex';
    const label = downloadBtn.querySelector('span');
    if (label) label.textContent = deferredPrompt ? 'Установить Runa' : 'Скачать приложение';
  }
}

function installHelpHtml() {
  const ios = isIosDevice();
  const android = isAndroidDevice();
  const steps = ios
    ? [
        ['<i data-lucide="share"></i>', 'Нажмите «Поделиться»', 'Кнопка в нижней панели Safari.'],
        ['<i data-lucide="plus-square"></i>', 'Выберите «На экран Домой»', 'Прокрутите меню немного вниз.'],
        ['<i data-lucide="check"></i>', 'Готово', 'Runa появится на экране как обычное приложение.']
      ]
    : android
      ? [
          ['<i data-lucide="more-vertical"></i>', 'Откройте меню браузера', 'Три точки в правом верхнем углу Chrome.'],
          ['<i data-lucide="download"></i>', 'Выберите «Установить приложение»', 'Или «Добавить на главный экран».'],
          ['<i data-lucide="check"></i>', 'Подтвердите установку', 'Runa откроется в отдельном окне.']
        ]
      : [
          ['<i data-lucide="monitor-down"></i>', 'Нажмите значок установки', 'Он находится справа в адресной строке Chrome или Edge.'],
          ['<i data-lucide="download"></i>', 'Выберите «Установить»', 'Можно также открыть меню браузера → «Установить Runa».'],
          ['<i data-lucide="check"></i>', 'Готово', 'Приложение появится в меню «Пуск» или Launchpad.']
        ];

  return `<div class="install-help">
    <div class="install-hero">
      <img src="/icons/icon-192.png" alt="Runa" class="install-hero-icon">
      <div>
        <h3>Runa на вашем устройстве</h3>
        <p>Отдельное окно, быстрый запуск, работа при слабой сети и офлайн-страница.</p>
      </div>
    </div>
    <div class="install-steps">
      ${steps.map(([icon, title, note], i) => `
        <div class="install-step">
          <div class="install-step-num">${i + 1}</div>
          <div class="install-step-icon">${icon}</div>
          <div class="install-step-text"><b>${title}</b><span>${note}</span></div>
        </div>`).join('')}
    </div>
    <p class="install-note"><i data-lucide="shield-check"></i> Устанавливается бесплатно, без магазина приложений. Данные аккаунта остаются на сервере Runa.</p>
  </div>`;
}

async function promptInstall() {
  if (isStandalonePwa()) {
    openList('Runa установлена', `<div class="install-help"><div class="install-hero">
      <img src="/icons/icon-192.png" alt="Runa" class="install-hero-icon">
      <div><h3>Всё готово</h3><p>Вы уже пользуетесь установленной Runa. Приятного общения!</p></div>
    </div><p class="install-note"><i data-lucide="check-circle"></i> Приложение запускается без адресной строки и работает офлайн.</p></div>`);
    if (window.lucide) lucide.createIcons();
    return;
  }

  if (deferredPrompt) {
    const prompt = deferredPrompt;
    deferredPrompt = null;
    try {
      prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        pwaInstalledThisSession = true;
        toast('Runa установлена 🎉', 'message');
      }
    } catch (e) { /* пользователь закрыл окно */ }
    syncInstallUi();
    return;
  }

  openList('Установить Runa', installHelpHtml());
  if (window.lucide) lucide.createIcons();
}

function showUpdateBar(show) {
  const bar = $('pwa-update-bar');
  if (!bar) return;
  bar.classList.toggle('show', !!show);
}

function setupPwa() {
  syncInstallUi();

  if (window.matchMedia) {
    try {
      window.matchMedia('(display-mode: standalone)').addEventListener('change', syncInstallUi);
    } catch (e) { /* старые браузеры */ }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    syncInstallUi();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    pwaInstalledThisSession = true;
    syncInstallUi();
    toast('Runa установлена — теперь она на вашем устройстве', 'message');
  });

  const navInstall = $('nav-install');
  if (navInstall) navInstall.addEventListener('click', () => { closeAnimated($('drawer-overlay'), 220); promptInstall(); });
  const downloadBtn = $('download-app-btn');
  if (downloadBtn) downloadBtn.addEventListener('click', promptInstall);

  /* --- офлайн-баннер --- */
  const syncOnlineState = () => {
    const offline = !navigator.onLine;
    document.body.classList.toggle('is-offline', offline);
    const banner = $('offline-banner');
    if (banner) banner.classList.toggle('show', offline);
  };
  window.addEventListener('online', () => {
    syncOnlineState();
    toast('Соединение восстановлено', 'message');
  });
  window.addEventListener('offline', syncOnlineState);
  syncOnlineState();

  /* --- обновление service worker --- */
  const updateReload = $('pwa-update-reload');
  if (updateReload) {
    updateReload.addEventListener('click', () => {
      if (swRegistration && swRegistration.waiting) {
        swReloading = true;
        swRegistration.waiting.postMessage('SKIP_WAITING');
      } else {
        location.reload();
      }
    });
  }

  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!swReloading) return;
    swReloading = false;
    location.reload();
  });

  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
    swRegistration = reg;

    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(true);

    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBar(true);
        }
      });
    });

    const checkForUpdate = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastSwCheck < 60 * 60 * 1000) return;
      lastSwCheck = Date.now();
      reg.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('focus', checkForUpdate);
  }).catch(() => {});
}

/* Ярлыки PWA: /?pwa=profile | new | chats */
function handlePwaAction() {
  const params = new URLSearchParams(location.search);
  const action = params.get('pwa');
  if (!action) return;

  params.delete('pwa');
  params.delete('source');
  const qs = params.toString();
  history.replaceState(history.state, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);

  if (action === 'profile' && currentUser) {
    openUserProfile(currentUser.id);
  } else if (action === 'new') {
    openNewChat();
  } else if (action === 'chats') {
    chatFilter = 'all';
    renderChats();
    const search = $('chats-search-input');
    if (search) setTimeout(() => search.focus(), 120);
  }
}

async function maybeJoinFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('join');
  if (!code) return;
  try {
    const res = await api('/api/chats/join', { method: 'POST', body: { code } });
    params.delete('join');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
    const list = await api('/api/chats');
    chats = list;
    renderChats();
    openChatById(res.id);
    toast('Вы присоединились к чату');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ================================================================== */
/*  АКТИВАЦИЯ                                                         */
/* ================================================================== */
function setupActivation() {
  const switchBtn = $('act-switch-mode');
  const nameBox = $('act-name-box');
  const header = $('act-header');
  const subtext = $('act-subtext');
  const submitBtn = $('act-submit-btn');
  const form = $('activation-form');
  const errorBox = $('act-error');
  const tabs = $$('#auth-mode-tabs .auth-tab');
  if (!switchBtn || !form) return;

  const usernameInput = $('act-username');
  const passwordInput = $('act-password');
  const statusEl = $('act-username-status');
  const hintEl = $('act-username-hint');
  const passHint = $('act-password-hint');
  let checkTimer = null;

  const showError = (text) => {
    if (!errorBox) return;
    errorBox.textContent = text || '';
    errorBox.classList.toggle('show', !!text);
  };

  const setUsernameHint = (text, kind) => {
    if (!hintEl) return;
    hintEl.textContent = text || '';
    hintEl.className = `auth-hint${kind ? ' ' + kind : ''}`;
  };
  const setUsernameStatus = (symbol, kind) => {
    if (!statusEl) return;
    statusEl.textContent = symbol || '';
    statusEl.className = `auth-check${kind ? ' ' + kind : ''}`;
  };

  const renderMode = () => {
    if (nameBox) nameBox.style.display = isRegisterMode ? 'block' : 'none';
    if (header) header.textContent = isRegisterMode ? 'Создайте аккаунт' : 'С возвращением';
    if (subtext) subtext.textContent = isRegisterMode
      ? 'Пара шагов — и вы в Runa. Юзернейм можно сменить позже.'
      : 'Войдите, чтобы продолжить общение в Runa.';
    if (submitBtn) {
      const label = submitBtn.querySelector('span');
      if (label) label.textContent = isRegisterMode ? 'Создать аккаунт' : 'Войти';
    }
    if (switchBtn) switchBtn.textContent = isRegisterMode ? 'Уже есть аккаунт' : 'Создать новую учётную запись';
    if (passwordInput) passwordInput.autocomplete = isRegisterMode ? 'new-password' : 'current-password';
    tabs.forEach(t => t.classList.toggle('active', t.dataset.authMode === (isRegisterMode ? 'register' : 'login')));
    if (passHint) {
      passHint.textContent = isRegisterMode ? 'Минимум 4 символа' : '';
      passHint.className = 'auth-hint';
    }
    showError('');
    if (!isRegisterMode) {
      setUsernameHint('');
      setUsernameStatus('');
    }
  };

  const toggleMode = (value) => {
    isRegisterMode = value === undefined ? !isRegisterMode : !!value;
    renderMode();
    if (usernameInput) setTimeout(() => usernameInput.focus(), 120);
  };

  switchBtn.addEventListener('click', () => toggleMode());
  tabs.forEach(tab => tab.addEventListener('click', () => toggleMode(tab.dataset.authMode === 'register')));

  const eye = $('act-eye');
  if (eye && passwordInput) {
    eye.addEventListener('click', () => {
      const visible = passwordInput.type === 'text';
      passwordInput.type = visible ? 'password' : 'text';
      eye.classList.toggle('on', !visible);
      if (window.lucide) lucide.createIcons();
    });
  }

  const checkUsername = async () => {
    if (!isRegisterMode || !usernameInput) return;
    const value = usernameInput.value.trim().toLowerCase().replace(/^@/, '');
    clearTimeout(checkTimer);
    if (!value) { setUsernameHint(''); setUsernameStatus(''); return; }
    if (!/^[a-z0-9_]{3,32}$/.test(value)) {
      setUsernameStatus('✕', 'bad');
      setUsernameHint('3–32 символа: латиница, цифры и _', 'bad');
      return;
    }
    setUsernameStatus('…', 'checking');
    setUsernameHint('Проверяем доступность…');
    checkTimer = setTimeout(async () => {
      try {
        const res = await api(`/api/username/check?username=${encodeURIComponent(value)}`);
        if (!usernameInput || usernameInput.value.trim().toLowerCase() !== value) return;
        setUsernameStatus(res.available ? '✓' : '✕', res.available ? 'ok' : 'bad');
        setUsernameHint(res.available ? 'Свободен — можно регистрироваться' : (res.reason || 'Занят'), res.available ? 'ok' : 'bad');
      } catch (e) {
        setUsernameStatus('', '');
        setUsernameHint('');
      }
    }, 320);
  };

  if (usernameInput) {
    usernameInput.addEventListener('input', () => {
      const clean = usernameInput.value.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '');
      if (usernameInput.value !== clean) usernameInput.value = clean;
      showError('');
      checkUsername();
    });
    usernameInput.addEventListener('blur', checkUsername);
  }
  if (passwordInput) passwordInput.addEventListener('input', () => {
    showError('');
    if (passHint && isRegisterMode) {
      const ok = passwordInput.value.length >= 4;
      passHint.textContent = ok ? 'Пароль подходит' : 'Минимум 4 символа';
      passHint.className = `auth-hint ${ok ? 'ok' : ''}`;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('act-username').value.trim().toLowerCase();
    const password = $('act-password').value;
    const fullname = $('act-fullname') ? $('act-fullname').value.trim() : '';
    if (!username || !password) {
      showError('Заполните юзернейм и пароль');
      return;
    }
    if (isRegisterMode && !/^[a-z0-9_]{3,32}$/.test(username)) {
      showError('Юзернейм: 3–32 символа, латиница, цифры и _');
      return;
    }
    if (isRegisterMode && password.length < 4) {
      showError('Пароль должен быть не короче 4 символов');
      return;
    }
    const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
    const payload = isRegisterMode
      ? { username, password, display_name: fullname || username }
      : { username, password };
    try {
      submitBtn.disabled = true;
      submitBtn.classList.add('loading');
      showError('');
      const data = await api(endpoint, { method: 'POST', body: payload });
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      startMainApp(data.user);
    } catch (err) {
      showError(err.message || 'Не получилось. Попробуйте ещё раз.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
    }
  });

  renderMode();
}

/* ================================================================== */
/*  SOCKET                                                            */
/* ================================================================== */
function connectSocket() {
  if (socket) { try { socket.disconnect(); } catch (e) { /* ignore */ } }
  socket = io({ auth: { token } });

  socket.on('connect', () => {
    socket.emit('fetch_chats');
    // После переподключения заново входим в открытый чат,
    // чтобы не потерять сообщения, отправленные во время обрыва связи.
    if (currentChat) {
      socket.emit('join_chat', { chatId: currentChat.id });
      socket.emit('mark_read', currentChat.id);
    }
  });

  socket.on('chats_list', (list) => {
    chats = Array.isArray(list) ? list : [];
    if (currentChat) {
      const fresh = chats.find(c => c.id === currentChat.id);
      if (fresh) {
        currentChat = fresh;
        setChatTitle(currentChat);
        const av = chatAvatarData(currentChat);
        paintAvatar($('opened-chat-avatar'), av.avatar, av.name);
        if (currentChat.type === 'dm') {
          const other = currentChat.otherUser;
          $('opened-chat-status').textContent = other && other.online
            ? 'в сети'
            : (other ? fmtLastSeen(other.lastSeen) : 'не в сети');
        } else if (currentChat.memberCount) {
          $('opened-chat-status').textContent = chatMemberCountText(currentChat);
        }
        setComposerEnabled(chatCanSend(currentChat), currentChat.type);
      }
    }
    renderChats();
    restoreLastChat();
  });

  socket.on('chat_history', ({ chatId, messages }) => {
    if (!currentChat || currentChat.id !== chatId) return;
    const history = Array.isArray(messages) ? messages : [];
    const historyIds = new Set(history.map(m => m.id));
    // Не теряем сообщения, которые уже показаны: пришедшие по сокету во время
    // загрузки истории и подгруженные ранее (старые страницы).
    const extra = currentMessages.filter(m => m && m.id && !historyIds.has(m.id));
    const merged = history.concat(extra).sort(compareMessages);
    renderMessages(merged);
  });

  socket.on('chat_updated', (patch) => {
    if (!patch || !patch.id) return;
    const row = chats.find(c => c.id === patch.id);
    if (row) Object.assign(row, patch);
    if (currentChat && currentChat.id === patch.id) {
      Object.assign(currentChat, patch);
      setChatTitle(currentChat);
      const av = chatAvatarData(currentChat);
      paintAvatar($('opened-chat-avatar'), av.avatar, av.name);
      if (chatSettings && chatSettings.data && chatSettings.data.id === patch.id) {
        Object.assign(chatSettings.data, patch);
        renderChatSettings();
      }
    }
    renderChats();
  });

  socket.on('chat_members_updated', ({ chatId } = {}) => {
    if (chatSettings && chatSettings.data && chatSettings.data.id === chatId) loadChatSettings(false);
  });

  socket.on('new_message', (msg) => {
    if (currentChat && currentChat.id === msg.chat_id) {
      if (!renderedIds.has(msg.id)) currentMessages.push(msg);
      appendMessage(msg);
    }
    if (msg.sender_id !== currentUser.id && (!currentChat || currentChat.id !== msg.chat_id)) {
      toast(`${msg.display_name || msg.username}: ${messagePreviewText(msg) || 'Сообщение'}`, 'message');
      beep();
    }
  });

  socket.on('notify_message', ({ chatId, message }) => {
    if (currentChat && currentChat.id === chatId) return;
    beep();
  });

  socket.on('message_deleted', ({ messageId }) => {
    if (replyTarget && replyTarget.id === messageId) clearReplyBar();
    if (reactionTarget && reactionTarget.messageId === messageId) closeReactionPicker();
    const bubble = document.querySelector(`.bubble[data-id="${messageId}"]`);
    if (bubble) {
      const row = bubble.closest('.msg-row');
      (row || bubble).remove();
    }
    renderedIds.delete(messageId);
    messageCache.delete(messageId);
    currentMessages = currentMessages.filter(m => m.id !== messageId);
    if ($('chat-messages-stream') && !$('chat-messages-stream').children.length) {
      $('chat-messages-stream').innerHTML = '<div class="empty-feed">Сообщений пока нет</div>';
    }
  });

  socket.on('message_edited', (msg) => {
    const cached = messageCache.get(msg.id);
    if (cached) Object.assign(cached, msg);
    const idx = currentMessages.findIndex(m => m.id === msg.id);
    if (idx >= 0) currentMessages[idx] = { ...currentMessages[idx], ...msg };
    const bubble = document.querySelector(`.bubble[data-id="${msg.id}"] .msg-text`);
    if (bubble) bubble.innerHTML = linkify(msg.text || '');
  });

  socket.on('message_reactions', ({ messageId, reactions }) => {
    updateMessageReactions(messageId, reactions || []);
  });

  socket.on('presence', ({ userId, online, lastSeen }) => {
    onlineMap.set(userId, { online, lastSeen });
    chats.forEach(c => {
      if (c.type === 'dm' && c.otherUser && c.otherUser.id === userId) {
        c.otherUser.online = online;
        c.otherUser.lastSeen = lastSeen;
      }
    });
    if (currentChat && currentChat.type === 'dm' && currentChat.otherUser && currentChat.otherUser.id === userId) {
      currentChat.otherUser.online = online;
      $('opened-chat-status').textContent = online ? 'в сети' : fmtLastSeen(lastSeen);
    }
    renderChats();
  });

  socket.on('user_typing', ({ chatId, displayName }) => {
    if (currentChat && currentChat.id === chatId) {
      $('opened-chat-status').textContent = `${displayName} печатает...`;
      clearTimeout(typingClearTimer);
      typingClearTimer = setTimeout(() => {
        if (currentChat && currentChat.type === 'dm') {
          const other = currentChat.otherUser;
          $('opened-chat-status').textContent = other && other.online ? 'в сети' : 'не в сети';
        } else {
          $('opened-chat-status').textContent = 'в сети';
        }
      }, 2500);
    }
  });

  socket.on('user_stop_typing', ({ chatId }) => {
    if (currentChat && currentChat.id === chatId) {
      if (currentChat.type === 'dm') {
        const other = currentChat.otherUser;
        $('opened-chat-status').textContent = other && other.online ? 'в сети' : 'не в сети';
      } else {
        $('opened-chat-status').textContent = 'в сети';
      }
    }
  });

  socket.on('error_message', (text) => toast(text, 'error'));

  socket.on('force_logout', ({ reason }) => {
    toast(reason || 'Сессия завершена', 'error');
    setTimeout(() => logoutLocal(), 800);
  });

  socket.on('nft_market_updated', () => {
    const list = $('modal-list');
    const title = $('list-modal-title');
    if (list && list.style.display !== 'none' && title && title.textContent === 'Маркет юзернеймов' && nftMarketTab === 'usernames') {
      openNftMarket('usernames', true);
    }
  });

  if (window.onRunaSocketReady) window.onRunaSocketReady(socket);
  if (window.onNftPhraseSocketReady) window.onNftPhraseSocketReady(socket);

  socket.on('user_updated', (profile) => {
    if (profile && profile.id === currentUser.id) {
      currentUser = { ...currentUser, ...profile };
      updateUserUI();
    }
    chats.forEach(c => {
      if (c.otherUser && c.otherUser.id === profile.id) {
        c.otherUser.displayName = profile.displayName;
        c.otherUser.avatar = profile.avatar;
      }
    });
    renderChats();
  });
}

function restoreLastChat() {
  if (restoringChat || currentChat || chatDismissed) return;
  const last = localStorage.getItem(LAST_CHAT_KEY);
  if (!last) return;
  const chat = chats.find(c => c.id === last);
  if (!chat) return;
  restoringChat = true;
  openChat(chat);
  restoringChat = false;
}

/* ================================================================== */
/*  UI ПОЛЬЗОВАТЕЛЯ                                                   */
/* ================================================================== */
function updateUserUI() {
  if (!currentUser) return;
  const u = currentUser;
  const name = u.displayName || u.username;
  const initial = String(name || '?').charAt(0).toUpperCase();

  const cardAvatar = $('card-avatar');
  if (cardAvatar) cardAvatar.className = `profile-avatar-giant frame-${u.avatarFrame || 'none'}`;

  const avatarTargets = [
    $('topbar-avatar'), $('story-my-avatar'), $('drawer-avatar'), $('card-avatar'),
    $('edit-avatar-preview'), $('custom-avatar-preview'),
    document.querySelector('.live-avatar-giant'),
    document.querySelector('.settings-user-card .avatar-circle-sm'),
    document.querySelector('.custom-user-summary .avatar-circle-sm')
  ];
  avatarTargets.forEach(el => paintAvatar(el, u.avatar, name));

  const text = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  text('topbar-name', name);
  text('topbar-username', `@${u.username}`);
  text('drawer-name', name);
  text('drawer-username', `@${u.username}`);
  text('card-name', name);
  text('card-username', u.username || '');
  const editUsernameInput = $('edit-username-val');
  const editUsernameVisible = !!(editUsernameInput && editUsernameInput.offsetParent);
  if (editUsernameInput && (!editUsernameVisible || document.activeElement !== editUsernameInput)) {
    editUsernameInput.value = u.username;
    const unameHint = $('edit-username-hint');
    if (unameHint) { unameHint.textContent = '3–32 символа: латиница, цифры и _'; unameHint.className = 'field-hint'; }
    const unameStatus = $('edit-username-status');
    if (unameStatus) { unameStatus.textContent = ''; unameStatus.className = 'username-status'; }
  }
  text('custom-user-name', name);
  text('custom-preview-name-1', name);
  text('live-name', name);
  text('live-handle', `@${u.username}`);
  text('settings-user-name', name);
  text('settings-user-handle', `@${u.username}`);
  text('wallet-card-holder', `@${u.username}`);
  text('wallet-card-name', u.displayName || u.username || 'Runa');
  const walletCardAvatar = $('wallet-card-avatar');
  if (walletCardAvatar) {
    walletCardAvatar.innerHTML = u.avatar
      ? `<img src="${escapeAttr(u.avatar)}" alt="">`
      : '<i data-lucide="paw-print"></i>';
  }
  applyCardStyle(u.cardStyle || localStorage.getItem('runa_card_style') || 'classic', false);
  text('rubies-card-user', `@${u.username}`);
  text('drawer-rubies-count', u.rubies || 0);
  text('card-balance-num', fmtMops(u.mopsBalance));
  text('card-level', u.level || 1);
  text('wallet-mops-val', fmtMops(u.mopsBalance));
  text('wallet-rubies-est', Number(u.rubies || 0).toLocaleString('ru-RU'));
  text('rubies-main-count', u.rubies || 0);
  text('custom-level-num', u.level || 1);
  text('custom-phone', u.phoneNumber || 'Не выдан');

  const nameInput = $('edit-name-val'); if (nameInput) nameInput.value = name;
  const bioInput = $('edit-bio-val'); if (bioInput) bioInput.value = u.bio || '';
  const cityInput = $('edit-city-val'); if (cityInput) cityInput.value = u.city || '';

  text('card-bio', u.bio || '');
  const bioEl = $('card-bio'); if (bioEl) bioEl.style.display = u.bio ? 'block' : 'none';
  text('card-city', u.city || '');
  const cityRow = $('card-city-row'); if (cityRow) cityRow.style.display = u.city ? 'flex' : 'none';
  text('card-phone', u.phoneNumber || '');
  const phoneRow = $('card-phone-row'); if (phoneRow) phoneRow.style.display = u.phoneNumber ? 'flex' : 'none';
  text('card-clan', u.clan ? `[${u.clan.tag}] ${u.clan.name}` : '');
  const clanRow = $('card-clan-row'); if (clanRow) clanRow.style.display = u.clan ? 'flex' : 'none';

  const reg = $('card-regdate');
  if (reg) reg.textContent = `На Runa с ${parseDate(u.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  renderBadges($('card-badges-flex'), u.badges);
  renderBadges($('custom-badges-list'), u.badges);

  const nftList = Array.isArray(u.nftUsernames) ? u.nftUsernames : [];

  const cardNfts = $('card-nfts');
  if (cardNfts) {
    cardNfts.innerHTML = nftList.map(n => nftChipHtml(n)).join('') + anonChipHtml(u.anonymousNumber);
  }

  const anonRow = $('anon-number-row');
  if (anonRow) {
    anonRow.innerHTML = u.anonymousNumber
      ? `${anonChipHtml(u.anonymousNumber)}<button type="button" class="anon-mini-btn" data-anon-action="remove">Удалить</button>`
      : `<button type="button" class="anon-get-btn" data-anon-action="get"><i data-lucide="shield-plus"></i> Получить анонимный номер</button>`;
  }

  const editNfts = $('edit-nfts-list');
  if (editNfts) {
    editNfts.innerHTML = nftList.length
      ? nftList.map(n => `<span class="nft-chip">@${escapeHtml(n.username)}${n.forSale ? ` <em>${Number(n.price) || 0} 💎</em>` : ''}</span>`).join('')
      : '<span class="muted-small">У вас пока нет NFT юзернеймов — их можно купить на маркете.</span>';
  }

  const nfts = $('custom-nfts-list');
  if (nfts) {
    nfts.innerHTML = nftList.length
      ? nftList.map(n => `
        <div class="nft-manage-row">
          <div class="nft-manage-main">
            <span class="nft-chip">@${escapeHtml(n.username)}</span>
            <small>${n.forSale ? `На продаже · ${Number(n.price) || 0} 💎` : 'В коллекции'}</small>
          </div>
          ${n.forSale
            ? `<button class="mac-btn secondary nft-mini-btn" data-action="nft-unlist" data-id="${escapeAttr(n.id)}">Снять</button>`
            : `<button class="mac-btn secondary nft-mini-btn" data-action="nft-sell" data-id="${escapeAttr(n.id)}" data-username="${escapeAttr(n.username)}">Продать</button>`}
        </div>`).join('')
      : '<span class="muted-small">Нет NFT юзернеймов. Загляните на маркет — там продаются короткие имена.</span>';
  }

  const balancePill = $('card-balance-pill');
  if (balancePill) balancePill.style.display = u.showBalance ? 'inline-flex' : 'none';

  const profileWindow = document.querySelector('#modal-profile-card .profile-window');
  if (profileWindow) {
    profileWindow.className = `profile-window style-${u.profileStyle || 'telegram'} bg-${u.profileBg || 'none'}`;
  }
  const cardName = $('card-name');
  if (cardName) cardName.style.color = u.usernameColor || '';
  const handle = $('card-username');
  if (handle) handle.style.color = u.accentColor || '';
  const liveName = $('live-name');
  if (liveName) liveName.style.color = u.usernameColor || '';

  const banner = $('card-banner');
  if (banner) {
    if (u.banner) { banner.style.backgroundImage = `url("${u.banner}")`; banner.classList.add('has-banner'); }
    else { banner.style.backgroundImage = ''; banner.classList.remove('has-banner'); }
  }
  const bannerPreview = $('banner-preview');
  if (bannerPreview) {
    if (u.banner) { bannerPreview.style.backgroundImage = `url("${u.banner}")`; bannerPreview.innerHTML = ''; }
    else { bannerPreview.style.backgroundImage = ''; bannerPreview.innerHTML = '<span>Баннер не установлен</span>'; }
  }

  const walletToggle = $('wallet-show-toggle');
  if (walletToggle) walletToggle.checked = !!u.showBalance;

  syncChoices();
  applyAvatarAdjust();
  if (window.lucide) lucide.createIcons();
}

function syncChoices() {
  if (!currentUser) return;
  $$('#frame-choices .swatch').forEach(b => b.classList.toggle('active', (b.dataset.frame || '') === (currentUser.avatarFrame || '')));
  $$('#bg-choices .swatch').forEach(b => b.classList.toggle('active', (b.dataset.bg || '') === (currentUser.profileBg || '')));
  $$('#nick-choices .swatch').forEach(b => b.classList.toggle('active', (b.dataset.color || '') === (currentUser.usernameColor || '')));
  $$('#accent-choices .swatch').forEach(b => b.classList.toggle('active', (b.dataset.accent || '') === (currentUser.accentColor || '')));
  $$('.style-choice-item').forEach(b => b.classList.toggle('active', (b.dataset.style || '') === (currentUser.profileStyle || 'telegram')));
}

function applyUserSettings() {
  if (!currentUser) return;
  document.body.classList.toggle('theme-light', currentUser.theme === 'light');

  const scale = Math.max(80, Math.min(140, Number(currentUser.fontSize || 100)));
  document.body.style.setProperty('--msg-font-size', `${Math.round(14 * scale / 100)}px`);
  document.body.style.zoom = `${Math.max(80, Math.min(120, Number(currentUser.uiScale || 100)))}%`;

  const fontKey = FONT_STACKS[currentUser.fontFamily] ? currentUser.fontFamily : 'rubik';
  document.body.style.setProperty('--font-ui', FONT_STACKS[fontKey]);
  document.documentElement.style.setProperty('--font-family', FONT_STACKS[fontKey]);
  document.body.classList.toggle('text-bold', !!currentUser.boldText);
  document.body.classList.toggle('cursor-dot', currentUser.cursorStyle === 'dot');
  document.body.classList.toggle('cursor-crosshair', currentUser.cursorStyle === 'crosshair');
  document.body.dataset.chatWallpaper = currentUser.chatWallpaper || 'runa';
  document.body.dataset.chatPattern = currentUser.chatPattern || 'doodle';

  document.body.classList.toggle('no-motion', localStorage.getItem('runa_no_motion') === '1');
  document.body.classList.toggle('no-blur', localStorage.getItem('runa_no_blur') === '1');
  const savedCard = currentUser.cardStyle || localStorage.getItem('runa_card_style') || 'classic';
  if (typeof applyCardStyle === 'function') applyCardStyle(savedCard, false);
}

/* ================================================================== */
/*  СПИСОК ЧАТОВ                                                      */
/* ================================================================== */
function applyFilterUi() {
  ['saved', 'groups', 'channels'].forEach(f => {
    const btn = $(`btn-filter-${f}`);
    if (btn) btn.classList.toggle('active', chatFilter === f);
  });
}

function renderChats() {
  applyFilterUi();
  const container = $('chats-list-container');
  if (!container) return;
  const q = searchQuery.trim().toLowerCase();
  const filtered = chats.filter(chat => {
    const name = chatName(chat).toLowerCase();
    const handle = chat.type === 'dm' && chat.otherUser ? chat.otherUser.username : '';
    if (q && !name.includes(q) && !handle.includes(q) && !String(chat.lastMessage || '').toLowerCase().includes(q)) return false;
    if (chatFilter === 'saved' && !chat.pinned) return false;
    if (chatFilter === 'groups' && chat.type === 'channel') return false;
    if (chatFilter === 'channels' && chat.type !== 'channel') return false;
    return true;
  });

  container.innerHTML = '';
  if (!filtered.length) {
    container.innerHTML = '<div class="empty-chats">Ничего не найдено</div>';
    return;
  }

  const listSignature = filtered.map(c => c.id).join('|') + '|' + chatFilter;
  const animateRows = !q && listSignature !== chatListSignature;
  chatListSignature = listSignature;

  const fragment = document.createDocumentFragment();
  filtered.forEach((chat, index) => {
    const el = document.createElement('div');
    el.className = `chat-row-item ${currentChat && currentChat.id === chat.id ? 'active' : ''}`;
    if (animateRows) {
      el.classList.add('chat-row-enter');
      el.style.setProperty('--row-i', Math.min(index, 12));
    }
    const av = chatAvatarData(chat);
    const verified = chatBadgeHtml(chat);
    const pin = chat.pinned ? '<i data-lucide="pin" class="chat-pin"></i>' : '';
    const unread = chat.unread ? `<span class="unread-badge">${chat.unread}</span>` : '';
    const lastText = chat.lastMessage || messagePreviewText({ file_type: chat.lastMessageType });
    const preview = lastText
      ? escapeHtml(lastText)
      : (chat.type === 'channel' ? 'Канал' : chat.type === 'group' ? 'Группа' : 'Нет сообщений');
    const onlineDot = chat.type === 'dm' && chat.otherUser && chat.otherUser.online
      ? '<span class="online-mini-dot"></span>' : '';
    const avatarHtml = av.avatar
      ? `<img src="${escapeAttr(av.avatar)}" alt="">`
      : escapeHtml(String(av.name || '?').charAt(0).toUpperCase());
    el.innerHTML = `
      <div class="avatar-circle-md chat-avatar ${av.avatar ? 'has-img' : ''}">${avatarHtml}${onlineDot}</div>
      <div class="chat-meta">
        <div class="chat-meta-top">
          <span class="chat-row-title">${escapeHtml(chatName(chat))} ${verified}</span>
          <span class="chat-row-side">${pin}<span class="chat-time">${fmtChatTime(chat.lastMessageDate)}</span></span>
        </div>
        <div class="chat-meta-bottom">
          <div class="chat-row-preview">${preview}</div>
          ${unread}
        </div>
      </div>`;
    el.addEventListener('click', () => openChat(chat));
    fragment.appendChild(el);
  });
  container.appendChild(fragment);
  if (window.lucide) lucide.createIcons();
}

function chatCanSend(chat) {
  if (!chat) return false;
  if (chat.type === 'dm') return true;
  const isManager = !!(currentUser && (currentUser.isAdmin || chat.role === 'owner' || chat.role === 'admin'));
  if (chat.type === 'channel') return isManager;
  const perms = chat.permissions || {};
  return perms.send_messages === 'admins' ? isManager : true;
}

function setComposerEnabled(enabled, type) {
  const bar = document.querySelector('.chat-input-bar');
  const composer = $('composer-textarea');
  const send = $('btn-send');
  const attach = $('btn-attach');
  if (type === 'channel' && !enabled) {
    if (bar) bar.style.display = 'none';
  } else {
    if (bar) bar.style.display = '';
  }
  if (bar) bar.classList.toggle('disabled', !enabled);
  if (composer) {
    composer.disabled = !enabled;
    composer.placeholder = enabled
      ? 'Написать сообщение...'
      : (type === 'channel' ? 'Только администраторы могут писать в канал' : 'Писать могут только администраторы');
  }
  if (send) send.disabled = !enabled;
  if (attach) attach.disabled = !enabled;
  const stickers = $('btn-stickers');
  if (stickers) stickers.disabled = !enabled;
  if (!enabled) closeStickerPanel();
}

function isMobileView() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 820px)').matches);
}

function closeChatView(animate = true) {
  const view = $('chat-opened');
  currentChat = null;
  chatDismissed = true;
  const token = ++chatViewCloseToken;
  if (window.onRunaChatClosed) window.onRunaChatClosed();
  const finish = () => {
    if (token !== chatViewCloseToken) return;
    document.body.classList.remove('mobile-chat-open');
    if (!view) return;
    view.classList.remove('is-closing');
    view.style.display = 'none';
    $('chat-unselected').style.display = 'flex';
  };
  if (animate && view && view.style.display !== 'none') {
    view.classList.add('is-closing');
    setTimeout(finish, 190);
  } else {
    finish();
  }
}

function openChat(chat) {
  if (!chat) return;
  clearReplyBar();
  closeReactionPicker();
  closeStickerPanel();
  chatDismissed = false;
  chatViewCloseToken++;
  currentChat = chat;
  currentMessages = [];
  hasMoreHistory = false;
  loadingOlder = false;
  localStorage.setItem(LAST_CHAT_KEY, chat.id);
  $('chat-unselected').style.display = 'none';
  const chatView = $('chat-opened');
  chatView.classList.remove('is-closing');
  chatView.style.display = 'flex';
  document.body.classList.add('mobile-chat-open');

  if (isMobileView()) {
    if (history.state && history.state.runaChat) history.replaceState({ runaChat: chat.id }, '', location.href);
    else history.pushState({ runaChat: chat.id }, '', location.href);
  }

  setChatTitle(chat);
  const av = chatAvatarData(chat);
  paintAvatar($('opened-chat-avatar'), av.avatar, av.name);

  if (chat.type === 'dm') {
    const other = chat.otherUser;
    $('opened-chat-status').textContent = other && other.online ? 'в сети' : (other ? fmtLastSeen(other.lastSeen) : 'не в сети');
  } else if (chat.memberCount) {
    $('opened-chat-status').textContent = chatMemberCountText(chat);
  } else {
    $('opened-chat-status').textContent = chat.type === 'channel' ? 'канал' : 'группа';
  }
  setComposerEnabled(chatCanSend(chat), chat.type);

  const stream = $('chat-messages-stream');
  stream.innerHTML = '<div class="empty-feed">Загрузка сообщений...</div>';
  renderedIds.clear();
  if (socket) {
    socket.emit('join_chat', { chatId: chat.id });
    socket.emit('mark_read', chat.id);
  }
  if (window.onRunaChatOpened) window.onRunaChatOpened(chat);
  renderChats();
}

function openChatById(chatId) {
  const chat = chats.find(c => c.id === chatId);
  if (chat) {
    closeListModal();
    openChat(chat);
  }
}

/* ================================================================== */
/*  СООБЩЕНИЯ                                                         */
/* ================================================================== */
function renderMessages(messages, isInitial = true) {
  const stream = $('chat-messages-stream');
  if (!stream) return;
  stream.innerHTML = '';
  renderedIds.clear();
  messageCache.clear();
  currentMessages = (messages || []).slice();
  if (isInitial) hasMoreHistory = currentMessages.length >= 100;
  if (!messages.length) {
    stream.innerHTML = '<div class="empty-feed">Сообщений пока нет. Напишите первым!</div>';
    return;
  }
  let lastDay = '';
  const animateFrom = isInitial ? Math.max(0, messages.length - 8) : messages.length;
  messages.forEach((msg, index) => {
    const day = dayKey(msg.created_at);
    if (day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'msg-day';
      sep.textContent = fmtDay(msg.created_at);
      stream.appendChild(sep);
      lastDay = day;
    }
    appendMessage(msg, false);
    if (index >= animateFrom) {
      const row = stream.lastElementChild;
      if (row) {
        row.classList.add('msg-appear');
        row.style.animationDelay = `${(index - animateFrom) * 34}ms`;
      }
    }
  });
  if (window.lucide) lucide.createIcons();
  if (isInitial) stream.scrollTop = stream.scrollHeight;
}

async function loadOlderMessages() {
  if (loadingOlder || !hasMoreHistory || !currentChat || !currentMessages.length) return;
  loadingOlder = true;
  const chatId = currentChat.id;
  const stream = $('chat-messages-stream');
  const oldest = currentMessages[0];
  const prevHeight = stream.scrollHeight;
  const prevTop = stream.scrollTop;
  try {
    const rows = await api(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=${HISTORY_PAGE}`
      + `&before=${encodeURIComponent(oldest.created_at || '')}&beforeId=${encodeURIComponent(oldest.id)}`
      + `&beforeSeq=${encodeURIComponent(oldest.seq || 0)}`);
    if (!currentChat || currentChat.id !== chatId) return;
    if (rows.length) {
      currentMessages = [...rows, ...currentMessages];
      renderMessages(currentMessages, false);
      hasMoreHistory = rows.length >= HISTORY_PAGE;
      stream.scrollTop = stream.scrollHeight - prevHeight + prevTop;
    } else {
      hasMoreHistory = false;
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    loadingOlder = false;
  }
}

function appendMessage(msg, scroll = true) {
  const stream = $('chat-messages-stream');
  if (!stream || renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);
  messageCache.set(msg.id, msg);
  const empty = stream.querySelector('.empty-feed');
  if (empty) empty.remove();

  const isMe = msg.sender_id === currentUser.id;
  const canDelete = isMe || currentUser.isAdmin;

  let prev = stream.lastElementChild;
  if (prev && prev.classList.contains('msg-day')) prev = null;
  const sameAuthor = !!(prev && prev.classList.contains('msg-row')
    && prev.dataset.senderId === msg.sender_id
    && Math.abs(parseDate(msg.created_at) - parseDate(prev.dataset.time || msg.created_at)) < 5 * 60000);

  const row = document.createElement('div');
  row.className = `msg-row ${isMe ? 'out' : 'in'}${sameAuthor ? ' continued' : ''}${scroll ? ' msg-appear' : ''}`;
  row.dataset.senderId = msg.sender_id;
  row.dataset.time = msg.created_at;

  if (!isMe) {
    if (sameAuthor) {
      const spacer = document.createElement('div');
      spacer.className = 'msg-avatar-spacer';
      row.appendChild(spacer);
    } else {
      const av = document.createElement('button');
      av.type = 'button';
      av.className = 'msg-avatar';
      av.dataset.userId = msg.sender_id;
      av.title = `Открыть профиль ${msg.display_name || msg.username || ''}`;
      paintAvatar(av, msg.avatar, msg.display_name || msg.username);
      row.appendChild(av);
    }
  }

  const content = document.createElement('div');
  content.className = 'msg-content';

  const bubble = document.createElement('div');
  bubble.className = `bubble ${isMe ? 'out' : 'in'}`;
  bubble.dataset.id = msg.id;

  let inner = '';
  if (!isMe && !sameAuthor) {
    const nftNames = String(msg.sender_nfts || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 2);
    const chips = nftNames.map(name => nftChipHtml(name, 'msg-identity-chip')).join('');
    inner += `<div class="msg-author" data-user-id="${escapeAttr(msg.sender_id)}">${escapeHtml(msg.display_name || msg.username || 'Пользователь')}${chips}</div>`;
  }
  if (msg.reply_to) {
    const quoteAuthor = msg.reply_deleted
      ? 'Сообщение удалено'
      : (msg.reply_author || msg.reply_username || 'Сообщение');
    const quoteFallback = msg.reply_file_type === 'sticker'
      ? 'Стикер'
      : msg.reply_file_type === 'image' ? 'Фотография' : 'Вложение';
    const quoteText = msg.reply_deleted
      ? ''
      : (msg.reply_text || (msg.reply_to ? quoteFallback : ''));
    inner += `<div class="msg-reply-quote" data-reply-id="${escapeAttr(msg.reply_to)}">
      <span class="reply-quote-author">${escapeHtml(quoteAuthor)}</span>
      <span class="reply-quote-text">${escapeHtml(quoteText)}</span>
    </div>`;
  }
  if (msg.text) inner += `<div class="msg-text">${linkify(msg.text)}</div>`;
  if (msg.file_type === 'sticker' && msg.file_url) {
    bubble.classList.add('sticker-bubble');
    inner += `<img class="msg-sticker" src="${escapeAttr(msg.file_url)}" alt="Стикер" loading="lazy" draggable="false">`;
  } else if (msg.file_url) {
    if (msg.file_type === 'image') {
      inner += `<img class="msg-image" src="${escapeAttr(msg.file_url)}" alt="${escapeAttr(msg.file_name || '')}" loading="lazy">`;
    } else {
      inner += `<a class="msg-file" href="${escapeAttr(msg.file_url)}" download="${escapeAttr(msg.file_name || '')}">
        <i data-lucide="paperclip"></i> ${escapeHtml(msg.file_name || 'Файл')}</a>`;
    }
  }
  inner += `<div class="msg-meta">
    <span class="msg-time">${fmtTime(msg.created_at)}</span>${msg.edited_at ? '<span class="msg-edited">изм.</span>' : ''}
    ${isMe ? '<span class="msg-ticks" title="Доставлено"><svg viewBox="0 0 16 10" aria-hidden="true"><path d="M1 5.2 3.4 7.6 9 2M6.4 7.6 8.8 10 15 3.8"/></svg></span>' : ''}
    <span class="msg-actions">
      <button class="msg-react" title="Поставить реакцию"><i data-lucide="smile-plus"></i></button>
      <button class="msg-reply" title="Ответить"><i data-lucide="reply"></i></button>
      ${canDelete ? '<button class="msg-del" title="Удалить"><i data-lucide="trash-2"></i></button>' : ''}
    </span>
  </div>`;

  bubble.innerHTML = inner;

  content.appendChild(bubble);
  content.appendChild(buildReactionsEl(msg.id, msg.reactions));
  row.appendChild(content);
  const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 180;
  stream.appendChild(row);
  if (scroll && window.lucide) lucide.createIcons();
  if (scroll && (nearBottom || (currentUser && msg.sender_id === currentUser.id))) {
    requestAnimationFrame(() => { stream.scrollTop = stream.scrollHeight; });
  }
}

function renderReactionChips(el, reactions) {
  el.innerHTML = (reactions || []).map(r => `
    <button class="reaction-chip${r.me ? ' me' : ''}" data-emoji="${escapeAttr(r.emoji)}"
      title="${r.me ? 'Убрать реакцию' : 'Поставить реакцию'}">
      <span>${escapeHtml(r.emoji)}</span>
      ${Number(r.count) > 1 ? `<span class="reaction-count">${Number(r.count)}</span>` : ''}
    </button>`).join('');
}

function buildReactionsEl(messageId, reactions) {
  const el = document.createElement('div');
  el.className = 'msg-reactions';
  el.dataset.messageId = messageId;
  renderReactionChips(el, reactions);
  return el;
}

function updateMessageReactions(messageId, reactions) {
  const bubble = document.querySelector(`.bubble[data-id="${messageId}"]`);
  if (!bubble) return;
  const content = bubble.closest('.msg-content');
  if (!content) return;
  let el = content.querySelector('.msg-reactions');
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg-reactions';
    el.dataset.messageId = messageId;
    content.appendChild(el);
  }
  renderReactionChips(el, reactions);
}

function openReactionPicker(messageId, anchor) {
  const picker = $('reaction-picker');
  if (!picker || !anchor) return;
  reactionTarget = { messageId };
  openAnimated(picker);
  picker.style.visibility = 'hidden';
  const rect = anchor.getBoundingClientRect();
  const pw = picker.offsetWidth || 270;
  const ph = picker.offsetHeight || 44;
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  let top = rect.top - ph - 8;
  if (top < 8) top = rect.bottom + 8;
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
  picker.style.visibility = 'visible';
}

function closeReactionPicker() {
  const picker = $('reaction-picker');
  if (picker) closeAnimated(picker, 120);
  reactionTarget = null;
}

function setupReactions() {
  const picker = $('reaction-picker');
  if (!picker) return;
  picker.querySelectorAll('.reaction-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (reactionTarget && socket) {
        socket.emit('toggle_reaction', { messageId: reactionTarget.messageId, emoji: btn.dataset.emoji });
      }
      closeReactionPicker();
    });
  });
  document.addEventListener('click', (e) => {
    if (picker.style.display === 'none') return;
    if (picker.contains(e.target) || e.target.closest('.msg-react')) return;
    closeReactionPicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeReactionPicker();
  });
  window.addEventListener('resize', closeReactionPicker);
  window.addEventListener('scroll', closeReactionPicker, true);
}

/* ================================================================== */
/*  СТИКЕРЫ                                                           */
/* ================================================================== */
function messagePreviewText(msg) {
  if (!msg) return '';
  if (msg.text) return msg.text;
  const type = msg.file_type || msg.fileType || msg.lastMessageType || '';
  if (type === 'sticker') return 'Стикер';
  if (type === 'image') return 'Фотография';
  if (type === 'file') return msg.file_name || msg.fileName || 'Файл';
  return '';
}

async function loadStickerPacks() {
  if (stickerPacks) return stickerPacks;
  try {
    const data = await api('/stickers/packs.json');
    const packs = data && Array.isArray(data.packs) ? data.packs.filter(p => p && Array.isArray(p.stickers) && p.stickers.length) : [];
    stickerPacks = packs.length ? packs : [STICKER_FALLBACK_PACK];
  } catch (e) {
    stickerPacks = [STICKER_FALLBACK_PACK];
  }
  return stickerPacks;
}

function renderStickerPanel() {
  const grid = $('sticker-grid');
  const bar = $('sticker-pack-bar');
  if (!grid || !bar || !stickerPacks) return;
  if (stickerActivePack >= stickerPacks.length) stickerActivePack = 0;
  const pack = stickerPacks[stickerActivePack];
  grid.innerHTML = pack.stickers.map((url, i) => `
    <button type="button" class="sticker-item" style="--i:${i}" data-sticker="${escapeAttr(url)}" title="Стикер ${i + 1}">
      <img src="${escapeAttr(url)}" alt="Стикер ${i + 1}" loading="lazy" decoding="async" draggable="false">
    </button>`).join('');
  bar.innerHTML = stickerPacks.map((p, i) => `
    <button type="button" class="sticker-pack-tab${i === stickerActivePack ? ' active' : ''}" data-pack="${i}" title="${escapeAttr(p.title || 'Стикеры')}">
      <span class="sticker-pack-thumb"><img src="${escapeAttr(p.cover || p.stickers[0])}" alt="" loading="lazy"></span>
      <span class="sticker-pack-name">${escapeHtml(p.title || 'Стикеры')}</span>
    </button>`).join('');
  if (window.lucide) lucide.createIcons();
}

async function toggleStickerPanel(force) {
  const panel = $('sticker-panel');
  const btn = $('btn-stickers');
  if (!panel) return;
  const shouldOpen = typeof force === 'boolean' ? force : !stickerPanelOpen;
  if (!shouldOpen) { closeStickerPanel(); return; }
  if (!currentChat || !chatCanSend(currentChat)) return;
  await loadStickerPacks();
  renderStickerPanel();
  openAnimated(panel);
  stickerPanelOpen = true;
  if (btn) btn.classList.add('active');
  const grid = $('sticker-grid');
  if (grid) grid.scrollTop = 0;
}

function closeStickerPanel() {
  const panel = $('sticker-panel');
  if (panel) closeAnimated(panel, 150);
  stickerPanelOpen = false;
  const btn = $('btn-stickers');
  if (btn) btn.classList.remove('active');
}

function sendSticker(url) {
  if (!url || !currentChat || !socket) return;
  if (!chatCanSend(currentChat) || $('composer-textarea').disabled) return;
  socket.emit('send_message', {
    chatId: currentChat.id,
    text: '',
    fileUrl: url,
    fileName: url.split('/').pop() || 'sticker.webp',
    fileType: 'sticker',
    replyTo: replyTarget ? replyTarget.id : null
  });
  closeStickerPanel();
  clearReplyBar();
  const btn = $('btn-stickers');
  if (btn) {
    btn.classList.remove('sending');
    void btn.offsetWidth;
    btn.classList.add('sending');
    setTimeout(() => btn.classList.remove('sending'), 420);
  }
  socket.emit('stop_typing', { chatId: currentChat.id });
}

function setupStickers() {
  const btn = $('btn-stickers');
  const panel = $('sticker-panel');
  if (!btn || !panel) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStickerPanel();
  });
  $('sticker-panel-close').addEventListener('click', () => closeStickerPanel());

  $('sticker-grid').addEventListener('click', (e) => {
    const item = e.target.closest('[data-sticker]');
    if (item) sendSticker(item.dataset.sticker);
  });

  $('sticker-pack-bar').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-pack]');
    if (!tab) return;
    stickerActivePack = Number(tab.dataset.pack) || 0;
    renderStickerPanel();
  });

  document.addEventListener('click', (e) => {
    if (!stickerPanelOpen) return;
    if (e.target.closest('#sticker-panel') || e.target.closest('#btn-stickers')) return;
    closeStickerPanel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stickerPanelOpen) closeStickerPanel();
  });
}

function startReply(msg) {
  if (!msg) return;
  replyTarget = msg;
  const author = msg.sender_id === currentUser.id ? 'Вы' : (msg.display_name || msg.username || 'Пользователь');
  $('reply-bar-author').textContent = author;
  $('reply-bar-text').textContent = messagePreviewText(msg) || 'Вложение';
  $('reply-bar').style.display = 'flex';
  const composer = $('composer-textarea');
  if (composer) composer.focus();
  if (window.lucide) lucide.createIcons();
}

function clearReplyBar() {
  replyTarget = null;
  const bar = $('reply-bar');
  if (bar) bar.style.display = 'none';
}

async function openUserProfile(userId) {
  if (!userId) return;
  if (currentUser && userId === currentUser.id) {
    $('modal-profile-card').style.display = 'flex';
    if (window.loadSelfProfileSocial) window.loadSelfProfileSocial();
    return;
  }
  try {
    const user = await api(`/api/users/${encodeURIComponent(userId)}`);
    showUserProfile(user);
  } catch (err) { toast(err.message, 'error'); }
}

function showUserProfile(user) {
  if (!user) return;
  const modal = $('modal-user-profile');
  const name = user.displayName || user.username || 'Пользователь';
  const isSelf = !!(currentUser && user.id === currentUser.id);

  const banner = $('up-banner');
  banner.classList.toggle('has-banner', !!user.banner);
  banner.style.backgroundImage = user.banner
    ? `linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.25)), url("${String(user.banner).replace(/"/g, '%22')}")`
    : '';

  const av = $('up-avatar');
  av.className = `up-avatar frame-${user.avatarFrame || 'none'}`;
  paintAvatar(av, user.avatar, name);

  $('up-online-dot').style.display = user.online ? 'block' : 'none';
  $('up-name').textContent = name;
  $('up-username').textContent = user.username || '';

  const pills = [];
  if (user.online) {
    pills.push('<span class="up-pill online"><i data-lucide="circle"></i>В сети</span>');
  } else if (user.lastSeen) {
    pills.push(`<span class="up-pill"><i data-lucide="clock"></i>${escapeHtml(fmtLastSeen(user.lastSeen))}</span>`);
  }
  if (user.isPremium) pills.push('<span class="up-pill premium"><i data-lucide="star"></i>Premium</span>');
  if (user.isAdmin) pills.push('<span class="up-pill admin"><i data-lucide="shield-check"></i>Администратор</span>');
  pills.push(`<span class="up-pill level"><i data-lucide="zap"></i>Уровень ${Number(user.level) || 1}</span>`);
  if (user.clan) pills.push(`<span class="up-pill"><i data-lucide="users"></i>[${escapeHtml(user.clan.tag || '')}] ${escapeHtml(user.clan.name || '')}</span>`);
  $('up-pills').innerHTML = pills.join('');

  $('up-bio').textContent = user.bio || '';

  const badges = (user.badges || []).map(badgeHtml).join('');
  $('up-badges').innerHTML = badges;

  const meta = [];
  if (user.city) meta.push(`<div class="up-meta-row"><i data-lucide="map-pin"></i><span>${escapeHtml(user.city)}</span><span class="up-meta-sub">Город</span></div>`);
  if (user.clan) meta.push(`<div class="up-meta-row"><i data-lucide="shield"></i><span>[${escapeHtml(user.clan.tag || '')}] ${escapeHtml(user.clan.name || '')}</span><span class="up-meta-sub">Клан</span></div>`);
  if (user.createdAt) meta.push(`<div class="up-meta-row"><i data-lucide="calendar-days"></i><span>На Runa с ${escapeHtml(fmtDay(user.createdAt))}</span></div>`);
  if (user.showBalance) meta.push(`<div class="up-meta-row"><i data-lucide="wallet"></i><span>${Number(user.mopsBalance || 0).toFixed(2)} мопсов</span><span class="up-meta-sub">Баланс</span></div>`);
  if (isSelf && user.phoneNumber) meta.push(`<div class="up-meta-row"><i data-lucide="phone"></i><span>${escapeHtml(user.phoneNumber)}</span><span class="up-meta-sub">Телефон</span></div>`);
  $('up-meta').innerHTML = meta.join('');

  const nftList = Array.isArray(user.nftUsernames) ? user.nftUsernames : [];
  $('up-nft').innerHTML = nftList.map(n => nftChipHtml(n)).join('') + anonChipHtml(user.anonymousNumber);

  $('up-actions').innerHTML = isSelf
    ? `<button class="mac-btn primary-purple" data-action="edit-self"><i data-lucide="pen-line"></i> Редактировать профиль</button>
       <button class="mac-btn up-icon-btn" data-action="copy-text" data-text="${escapeAttr(user.username || '')}" title="Скопировать username"><i data-lucide="copy"></i></button>`
    : `<button class="mac-btn primary-purple" data-action="dm-user" data-id="${escapeAttr(user.id)}"><i data-lucide="message-circle"></i> Написать</button>
       <button class="mac-btn up-icon-btn" data-action="copy-text" data-text="${escapeAttr(user.username || '')}" title="Скопировать username"><i data-lucide="copy"></i></button>`;

  const upWindow = modal.querySelector('.up-window');
  if (upWindow) upWindow.className = `up-window up-style-${user.profileStyle || 'telegram'}`;

  modal.style.display = 'flex';
  if (window.lucide) lucide.createIcons();
  if (window.onRunaUserProfileShown) window.onRunaUserProfileShown(user);
}

/* ================================================================== */
/*  НАСТРОЙКИ ГРУППЫ / КАНАЛА                                         */
/* ================================================================== */
function ruPlural(n, one, few, many) {
  const abs = Math.abs(Number(n) || 0) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function chatMemberCountText(data) {
  if (data.type === 'channel') return `${data.memberCount} ${ruPlural(data.memberCount, 'подписчик', 'подписчика', 'подписчиков')}`;
  return `${data.memberCount} ${ruPlural(data.memberCount, 'участник', 'участника', 'участников')}`;
}

function csMemberRow(m, data) {
  const isOwner = m.role === 'owner' || m.id === data.ownerId;
  const isMe = currentUser && m.id === currentUser.id;
  const roleLabel = isOwner ? 'владелец' : m.role === 'admin' ? 'админ' : '';
  const canModify = data.canManage && !isOwner && !isMe;
  const avatarHtml = m.avatar
    ? `<img src="${escapeAttr(m.avatar)}" alt="">`
    : escapeHtml(String(m.displayName || m.username || '?').charAt(0).toUpperCase());
  return `<div class="cs-member-row" data-member-name="${escapeAttr(String(m.displayName || '').toLowerCase())} ${escapeAttr(String(m.username || '').toLowerCase())}">
    <div class="cs-member-avatar ${m.avatar ? 'has-img' : ''}">${avatarHtml}${m.online ? '<span class="cs-online-dot"></span>' : ''}</div>
    <div class="cs-member-main">
      <span class="cs-member-name">${escapeHtml(m.displayName || m.username)}${isMe ? ' <em>(вы)</em>' : ''}</span>
      <span class="cs-member-handle">@${escapeHtml(m.username)}${roleLabel ? ` · ${roleLabel}` : ''}</span>
    </div>
    ${canModify ? `<div class="cs-member-actions">
      <button class="cs-mini-btn ${m.role === 'admin' ? 'active' : ''}" data-cs-action="toggle-admin" data-id="${escapeAttr(m.id)}" data-role="${m.role === 'admin' ? 'member' : 'admin'}" title="${m.role === 'admin' ? 'Снять админа' : 'Сделать админом'}"><i data-lucide="shield${m.role === 'admin' ? '-off' : ''}"></i></button>
      <button class="cs-mini-btn danger" data-cs-action="remove-member" data-id="${escapeAttr(m.id)}" title="Исключить"><i data-lucide="user-minus"></i></button>
    </div>` : ''}
  </div>`;
}

function renderChatSettings() {
  if (!chatSettings || !chatSettings.data) return;
  const d = chatSettings.data;
  const tab = chatSettings.tab || 'general';
  const isChannel = d.type === 'channel';
  const title = isChannel ? 'Настройки канала' : 'Настройки группы';
  $('cs-topbar-title').textContent = title;

  const avatarHtml = d.avatar
    ? `<img src="${escapeAttr(d.avatar)}" alt="">`
    : escapeHtml(String(d.title || '?').charAt(0).toUpperCase());
  const hero = `<div class="cs-hero">
    <button class="cs-hero-avatar ${d.avatar ? 'has-img' : ''}" data-cs-action="${d.canEditInfo ? 'change-avatar' : 'noop'}" title="${d.canEditInfo ? 'Сменить фото' : ''}">
      ${avatarHtml}
      ${d.canEditInfo ? '<span class="cs-avatar-edit"><i data-lucide="camera"></i></span>' : ''}
    </button>
    <h2 class="cs-hero-title">${escapeHtml(d.title)}</h2>
    <p class="cs-hero-sub">${isChannel ? 'Канал' : 'Группа'} · ${chatMemberCountText(d)}</p>
    ${d.username ? `<button class="cs-hero-handle" data-cs-action="copy-link">@${escapeHtml(d.username)} <i data-lucide="copy"></i></button>` : ''}
  </div>`;

  const quick = `<div class="cs-quick-grid">
    <button class="cs-quick ${d.muted ? 'active' : ''}" data-cs-action="mute">
      <i data-lucide="${d.muted ? 'bell-off' : 'bell'}"></i>
      <span>${d.muted ? 'Без звука' : 'Уведомления'}</span>
    </button>
    <button class="cs-quick ${d.pinned ? 'active' : ''}" data-cs-action="pin">
      <i data-lucide="pin"></i>
      <span>${d.pinned ? 'Открепить' : 'Закрепить'}</span>
    </button>
    <button class="cs-quick" data-cs-action="copy-invite">
      <i data-lucide="link"></i>
      <span>Ссылка</span>
    </button>
    <button class="cs-quick danger" data-cs-action="${d.canManage ? 'delete-chat' : 'leave-chat'}">
      <i data-lucide="${d.canManage ? 'trash-2' : 'log-out'}"></i>
      <span>${d.canManage ? 'Удалить' : 'Выйти'}</span>
    </button>
  </div>`;

  const tabs = `<div class="cs-tabs">
    <button class="cs-tab ${tab === 'general' ? 'active' : ''}" data-cs-tab="general">Общее</button>
    <button class="cs-tab ${tab === 'members' ? 'active' : ''}" data-cs-tab="members">Участники <span>${d.memberCount}</span></button>
    ${d.canEditInfo ? `<button class="cs-tab ${tab === 'permissions' ? 'active' : ''}" data-cs-tab="permissions">Права</button>` : ''}
    ${isChannel ? `<button class="cs-tab ${tab === 'giveaways' ? 'active' : ''}" data-cs-tab="giveaways">Розыгрыши</button>` : ''}
  </div>`;

  let content = '';
  if (tab === 'general') {
    const inviteBox = `<div class="cs-section">
      <div class="cs-section-title">Ссылка-приглашение</div>
      <div class="cs-invite-row">
        <input class="cs-input" id="cs-invite-input" readonly value="${escapeAttr(d.inviteLink)}">
        <button class="cs-square-btn" data-cs-action="copy-invite" title="Скопировать"><i data-lucide="copy"></i></button>
      </div>
      ${d.canManage ? `<button class="cs-text-btn" data-cs-action="reset-invite"><i data-lucide="refresh-cw"></i> Сбросить ссылку</button>` : ''}
    </div>`;

    if (d.canEditInfo) {
      content += `<div class="cs-section">
        <div class="cs-section-title">Основное</div>
        <label class="cs-label">Название</label>
        <input class="cs-input" id="cs-title" maxlength="80" value="${escapeAttr(d.title)}">
        <label class="cs-label">Описание</label>
        <textarea class="cs-input cs-textarea" id="cs-about" maxlength="300" placeholder="О чём этот ${isChannel ? 'канал' : 'чат'}?">${escapeHtml(d.about || '')}</textarea>
        <label class="cs-label">Публичная ссылка</label>
        <div class="cs-input-prefix"><span>@</span><input class="cs-input" id="cs-username" maxlength="32" placeholder="runa_chat" value="${escapeAttr(d.username || '')}"></div>
        <label class="cs-switch-row">
          <span><b>Публичный ${isChannel ? 'канал' : 'чат'}</b><small>Можно найти по ссылке @username</small></span>
          <input type="checkbox" class="mac-switch" id="cs-public" ${d.isPublic ? 'checked' : ''}>
        </label>
        <button class="cs-primary-btn" data-cs-action="save-general"><i data-lucide="check"></i> Сохранить</button>
      </div>`;
    } else {
      content += `<div class="cs-section">
        <div class="cs-section-title">Описание</div>
        <p class="cs-about-text">${d.about ? escapeHtml(d.about) : 'Описание пока не добавлено.'}</p>
        <div class="cs-info-row"><i data-lucide="users"></i><span>${chatMemberCountText(d)}</span></div>
        ${d.username ? `<div class="cs-info-row"><i data-lucide="at-sign"></i><span>@${escapeHtml(d.username)}</span></div>` : ''}
      </div>`;
    }
    content += inviteBox;

    content += `<div class="cs-section">
      <div class="cs-section-title">Уведомления</div>
      <label class="cs-switch-row">
        <span><b>${d.muted ? 'Включить уведомления' : 'Отключить уведомления'}</b><small>${d.muted ? 'Вы не получаете звуковые оповещения' : 'Звук и всплывающие уведомления включены'}</small></span>
        <input type="checkbox" class="mac-switch" id="cs-mute-switch" ${d.muted ? '' : 'checked'}>
      </label>
    </div>`;

    content += `<div class="cs-section cs-danger-section">
      <div class="cs-section-title">${d.canManage ? 'Удалить чат' : 'Покинуть чат'}</div>
      <p class="cs-danger-text">${d.canManage ? 'Чат и все сообщения будут удалены для всех участников.' : 'Вы больше не будете получать сообщения из этого чата.'}</p>
      <button class="cs-danger-btn" data-cs-action="${d.canManage ? 'delete-chat' : 'leave-chat'}">
        <i data-lucide="${d.canManage ? 'trash-2' : 'log-out'}"></i> ${d.canManage ? 'Удалить чат' : 'Покинуть чат'}
      </button>
    </div>`;
  }

  if (tab === 'members') {
    content += `<div class="cs-section">
      <div class="cs-members-toolbar">
        <input class="cs-input" id="cs-member-search" placeholder="Поиск участников">
        ${d.canAddMembers ? `<button class="cs-square-btn" data-cs-action="add-member" title="Добавить участника"><i data-lucide="user-plus"></i></button>` : ''}
      </div>
      ${chatSettings.addingMember ? `<div class="cs-add-member">
        <input class="cs-input" id="cs-add-member-input" placeholder="@username">
        <button class="cs-square-btn accent" data-cs-action="add-member-submit" title="Добавить"><i data-lucide="check"></i></button>
        <button class="cs-square-btn" data-cs-action="add-member-cancel" title="Отмена"><i data-lucide="x"></i></button>
      </div>` : ''}
      <div class="cs-member-list" id="cs-member-list">
        ${d.members.map(m => csMemberRow(m, d)).join('')}
      </div>
    </div>`;
  }

  if (tab === 'permissions') {
    const perm = d.permissions || {};
    content += `<div class="cs-section">
      <div class="cs-section-title">Права участников</div>
      <label class="cs-label">Кто может писать сообщения</label>
      <select class="cs-input" id="cs-perm-send" ${isChannel ? 'disabled' : ''}>
        <option value="all" ${perm.send_messages === 'all' ? 'selected' : ''}>Все участники</option>
        <option value="admins" ${perm.send_messages === 'admins' ? 'selected' : ''}>Только администраторы</option>
      </select>
      ${isChannel ? '<p class="cs-hint">В каналах писать могут только администраторы.</p>' : ''}
      <label class="cs-label">Кто может добавлять участников</label>
      <select class="cs-input" id="cs-perm-add">
        <option value="all" ${perm.add_members === 'all' ? 'selected' : ''}>Все участники</option>
        <option value="admins" ${perm.add_members === 'admins' ? 'selected' : ''}>Только администраторы</option>
      </select>
      <label class="cs-label">Кто может менять информацию</label>
      <select class="cs-input" id="cs-perm-edit">
        <option value="all" ${perm.edit_info === 'all' ? 'selected' : ''}>Все участники</option>
        <option value="admins" ${perm.edit_info === 'admins' ? 'selected' : ''}>Только администраторы</option>
      </select>
      <button class="cs-primary-btn" data-cs-action="save-permissions"><i data-lucide="check"></i> Сохранить права</button>
    </div>`;
  }

  if (tab === 'giveaways' && isChannel) {
    content += window.giveawaysTabHtml ? window.giveawaysTabHtml() : '';
  }

  $('cs-body').innerHTML = hero + quick + tabs + content;
  if (window.lucide) lucide.createIcons();
  if (tab === 'giveaways' && isChannel && window.bindGiveawaysTab) window.bindGiveawaysTab();
}

async function loadChatSettings(showLoading = true) {
  if (!currentChat) return;
  const body = $('cs-body');
  if (showLoading) body.innerHTML = '<div class="cs-loading"><span class="cs-spinner"></span>Загрузка...</div>';
  try {
    const data = await api(`/api/chats/${encodeURIComponent(currentChat.id)}/info`);
    chatSettings = { ...(chatSettings || {}), data, tab: (chatSettings && chatSettings.tab) || 'general' };
    if (currentChat && currentChat.id === data.id) {
      $('opened-chat-status').textContent = chatMemberCountText(data);
      setComposerEnabled(!!data.canSend, data.type);
    }
    renderChatSettings();
  } catch (err) {
    toast(err.message, 'error');
    if (showLoading) body.innerHTML = `<div class="cs-loading">${escapeHtml(err.message)}</div>`;
  }
}

async function openChatSettings() {
  if (!currentChat || currentChat.type === 'dm') return;
  chatSettings = { data: null, tab: 'general', addingMember: false };
  openAnimated($('modal-chat-settings'));
  document.body.classList.add('chat-settings-open');
  await loadChatSettings(true);
}

function closeChatSettings() {
  closeAnimated($('modal-chat-settings'));
  document.body.classList.remove('chat-settings-open');
  chatSettings = null;
}

function applyChatPatch(patch) {
  if (!currentChat || !patch) return;
  Object.assign(currentChat, patch);
  const row = chats.find(c => c.id === currentChat.id);
  if (row) Object.assign(row, patch);
  setChatTitle(currentChat);
  const av = chatAvatarData(currentChat);
  paintAvatar($('opened-chat-avatar'), av.avatar, av.name);
  renderChats();
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(String(value || ''));
    toast(message || 'Скопировано');
  } catch (e) {
    toast('Не удалось скопировать', 'error');
  }
}

async function saveChatGeneral() {
  if (!chatSettings || !chatSettings.data) return;
  const id = chatSettings.data.id;
  const body = {
    title: $('cs-title').value.trim(),
    about: $('cs-about').value.trim(),
    username: $('cs-username').value.trim(),
    isPublic: $('cs-public').checked
  };
  if (!body.title) return toast('Введите название', 'error');
  try {
    const res = await api(`/api/chats/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    Object.assign(chatSettings.data, res.chat);
    applyChatPatch(res.chat);
    toast('Настройки сохранены');
    renderChatSettings();
  } catch (err) { toast(err.message, 'error'); }
}

async function saveChatPermissions() {
  if (!chatSettings || !chatSettings.data) return;
  const id = chatSettings.data.id;
  const permissions = {
    send_messages: $('cs-perm-send').value,
    add_members: $('cs-perm-add').value,
    edit_info: $('cs-perm-edit').value
  };
  try {
    const res = await api(`/api/chats/${encodeURIComponent(id)}`, { method: 'PATCH', body: { permissions } });
    Object.assign(chatSettings.data, res.chat);
    applyChatPatch(res.chat);
    toast('Права обновлены');
    renderChatSettings();
  } catch (err) { toast(err.message, 'error'); }
}

async function removeChatFromClient(chatId) {
  chats = chats.filter(c => c.id !== chatId);
  if (currentChat && currentChat.id === chatId) {
    localStorage.removeItem(LAST_CHAT_KEY);
    closeChatView(false);
    if (history.state && history.state.runaChat) history.replaceState(null, '', location.href);
  }
  renderChats();
}

async function leaveCurrentChat() {
  if (!chatSettings || !chatSettings.data) return;
  const d = chatSettings.data;
  if (!confirm(d.canManage ? 'Удалить чат для всех участников?' : 'Покинуть этот чат?')) return;
  try {
    await api(`/api/chats/${encodeURIComponent(d.id)}/members/${encodeURIComponent(currentUser.id)}`, { method: 'DELETE' });
    await removeChatFromClient(d.id);
    closeChatSettings();
    toast(d.canManage ? 'Чат удалён' : 'Вы покинули чат');
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteCurrentChat() {
  if (!chatSettings || !chatSettings.data) return;
  const d = chatSettings.data;
  if (!confirm('Удалить чат и все сообщения? Это действие необратимо.')) return;
  try {
    await api(`/api/chats/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
    await removeChatFromClient(d.id);
    closeChatSettings();
    toast('Чат удалён');
  } catch (err) { toast(err.message, 'error'); }
}

function setupChatSettings() {
  const body = $('cs-body');
  if (!body) return;

  $('cs-refresh').addEventListener('click', () => loadChatSettings(true));

  $('cs-avatar-input').addEventListener('change', async () => {
    const file = $('cs-avatar-input').files[0];
    if (!file || !chatSettings || !chatSettings.data) return;
    try {
      const fd = new FormData();
      fd.append('avatar', file);
      toast('Загрузка фото...');
      const res = await api(`/api/chats/${encodeURIComponent(chatSettings.data.id)}/avatar`, { method: 'POST', body: fd });
      chatSettings.data.avatar = res.avatar;
      applyChatPatch({ avatar: res.avatar });
      toast('Фото обновлено');
      renderChatSettings();
    } catch (err) { toast(err.message, 'error'); }
    finally { $('cs-avatar-input').value = ''; }
  });

  body.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-cs-tab]');
    if (tabBtn) {
      if (!chatSettings) return;
      chatSettings.tab = tabBtn.dataset.csTab;
      chatSettings.addingMember = false;
      renderChatSettings();
      return;
    }
    const btn = e.target.closest('[data-cs-action]');
    if (!btn || !chatSettings || !chatSettings.data) return;
    const action = btn.dataset.csAction;
    const d = chatSettings.data;

    if (action === 'noop') return;
    if (action === 'change-avatar') { $('cs-avatar-input').click(); return; }
    if (action === 'copy-link' && d.username) { copyText('@' + d.username, 'Ссылка скопирована'); return; }
    if (action === 'copy-invite') { copyText(d.inviteLink, 'Ссылка-приглашение скопирована'); return; }
    if (action === 'save-general') { saveChatGeneral(); return; }
    if (action === 'save-permissions') { saveChatPermissions(); return; }
    if (action === 'mute') {
      try {
        const res = await api(`/api/chats/${encodeURIComponent(d.id)}/mute`, { method: 'POST', body: { muted: !d.muted } });
        d.muted = res.muted;
        applyChatPatch({ muted: res.muted });
        renderChatSettings();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (action === 'pin') {
      try {
        await api(`/api/chats/${encodeURIComponent(d.id)}`, { method: 'PATCH', body: { pinned: !d.pinned } });
        d.pinned = !d.pinned;
        applyChatPatch({ pinned: d.pinned });
        renderChatSettings();
        toast(d.pinned ? 'Чат закреплён' : 'Чат откреплён');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (action === 'reset-invite') {
      if (!confirm('Сбросить ссылку? Старая ссылка перестанет работать.')) return;
      try {
        const res = await api(`/api/chats/${encodeURIComponent(d.id)}/invite/reset`, { method: 'POST' });
        d.inviteCode = res.inviteCode;
        d.inviteLink = res.inviteLink;
        renderChatSettings();
        toast('Новая ссылка создана');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (action === 'add-member') { chatSettings.addingMember = true; renderChatSettings(); setTimeout(() => { const i = $('cs-add-member-input'); if (i) i.focus(); }, 30); return; }
    if (action === 'add-member-cancel') { chatSettings.addingMember = false; renderChatSettings(); return; }
    if (action === 'add-member-submit') {
      const input = $('cs-add-member-input');
      const username = (input ? input.value : '').trim().replace(/^@/, '');
      if (!username) return toast('Введите @username', 'error');
      try {
        await api(`/api/chats/${encodeURIComponent(d.id)}/members`, { method: 'POST', body: { username } });
        chatSettings.addingMember = false;
        toast('Участник добавлен');
        await loadChatSettings(false);
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (action === 'toggle-admin') {
      try {
        await api(`/api/chats/${encodeURIComponent(d.id)}/members/${encodeURIComponent(btn.dataset.id)}`, {
          method: 'PATCH', body: { role: btn.dataset.role }
        });
        await loadChatSettings(false);
        toast('Роль обновлена');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (action === 'remove-member') {
      const member = d.members.find(m => m.id === btn.dataset.id);
      if (!confirm(`Исключить ${member ? member.displayName : 'участника'}?`)) return;
      try {
        await api(`/api/chats/${encodeURIComponent(d.id)}/members/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
        await loadChatSettings(false);
        toast('Участник исключён');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (action === 'delete-chat') { deleteCurrentChat(); return; }
    if (action === 'leave-chat') { leaveCurrentChat(); return; }
  });

  body.addEventListener('input', (e) => {
    if (e.target.id === 'cs-member-search') {
      const q = e.target.value.trim().toLowerCase();
      body.querySelectorAll('.cs-member-row').forEach(row => {
        row.style.display = !q || (row.dataset.memberName || '').includes(q) ? '' : 'none';
      });
    }
    if (e.target.id === 'cs-mute-switch' && chatSettings && chatSettings.data) {
      const muted = !e.target.checked;
      api(`/api/chats/${encodeURIComponent(chatSettings.data.id)}/mute`, { method: 'POST', body: { muted } })
        .then(res => {
          chatSettings.data.muted = res.muted;
          applyChatPatch({ muted: res.muted });
        }).catch(err => toast(err.message, 'error'));
    }
  });

  body.addEventListener('keydown', (e) => {
    if (e.target.id === 'cs-add-member-input' && e.key === 'Enter') {
      e.preventDefault();
      const btn = body.querySelector('[data-cs-action="add-member-submit"]');
      if (btn) btn.click();
    }
  });
}

function setupUserProfile() {
  const copy = $('up-copy');
  if (!copy) return;
  copy.addEventListener('click', () => {
    const text = ($('up-username').textContent || '').replace(/^@/, '').trim();
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(() => toast('Username скопирован'))
      .catch(() => toast('Не удалось скопировать', 'error'));
  });
}

function setupLightbox() {
  const box = $('image-lightbox');
  if (!box) return;
  box.addEventListener('click', () => { box.style.display = 'none'; $('lightbox-img').src = ''; });
}

/* ================================================================== */
/*  КОМПОЗЕР                                                          */
/* ================================================================== */
function setupWorkspace() {
  const composer = $('composer-textarea');
  const sendBtn = $('btn-send');
  const attachBtn = $('btn-attach');
  const fileInput = $('media-file-input');
  if (!composer) return;

  const send = () => {
    const text = composer.value.trim();
    if (!text || !currentChat || !socket || composer.disabled) return;
    socket.emit('send_message', {
      chatId: currentChat.id,
      text,
      replyTo: replyTarget ? replyTarget.id : null
    });
    sendBtn.classList.remove('sending');
    void sendBtn.offsetWidth;
    sendBtn.classList.add('sending');
    composer.value = '';
    composer.style.height = 'auto';
    socket.emit('stop_typing', { chatId: currentChat.id });
    clearReplyBar();
    composer.focus();
  };

  sendBtn.addEventListener('click', send);
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('reply-bar-close').addEventListener('click', clearReplyBar);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && replyTarget) clearReplyBar();
  });
  composer.addEventListener('input', () => {
    composer.style.height = 'auto';
    composer.style.height = Math.min(composer.scrollHeight, 140) + 'px';
    if (!currentChat || !socket) return;
    const now = Date.now();
    if (now - lastTypingSent > 1200) {
      lastTypingSent = now;
      socket.emit('typing', { chatId: currentChat.id });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      lastTypingSent = 0;
      socket.emit('stop_typing', { chatId: currentChat.id });
    }, 1500);
  });

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file || !currentChat) return;
    try {
      const fd = new FormData();
      fd.append('file', file);
      toast('Загрузка файла...');
      const data = await api('/api/upload', { method: 'POST', body: fd });
      socket.emit('send_message', {
        chatId: currentChat.id, text: '', fileUrl: data.url, fileName: data.name, fileType: data.type,
        replyTo: replyTarget ? replyTarget.id : null
      });
      clearReplyBar();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      fileInput.value = '';
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    logoutLocal();
  });

  $('chats-search-input').addEventListener('input', (e) => {
    const value = e.target.value;
    clearTimeout(chatSearchTimer);
    chatSearchTimer = setTimeout(() => {
      searchQuery = value;
      renderChats();
    }, 110);
  });
  $('chats-search-input').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim();
    if (q.length < 2) return;
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
      const html = renderSearchResults(data);
      openList(`Поиск: ${q}`, html);
    } catch (err) { toast(err.message, 'error'); }
  });

  const setFilter = (filter) => {
    chatFilter = chatFilter === filter ? 'all' : filter;
    ['saved', 'groups', 'channels'].forEach(f => {
      const btn = $(`btn-filter-${f}`);
      if (btn) btn.classList.toggle('active', chatFilter === f);
    });
    renderChats();
  };
  $('btn-filter-saved').addEventListener('click', () => setFilter('saved'));
  $('btn-filter-groups').addEventListener('click', () => setFilter('groups'));
  $('btn-filter-channels').addEventListener('click', () => setFilter('channels'));

  $('btn-chat-back').addEventListener('click', () => {
    if (history.state && history.state.runaChat) history.back();
    else closeChatView();
  });

  $('btn-chat-info').addEventListener('click', () => {
    if (!currentChat) return;
    if (currentChat.type === 'dm' && currentChat.otherUser) {
      openUserProfile(currentChat.otherUser.id);
      return;
    }
    openChatInfoSheet();
  });

  $('chat-messages-stream').addEventListener('scroll', () => {
    if ($('chat-messages-stream').scrollTop < 70) loadOlderMessages();
  }, { passive: true });

  $('chat-messages-stream').addEventListener('click', (e) => {
    const reactBtn = e.target.closest('.msg-react');
    if (reactBtn) {
      const bubble = reactBtn.closest('.bubble');
      if (bubble) openReactionPicker(bubble.dataset.id, reactBtn);
      return;
    }

    const chip = e.target.closest('.reaction-chip');
    if (chip) {
      const wrap = chip.closest('.msg-reactions');
      if (wrap && socket) socket.emit('toggle_reaction', { messageId: wrap.dataset.messageId, emoji: chip.dataset.emoji });
      return;
    }

    const replyBtn = e.target.closest('.msg-reply');
    if (replyBtn) {
      const bubble = replyBtn.closest('.bubble');
      const msg = bubble && messageCache.get(bubble.dataset.id);
      if (msg) startReply(msg);
      return;
    }

    const delBtn = e.target.closest('.msg-del');
    if (delBtn) {
      const bubble = delBtn.closest('.bubble');
      if (bubble && confirm('Удалить сообщение?')) socket.emit('delete_message', { messageId: bubble.dataset.id });
      return;
    }

    const img = e.target.closest('.msg-image');
    if (img) {
      $('lightbox-img').src = img.src;
      $('image-lightbox').style.display = 'flex';
      return;
    }

    const quote = e.target.closest('.msg-reply-quote');
    if (quote) {
      const original = document.querySelector(`.bubble[data-id="${quote.dataset.replyId}"]`);
      if (!original) return;
      const rowEl = original.closest('.msg-row') || original;
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      rowEl.classList.add('msg-highlight');
      setTimeout(() => rowEl.classList.remove('msg-highlight'), 1200);
      return;
    }

    const target = e.target.closest('.msg-avatar, .msg-author');
    if (target && target.dataset.userId) openUserProfile(target.dataset.userId);
  });

  const openHeaderProfile = () => {
    if (!currentChat) return;
    if (currentChat.type === 'dm' && currentChat.otherUser) openUserProfile(currentChat.otherUser.id);
    else $('btn-chat-info').click();
  };
  $('opened-chat-avatar').addEventListener('click', openHeaderProfile);
  $('opened-chat-title').addEventListener('click', openHeaderProfile);
}

/* ================================================================== */
/*  ИНФОРМАЦИЯ О ЧАТЕ                                                  */
/* ================================================================== */
let chatInfoGifts = [];

function ciRow(label, value, copyValue = '') {
  return `<button type="button" class="ci-row" ${copyValue ? `data-ci-copy="${escapeAttr(copyValue)}"` : 'disabled'}>
    <span class="ci-row-main"><b>${escapeHtml(value)}</b><small>${escapeHtml(label)}</small></span>
    ${copyValue ? '<i data-lucide="copy" class="ci-row-copy"></i>' : ''}
  </button>`;
}

function paintChatInfo(info) {
  const title = info.title || 'Без названия';
  const username = info.username || '';
  const members = Number(info.memberCount || 0);
  const handle = username ? `@${username}` : (info.type === 'channel' ? 'Публичный канал' : 'Приватная группа');
  const av = chatAvatarData(info);
  const avatarHtml = av.avatar
    ? `<img src="${escapeAttr(av.avatar)}" alt="">`
    : escapeHtml(av.name.charAt(0).toUpperCase());

  const emblem = $('ci-emblem');
  if (emblem) emblem.innerHTML = `<div class="ci-avatar">${avatarHtml}</div>`;

  const banner = $('ci-banner');
  if (banner) {
    banner.style.setProperty('--ci-banner-img', av.avatar ? `url("${av.avatar}")` : 'none');
    banner.classList.toggle('has-image', !!av.avatar);
  }

  const handleEl = $('ci-handle');
  if (handleEl) handleEl.textContent = handle;
  const titleEl = $('ci-title');
  if (titleEl) titleEl.innerHTML = `${escapeHtml(title)}${chatBadgeHtml(info)}`;
  const membersEl = $('ci-members');
  if (membersEl) membersEl.textContent = `${members.toLocaleString('ru-RU')} ${members === 1 ? 'участник' : members > 1 && members < 5 ? 'участника' : 'участников'}`;

  const owner = (info.members || []).find(m => m.role === 'owner' || m.id === info.ownerId) || null;
  const ownerName = owner ? `@${owner.username}` : '';
  const rows = [];
  if (username) rows.push(ciRow('Имя пользователя', `@${username}`, `@${username}`));
  if (info.about) rows.push(ciRow('Описание', info.about));
  else rows.push(ciRow('Описание', 'Правила в закрепе'));
  if (ownerName) rows.push(ciRow('Владелец', ownerName, ownerName));
  rows.push(ciRow('Идентификатор', info.id, info.id));
  const rowsEl = $('ci-rows');
  if (rowsEl) rowsEl.innerHTML = rows.join('');

  if (window.lucide) lucide.createIcons();
}

async function loadChatInfoGifts() {
  const box = $('ci-gifts');
  if (!box) return;
  box.innerHTML = '<div class="ci-gifts-loading"><span class="gifts-spinner"></span></div>';
  try {
    const items = await api('/api/gifts');
    chatInfoGifts = items || [];
    if (!chatInfoGifts.length) {
      box.innerHTML = '<p class="ci-gifts-empty">В маркете пока нет подарков</p>';
      return;
    }
    box.innerHTML = chatInfoGifts.slice(0, 6).map((g, i) => `
      <button type="button" class="ci-gift-card" data-ci-gift-id="${escapeAttr(g.id)}" style="--gift-i:${i}">
        <span class="ci-gift-tag">${g.rarity === 'legendary' ? 'ЛЕГЕНДА' : '2026'}</span>
        <span class="ci-gift-media">${giftMediaHtml(g)}</span>
        <span class="ci-gift-name">${escapeHtml(g.title)}</span>
      </button>`).join('');
    mountGiftAnimations(box);
  } catch (err) {
    box.innerHTML = '<p class="ci-gifts-empty">Не удалось загрузить подарки</p>';
  }
}

async function openChatInfoSheet() {
  if (!currentChat) return;
  const modal = $('modal-chat-info');
  if (!modal) return;
  paintChatInfo(currentChat);
  openAnimated(modal);
  loadChatInfoGifts();
  try {
    const info = await api(`/api/chats/${currentChat.id}/info`);
    if (!modal.classList.contains('is-closing')) paintChatInfo({ ...currentChat, ...info });
  } catch (err) { /* показываем данные из списка чатов */ }
}

function setupChatInfo() {
  const modal = $('modal-chat-info');
  if (!modal) return;
  modal.addEventListener('click', async (e) => {
    if (e.target === modal) { closeAnimated(modal); return; }
    const copy = e.target.closest('[data-ci-copy]');
    if (copy) { copyText(copy.dataset.ciCopy, 'Скопировано'); return; }
    const giftCard = e.target.closest('[data-ci-gift-id]');
    if (giftCard) {
      const gift = chatInfoGifts.find(g => g.id === giftCard.dataset.ciGiftId);
      if (gift) openGiftSend(gift);
      return;
    }
    const action = e.target.closest('[data-ci-action]');
    if (!action) return;
    const kind = action.dataset.ciAction;
    if (kind === 'open') closeAnimated(modal);
    else if (kind === 'more') { closeAnimated(modal); openChatSettings(); }
    else if (kind === 'gift' || kind === 'all-gifts') { closeAnimated(modal); openGifts('catalog'); }
  });
}

/* ================================================================== */
/*  ПОДСКАЗКА К ЗНАЧКАМ                                               */
/* ================================================================== */
function badgeDescription(title) {
  const t = String(title || '').toLowerCase();
  if (t.includes('halloween') || t.includes('хэллоуин')) return 'Страшные времена Runa настигли…';
  if (t.includes('verified') || t.includes('подтверж')) return 'Подтверждённый аккаунт Runa.';
  if (t.includes('level') || t.includes('уровень')) return 'Достижение за активность в Runa.';
  if (t.includes('premium')) return 'Эксклюзивный значок подписчика Premium.';
  return 'Особый значок коллекции Runa.';
}

function hideBadgeTip() {
  document.querySelectorAll('.badge-tooltip').forEach(el => el.remove());
}

function showBadgeTip(anchor, badge) {
  hideBadgeTip();
  const tip = document.createElement('div');
  tip.className = 'badge-tooltip';
  const icon = badge.icon && /^[a-z0-9-]+$/i.test(badge.icon)
    ? `<i data-lucide="${escapeAttr(badge.icon)}"></i>`
    : escapeHtml(badge.icon || '⭐');
  tip.innerHTML = `
    <div class="bt-emoji" style="background:${escapeAttr(badge.color || '#24242c')}">${icon}</div>
    <div class="bt-body">
      <div class="bt-line"><span>Значок:</span> <b>${escapeHtml(badge.title || 'Значок Runa')}</b></div>
      <div class="bt-desc"><span>Описание:</span> ${escapeHtml(badgeDescription(badge.title))}</div>
      <div class="bt-exclusive">Эксклюзивный значок</div>
      <div class="bt-date">Дата выпуска: <b>2026</b></div>
    </div>`;
  document.body.appendChild(tip);
  if (window.lucide) lucide.createIcons();
  const r = anchor.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let left = Math.min(Math.max(10, r.left), window.innerWidth - tr.width - 10);
  let top = r.bottom + 10;
  if (top + tr.height > window.innerHeight - 10) top = Math.max(10, r.top - tr.height - 10);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function setupBadgeTooltips() {
  document.addEventListener('click', (e) => {
    const target = e.target.closest('.badge-tip-target');
    if (target) {
      e.preventDefault();
      e.stopPropagation();
      showBadgeTip(target, {
        icon: target.dataset.badgeIcon,
        title: target.dataset.badgeTitle,
        color: target.dataset.badgeColor
      });
      return;
    }
    if (!e.target.closest('.badge-tooltip')) hideBadgeTip();
  });
  document.addEventListener('pointerover', (e) => {
    const target = e.target.closest('.badge-tip-target');
    if (target) showBadgeTip(target, {
      icon: target.dataset.badgeIcon,
      title: target.dataset.badgeTitle,
      color: target.dataset.badgeColor
    });
  });
  document.addEventListener('pointerout', (e) => {
    const target = e.target.closest('.badge-tip-target');
    if (target && !e.relatedTarget?.closest?.('.badge-tooltip')) hideBadgeTip();
  });
  window.addEventListener('scroll', hideBadgeTip, true);
}

/* ================================================================== */
/*  МОДАЛЬНЫЕ ОКНА                                                    */
/* ================================================================== */
function setupModalNavigation() {
  const drawerOverlay = $('drawer-overlay');
  $$('.drawer-nav-item').forEach((el, i) => el.style.setProperty('--nav-i', i));
  $('toggle-drawer-btn').addEventListener('click', () => openAnimated(drawerOverlay, 'block'));
  drawerOverlay.addEventListener('click', (e) => { if (e.target === drawerOverlay) closeAnimated(drawerOverlay, 220); });

  $$('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = $(btn.dataset.close);
      if (target) closeAnimated(target);
    });
  });

  $$('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && backdrop.id !== 'modal-profile-card') closeAnimated(backdrop);
    });
  });

  window.addEventListener('popstate', () => {
    if ($('chat-opened').style.display !== 'none' && isMobileView()) closeChatView();
  });

  const profileCard = $('modal-profile-card');
  const openProf = () => {
    closeAnimated(drawerOverlay, 220);
    openAnimated(profileCard);
    if (window.loadSelfProfileSocial) window.loadSelfProfileSocial();
  };
  $('drawer-user-card-btn').addEventListener('click', openProf);
  $('topbar-user-badge').addEventListener('click', openProf);

  const editModal = $('modal-edit-profile');
  $('btn-edit-profile-open').addEventListener('click', () => {
    profileCard.style.display = 'none';
    editModal.style.display = 'flex';
  });
  $('btn-edit-profile-back').addEventListener('click', () => {
    editModal.style.display = 'none';
    profileCard.style.display = 'flex';
  });

  const usernameInput = $('edit-username-val');
  let usernameCheckTimer = null;
  if (usernameInput) {
    usernameInput.addEventListener('input', () => {
      const value = usernameInput.value.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '').slice(0, 32);
      if (usernameInput.value !== value) usernameInput.value = value;
      const status = $('edit-username-status');
      const hint = $('edit-username-hint');
      clearTimeout(usernameCheckTimer);
      if (!currentUser) return;
      if (value === currentUser.username) {
        if (status) { status.textContent = ''; status.className = 'username-status'; }
        if (hint) { hint.textContent = 'Это ваш текущий юзернейм'; hint.className = 'field-hint'; }
        return;
      }
      if (!/^[a-z0-9_]{3,32}$/.test(value)) {
        if (status) { status.textContent = '✕'; status.className = 'username-status bad'; }
        if (hint) { hint.textContent = '3–32 символа: латиница, цифры и _'; hint.className = 'field-hint bad'; }
        return;
      }
      if (status) { status.textContent = '…'; status.className = 'username-status checking'; }
      if (hint) { hint.textContent = 'Проверяем доступность…'; hint.className = 'field-hint'; }
      usernameCheckTimer = setTimeout(async () => {
        try {
          const res = await api(`/api/username/check?username=${encodeURIComponent(value)}`);
          if (usernameInput.value !== value) return;
          if (status) { status.textContent = res.available ? '✓' : '✕'; status.className = `username-status ${res.available ? 'ok' : 'bad'}`; }
          if (hint) {
            hint.textContent = res.available ? 'Свободен — можно сохранить' : (res.reason || 'Занят');
            hint.className = `field-hint ${res.available ? 'ok' : 'bad'}`;
          }
        } catch (err) {
          if (status) { status.textContent = ''; status.className = 'username-status'; }
        }
      }, 320);
    });
  }

  $('btn-save-profile').addEventListener('click', async () => {
    try {
      const nextUsername = usernameInput ? usernameInput.value.trim().toLowerCase().replace(/^@/, '') : '';
      const body = {
        display_name: $('edit-name-val').value.trim(),
        bio: $('edit-bio-val').value.trim(),
        city: $('edit-city-val').value.trim()
      };
      const usernameChanged = !!(currentUser && nextUsername && nextUsername !== currentUser.username);
      if (usernameChanged) body.username = nextUsername;

      currentUser = await api('/api/user/update', { method: 'POST', body });
      updateUserUI();
      editModal.style.display = 'none';
      profileCard.style.display = 'flex';
      toast(usernameChanged ? 'Профиль и юзернейм сохранены' : 'Профиль сохранён', 'message');
    } catch (err) {
      toast(err.message, 'error');
      const hint = $('edit-username-hint');
      if (hint) { hint.textContent = err.message; hint.className = 'field-hint bad'; }
    }
  });

  $('btn-avatar-upload').addEventListener('click', () => $('avatar-file-input').click());
  $('avatar-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('avatar', file);
      currentUser = await api('/api/user/avatar', { method: 'POST', body: fd });
      updateUserUI();
      toast('Аватар обновлён');
    } catch (err) { toast(err.message, 'error'); }
    e.target.value = '';
  });

  const copy = document.querySelector('.copy-handle');
  if (copy) copy.addEventListener('click', () => {
    navigator.clipboard.writeText(`@${currentUser.username}`).then(() => toast('Юзернейм скопирован'));
  });

  $('card-balance-pill').addEventListener('click', () => {
    profileCard.style.display = 'none';
    $('modal-wallet').style.display = 'flex';
    loadTransactions();
  });

  function openCustomizationTab(tab) {
    $$('.custom-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.custom-view-panel').forEach(p => { p.style.display = p.id === tab ? 'block' : 'none'; });
    openAnimated($('modal-customization'));
  }

  $('btn-open-customization').addEventListener('click', () => {
    closeAnimated(editModal);
    openCustomizationTab('tab-avatar');
  });

  const manageNfts = $('card-nfts-manage');
  if (manageNfts) manageNfts.addEventListener('click', () => {
    closeAnimated(profileCard);
    openCustomizationTab('tab-nfts');
  });

  $$('.custom-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.custom-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.custom-view-panel').forEach(p => p.style.display = 'none');
      const target = $(btn.dataset.tab);
      if (target) target.style.display = 'block';
      if (window.innerWidth <= 820) {
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        btn.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduce ? 'auto' : 'smooth' });
        const settings = document.querySelector('.custom-center-settings');
        if (settings) settings.scrollTop = 0;
      }
    });
  });

  $$('.style-choice-item').forEach(item => {
    item.addEventListener('click', async () => {
      try {
        currentUser = await api('/api/user/update', { method: 'POST', body: { profile_style: item.dataset.style } });
        updateUserUI();
        $$('.style-choice-item').forEach(el => el.classList.toggle('active', el === item));
        toast('Вид профиля обновлён');
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  $('btn-custom-avatar-upload').addEventListener('click', () => $('avatar-file-input').click());
  $('btn-custom-avatar-remove').addEventListener('click', async () => {
    try {
      currentUser = await api('/api/user/update', { method: 'POST', body: { avatar: '' } });
      updateUserUI();
      toast('Аватар удалён');
    } catch (err) { toast(err.message, 'error'); }
  });

  $('btn-banner-upload').addEventListener('click', () => $('banner-file-input').click());
  $('banner-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const uploaded = await api('/api/upload', { method: 'POST', body: fd });
      currentUser = await api('/api/user/update', { method: 'POST', body: { banner: uploaded.url } });
      updateUserUI();
      toast('Баннер обновлён');
    } catch (err) { toast(err.message, 'error'); }
    e.target.value = '';
  });
  $('btn-banner-remove').addEventListener('click', async () => {
    try {
      currentUser = await api('/api/user/update', { method: 'POST', body: { banner: '' } });
      updateUserUI();
      toast('Баннер удалён');
    } catch (err) { toast(err.message, 'error'); }
  });

  $$('#frame-choices .swatch').forEach(btn => btn.addEventListener('click', async () => {
    try {
      currentUser = await api('/api/user/update', { method: 'POST', body: { avatar_frame: btn.dataset.frame || '' } });
      updateUserUI();
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('#bg-choices .swatch').forEach(btn => btn.addEventListener('click', async () => {
    try {
      currentUser = await api('/api/user/update', { method: 'POST', body: { profile_bg: btn.dataset.bg || '' } });
      updateUserUI();
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('#nick-choices .swatch').forEach(btn => btn.addEventListener('click', async () => {
    try {
      currentUser = await api('/api/user/update', { method: 'POST', body: { username_color: btn.dataset.color || '' } });
      updateUserUI();
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('#accent-choices .swatch').forEach(btn => btn.addEventListener('click', async () => {
    try {
      currentUser = await api('/api/user/update', { method: 'POST', body: { accent_color: btn.dataset.accent || '' } });
      updateUserUI();
    } catch (err) { toast(err.message, 'error'); }
  }));

  $('wallet-show-toggle').addEventListener('change', async (e) => {
    try {
      currentUser = await api('/api/user/update', { method: 'POST', body: { show_balance: e.target.checked } });
      updateUserUI();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function openList(title, html) {
  $('list-modal-title').textContent = title;
  $('list-modal-body').innerHTML = html;
  openAnimated($('modal-list'));
  if (window.lucide) lucide.createIcons();
}
function closeListModal() { closeAnimated($('modal-list')); }

/* ================================================================== */
/*  НАВИГАЦИЯ                                                         */
/* ================================================================== */
function setupNavigation() {
  const drawer = $('drawer-overlay');
  const closeDrawer = () => closeAnimated(drawer, 220);

  $('nav-feed').addEventListener('click', () => { closeDrawer(); chatFilter = 'channels'; renderChats(); });
  $('nav-chats').addEventListener('click', () => { closeDrawer(); chatFilter = 'all'; renderChats(); $('chats-search-input').focus(); });

  $('nav-notifications').addEventListener('click', () => {
    closeDrawer();
    const unread = chats.filter(c => c.unread > 0);
    const html = unread.length ? unread.map(c => `
      <button class="list-row" data-action="open-chat" data-id="${c.id}">
        <div class="list-avatar">${chatAvatarData(c).avatar ? `<img src="${escapeAttr(chatAvatarData(c).avatar)}">` : escapeHtml(chatName(c).charAt(0))}</div>
        <div class="list-row-main"><span>${escapeHtml(chatName(c))}</span><small>${c.unread} новых</small></div>
      </button>`).join('') : '<p class="empty-feed">Непрочитанных сообщений нет</p>';
    openList('Уведомления', html);
  });

  $('nav-saved').addEventListener('click', () => { closeDrawer(); openSavedMessages(); });
  $('nav-gifts').addEventListener('click', () => { closeDrawer(); openGifts('catalog'); });
  $('nav-store').addEventListener('click', () => { closeDrawer(); openStore(); });
  $('nav-market').addEventListener('click', () => { closeDrawer(); openNftMarket(); });
  $('nav-clans').addEventListener('click', () => {
    closeDrawer();
    $('modal-clans').style.display = 'flex';
    loadClansIntoClanModal();
  });
  $('nav-premium').addEventListener('click', () => { closeDrawer(); openPremium(); });
  $('nav-rubies').addEventListener('click', () => {
    closeDrawer();
    $('modal-rubies').style.display = 'flex';
    updateUserUI();
    loadTransactions();
  });
  $('nav-wallet').addEventListener('click', () => {
    closeDrawer();
    $('modal-wallet').style.display = 'flex';
    loadTransactions();
  });
  $('nav-accounts').addEventListener('click', () => { closeDrawer(); openNewChat(); });
  $('nav-settings').addEventListener('click', () => { closeDrawer(); openSettings('privacy'); });
  $('nav-admin').addEventListener('click', () => { location.href = '/admin.html'; });

  $('btn-new-chat').addEventListener('click', openNewChat);

  $('btn-replenish-rubies').addEventListener('click', async () => {
    try {
      const data = await api('/api/wallet/daily', { method: 'POST' });
      currentUser = data.user;
      updateUserUI();
      toast('Ежедневный бонус: +100 💎');
    } catch (err) { toast(err.message, 'error'); }
  });

  const walletPills = $$('#modal-wallet .wallet-action-pills .action-pill');
  if (walletPills[0]) walletPills[0].addEventListener('click', async () => {
    const value = prompt('Сколько рубинов обменять? (10 💎 = 1 MOPS)');
    if (!value) return;
    try {
      const data = await api('/api/wallet/exchange', { method: 'POST', body: { rubies: Number(value) } });
      currentUser = data.user;
      updateUserUI();
      loadTransactions();
      toast(`Обменяно: +${data.mops} MOPS`);
    } catch (err) { toast(err.message, 'error'); }
  });
  if (walletPills[1]) walletPills[1].addEventListener('click', async () => {
    const username = prompt('Кому отправить рубины? Введите @username');
    if (!username) return;
    const amount = prompt('Сколько рубинов отправить?');
    if (!amount) return;
    try {
      const data = await api('/api/wallet/send', { method: 'POST', body: { username, amount: Number(amount) } });
      currentUser = data.user;
      updateUserUI();
      loadTransactions();
      toast('Перевод отправлен');
    } catch (err) { toast(err.message, 'error'); }
  });

  const rubyShop = $$('#modal-rubies .rubies-actions-row .ruby-btn');
  if (rubyShop[1]) rubyShop[1].addEventListener('click', openStore);
  if (rubyShop[2]) rubyShop[2].addEventListener('click', openNftMarket);

  $('btn-clan-buy').addEventListener('click', async () => {
    const name = prompt('Введите название клана:');
    if (!name) return;
    const tag = prompt('Введите тег клана (до 4 символов):');
    if (!tag) return;
    try {
      await api('/api/clans/create', { method: 'POST', body: { name, tag } });
      currentUser = await api('/api/auth/me');
      updateUserUI();
      toast(`Клан [${tag.toUpperCase()}] ${name} создан!`);
      loadClansIntoClanModal();
    } catch (err) { toast(err.message, 'error'); }
  });

  $$('#modal-clans .clan-action-row').forEach(btn => btn.addEventListener('click', openClansList));

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) handleListAction({ target: btn });
  });
}

async function handleListAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  try {
    if (action === 'open-chat') openChatById(id);
    if (action === 'dm-user') {
      const data = await api('/api/chats', { method: 'POST', body: { type: 'dm', userId: id } });
      const list = await api('/api/chats');
      chats = list;
      renderChats();
      closeListModal();
      $('modal-new-chat').style.display = 'none';
      $('modal-user-profile').style.display = 'none';
      openChatById(data.id);
    }
    if (action === 'open-user') {
      const user = await api(`/api/users/${id}`);
      closeListModal();
      showUserProfile(user);
    }
    if (action === 'edit-self') {
      $('modal-user-profile').style.display = 'none';
      $('modal-edit-profile').style.display = 'flex';
    }
    if (action === 'pin-chat') {
      const chat = chats.find(c => c.id === id);
      await api(`/api/chats/${id}`, { method: 'PATCH', body: { pinned: !(chat && chat.pinned) } });
      const list = await api('/api/chats'); chats = list; renderChats(); closeListModal();
      toast('Готово');
    }
    if (action === 'delete-chat') {
      if (!confirm('Удалить чат со всеми сообщениями?')) return;
      await api(`/api/chats/${id}`, { method: 'DELETE' });
      const list = await api('/api/chats'); chats = list; renderChats(); closeListModal();
      closeChatView(false);
      currentChat = null; localStorage.removeItem(LAST_CHAT_KEY);
      toast('Чат удалён');
    }
    if (action === 'buy-badge') {
      const data = await api('/api/store/badge', { method: 'POST', body: { icon: btn.dataset.icon, title: btn.dataset.title } });
      currentUser = data.user; updateUserUI(); toast('Значок куплен!');
    }
    if (action === 'buy-color') {
      const data = await api('/api/store/color', { method: 'POST', body: { color: btn.dataset.color } });
      currentUser = data.user; updateUserUI(); toast('Цвет никнейма куплен!');
    }
    if (action === 'join-clan') {
      await api(`/api/clans/${id}/join`, { method: 'POST' });
      currentUser = await api('/api/auth/me'); updateUserUI(); toast('Вы вступили в клан');
      openClansList();
    }
    if (action === 'premium-buy') {
      const data = await api('/api/premium/buy', { method: 'POST' });
      currentUser = data.user; updateUserUI(); toast('Premium активирован!'); closeListModal();
    }
    if (action === 'nft-request') {
      toast('Запрос отправлен администрации');
    }
    if (action === 'market-tab') {
      await openNftMarket(btn.dataset.tab);
    }
    if (action === 'market-phrases') {
      closeAnimated($('modal-profile-card'));
      closeAnimated($('modal-user-profile'));
      await openNftMarket('phrases');
    }
    if (action === 'phrase-sell') {
      const text = btn.dataset.text || '';
      const raw = prompt(`Цена NFT-фразы «${text}» в рубинах:`, '1000');
      if (raw === null) return;
      const price = Number(raw);
      if (!Number.isSafeInteger(price) || price < 1 || price > 10000000) {
        return toast('Введите целую цену от 1 до 10 000 000 рубинов', 'error');
      }
      await api(`/api/nft-phrases/${encodeURIComponent(id)}/sell`, { method: 'POST', body: { price } });
      toast(`Фраза выставлена на продажу за ${price.toLocaleString('ru-RU')} 💎`, 'message');
      refreshPhraseViews();
    }
    if (action === 'phrase-unlist') {
      await api(`/api/nft-phrases/${encodeURIComponent(id)}/unlist`, { method: 'POST' });
      toast('Фраза снята с продажи');
      refreshPhraseViews();
    }
    if (action === 'phrase-buy') {
      const price = Number(btn.dataset.price) || 0;
      const text = btn.dataset.text || '';
      if (!confirm(`Купить NFT-фразу «${text}» за ${price.toLocaleString('ru-RU')} рубинов?`)) return;
      const data = await api(`/api/nft-phrases/${encodeURIComponent(id)}/buy`, { method: 'POST', body: { expectedPrice: price } });
      if (data.user) { currentUser = data.user; updateUserUI(); }
      toast('NFT-фраза теперь в вашем профиле', 'message');
      refreshPhraseViews();
    }
    if (action === 'nft-buy') {
      const price = Number(btn.dataset.price) || 0;
      const handle = btn.dataset.username || '';
      if (!confirm(`Купить @${handle} за ${price} рубинов?`)) return;
      const data = await api(`/api/nft/${encodeURIComponent(id)}/buy`, { method: 'POST' });
      currentUser = data.user;
      updateUserUI();
      toast(`Юзернейм @${handle} теперь ваш`, 'message');
      openNftMarket();
    }
    if (action === 'nft-sell') {
      const handle = btn.dataset.username || '';
      const raw = prompt(`Цена для @${handle} в рубинах:`, '1000');
      if (raw === null) return;
      const price = Math.floor(Number(raw));
      if (!Number.isFinite(price) || price < 1) return toast('Введите цену больше нуля', 'error');
      const data = await api(`/api/nft/${encodeURIComponent(id)}/sell`, { method: 'POST', body: { price } });
      currentUser = data.user;
      updateUserUI();
      toast(`@${handle} выставлен на продажу за ${price} 💎`, 'message');
      if ($('modal-list').style.display !== 'none') openNftMarket();
    }
    if (action === 'nft-unlist') {
      const data = await api(`/api/nft/${encodeURIComponent(id)}/unlist`, { method: 'POST' });
      currentUser = data.user;
      updateUserUI();
      toast('Лот снят с продажи');
      if ($('modal-list').style.display !== 'none') openNftMarket();
    }
    if (action === 'copy-text') {
      navigator.clipboard.writeText(btn.dataset.text || '').then(() => toast('Скопировано'));
    }
  } catch (err) {
    toast(err.message, 'error');
    if (action === 'phrase-buy' && err.status === 409) refreshPhraseViews();
  }
}

function renderUserProfile(user) {
  const badges = (user.badges || []).map(badgeHtml).join('');
  return `
    <div class="user-profile-card">
      <div class="profile-avatar-giant" style="width:72px;height:72px;font-size:28px;">
        ${user.avatar ? `<img src="${escapeAttr(user.avatar)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : escapeHtml((user.displayName || '?').charAt(0))}
      </div>
      <h3>${escapeHtml(user.displayName)}</h3>
      <p class="muted-small">@${escapeHtml(user.username)} ${user.online ? '· в сети' : ''}</p>
      ${user.bio ? `<p class="chat-info-about">${escapeHtml(user.bio)}</p>` : ''}
      ${user.city ? `<p class="muted-small">${escapeHtml(user.city)}</p>` : ''}
      <div class="badges-flex" style="justify-content:center;margin:12px 0;">${badges || ''}</div>
      ${user.id !== currentUser.id ? `<button class="mac-btn primary-purple" data-action="dm-user" data-id="${user.id}">Написать</button>` : ''}
    </div>`;
}

function nftHandleHint(user) {
  const list = user && Array.isArray(user.nftUsernames) ? user.nftUsernames : [];
  if (!list.length) return '';
  const first = typeof list[0] === 'string' ? list[0] : (list[0] && list[0].username);
  if (!first) return '';
  return ` · NFT @${escapeHtml(first)}${list.length > 1 ? ` +${list.length - 1}` : ''}`;
}

function renderSearchResults(data) {
  const users = (data.users || []).map(u => `
    <button class="list-row" data-action="open-user" data-id="${u.id}">
      <div class="list-avatar">${u.avatar ? `<img src="${escapeAttr(u.avatar)}">` : escapeHtml((u.displayName || '?').charAt(0))}</div>
      <div class="list-row-main"><span>${escapeHtml(u.displayName)}</span><small>@${escapeHtml(u.username)}${nftHandleHint(u)}</small></div>
    </button>`).join('');
  const chatsHtml = (data.chats || []).map(c => `
    <button class="list-row" data-action="open-chat" data-id="${c.id}">
      <div class="list-avatar">${c.avatar ? `<img src="${escapeAttr(c.avatar)}">` : escapeHtml((c.title || '?').charAt(0))}</div>
      <div class="list-row-main"><span>${escapeHtml(c.title)}</span><small>${c.type === 'channel' ? 'Канал' : 'Группа'}</small></div>
    </button>`).join('');
  const messages = (data.messages || []).map(m => `
    <button class="list-row" data-action="open-chat" data-id="${m.chat_id}">
      <div class="list-avatar">💬</div>
      <div class="list-row-main"><span>${escapeHtml(m.text || '')}</span><small>${escapeHtml(m.display_name || '')} · ${fmtChatTime(m.created_at)}</small></div>
    </button>`).join('');
  return `${users ? `<div class="list-section-title">Пользователи</div>${users}` : ''}
    ${chatsHtml ? `<div class="list-section-title">Чаты</div>${chatsHtml}` : ''}
    ${messages ? `<div class="list-section-title">Сообщения</div>${messages}` : ''}
    ${!users && !chatsHtml && !messages ? '<p class="empty-feed">Ничего не найдено</p>' : ''}`;
}

/* ================================================================== */
/*  НОВЫЙ ЧАТ                                                         */
/* ================================================================== */
function setupNewChat() {
  const input = $('new-chat-search');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadUserResults(input.value.trim()), 250);
  });
  $('btn-create-group').addEventListener('click', () => {
    $('modal-new-chat').style.display = 'none';
    openCreateChat('group');
  });
  $('btn-create-channel').addEventListener('click', () => {
    $('modal-new-chat').style.display = 'none';
    openCreateChat('channel');
  });
}
function openNewChat() {
  $('modal-new-chat').style.display = 'flex';
  $('new-chat-search').value = '';
  loadUserResults('');
  setTimeout(() => $('new-chat-search').focus(), 50);
}
async function loadUserResults(q) {
  const box = $('new-chat-results');
  try {
    const users = await api(`/api/users?q=${encodeURIComponent(q)}`);
    const list = users.filter(u => u.id !== currentUser.id);
    box.innerHTML = list.length ? list.map(u => `
      <button class="list-row" data-action="dm-user" data-id="${u.id}">
        <div class="list-avatar">${u.avatar ? `<img src="${escapeAttr(u.avatar)}">` : escapeHtml((u.displayName || '?').charAt(0))}</div>
        <div class="list-row-main"><span>${escapeHtml(u.displayName)} ${u.online ? '<i class="online-dot-inline"></i>' : ''}</span><small>@${escapeHtml(u.username)}${nftHandleHint(u)}</small></div>
      </button>`).join('') : '<p class="empty-feed">Пользователи не найдены</p>';
  } catch (err) { box.innerHTML = `<p class="empty-feed">${escapeHtml(err.message)}</p>`; }
}


/* ================================================================== */
/*  МАГАЗИН / МАРКЕТ / PREMIUM / КЛАНЫ                                */
/* ================================================================== */
function openStore() {
  const badges = [
    { icon: '🔥', title: 'Flame' }, { icon: '⚡', title: 'Zeus' },
    { icon: '👑', title: 'King' }, { icon: '💎', title: 'Diamond' },
    { icon: '🚀', title: 'Rocket' }, { icon: '🎯', title: 'Sniper' }
  ];
  const colors = ['#0A84FF', '#BF5AF2', '#30D158', '#FFD60A', '#FF453A', '#64D2FF'];
  openList('Магазин', `
    <p class="muted-small">Баланс: <b>${currentUser.rubies || 0} 💎</b></p>
    <div class="list-section-title">Значки · 300 💎</div>
    <div class="store-grid">
      ${badges.map(b => `<button class="store-item" data-action="buy-badge" data-icon="${b.icon}" data-title="${b.title}">
        <span class="store-icon">${b.icon}</span><span>${b.title}</span><small>300 💎</small></button>`).join('')}
    </div>
    <div class="list-section-title">Цвет никнейма · 200 💎</div>
    <div class="swatch-row">
      ${colors.map(c => `<button class="swatch color-dot" data-action="buy-color" data-color="${c}" style="background:${c}"></button>`).join('')}
    </div>`);
}

let nftMarketTab = 'usernames';
let nftMarketRequest = 0;

function refreshPhraseViews(ownerIds) {
  if (window.refreshPhraseProfiles) window.refreshPhraseProfiles(ownerIds);
  const list = $('modal-list');
  const title = $('list-modal-title');
  if (list && list.style.display !== 'none' && title && title.textContent === 'Маркет NFT-фраз' && nftMarketTab === 'phrases') {
    openNftMarket('phrases', true);
  }
}

function phraseMarketLot(phrase) {
  const text = escapeHtml(phrase.text);
  const id = escapeAttr(phrase.id);
  const textAttr = escapeAttr(phrase.text);
  const price = Number(phrase.price) || 0;
  const action = phrase.mine
    ? (phrase.forSale
      ? `<button class="mac-btn secondary nft-lot-btn" data-action="phrase-unlist" data-id="${id}">Снять</button>`
      : `<button class="mac-btn secondary nft-lot-btn" data-action="phrase-sell" data-id="${id}" data-text="${textAttr}">Продать</button>`)
    : `<button class="mac-btn primary-purple nft-lot-btn" data-action="phrase-buy" data-id="${id}" data-text="${textAttr}" data-price="${price}">Купить</button>`;
  return `<div class="nft-lot-row nft-phrase-lot">
    <div class="nft-lot-icon nft-phrase-lot-icon">“</div>
    <div class="nft-lot-main">
      <span class="nft-lot-name nft-phrase-lot-name">«${text}»</span>
      <small title="ID: ${id}">${phrase.mine ? 'Ваша коллекция' : `${escapeHtml(phrase.ownerName)} · @${escapeHtml(phrase.ownerUsername)}`} · #${escapeHtml(phrase.id.slice(0, 8).toUpperCase())}</small>
    </div>
    ${phrase.forSale ? `<div class="nft-lot-price">${price.toLocaleString('ru-RU')} <span>💎</span></div>` : ''}
    ${action}
  </div>`;
}

async function openNftMarket(tab, refreshOnly = false) {
  if (tab === 'usernames' || tab === 'phrases') nftMarketTab = tab;
  const selected = nftMarketTab;
  const request = ++nftMarketRequest;
  try {
    const items = await api(selected === 'phrases' ? '/api/nft-phrases/market' : '/api/nft-market?all=1');
    if (request !== nftMarketRequest) return;
    if (refreshOnly) {
      const modal = $('modal-list');
      const expectedTitle = selected === 'phrases' ? 'Маркет NFT-фраз' : 'Маркет юзернеймов';
      if (!modal || modal.style.display === 'none' || modal.classList.contains('is-closing') || $('list-modal-title').textContent !== expectedTitle) return;
    }
    const tabs = `<div class="nft-market-tabs" role="tablist" aria-label="Разделы маркета">
      <button type="button" role="tab" aria-selected="${selected === 'usernames'}" class="${selected === 'usernames' ? 'active' : ''}" data-action="market-tab" data-tab="usernames">Юзернеймы</button>
      <button type="button" role="tab" aria-selected="${selected === 'phrases'}" class="${selected === 'phrases' ? 'active' : ''}" data-action="market-tab" data-tab="phrases">NFT-фразы <span>✦</span></button>
    </div>`;

    if (selected === 'phrases') {
      const forSale = items.forSale || [];
      const mine = items.mine || [];
      openList('Маркет NFT-фраз', `
        ${tabs}
        <div class="nft-market-hero nft-phrase-market-hero">
          <div><h3>Слова, которые остаются</h3>
            <p>Создавайте фразы, общаясь в чатах, и обменивайтесь ими за рубины. Это коллекционные предметы внутри Runa, без блокчейна.</p></div>
          <div class="nft-market-balance"><span>${Number(currentUser.rubies) || 0}</span> 💎</div>
        </div>
        <div class="list-section-title">На продаже · ${forSale.length}</div>
        <div class="nft-lot-list">${forSale.length ? forSale.map(phraseMarketLot).join('') : '<p class="empty-feed">Пока нет фраз на продаже. Загляните позже.</p>'}</div>
        <div class="list-section-title">Мои NFT-фразы · ${mine.length}</div>
        <div class="nft-lot-list">${mine.length ? mine.map(phraseMarketLot).join('') : '<p class="empty-feed">Общайтесь в чатах — шанс создать первую фразу может выпасть в любой момент.</p>'}</div>
      `);
      return;
    }

    const forSale = items.filter(n => n.forSale && !n.mine);
    const mine = items.filter(n => n.mine);
    const saleHtml = forSale.length ? forSale.map(n => `
      <div class="nft-lot-row">
        <div class="nft-lot-icon">@</div>
        <div class="nft-lot-main">
          <span class="nft-lot-name">@${escapeHtml(n.username)}</span>
          <small>${escapeHtml(n.ownerName)} · @${escapeHtml(n.ownerUsername)}</small>
        </div>
        <div class="nft-lot-price">${Number(n.price) || 0} <span>💎</span></div>
        <button class="mac-btn primary-purple nft-lot-btn" data-action="nft-buy"
                data-id="${escapeAttr(n.id)}" data-price="${Number(n.price) || 0}"
                data-username="${escapeAttr(n.username)}">Купить</button>
      </div>`).join('') : '<p class="empty-feed">Сейчас на продаже нет юзернеймов. Загляните позже.</p>';

    const mineHtml = mine.length ? mine.map(n => `
      <div class="nft-lot-row">
        <div class="nft-lot-icon mine">@</div>
        <div class="nft-lot-main">
          <span class="nft-lot-name">@${escapeHtml(n.username)}</span>
          <small>${n.forSale ? `На продаже за ${Number(n.price) || 0} 💎` : 'В вашей коллекции'}</small>
        </div>
        ${n.forSale
          ? `<button class="mac-btn secondary nft-lot-btn" data-action="nft-unlist" data-id="${escapeAttr(n.id)}">Снять</button>`
          : `<button class="mac-btn secondary nft-lot-btn" data-action="nft-sell" data-id="${escapeAttr(n.id)}" data-username="${escapeAttr(n.username)}">Продать</button>`}
      </div>`).join('') : '<p class="empty-feed">У вас пока нет NFT юзернеймов.</p>';

    openList('Маркет юзернеймов', `
      ${tabs}
      <div class="nft-market-hero">
        <div>
          <h3>Короткие имена для профиля</h3>
          <p>Купили — имя сразу ваше. Его видно в профиле, по нему вас находят и упоминают.</p>
        </div>
        <div class="nft-market-balance"><span>${Number(currentUser.rubies) || 0}</span> 💎</div>
      </div>
      <div class="list-section-title">На продаже · ${forSale.length}</div>
      <div class="nft-lot-list">${saleHtml}</div>
      <div class="list-section-title">Мои юзернеймы · ${mine.length}</div>
      <div class="nft-lot-list">${mineHtml}</div>
    `);
  } catch (err) { if (request === nftMarketRequest) toast(err.message, 'error'); }
}

function openPremium() {
  openList('Runa Premium', `
    <div class="premium-hero">
      <div class="premium-star">⭐</div>
      <h3>${currentUser.isPremium ? 'Premium активен' : 'Runa Premium'}</h3>
      <p class="muted-small">Эксклюзивные значки, приоритетная поддержка и расширенные настройки профиля.</p>
    </div>
    <ul class="premium-list">
      <li>✔ Значок Premium в профиле</li>
      <li>✔ Любые цвета никнейма</li>
      <li>✔ Приоритет в поддержке</li>
    </ul>
    ${currentUser.isPremium ? '<p class="empty-feed">Спасибо, что поддерживаете проект!</p>'
      : '<button class="mac-btn primary-purple" data-action="premium-buy" style="width:100%">Активировать за 1 000 💎</button>'}`);
}

async function loadClansIntoClanModal() {
  try {
    const clans = await api('/api/clans');
    const host = document.querySelector('#modal-clans .clans-body');
    let box = host.querySelector('.clan-list-inline');
    if (!box) { box = document.createElement('div'); box.className = 'clan-list-inline'; host.appendChild(box); }
    box.innerHTML = clans.length ? clans.slice(0, 5).map(c => `
      <div class="list-row static">
        <div class="list-avatar">${escapeHtml(c.tag)}</div>
        <div class="list-row-main"><span>[${escapeHtml(c.tag)}] ${escapeHtml(c.name)}</span><small>${c.membersCount} участников</small></div>
        ${c.joined ? '<span class="muted-small">вы в клане</span>' : `<button class="mac-btn secondary" data-action="join-clan" data-id="${c.id}">Вступить</button>`}
      </div>`).join('') : '<p class="empty-feed">Кланов пока нет</p>';
  } catch (err) { toast(err.message, 'error'); }
}

async function openClansList() {
  try {
    const clans = await api('/api/clans');
    openList('Рейтинг кланов', clans.length ? clans.map((c, i) => `
      <div class="list-row static">
        <div class="list-avatar">${i + 1}</div>
        <div class="list-row-main"><span>[${escapeHtml(c.tag)}] ${escapeHtml(c.name)}</span><small>${c.membersCount} участников · лидер ${escapeHtml(c.leaderName || '—')}</small></div>
        ${c.joined ? '<span class="muted-small">вы в клане</span>' : `<button class="mac-btn secondary" data-action="join-clan" data-id="${c.id}">Вступить</button>`}
      </div>`).join('') : '<p class="empty-feed">Кланов пока нет</p>');
  } catch (err) { toast(err.message, 'error'); }
}

/* ================================================================== */
/*  КАРТА MOPS WALLET: 3D-НАКЛОН И ДИЗАЙНЫ                            */
/* ================================================================== */
const CARD_DESIGNS = [
  { id: 'classic', name: 'Обычная', sub: 'у всех' },
  { id: 'premium', name: 'Premium', sub: 'с Premium', premium: true },
  { id: 'halloween', name: 'Хэллоуин', sub: 'зашёл до 1 ноября' },
  { id: 'neon', name: 'Най', sub: 'за 1 MOPS' }
];
let cardDesignSelection = null;

function applyCardStyle(style, persist = false) {
  const card = $('wallet-card');
  if (!card) return;
  const valid = CARD_DESIGNS.some(d => d.id === style) ? style : 'classic';
  CARD_DESIGNS.forEach(d => card.classList.toggle('style-' + d.id, d.id === valid));
  card.dataset.style = valid;
  localStorage.setItem('runa_card_style', valid);
  if (persist && currentUser) {
    currentUser.cardStyle = valid;
    api('/api/user/update', { method: 'POST', body: { card_style: valid } })
      .then(profile => { currentUser = { ...currentUser, ...profile }; })
      .catch(() => {});
  }
}

function setupWalletCardTilt() {
  const scene = $('wallet-card-scene');
  const card = $('wallet-card');
  if (!scene || !card) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let raf = null;
  let lastX = 0;
  let lastY = 0;

  const paint = () => {
    raf = null;
    const r = scene.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = Math.max(0, Math.min(1, (lastX - r.left) / r.width));
    const py = Math.max(0, Math.min(1, (lastY - r.top) / r.height));
    const rx = (0.5 - py) * 13;
    const ry = (px - 0.5) * 17;
    card.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-2px)`;
    card.style.setProperty('--sx', `${(px * 100).toFixed(1)}%`);
    card.style.setProperty('--sy', `${(py * 100).toFixed(1)}%`);
    scene.classList.add('is-tilting');
  };

  const move = (x, y) => {
    lastX = x; lastY = y;
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const reset = () => {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    card.style.transform = '';
    scene.classList.remove('is-tilting');
  };

  scene.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
  scene.addEventListener('pointerleave', reset);
  scene.addEventListener('pointercancel', reset);
  scene.addEventListener('touchmove', (e) => {
    const t = e.touches && e.touches[0];
    if (t) move(t.clientX, t.clientY);
  }, { passive: true });
  scene.addEventListener('touchend', reset);
  scene.addEventListener('touchcancel', reset);
}

function miniCardHtml(design) {
  const name = escapeHtml((currentUser && (currentUser.displayName || currentUser.username)) || 'Runa');
  const handle = escapeHtml('@' + ((currentUser && currentUser.username) || 'runa'));
  const avatar = currentUser && currentUser.avatar
    ? `<img src="${escapeAttr(currentUser.avatar)}" alt="">`
    : '🐶';
  const bal = currentUser ? fmtMops(currentUser.mopsBalance) : '0,00';
  return `<div class="mini-card style-${design.id}">
    <div class="mini-chip"></div>
    <div class="mini-top">
      <span class="mini-avatar">${avatar}</span>
      <span><span class="mini-name">${name}</span><br><span class="mini-sub">CARD</span></span>
    </div>
    <div>
      <div class="mini-balance">${bal}<span>MOPS</span></div>
      <div class="mini-holder">${handle}</div>
    </div>
  </div>`;
}

function designPreviewHtml(design) {
  const name = escapeHtml((currentUser && (currentUser.displayName || currentUser.username)) || 'Runa');
  const handle = escapeHtml('@' + ((currentUser && currentUser.username) || 'runa'));
  const avatar = currentUser && currentUser.avatar
    ? `<img src="${escapeAttr(currentUser.avatar)}" alt="">`
    : '🐶';
  const bal = currentUser ? fmtMops(currentUser.mopsBalance) : '0,00';
  return `<div class="cd-preview-card style-${design.id}">
    <div class="cdp-top">
      <div class="cdp-brand">
        <span class="cdp-avatar">${avatar}</span>
        <div><b>${name}</b><span class="cdp-sub">CARD</span></div>
      </div>
      <span class="cdp-chip"></span>
    </div>
    <div class="cdp-watermark">RUNA<span>MOPS</span></div>
    <div class="cdp-bottom">
      <div class="cdp-balance">${bal}<span>MOPS</span></div>
      <div class="cdp-holder">${handle}</div>
    </div>
  </div>`;
}

function renderCardDesignGrid() {
  const grid = $('card-design-grid');
  if (!grid) return;
  const current = (currentUser && currentUser.cardStyle) || localStorage.getItem('runa_card_style') || 'classic';
  if (!cardDesignSelection) cardDesignSelection = current;
  const preview = $('card-design-preview');
  const selected = CARD_DESIGNS.find(d => d.id === cardDesignSelection) || CARD_DESIGNS[0];
  if (preview) preview.innerHTML = designPreviewHtml(selected);
  grid.innerHTML = CARD_DESIGNS.map(d => `
    <button type="button" class="card-design-option ${d.id === cardDesignSelection ? 'active' : ''}" data-card-design="${d.id}">
      ${miniCardHtml(d)}
      <span class="cd-name">${d.name}</span>
      <span class="cd-sub ${d.premium ? 'premium' : ''}">${d.sub}</span>
    </button>`).join('');
  grid.querySelectorAll('[data-card-design]').forEach(btn => {
    btn.addEventListener('click', () => {
      cardDesignSelection = btn.dataset.cardDesign;
      grid.querySelectorAll('.card-design-option').forEach(el => el.classList.toggle('active', el === btn));
      const chosen = CARD_DESIGNS.find(d => d.id === cardDesignSelection);
      const previewEl = $('card-design-preview');
      if (previewEl && chosen) previewEl.innerHTML = designPreviewHtml(chosen);
      updateCardDesignApply();
    });
  });
  updateCardDesignApply();
}

function updateCardDesignApply() {
  const btn = $('btn-card-design-apply');
  if (!btn) return;
  const current = (currentUser && currentUser.cardStyle) || 'classic';
  const equipped = cardDesignSelection === current;
  btn.textContent = equipped ? 'Надета' : 'Надеть';
  btn.classList.toggle('ready', !equipped);
  btn.disabled = equipped;
}

function openCardDesign() {
  cardDesignSelection = (currentUser && currentUser.cardStyle) || localStorage.getItem('runa_card_style') || 'classic';
  renderCardDesignGrid();
  const modal = $('modal-card-design');
  if (modal) modal.style.display = 'flex';
}

function setupWalletCardUi() {
  setupWalletCardTilt();
  const openers = ['btn-card-design', 'btn-card-design-2'];
  openers.forEach(id => {
    const btn = $(id);
    if (btn) btn.addEventListener('click', openCardDesign);
  });
  const applyBtn = $('btn-card-design-apply');
  if (applyBtn) applyBtn.addEventListener('click', () => {
    if (!cardDesignSelection) return;
    applyCardStyle(cardDesignSelection, true);
    const modal = $('modal-card-design');
    if (modal) modal.style.display = 'none';
    toast('Дизайн карты обновлён');
  });
  const filters = $('wallet-hist-filters');
  if (filters) filters.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tx-filter]');
    if (!btn) return;
    filters.querySelectorAll('.filter-pill').forEach(el => el.classList.toggle('active', el === btn));
    renderWalletTransactions(btn.dataset.txFilter);
  });
}

let walletTxCache = [];
function renderWalletTransactions(filter = 'all') {
  const block = document.querySelector('#modal-wallet .history-block');
  if (!block) return;
  block.querySelectorAll('.tx-list, .empty-feed').forEach(el => el.remove());
  const list = (walletTxCache || []).filter(t => {
    if (filter === 'all') return true;
    if (filter === 'exchange') return t.kind === 'exchange';
    return t.kind === filter;
  });
  if (!list.length) {
    block.insertAdjacentHTML('beforeend', '<p class="empty-feed">Пока пусто</p>');
    return;
  }
  const html = list.map(t => `
    <div class="tx-row">
      <span class="tx-kind ${t.kind}">${t.kind === 'in' ? '+' : t.kind === 'out' ? '−' : '⇄'}</span>
      <div class="tx-main"><span>${escapeHtml(t.note || t.kind)}</span><small>${fmtDay(t.created_at)} · ${fmtTime(t.created_at)}</small></div>
      <span class="tx-amount ${t.amount >= 0 ? 'plus' : 'minus'}">${t.amount >= 0 ? '+' : ''}${t.amount} ${t.currency === 'rubies' ? '💎' : 'MOPS'}</span>
    </div>`).join('');
  block.insertAdjacentHTML('beforeend', `<div class="tx-list">${html}</div>`);
}

/* ================================================================== */
/*  ТРАНЗАКЦИИ                                                        */
/* ================================================================== */
async function loadTransactions() {
  try {
    const list = await api('/api/wallet/transactions');
    walletTxCache = list || [];
    const activeFilter = document.querySelector('#wallet-hist-filters .filter-pill.active');
    renderWalletTransactions(activeFilter ? activeFilter.dataset.txFilter : 'all');
    const rubiesBody = document.querySelector('#modal-rubies .rubies-body');
    if (rubiesBody) {
      const html = list.length ? list.map(t => `
        <div class="tx-row">
          <span class="tx-kind ${t.kind}">${t.kind === 'in' ? '+' : t.kind === 'out' ? '−' : '⇄'}</span>
          <div class="tx-main"><span>${escapeHtml(t.note || t.kind)}</span><small>${fmtDay(t.created_at)} · ${fmtTime(t.created_at)}</small></div>
          <span class="tx-amount ${t.amount >= 0 ? 'plus' : 'minus'}">${t.amount >= 0 ? '+' : ''}${t.amount} ${t.currency === 'rubies' ? '💎' : 'MOPS'}</span>
        </div>`).join('') : '<p class="empty-feed">Операций пока не было</p>';
      rubiesBody.querySelectorAll('.tx-list, .empty-feed').forEach(el => el.remove());
      rubiesBody.insertAdjacentHTML('beforeend', `<div class="tx-list">${html}</div>`);
    }
  } catch (err) { /* silent */ }
}

/* ================================================================== */
/*  НАСТРОЙКИ                                                         */
/* ================================================================== */
const SETTINGS_META = {
  language: { title: 'Язык', sub: 'Язык интерфейса Runa', icon: 'globe', color: 'purple' },
  privacy: { title: 'Конфиденциальность', sub: 'Кто видит вас и может писать', icon: 'hand', color: 'blue' },
  devices: { title: 'Устройства', sub: 'Где открыт ваш аккаунт', icon: 'laptop', color: 'orange' },
  security: { title: 'Безопасность', sub: 'Пароль и защита аккаунта', icon: 'shield-check', color: 'green' },
  appearance: { title: 'Оформление', sub: 'Тема, фон чата и курсор', icon: 'palette', color: 'grey' },
  fonts: { title: 'Шрифты', sub: 'Гарнитура и насыщенность текста', icon: 'type', color: 'cyan' },
  scale: { title: 'Масштаб', sub: 'Размер интерфейса', icon: 'zoom-in', color: 'blue' },
  mic: { title: 'Микрофон', sub: 'Запись голосовых сообщений', icon: 'mic', color: 'orange' },
  sounds: { title: 'Звук уведомлений', sub: 'Звуки сообщений и звонков', icon: 'bell', color: 'red' },
  folders: { title: 'Папки с чатами', sub: 'Группируйте чаты по темам', icon: 'folder', color: 'blue' },
  performance: { title: 'Производительность', sub: 'Анимации и эффекты', icon: 'zap', color: 'green' },
  memory: { title: 'Память', sub: 'Кэш и хранилище', icon: 'database', color: 'grey' },
  info: { title: 'Информация', sub: 'О приложении Runa', icon: 'info', color: 'blue' },
  terms: { title: 'Пользовательское соглашение', sub: 'Правила использования Runa', icon: 'file-text', color: 'grey' },
  policy: { title: 'Политика конфиденциальности', sub: 'Как мы храним данные', icon: 'shield', color: 'blue' },
  support: { title: 'Поддержка', sub: 'Мы на связи', icon: 'life-buoy', color: 'orange' }
};

const WALLPAPERS = [
  { id: 'runa', name: 'Runa' }, { id: 'classic', name: 'Классика' },
  { id: 'ocean', name: 'Океан' }, { id: 'sunset', name: 'Закат' },
  { id: 'sky', name: 'Небо' }, { id: 'violet', name: 'Фиалка' },
  { id: 'peach', name: 'Персик' }, { id: 'mint', name: 'Мята' },
  { id: 'fire', name: 'Огонь' }, { id: 'forest', name: 'Лес' },
  { id: 'ice', name: 'Лёд' }, { id: 'gold', name: 'Золото' },
  { id: 'night', name: 'Ночь' }
];

const PATTERNS = [
  { id: 'doodle', name: 'Runa' },
  { id: 'none', name: 'Без узора' },
  { id: 'dots', name: 'Точки' },
  { id: 'stars', name: 'Звёзды' },
  { id: 'waves', name: 'Волны' },
  { id: 'anchors', name: 'Якоря' }
];

const FONT_STACKS = {
  rubik: "'Rubik', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', sans-serif",
  minecraft: "'Press Start 2P', 'Rubik', monospace",
  system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
};

let settingsState = { section: 'privacy', appearanceTab: 'theme' };

function settingsHeader(key) {
  const m = SETTINGS_META[key] || SETTINGS_META.privacy;
  return `<div class="set-header">
    <div class="set-header-icon ${m.color}"><i data-lucide="${m.icon}"></i></div>
    <div><h3>${m.title}</h3><p>${m.sub}</p></div>
  </div>`;
}

function setCheck() {
  return '<span class="set-check"><i data-lucide="check"></i></span>';
}

function toggleRow(label, sub, toggleKey, checked) {
  return `<div class="set-row">
    <div class="set-row-main"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</div>
    <input type="checkbox" class="mac-switch" data-toggle="${toggleKey}" ${checked ? 'checked' : ''}>
  </div>`;
}

function detectBrowser() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Система';
  return { browser, os };
}

function renderAppearanceBody() {
  const tab = settingsState.appearanceTab || 'theme';
  if (tab === 'theme') {
    return `<p class="set-hint">Тема применяется сразу. Светлая тема повторяет стеклянные поверхности Runa.</p>
      <div class="theme-choice-grid">
        <button class="theme-choice ${currentUser.theme !== 'light' ? 'active' : ''}" data-theme-choice="dark">
          <div class="theme-mock dark"><span></span><span></span></div>
          <b>Тёмная</b><small>Runa Night</small>
        </button>
        <button class="theme-choice ${currentUser.theme === 'light' ? 'active' : ''}" data-theme-choice="light">
          <div class="theme-mock light"><span></span><span></span></div>
          <b>Светлая</b><small>Runa Day</small>
        </button>
      </div>`;
  }
  if (tab === 'wallpaper') {
    const active = currentUser.chatWallpaper || 'runa';
    return `<p class="set-hint">Фон чата — как в Telegram: меняется сразу и сохраняется в профиле.</p>
      <div class="wallpaper-grid">
        ${WALLPAPERS.map(w => `<button class="wp-swatch ${w.id === active ? 'active' : ''}" data-wallpaper="${w.id}">
          <div class="wp-preview wp-${w.id}"></div><span>${w.name}</span>
        </button>`).join('')}
      </div>
      <span class="set-section-label" style="margin-top:14px">Узор поверх фона</span>
      <div class="pattern-strip">
        ${PATTERNS.map(p => `<button class="pattern-swatch ${(currentUser.chatPattern || 'doodle') === p.id ? 'active' : ''}" data-pattern="${p.id}" title="${p.name}">
          <span class="pattern-preview pat-${p.id}"></span>
        </button>`).join('')}
      </div>`;
  }
  if (tab === 'resolution') {
    const scale = Number(currentUser.uiScale || 100);
    return `<p class="set-hint">Разрешение интерфейса. На телефоне удобнее «Крупно».</p>
      <div class="set-card">
        ${[[90, 'Компактно', 'Больше чатов на экране'], [100, 'Обычно', 'Рекомендуется'], [110, 'Крупно', 'Крупный текст и кнопки']].map(([v, name, sub]) => `
          <div class="set-row ${scale === v ? 'active' : ''}" data-scale="${v}">
            <div class="set-row-main"><b>${name}</b><small>${sub}</small></div>
            ${scale === v ? setCheck() : ''}
          </div>`).join('')}
      </div>`;
  }
  const cursor = currentUser.cursorStyle || 'default';
  return `<p class="set-hint">Курсор Runa. На телефоне настройка не влияет на касания.</p>
    <div class="set-card">
      ${[['default', 'Системный', 'Стандартный курсор устройства'], ['dot', 'Точка Runa', 'Синяя точка с белой обводкой'], ['crosshair', 'Прицел', 'Точный курсор для выделения']].map(([v, name, sub]) => `
        <div class="set-row ${cursor === v ? 'active' : ''}" data-cursor="${v}">
          <div class="set-row-main"><b>${name}</b><small>${sub}</small></div>
          ${cursor === v ? setCheck() : ''}
        </div>`).join('')}
    </div>`;
}

function renderSettingsPane() {
  const pane = $('settings-pane');
  if (!pane) return;
  const key = settingsState.section;
  const m = SETTINGS_META[key] || SETTINGS_META.privacy;
  let body = '';

  if (key === 'language') {
    const langs = [['ru', '🇷🇺', 'Русский'], ['en', '🇬🇧', 'English'], ['uk', '🇺🇦', 'Українська'], ['be', '🇧🇾', 'Беларуская']];
    body = `<div class="set-card">
      ${langs.map(([code, flag, name]) => `<div class="set-row ${currentUser.language === code ? 'active' : ''}" data-lang="${code}">
        <span class="set-row-icon" style="background:rgba(255,255,255,.07)">${flag}</span>
        <div class="set-row-main"><b>${name}</b></div>
        ${currentUser.language === code ? setCheck() : ''}
      </div>`).join('')}
    </div>
    <p class="set-hint">Сейчас интерфейс полностью переведён на русский. Английский включается постепенно.</p>`;
  } else if (key === 'privacy') {
    body = `
      <span class="set-section-label">Пересылка сообщений</span>
      <div class="set-card radio-card">
        <label class="radio-row"><input type="radio" name="set-fwd" checked><span>Все</span></label>
        <label class="radio-row"><input type="radio" name="set-fwd"><span>Мои контакты</span></label>
        <label class="radio-row"><input type="radio" name="set-fwd"><span>Никто</span></label>
      </div>
      <span class="set-section-label">Кто видит фото профиля</span>
      <div class="set-card radio-card">
        <label class="radio-row"><input type="radio" name="set-photo" checked><span>Все</span></label>
        <label class="radio-row"><input type="radio" name="set-photo"><span>Мои контакты</span></label>
        <label class="radio-row"><input type="radio" name="set-photo"><span>Никто</span></label>
      </div>
      <span class="set-section-label">Кто может мне писать</span>
      <div class="set-card radio-card">
        <label class="radio-row"><input type="radio" name="set-write" checked><span>Все</span></label>
        <label class="radio-row locked"><span>Только Premium</span><i data-lucide="lock"></i></label>
        <label class="radio-row locked"><span>За рубины</span><i data-lucide="lock"></i></label>
      </div>
      <button class="set-danger-btn" data-act="delete-account"><i data-lucide="trash-2"></i> Удалить аккаунт</button>`;
  } else if (key === 'devices') {
    const { browser, os } = detectBrowser();
    body = `
      <div class="set-card">
        <div class="set-device-hero">
          <div class="laptop-badge"><i data-lucide="laptop"></i></div>
          <b>${browser} · ${os}</b>
          <small><i></i> Это устройство</small>
        </div>
      </div>
      <span class="set-section-label">Другие устройства</span>
      <div class="set-card">
        <div class="set-empty-note"><b>Других устройств нет.</b><br>Здесь появятся телефоны и компьютеры, на которых вы войдёте.</div>
      </div>
      <span class="set-section-label">Telegram</span>
      <div class="set-card">
        <div class="set-row">
          <span class="set-row-icon" style="background:#229ED9;color:#fff"><i data-lucide="send"></i></span>
          <div class="set-row-main"><b>Не привязан</b><small>Открывает ленту и покупки за звёзды</small></div>
          <button class="set-primary-btn" style="width:auto;margin:0;padding:7px 13px" data-act="bind-telegram">Привязать</button>
        </div>
      </div>`;
  } else if (key === 'security') {
    body = `
      <span class="set-section-label">Смена пароля</span>
      <div class="set-card" style="padding:14px">
        <div class="set-field"><label>Текущий пароль</label><input type="password" id="sec-current" placeholder="••••••••" autocomplete="current-password"></div>
        <div class="set-field"><label>Новый пароль</label><input type="password" id="sec-next" placeholder="Минимум 4 символа" autocomplete="new-password"></div>
        <div class="set-field" style="margin-bottom:2px"><label>Повторите пароль</label><input type="password" id="sec-repeat" placeholder="Ещё раз" autocomplete="new-password"></div>
      </div>
      <button class="set-primary-btn" data-act="save-password"><i data-lucide="shield-check"></i> Сохранить пароль</button>
      <span class="set-section-label" style="margin-top:18px">Активные сеансы</span>
      <div class="set-card"><div class="set-row"><span class="set-row-icon" style="background:rgba(48,209,88,.15);color:#6BE08B"><i data-lucide="monitor-smartphone"></i></span><div class="set-row-main"><b>Это устройство</b><small>Текущий сеанс · активно</small></div><span class="set-check"><i data-lucide="check"></i></span></div></div>`;
  } else if (key === 'appearance') {
    body = `<div class="set-tabs">
        ${[['theme', 'Тема'], ['wallpaper', 'Фон чата'], ['resolution', 'Разрешение'], ['cursor', 'Курсор']].map(([id, label]) => `
          <button class="set-tab ${settingsState.appearanceTab === id ? 'active' : ''}" data-app-tab="${id}">${label}</button>`).join('')}
      </div>
      <div id="appearance-body">${renderAppearanceBody()}</div>`;
  } else if (key === 'fonts') {
    const font = currentUser.fontFamily || 'rubik';
    body = `<div class="set-card">
      <div class="font-row ${font === 'rubik' ? 'active' : ''}" data-font="rubik">
        <div class="font-aa" style="font-family:'Rubik',sans-serif">Aa</div>
        <div class="font-preview"><b>Rubik</b><small>Привет! Как дела?</small></div>
        ${font === 'rubik' ? setCheck() : ''}
      </div>
      <div class="font-row premium ${font === 'minecraft' ? 'active' : ''}" data-font="minecraft">
        <div class="font-aa" style="font-family:'Press Start 2P',monospace;font-size:9px">Aa</div>
        <div class="font-preview"><b>Minecraft</b><small>Привет! Как дела?</small></div>
        ${font === 'minecraft' ? setCheck() : '<span class="premium-tag">с Premium</span>'}
      </div>
    </div>
    <div class="set-card">
      ${toggleRow('Жирный шрифт', 'Сделает сообщения и заголовки насыщеннее', 'bold', !!currentUser.boldText)}
    </div>
    <p class="set-hint">Шрифт применяется ко всему интерфейсу Runa и сохраняется в профиле.</p>`;
  } else if (key === 'scale') {
    const scale = Number(currentUser.uiScale || 100);
    body = `<div class="set-card" style="padding:16px">
        <div class="set-scale-row">
          <input type="range" id="set-scale" min="80" max="120" step="5" value="${scale}">
          <span class="set-scale-val" id="set-scale-val">${scale}%</span>
        </div>
      </div>
      <p class="set-hint">Масштаб меняет размер всего интерфейса. На маленьких экранах рекомендуем 90–100%.</p>`;
  } else if (key === 'mic') {
    body = `<div class="set-card">${toggleRow('Микрофон', 'Разрешить запись голосовых сообщений', 'mic', !!currentUser.mic)}</div>
      <p class="set-hint">Runa попросит доступ к микрофону только при первой записи.</p>`;
  } else if (key === 'sounds') {
    body = `<div class="set-card">${toggleRow('Звук уведомлений', 'Проигрывать звук при новом сообщении', 'sounds', !!currentUser.sounds)}</div>
      <span class="set-section-label">Звук</span>
      <div class="set-card">
        ${[['Runa', 'Мягкий стеклянный сигнал', true], ['Telegram', 'Классический сигнал', false], ['Тишина', 'Только вибрация', false]].map(([name, sub, active]) => `
          <div class="set-row ${active ? 'active' : ''}" data-sound="${name}">
            <div class="set-row-main"><b>${name}</b><small>${sub}</small></div>
            ${active ? setCheck() : ''}
          </div>`).join('')}
      </div>`;
  } else if (key === 'folders') {
    let folders = [];
    try { folders = JSON.parse(localStorage.getItem('runa_folders') || '[]'); } catch (e) { folders = []; }
    body = `<div class="set-card">
        <div class="set-row active"><span class="set-row-icon" style="background:rgba(10,132,255,.16);color:#64D2FF"><i data-lucide="inbox"></i></span><div class="set-row-main"><b>Все чаты</b><small>${chats.length} чатов</small></div>${setCheck()}</div>
        ${folders.map(f => `<div class="set-row"><span class="set-row-icon"><i data-lucide="folder"></i></span><div class="set-row-main"><b>${escapeHtml(f)}</b><small>Папка</small></div><i data-lucide="chevron-right" class="set-row-chev"></i></div>`).join('')}
      </div>
      <button class="set-primary-btn" data-act="create-folder"><i data-lucide="plus"></i> Создать папку</button>`;
  } else if (key === 'performance') {
    const noMotion = localStorage.getItem('runa_no_motion') === '1';
    const noBlur = localStorage.getItem('runa_no_blur') === '1';
    body = `<div class="set-card">
        ${toggleRow('Анимации', 'Плавные переходы и эффекты Liquid Glass', 'animations', !noMotion)}
        ${toggleRow('Размытие фона', 'Эффект матового стекла (может нагружать GPU)', 'blur', !noBlur)}
      </div>
      <p class="set-hint">Если телефон нагревается, отключите размытие и анимации — интерфейс станет легче.</p>`;
  } else if (key === 'memory') {
    body = `<div class="set-card">
        <div class="set-row"><span class="set-row-icon" style="background:rgba(255,255,255,.07)"><i data-lucide="database"></i></span><div class="set-row-main"><b>Кэш приложения</b><small id="mem-size">Считаем…</small></div></div>
        <div class="set-row"><span class="set-row-icon" style="background:rgba(255,255,255,.07)"><i data-lucide="hard-drive"></i></span><div class="set-row-main"><b>Медиа и стикеры</b><small>Хранятся локально для офлайна</small></div></div>
      </div>
      <button class="set-primary-btn" data-act="clear-cache"><i data-lucide="trash-2"></i> Очистить кэш</button>`;
  } else if (key === 'info') {
    body = `<div class="set-card">
        <div class="set-row"><span class="set-row-icon" style="background:linear-gradient(150deg,#3FA2FF,#0A6FE8);color:#fff"><i data-lucide="cookie"></i></span><div class="set-row-main"><b>Runa</b><small>Версия 2.0.0 · Liquid Glass</small></div></div>
        <div class="set-row"><div class="set-row-main"><b>Сборка</b><small>2026.10 · macOS / iPhone</small></div></div>
        <div class="set-row"><div class="set-row-main"><b>Сервер</b><small>runachat.duckdns.org</small></div></div>
        <div class="set-row"><div class="set-row-main"><b>Ваш ID</b><small>${escapeHtml(currentUser.id)}</small></div></div>
      </div>
      <p class="set-hint">Runa — мессенджер с NFT-юзернеймами, подарками и анонимными номерами.</p>`;
  } else if (key === 'terms') {
    body = `<div class="set-info-box"><b>Пользовательское соглашение Runa</b><br><br>Используя Runa, вы соглашаетесь уважать других участников, не публиковать незаконный контент и не пытаться нарушить работу сервиса. NFT-юзернеймы, подарки и анонимные номера — цифровые объекты внутри Runa.<br><br>Администрация может ограничить доступ за нарушение правил.</div>`;
  } else if (key === 'policy') {
    body = `<div class="set-info-box"><b>Политика конфиденциальности</b><br><br>Мы храним только данные, необходимые для работы мессенджера: профиль, сообщения, настройки и историю операций. Пароли хранятся в виде хэша.<br><br>Мы не продаём данные третьим лицам. Вы можете удалить аккаунт в разделе «Конфиденциальность».</div>`;
  } else if (key === 'support') {
    body = `<div class="set-card">
        <div class="set-row" data-act="support-contact"><span class="set-row-icon" style="background:rgba(10,132,255,.16);color:#64D2FF"><i data-lucide="send"></i></span><div class="set-row-main"><b>Написать в поддержку</b><small>@runachat · отвечаем в течение дня</small></div><i data-lucide="chevron-right" class="set-row-chev"></i></div>
        <div class="set-row" data-act="knowledge-base"><span class="set-row-icon" style="background:rgba(48,209,88,.14);color:#6BE08B"><i data-lucide="book-open"></i></span><div class="set-row-main"><b>База знаний</b><small>Гайды по NFT, подаркам и кланам</small></div><i data-lucide="chevron-right" class="set-row-chev"></i></div>
      </div>
      <p class="set-hint">Опишите проблему и приложите скриншот — так мы ответим быстрее.</p>`;
  }

  pane.innerHTML = settingsHeader(key) + body;
  if (window.lucide) lucide.createIcons();
  if (key === 'memory') fillMemorySize();
  if (key === 'scale') bindScaleSlider();
  if (key === 'appearance') bindAppearance();
}

async function fillMemorySize() {
  const el = $('mem-size');
  if (!el) return;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const mb = (est.usage || 0) / 1048576;
      el.textContent = `${mb < 1 ? '< 1' : mb.toFixed(1)} МБ · офлайн-кэш`;
    } else {
      el.textContent = 'Недоступно в этом браузере';
    }
  } catch (e) { el.textContent = 'Не удалось посчитать'; }
}

function bindScaleSlider() {
  const slider = $('set-scale');
  if (!slider) return;
  const label = $('set-scale-val');
  let timer = null;
  slider.addEventListener('input', () => {
    if (label) label.textContent = `${slider.value}%`;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const ok = await saveUserPatch({ ui_scale: Number(slider.value) }, '');
      if (!ok) slider.value = currentUser.uiScale || 100;
    }, 220);
  });
}

function bindAppearance() {
  const tabs = document.querySelectorAll('#settings-pane .set-tab');
  tabs.forEach(tab => tab.addEventListener('click', () => {
    settingsState.appearanceTab = tab.dataset.appTab;
    renderSettingsPane();
  }));
}

async function saveUserPatch(patch, message) {
  try {
    currentUser = await api('/api/user/update', { method: 'POST', body: patch });
    applyUserSettings();
    updateUserUI();
    if (message) toast(message);
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

function openSettings(section = 'privacy') {
  settingsState.section = section;
  $$('#settings-menu-list .s-item').forEach(b => b.classList.toggle('active', b.dataset.setting === section));
  const modal = $('modal-settings');
  if (modal && modal.style.display !== 'flex') modal.style.display = 'flex';
  renderSettingsPane();
}

function setupSettings() {
  $$('#settings-menu-list .s-item').forEach(item => {
    item.addEventListener('click', () => {
      settingsState.section = item.dataset.setting || 'privacy';
      $$('#settings-menu-list .s-item').forEach(b => b.classList.toggle('active', b === item));
      renderSettingsPane();
    });
  });

  const changeUsername = $('settings-change-username');
  if (changeUsername) changeUsername.addEventListener('click', () => {
    closeAnimated($('modal-settings'));
    openAnimated($('modal-edit-profile'));
    setTimeout(() => {
      const input = $('edit-username-val');
      if (input) { input.focus(); input.select(); }
    }, 220);
  });

  const search = $('settings-search');
  if (search) search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    $$('#settings-menu-list .s-item').forEach(item => {
      item.style.display = !q || item.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  const pane = $('settings-pane');
  if (!pane) return;

  pane.addEventListener('click', async (e) => {
    const lang = e.target.closest('#settings-pane [data-lang]');
    if (lang) {
      const ok = await saveUserPatch({ language: lang.dataset.lang }, 'Язык сохранён');
      if (ok) renderSettingsPane();
      return;
    }
    const theme = e.target.closest('#settings-pane [data-theme-choice]');
    if (theme) {
      const ok = await saveUserPatch({ theme: theme.dataset.themeChoice }, theme.dataset.themeChoice === 'light' ? 'Светлая тема' : 'Тёмная тема');
      if (ok) renderSettingsPane();
      return;
    }
    const wp = e.target.closest('#settings-pane [data-wallpaper]');
    if (wp) {
      const ok = await saveUserPatch({ chat_wallpaper: wp.dataset.wallpaper }, 'Фон чата обновлён');
      if (ok) renderSettingsPane();
      return;
    }
    const pattern = e.target.closest('#settings-pane [data-pattern]');
    if (pattern) {
      const ok = await saveUserPatch({ chat_pattern: pattern.dataset.pattern }, 'Узор обновлён');
      if (ok) renderSettingsPane();
      return;
    }
    const scale = e.target.closest('#settings-pane [data-scale]');
    if (scale) {
      const ok = await saveUserPatch({ ui_scale: Number(scale.dataset.scale) }, 'Масштаб обновлён');
      if (ok) renderSettingsPane();
      return;
    }
    const cursor = e.target.closest('#settings-pane [data-cursor]');
    if (cursor) {
      const ok = await saveUserPatch({ cursor_style: cursor.dataset.cursor }, 'Курсор обновлён');
      if (ok) renderSettingsPane();
      return;
    }
    const font = e.target.closest('#settings-pane [data-font]');
    if (font) {
      const ok = await saveUserPatch({ font_family: font.dataset.font }, 'Шрифт обновлён');
      if (ok) renderSettingsPane();
      return;
    }
    const sound = e.target.closest('#settings-pane [data-sound]');
    if (sound) {
      pane.querySelectorAll('[data-sound]').forEach(el => el.classList.toggle('active', el === sound));
      toast(`Звук: ${sound.dataset.sound}`);
      return;
    }
    const act = e.target.closest('#settings-pane [data-act]');
    if (!act) return;
    const action = act.dataset.act;
    if (action === 'bind-telegram') return toast('Привязка Telegram появится в следующем обновлении');
    if (action === 'support-contact') return copyText('@runachat', 'Контакт поддержки скопирован');
    if (action === 'knowledge-base') return toast('База знаний Runa скоро появится');
    if (action === 'create-folder') {
      const name = prompt('Название папки:');
      if (!name) return;
      let folders = [];
      try { folders = JSON.parse(localStorage.getItem('runa_folders') || '[]'); } catch (e) { folders = []; }
      folders.push(name.slice(0, 24));
      localStorage.setItem('runa_folders', JSON.stringify(folders));
      toast('Папка создана');
      renderSettingsPane();
      return;
    }
    if (action === 'clear-cache') {
      try {
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        toast('Кэш очищен');
        fillMemorySize();
      } catch (err) { toast('Не удалось очистить кэш', 'error'); }
      return;
    }
    if (action === 'save-password') {
      const current = $('sec-current').value;
      const next = $('sec-next').value;
      const repeat = $('sec-repeat').value;
      if (!current || !next) return toast('Заполните все поля', 'error');
      if (next.length < 4) return toast('Пароль слишком короткий', 'error');
      if (next !== repeat) return toast('Пароли не совпадают', 'error');
      try {
        await api('/api/user/password', { method: 'POST', body: { current, next } });
        $('sec-current').value = ''; $('sec-next').value = ''; $('sec-repeat').value = '';
        toast('Пароль изменён');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (action === 'delete-account') {
      if (!confirm('Удалить аккаунт? Это действие необратимо.')) return;
      const password = prompt('Введите пароль для подтверждения:');
      if (!password) return;
      try {
        await api('/api/user/password', { method: 'POST', body: { current: password, next: password } });
        await api('/api/user/me', { method: 'DELETE' });
        logoutLocal();
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  pane.addEventListener('change', async (e) => {
    const t = e.target.closest('[data-toggle]');
    if (!t) return;
    const key = t.dataset.toggle;
    if (key === 'bold') {
      const ok = await saveUserPatch({ bold_text: t.checked }, t.checked ? 'Жирный шрифт включён' : 'Жирный шрифт выключен');
      if (!ok) t.checked = !t.checked;
    } else if (key === 'mic') {
      const ok = await saveUserPatch({ mic: t.checked }, t.checked ? 'Микрофон включён' : 'Микрофон выключен');
      if (!ok) t.checked = !t.checked;
    } else if (key === 'sounds') {
      const ok = await saveUserPatch({ sounds: t.checked }, t.checked ? 'Звуки включены' : 'Звуки выключены');
      if (!ok) t.checked = !t.checked;
    } else if (key === 'animations') {
      localStorage.setItem('runa_no_motion', t.checked ? '0' : '1');
      document.body.classList.toggle('no-motion', !t.checked);
      toast(t.checked ? 'Анимации включены' : 'Анимации отключены');
    } else if (key === 'blur') {
      localStorage.setItem('runa_no_blur', t.checked ? '0' : '1');
      document.body.classList.toggle('no-blur', !t.checked);
      toast(t.checked ? 'Размытие включено' : 'Размытие отключено');
    }
  });
}

async function handleSetting(label) {
  const map = {
    'Язык': 'language', 'Конфиденциальность': 'privacy', 'Устройства': 'devices',
    'Безопасность': 'security', 'Оформление': 'appearance', 'Шрифты': 'fonts',
    'Масштаб': 'scale', 'Микрофон': 'mic', 'Звук уведомлений': 'sounds'
  };
  openSettings(map[label] || 'privacy');
}

/* ================================================================== */
/*  КАРТОЧКА ЮЗЕРНЕЙМА / АНОНИМНОГО НОМЕРА                             */
/* ================================================================== */
let identitySheetData = null;

function identityActionBtn(action, label, icon, cls = '') {
  return `<button type="button" class="identity-btn ${cls}" data-identity-action="${action}">
    <i data-lucide="${icon}"></i><span>${escapeHtml(label)}</span></button>`;
}

async function openIdentitySheet(chip) {
  const modal = $('modal-identity');
  if (!modal) return;
  const kind = chip.dataset.identityKind || 'username';
  const handle = chip.dataset.identityUsername || '';
  const number = chip.dataset.identityNumber || '';
  const userId = chip.dataset.identityUser || '';

  const glyph = $('identity-glyph');
  const title = $('identity-title');
  const kindEl = $('identity-kind');
  const statusEl = $('identity-status');
  const ownerEl = $('identity-owner');
  const factsEl = $('identity-facts');
  const actionsEl = $('identity-actions');
  const noteEl = $('identity-note');

  glyph.className = 'identity-glyph';
  statusEl.innerHTML = '';
  factsEl.innerHTML = '';
  ownerEl.innerHTML = '';
  actionsEl.innerHTML = '';
  noteEl.textContent = '';

  let mine = false;
  let forSale = chip.dataset.identitySale === '1';
  let price = Number(chip.dataset.identityPrice || 0);
  let owner = null;

  if (kind === 'nft') {
    glyph.classList.add('nft');
    glyph.textContent = '✦';
    title.textContent = `@${handle}`;
    title.className = 'identity-title nft';
    kindEl.textContent = 'Коллекционный юзернейм';
    noteEl.textContent = 'По этому имени вас находят и упоминают. Юзернейм нельзя сменить — только носить, убрать в коллекцию или продать.';

    try {
      const items = await api('/api/nft-market?all=1');
      const lot = (items || []).find(n => n.username === handle);
      if (lot) {
        forSale = !!lot.forSale;
        price = Number(lot.price) || 0;
        mine = !!lot.mine;
        owner = { id: lot.ownerId, name: lot.ownerName, username: lot.ownerUsername, avatar: lot.ownerAvatar };
      }
    } catch (e) { /* офлайн — показываем по данным карточки */ }

    if (!owner && currentUser && currentUser.username === handle) {
      mine = true;
      owner = { id: currentUser.id, name: currentUser.displayName, username: currentUser.username, avatar: currentUser.avatar };
    }

    statusEl.innerHTML = forSale
      ? `<span class="identity-status-pill sale"><span class="identity-status-dot"></span>На продаже · ${Number(price).toLocaleString('ru-RU')} 💎</span>`
      : `<span class="identity-status-pill owned"><i data-lucide="check-circle-2"></i>В коллекции</span>`;

    if (owner) {
      ownerEl.innerHTML = `<div class="identity-owner-card">
        <div class="identity-owner-avatar" data-owner-id="${escapeAttr(owner.id || '')}"></div>
        <div class="identity-owner-text">
          <span class="identity-owner-label">Владелец</span>
          <b>${escapeHtml(owner.name || owner.username || '')}</b>
          <small>@${escapeHtml(owner.username || '')}</small>
        </div>
      </div>`;
      const av = ownerEl.querySelector('.identity-owner-avatar');
      paintAvatar(av, owner.avatar, owner.name || owner.username);
    }

    factsEl.innerHTML = `
      <div class="identity-fact"><span>Тип</span><b>NFT · коллекционный</b></div>
      <div class="identity-fact"><span>Адрес</span><b>@${escapeHtml(handle)}</b></div>`;

    actionsEl.innerHTML = [
      identityActionBtn('copy', 'Скопировать имя', 'copy'),
      mine && !forSale ? identityActionBtn('sell', 'Выставить на продажу', 'tag', 'primary') : '',
      mine && forSale ? identityActionBtn('unlist', 'Снять с продажи', 'undo-2') : '',
      !mine && forSale ? identityActionBtn('buy', `Купить за ${Number(price).toLocaleString('ru-RU')} 💎`, 'shopping-bag', 'primary') : '',
      !mine && owner && owner.id ? identityActionBtn('write', 'Написать владельцу', 'message-circle') : ''
    ].join('');
    identitySheetData = { kind, handle, price, mine, forSale, lotId: null };
    try {
      const items = await api('/api/nft-market?all=1');
      const lot = (items || []).find(n => n.username === handle);
      if (lot) identitySheetData.lotId = lot.id;
    } catch (e) { /* ignore */ }
  } else if (kind === 'anon') {
    glyph.classList.add('anon');
    glyph.textContent = '#';
    title.textContent = number;
    title.className = 'identity-title anon';
    kindEl.textContent = 'Анонимный номер';
    noteEl.textContent = 'Номер скрывает ваш настоящий телефон. Его можно показывать в профиле и использовать для входа.';
    statusEl.innerHTML = '<span class="identity-status-pill owned"><i data-lucide="shield-check"></i>Анонимный</span>';
    factsEl.innerHTML = `
      <div class="identity-fact"><span>Формат</span><b>+888 · анонимный</b></div>
      <div class="identity-fact"><span>Видимость</span><b>В профиле</b></div>`;
    const ownNumber = !!(currentUser && currentUser.anonymousNumber === number);
    actionsEl.innerHTML = [
      identityActionBtn('copy', 'Скопировать номер', 'copy'),
      identityActionBtn('call', 'Позвонить', 'phone'),
      ownNumber ? identityActionBtn('remove-anon', 'Удалить номер', 'trash-2', 'danger') : ''
    ].join('');
    identitySheetData = { kind, number, mine: ownNumber };
  } else {
    glyph.classList.add('regular');
    glyph.textContent = '@';
    title.textContent = `@${handle}`;
    title.className = 'identity-title';
    kindEl.textContent = 'Юзернейм';
    noteEl.textContent = 'Основной адрес профиля. По нему вас находят в поиске.';
    mine = !!(currentUser && currentUser.username === handle);
    statusEl.innerHTML = mine
      ? '<span class="identity-status-pill owned"><i data-lucide="check-circle-2"></i>Ваш юзернейм</span>'
      : '<span class="identity-status-pill neutral"><i data-lucide="at-sign"></i>Основной адрес</span>';
    factsEl.innerHTML = `<div class="identity-fact"><span>Адрес</span><b>@${escapeHtml(handle)}</b></div>`;
    actionsEl.innerHTML = [
      identityActionBtn('copy', 'Скопировать', 'copy'),
      !mine && userId ? identityActionBtn('write', 'Написать', 'message-circle', 'primary') : '',
      mine ? identityActionBtn('edit', 'Сменить юзернейм', 'pen-line') : ''
    ].join('');
    identitySheetData = { kind, handle, userId, mine };
  }

  if (window.lucide) lucide.createIcons();
  openAnimated(modal);
}

function setupIdentitySheet() {
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-identity-kind]');
    if (chip) {
      e.preventDefault();
      e.stopPropagation();
      openIdentitySheet(chip);
      return;
    }
    const anonBtn = e.target.closest('[data-anon-action]');
    if (anonBtn) {
      e.preventDefault();
      handleAnonNumberAction(anonBtn.dataset.anonAction);
      return;
    }
    const actionBtn = e.target.closest('[data-identity-action]');
    if (actionBtn && identitySheetData) {
      e.preventDefault();
      handleIdentityAction(actionBtn.dataset.identityAction, identitySheetData);
    }
  });
}

async function handleAnonNumberAction(action) {
  try {
    if (action === 'get') {
      const res = await api('/api/user/anonymous-number', { method: 'POST' });
      currentUser = res.user; updateUserUI();
      toast(`Анонимный номер ${res.anonymousNumber} получен`, 'message');
    }
    if (action === 'remove') {
      if (!confirm('Удалить анонимный номер?')) return;
      const res = await api('/api/user/anonymous-number', { method: 'DELETE' });
      currentUser = res.user; updateUserUI();
      toast('Анонимный номер удалён');
    }
  } catch (err) { toast(err.message, 'error'); }
}

async function handleIdentityAction(action, data) {
  const modal = $('modal-identity');
  const close = () => { if (modal) closeAnimated(modal); };
  try {
    if (action === 'copy') {
      const value = data.kind === 'anon' ? data.number : data.handle;
      await navigator.clipboard.writeText(value);
      toast('Скопировано');
    }
    if (action === 'call') {
      location.href = `tel:${String(data.number || '').replace(/[^\d+]/g, '')}`;
    }
    if (action === 'write' && data.userId) {
      close();
      const chat = await api('/api/chats', { method: 'POST', body: { type: 'dm', userId: data.userId } });
      const list = await api('/api/chats');
      chats = list; renderChats(); openChatById(chat.id);
    }
    if (action === 'edit') {
      close();
      openAnimated($('modal-edit-profile'));
      setTimeout(() => { const i = $('edit-username-val'); if (i) { i.focus(); i.select(); } }, 220);
    }
    if (action === 'sell' && data.lotId) {
      const raw = prompt(`Цена для @${data.handle} в рубинах:`, '1000');
      if (raw === null) return;
      const price = Math.floor(Number(raw));
      if (!Number.isFinite(price) || price < 1) return toast('Введите цену больше нуля', 'error');
      const res = await api(`/api/nft/${encodeURIComponent(data.lotId)}/sell`, { method: 'POST', body: { price } });
      currentUser = res.user; updateUserUI();
      toast(`@${data.handle} выставлен на продажу за ${price} 💎`, 'message');
      close();
    }
    if (action === 'unlist' && data.lotId) {
      const res = await api(`/api/nft/${encodeURIComponent(data.lotId)}/unlist`, { method: 'POST' });
      currentUser = res.user; updateUserUI();
      toast('Лот снят с продажи');
      close();
    }
    if (action === 'buy' && data.lotId) {
      if (!confirm(`Купить @${data.handle} за ${Number(data.price).toLocaleString('ru-RU')} рубинов?`)) return;
      const res = await api(`/api/nft/${encodeURIComponent(data.lotId)}/buy`, { method: 'POST' });
      currentUser = res.user; updateUserUI();
      toast(`Юзернейм @${data.handle} теперь ваш`, 'message');
      close();
    }
    if (action === 'remove-anon') {
      if (!confirm('Удалить анонимный номер из профиля?')) return;
      const res = await api('/api/user/anonymous-number', { method: 'DELETE' });
      currentUser = res.user; updateUserUI();
      toast('Анонимный номер удалён');
      close();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ================================================================== */
/*  ПОДАРКИ                                                           */
/* ================================================================== */
let giftsTab = 'catalog';
let lastGiftCatalog = [];

const GIFTS_EMPTY = {
  catalog: {
    icon: 'gift',
    title: 'Подарки скоро появятся',
    text: 'Мы готовим коллекцию подарков. Как только она будет готова — вы увидите её здесь.',
    action: ''
  },
  received: {
    icon: 'inbox',
    title: 'Пока нет подарков',
    text: 'Когда друзья отправят вам подарок, он появится в этом разделе.',
    action: ''
  },
  sent: {
    icon: 'send',
    title: 'Вы ещё не отправляли подарки',
    text: 'Отправленные подарки будут храниться здесь.',
    action: ''
  }
};

function giftsEmptyHtml(tab) {
  const e = GIFTS_EMPTY[tab] || GIFTS_EMPTY.catalog;
  return `<div class="gifts-empty">
    <div class="gifts-empty-icon"><i data-lucide="${e.icon}"></i></div>
    <h3>${escapeHtml(e.title)}</h3>
    <p>${escapeHtml(e.text)}</p>
    <span class="gifts-soon-pill"><i data-lucide="sparkles"></i> Скоро</span>
  </div>`;
}

function giftMediaHtml(g) {
  const url = String(g.fileUrl || '');
  const type = String(g.fileType || '').toLowerCase();
  const lower = url.toLowerCase();
  if (url && (type === 'tgs' || lower.endsWith('.tgs') || type === 'lottie' || lower.endsWith('.json'))) {
    return `<div class="gift-lottie" data-gift-url="${escapeAttr(url)}" data-gift-type="${escapeAttr(type)}"></div>`;
  }
  if (url && (type === 'image' || /\.(png|jpe?g|webp|gif|svg)$/.test(lower))) {
    return `<img src="${escapeAttr(url)}" alt="${escapeAttr(g.title || 'Подарок')}" loading="lazy">`;
  }
  return `<div class="gift-emoji">${escapeHtml(g.emoji || '🎁')}</div>`;
}

function mountGiftAnimations(root) {
  if (!root || !window.lottie || !window.pako) return;
  root.querySelectorAll('[data-gift-url]').forEach(async (el) => {
    if (el.dataset.mounted === '1') return;
    el.dataset.mounted = '1';
    const url = el.dataset.giftUrl;
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const json = JSON.parse(pako.ungzip(new Uint8Array(buf), { to: 'string' }));
      el.innerHTML = '';
      lottie.loadAnimation({ container: el, renderer: 'svg', loop: true, autoplay: true, animationData: json });
    } catch (e) {
      el.innerHTML = '<div class="gift-emoji">🎁</div>';
    }
  });
}

async function openGifts(tab = giftsTab) {
  giftsTab = tab;
  const modal = $('modal-gifts');
  if (!modal) return;
  $$('#gifts-tabs .gifts-tab').forEach(t => t.classList.toggle('active', t.dataset.giftsTab === tab));
  const body = $('gifts-body');
  body.innerHTML = '<div class="gifts-loading"><span class="gifts-spinner"></span>Загрузка…</div>';
  openAnimated(modal);

  try {
    if (tab === 'catalog') {
      const items = await api('/api/gifts');
      lastGiftCatalog = items || [];
      body.innerHTML = items && items.length
        ? `<div class="gifts-grid">${items.map(g => `
            <div class="gift-card" data-gift-id="${escapeAttr(g.id)}" role="button" tabindex="0" title="Подарить">
              <div class="gift-media">${giftMediaHtml(g)}</div>
              <b>${escapeHtml(g.title)}</b>
              <span class="gift-price">${Number(g.price).toLocaleString('ru-RU')} 💎</span>
              <span class="gift-send-hint">Подарить</span>
            </div>`).join('')}</div>`
        : giftsEmptyHtml('catalog');
    } else if (tab === 'received') {
      const items = await api('/api/gifts/received');
      body.innerHTML = items && items.length
        ? `<div class="gifts-grid">${items.map(g => `
            <div class="gift-card received">
              <div class="gift-media">${giftMediaHtml(g)}</div>
              <b>${escapeHtml(g.title)}</b>
              <small>${g.anonymous ? 'Анонимно' : 'от @' + escapeHtml(g.from ? g.from.username : '')}</small>
            </div>`).join('')}</div>`
        : giftsEmptyHtml('received');
    } else {
      const items = await api('/api/gifts/sent');
      body.innerHTML = items && items.length
        ? `<div class="gifts-grid">${items.map(g => `
            <div class="gift-card sent">
              <div class="gift-media">${giftMediaHtml(g)}</div>
              <b>${escapeHtml(g.title)}</b>
              <small>${g.anonymous ? 'Анонимно' : 'для @' + escapeHtml(g.to ? g.to.username : '')}</small>
            </div>`).join('')}</div>`
        : giftsEmptyHtml('sent');
    }
  } catch (e) {
    body.innerHTML = giftsEmptyHtml(tab);
  }
  body.querySelectorAll('.gift-card[data-gift-id]').forEach(card => {
    const open = () => {
      const gift = lastGiftCatalog.find(g => g.id === card.dataset.giftId);
      if (gift) openGiftSend(gift);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  mountGiftAnimations(body);
  if (window.lucide) lucide.createIcons();
}

function openGiftSend(gift, opts = {}) {
  document.querySelectorAll('.gift-send-backdrop').forEach(el => el.remove());
  const back = document.createElement('div');
  back.className = 'msg-sheet-backdrop gift-send-backdrop';
  back.innerHTML = `<div class="gift-send-sheet">
    <div class="gift-send-head">
      <div class="gift-send-preview">${giftMediaHtml(gift)}</div>
      <div class="gift-send-title">
        <b>${escapeHtml(gift.title)}</b>
        <span>${Number(gift.price).toLocaleString('ru-RU')} 💎</span>
        <small>${escapeHtml(gift.description || 'Коллекционный подарок')}</small>
      </div>
      <button type="button" class="gift-self-btn" data-gift-self title="Подарить этот подарок себе"><i data-lucide="user-round"></i> Себе</button>
    </div>
    <div class="create-field">
      <label>Кому подарить</label>
      <input type="text" id="gift-send-to" placeholder="@username" autocomplete="off" spellcheck="false">
    </div>
    <div class="create-field">
      <label>Сообщение</label>
      <textarea id="gift-send-message" rows="2" maxlength="200" placeholder="Необязательно"></textarea>
    </div>
    <label class="gift-send-anon"><input type="checkbox" id="gift-send-anon"> Отправить анонимно</label>
    <button type="button" class="mac-btn primary-purple gift-send-submit" id="gift-send-submit">Подарить за ${Number(gift.price).toLocaleString('ru-RU')} 💎</button>
    <button type="button" class="msg-sheet-cancel" data-gift-send-close>Отмена</button>
  </div>`;
  document.body.appendChild(back);
  mountGiftAnimations(back);
  if (window.lucide) lucide.createIcons();

  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.querySelector('[data-gift-send-close]').addEventListener('click', close);
  const toInput = $('gift-send-to');
  if (toInput && opts.self && currentUser) toInput.value = currentUser.username;
  const selfBtn = back.querySelector('[data-gift-self]');
  if (selfBtn) selfBtn.addEventListener('click', () => {
    if (!currentUser) return;
    toInput.value = currentUser.username;
    toast('Получатель — вы. Подарок появится в вашем профиле.', 'info');
  });
  const submit = $('gift-send-submit');
  submit.addEventListener('click', async () => {
    const username = $('gift-send-to').value.trim().replace(/^@/, '');
    if (!username) { toast('Введите юзернейм получателя', 'error'); return; }
    try {
      submit.disabled = true;
      await api('/api/gifts/send', {
        method: 'POST',
        body: {
          giftId: gift.id,
          username,
          message: $('gift-send-message').value.trim(),
          anonymous: $('gift-send-anon').checked
        }
      });
      close();
      const toSelf = currentUser && username === currentUser.username;
      toast(toSelf ? `Подарок «${gift.title}» добавлен в ваш профиль` : `Подарок «${gift.title}» отправлен`, 'message');
      if (window.refreshOpenProfileSocial) window.refreshOpenProfileSocial();
      openGifts(toSelf ? 'received' : 'sent');
    } catch (err) {
      toast(err.message, 'error');
    } finally { submit.disabled = false; }
  });
}

function setupGifts() {
  const modal = $('modal-gifts');
  if (!modal) return;
  $$('#gifts-tabs .gifts-tab').forEach(tab => {
    tab.addEventListener('click', () => openGifts(tab.dataset.giftsTab));
  });
}

/* ================================================================== */
/*  СОЗДАНИЕ ГРУППЫ / КАНАЛА                                          */
/* ================================================================== */
const createChatState = { step: 1, type: 'group', title: '', about: '', avatar: '', username: '' };

function createChatDots() {
  $$('#create-chat-steps .create-step-dot').forEach((d, i) => d.classList.toggle('active', i < createChatState.step));
}

function createChatStepHtml() {
  const s = createChatState;
  if (s.step === 1) {
    return `<div class="create-step">
      <h3 class="create-step-title">Что создаём?</h3>
      <p class="create-step-sub">Группа — для общения. Канал — для публикаций на аудиторию.</p>
      <div class="create-type-grid">
        <button type="button" class="create-type-card ${s.type === 'group' ? 'active' : ''}" data-create-type="group">
          <span class="create-type-icon group"><i data-lucide="users"></i></span>
          <b>Группа</b>
          <small>До 200 000 участников. Все могут писать.</small>
        </button>
        <button type="button" class="create-type-card ${s.type === 'channel' ? 'active' : ''}" data-create-type="channel">
          <span class="create-type-icon channel"><i data-lucide="megaphone"></i></span>
          <b>Канал</b>
          <small>Публикации для подписчиков. Пишут админы.</small>
        </button>
      </div>
    </div>`;
  }
  if (s.step === 2) {
    return `<div class="create-step">
      <h3 class="create-step-title">${s.type === 'channel' ? 'Название канала' : 'Название группы'}</h3>
      <p class="create-step-sub">Так вас увидят в поиске и в списке чатов.</p>
      <div class="create-avatar-row">
        <button type="button" class="create-avatar" id="create-avatar-btn">
          ${s.avatar ? `<img src="${escapeAttr(s.avatar)}" alt="">` : '<i data-lucide="camera"></i>'}
        </button>
        <div class="create-avatar-hint"><b>Аватар</b><small>Необязательно. Можно добавить позже.</small></div>
      </div>
      <input type="file" id="create-avatar-input" accept="image/*" style="display:none">
      <div class="create-field">
        <label>Название</label>
        <input type="text" id="create-title-input" maxlength="80" placeholder="${s.type === 'channel' ? 'Например, Runa News' : 'Например, Друзья'}" value="${escapeAttr(s.title)}">
      </div>
      <div class="create-field">
        <label>Описание</label>
        <textarea id="create-about-input" maxlength="300" rows="3" placeholder="Пара слов о ${s.type === 'channel' ? 'канале' : 'группе'}">${escapeHtml(s.about)}</textarea>
      </div>
    </div>`;
  }
  return `<div class="create-step">
    <h3 class="create-step-title">Публичная ссылка</h3>
    <p class="create-step-sub">Необязательно. С короткой ссылкой вас смогут найти и присоединиться.</p>
    <div class="create-field">
      <label>Ссылка</label>
      <div class="username-input-row">
        <span class="static-prefix">@</span>
        <input type="text" id="create-username-input" maxlength="32" autocomplete="off" spellcheck="false" placeholder="runa_news" value="${escapeAttr(s.username)}">
        <span class="username-status" id="create-username-status"></span>
      </div>
      <span class="field-hint" id="create-username-hint">3–32 символа: латиница, цифры и _</span>
    </div>
    <div class="create-summary">
      <div class="create-summary-icon ${s.type}"><i data-lucide="${s.type === 'channel' ? 'megaphone' : 'users'}"></i></div>
      <div>
        <b>${escapeHtml(s.title || (s.type === 'channel' ? 'Новый канал' : 'Новая группа'))}</b>
        <small>${s.type === 'channel' ? 'Канал' : 'Группа'}${s.username ? ' · @' + escapeHtml(s.username) : ' · приватная'}</small>
      </div>
    </div>
    <p class="create-note"><i data-lucide="info"></i> Вы станете владельцем и сможете менять название, аватар и участников.</p>
  </div>`;
}

function renderCreateChat() {
  const body = $('create-chat-body');
  if (!body) return;
  body.innerHTML = createChatStepHtml();
  createChatDots();
  const title = $('create-chat-title');
  if (title) title.textContent = createChatState.step === 1 ? 'Новый чат' : createChatState.step === 2 ? 'Оформление' : 'Публичная ссылка';
  const next = $('create-chat-next');
  if (next) next.textContent = createChatState.step === 3 ? 'Создать' : 'Далее';
  const back = $('create-chat-back');
  if (back) back.style.visibility = createChatState.step === 1 ? 'hidden' : 'visible';
  if (window.lucide) lucide.createIcons();
  wireCreateChatStep();
}

function wireCreateChatStep() {
  $$('[data-create-type]').forEach(btn => btn.addEventListener('click', () => {
    createChatState.type = btn.dataset.createType;
    renderCreateChat();
  }));
  const avatarBtn = $('create-avatar-btn');
  const avatarInput = $('create-avatar-input');
  if (avatarBtn && avatarInput) {
    avatarBtn.addEventListener('click', () => avatarInput.click());
    avatarInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await api('/api/upload', { method: 'POST', body: fd });
        createChatState.avatar = res.url;
        renderCreateChat();
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  const titleInput = $('create-title-input');
  if (titleInput) titleInput.addEventListener('input', () => { createChatState.title = titleInput.value; });
  const aboutInput = $('create-about-input');
  if (aboutInput) aboutInput.addEventListener('input', () => { createChatState.about = aboutInput.value; });
  const uname = $('create-username-input');
  if (uname) {
    let timer = null;
    uname.addEventListener('input', () => {
      const clean = uname.value.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '');
      if (uname.value !== clean) uname.value = clean;
      createChatState.username = clean;
      const st = $('create-username-status');
      const hint = $('create-username-hint');
      clearTimeout(timer);
      if (!clean) { if (st) st.textContent = ''; if (hint) { hint.textContent = 'Можно оставить пустым'; hint.className = 'field-hint'; } return; }
      if (!/^[a-z0-9_]{3,32}$/.test(clean)) {
        if (st) { st.textContent = '✕'; st.className = 'username-status bad'; }
        if (hint) { hint.textContent = '3–32 символа: латиница, цифры и _'; hint.className = 'field-hint bad'; }
        return;
      }
      if (st) { st.textContent = '…'; st.className = 'username-status checking'; }
      timer = setTimeout(async () => {
        try {
          const res = await api(`/api/chats/username/check?username=${encodeURIComponent(clean)}`);
          if (uname.value !== clean) return;
          if (st) { st.textContent = res.available ? '✓' : '✕'; st.className = `username-status ${res.available ? 'ok' : 'bad'}`; }
          if (hint) { hint.textContent = res.available ? 'Свободна — можно создавать' : (res.reason || 'Занята'); hint.className = `field-hint ${res.available ? 'ok' : 'bad'}`; }
        } catch (err) { if (st) st.textContent = ''; }
      }, 320);
    });
  }
}

function openCreateChat(type = 'group') {
  createChatState.step = 1;
  createChatState.type = type;
  createChatState.title = '';
  createChatState.about = '';
  createChatState.avatar = '';
  createChatState.username = '';
  renderCreateChat();
  openAnimated($('modal-create-chat'));
}

function setupCreateChat() {
  const next = $('create-chat-next');
  const back = $('create-chat-back');
  if (!next || !back) return;
  next.addEventListener('click', async () => {
    const s = createChatState;
    if (s.step === 1) { s.step = 2; renderCreateChat(); return; }
    if (s.step === 2) {
      if (!s.title.trim()) { toast('Введите название', 'error'); return; }
      s.step = 3; renderCreateChat(); return;
    }
    try {
      next.disabled = true;
      const data = await api('/api/chats', {
        method: 'POST',
        body: {
          type: s.type,
          title: s.title.trim(),
          about: s.about.trim(),
          avatar: s.avatar,
          username: s.username || undefined
        }
      });
      const list = await api('/api/chats');
      chats = list; renderChats();
      closeAnimated($('modal-create-chat'));
      toast(s.type === 'channel' ? 'Канал создан' : 'Группа создана', 'message');
      openChatById(data.id);
    } catch (err) {
      toast(err.message, 'error');
    } finally { next.disabled = false; }
  });
  back.addEventListener('click', () => {
    if (createChatState.step > 1) { createChatState.step -= 1; renderCreateChat(); }
  });
}

/* ================================================================== */
/*  ИЗБРАННОЕ                                                         */
/* ================================================================== */
async function openSavedMessages() {
  try {
    const res = await api('/api/chats/saved', { method: 'POST' });
    const list = await api('/api/chats');
    chats = list; renderChats();
    openChatById(res.id);
  } catch (err) { toast(err.message, 'error'); }
}

/* ================================================================== */
/*  ОТВЕТ СВАЙПОМ                                                     */
/* ================================================================== */
function setupSwipeReply() {
  const stream = $('chat-messages-stream');
  if (!stream) return;
  let active = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let locked = null;

  const reset = (row) => {
    if (!row) return;
    row.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)';
    row.style.transform = '';
    const hint = row.querySelector('.swipe-reply-hint');
    if (hint) hint.style.opacity = '0';
    setTimeout(() => { row.style.transition = ''; }, 220);
  };

  stream.addEventListener('touchstart', (e) => {
    const row = e.target.closest('.msg-row');
    if (!row || !e.touches.length) return;
    if (e.target.closest('button, a, img, .msg-reactions, .msg-reply-quote')) { active = null; return; }
    active = row;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = 0; locked = null;
    if (!row.querySelector('.swipe-reply-hint')) {
      const hint = document.createElement('div');
      hint.className = 'swipe-reply-hint';
      hint.innerHTML = '<i data-lucide="reply"></i>';
      row.appendChild(hint);
      if (window.lucide) lucide.createIcons();
    }
  }, { passive: true });

  stream.addEventListener('touchmove', (e) => {
    if (!active || !e.touches.length) return;
    const mx = e.touches[0].clientX - startX;
    const my = e.touches[0].clientY - startY;
    if (locked === null) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      locked = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
    }
    if (locked !== 'x') return;
    dx = Math.max(0, Math.min(88, mx * 0.9));
    if (dx > 4) {
      active.style.transition = 'none';
      active.style.transform = `translateX(${dx}px)`;
      const hint = active.querySelector('.swipe-reply-hint');
      if (hint) hint.style.opacity = String(Math.min(1, dx / 56));
    }
  }, { passive: true });

  const finish = () => {
    if (!active) return;
    const row = active;
    const fired = dx > 56;
    active = null;
    reset(row);
    if (fired) {
      const bubble = row.querySelector('.bubble');
      const id = bubble && bubble.dataset.id;
      const msg = id && messageCache.get(id);
      if (msg) {
        startReply(msg);
        if (navigator.vibrate) navigator.vibrate(8);
      }
    }
    dx = 0; locked = null;
  };
  stream.addEventListener('touchend', finish);
  stream.addEventListener('touchcancel', finish);
}

/* ================================================================== */
/*  КАСТОМИЗАЦИЯ: ПОИСК, КАДР АВАТАРА, ПРЕДПРОСМОТР                   */
/* ================================================================== */
const AVATAR_ADJUST_DEFAULT = { scale: 100, brightness: 135, contrast: 150, saturate: 100, warmth: 100, flip: false };
const AVATAR_ADJUST_LABELS = {
  'Масштаб': 'scale',
  'Яркость': 'brightness',
  'Контраст': 'contrast',
  'Насыщенность': 'saturate',
  'Теплота': 'warmth'
};

function avatarAdjustKey() {
  return `runa_avatar_adjust_${currentUser ? currentUser.id : 'guest'}`;
}

function loadAvatarAdjust() {
  try {
    const raw = localStorage.getItem(avatarAdjustKey());
    if (!raw) return { ...AVATAR_ADJUST_DEFAULT };
    return { ...AVATAR_ADJUST_DEFAULT, ...JSON.parse(raw) };
  } catch (e) {
    return { ...AVATAR_ADJUST_DEFAULT };
  }
}

function applyAvatarAdjust(settings) {
  const s = settings || loadAvatarAdjust();
  const filters = [
    `brightness(${Number(s.brightness) || 100}%)`,
    `contrast(${Number(s.contrast) || 100}%)`,
    `saturate(${Number(s.saturate) || 100}%)`
  ];
  const warmth = Number(s.warmth) || 0;
  if (warmth >= 0) filters.push(`sepia(${(warmth / 100 * 0.45).toFixed(3)})`);
  else filters.push(`hue-rotate(${(warmth * 0.25).toFixed(1)}deg)`);
  const transform = `scale(${(Number(s.scale) || 100) / 100})${s.flip ? ' scaleX(-1)' : ''}`;
  [$('custom-avatar-preview'), document.querySelector('.live-avatar-giant')].forEach(el => {
    if (!el) return;
    const target = el.querySelector('img') || el;
    target.style.filter = filters.join(' ');
    target.style.transform = transform;
    target.style.transformOrigin = 'center';
  });
}

function syncAvatarAdjustControls(settings) {
  const s = settings || loadAvatarAdjust();
  const controls = $('avatar-adjust-controls');
  if (!controls) return;
  controls.querySelectorAll('.slider-row').forEach(row => {
    const label = row.querySelector('label');
    const input = row.querySelector('input[type="range"]');
    const val = row.querySelector('.slider-val');
    const key = label ? AVATAR_ADJUST_LABELS[label.textContent.trim()] : null;
    if (!key || !input) return;
    input.value = s[key];
    if (val) val.textContent = key === 'warmth'
      ? (Number(s[key]) >= 0 ? `+${s[key]}` : String(s[key]))
      : `${s[key]}%`;
  });
  const flip = $('avatar-adjust-flip');
  if (flip) flip.checked = !!s.flip;
}

function setupCustomizationExtras() {
  const search = document.querySelector('#modal-customization .custom-search input');
  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      $$('.custom-tab-btn').forEach(btn => {
        const match = !q || btn.textContent.toLowerCase().includes(q);
        btn.style.display = match ? '' : 'none';
      });
    });
  }

  const controls = $('avatar-adjust-controls');
  if (controls) {
    controls.querySelectorAll('.slider-row').forEach(row => {
      const label = row.querySelector('label');
      const input = row.querySelector('input[type="range"]');
      const val = row.querySelector('.slider-val');
      const key = label ? AVATAR_ADJUST_LABELS[label.textContent.trim()] : null;
      if (!key || !input) return;
      input.addEventListener('input', () => {
        const s = loadAvatarAdjust();
        s[key] = Number(input.value);
        if (val) val.textContent = key === 'warmth'
          ? (s[key] >= 0 ? `+${s[key]}` : String(s[key]))
          : `${s[key]}%`;
        applyAvatarAdjust(s);
      });
    });
    const flip = $('avatar-adjust-flip');
    if (flip) flip.addEventListener('change', () => {
      const s = loadAvatarAdjust();
      s.flip = flip.checked;
      applyAvatarAdjust(s);
    });
    const reset = $('btn-avatar-adjust-reset');
    if (reset) reset.addEventListener('click', () => {
      localStorage.removeItem(avatarAdjustKey());
      const s = { ...AVATAR_ADJUST_DEFAULT };
      syncAvatarAdjustControls(s);
      applyAvatarAdjust(s);
      toast('Настройки кадра сброшены');
    });
    const save = $('btn-avatar-adjust-save');
    if (save) save.addEventListener('click', () => {
      localStorage.setItem(avatarAdjustKey(), JSON.stringify(loadAvatarAdjust()));
      applyAvatarAdjust();
      toast('Кадр аватара сохранён');
    });
  }

  const previewSwitch = $('preview-mode-switch');
  if (previewSwitch) {
    previewSwitch.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        previewSwitch.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        const chatMode = btn.dataset.previewMode === 'chat';
        const card = $('live-preview-card');
        const chat = $('live-chat-mock');
        if (card) card.style.display = chatMode ? 'none' : '';
        if (chat) chat.style.display = chatMode ? 'flex' : 'none';
        const note = document.querySelector('.preview-disclaimer');
        if (note) note.textContent = chatMode
          ? 'Так ваши сообщения выглядят в чате'
          : 'Так вас видят все, кто открыл профиль';
      });
    });
  }

  syncAvatarAdjustControls();
  applyAvatarAdjust();
}

/* ================================================================== */
/*  МОБИЛЬНОЕ МЕНЮ СООБЩЕНИЯ (долгое нажатие)                         */
/* ================================================================== */
function openMessageActionsSheet(bubble) {
  if (!bubble) return;
  const msg = messageCache.get(bubble.dataset.id);
  if (!msg) return;
  const isMe = msg.sender_id === currentUser.id;
  const canDelete = isMe || currentUser.isAdmin;
  document.querySelectorAll('.msg-sheet-backdrop').forEach(el => el.remove());

  const back = document.createElement('div');
  back.className = 'msg-sheet-backdrop';
  back.innerHTML = `<div class="msg-sheet" role="dialog" aria-label="Действия с сообщением">
    <div class="msg-sheet-preview">${escapeHtml(messagePreviewText(msg) || 'Сообщение').slice(0, 120)}</div>
    <button type="button" data-sheet-action="reply"><i data-lucide="reply"></i><span>Ответить</span></button>
    <button type="button" data-sheet-action="react"><i data-lucide="smile-plus"></i><span>Реакция</span></button>
    ${msg.text ? '<button type="button" data-sheet-action="copy"><i data-lucide="copy"></i><span>Скопировать текст</span></button>' : ''}
    ${canDelete ? '<button type="button" class="danger" data-sheet-action="delete"><i data-lucide="trash-2"></i><span>Удалить</span></button>' : ''}
    <button type="button" class="cancel" data-sheet-action="cancel">Отмена</button>
  </div>`;
  document.body.appendChild(back);
  if (window.lucide) lucide.createIcons();

  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.querySelectorAll('[data-sheet-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.sheetAction;
      close();
      if (action === 'reply') startReply(msg);
      if (action === 'react') openReactionPicker(msg.id, bubble);
      if (action === 'copy') {
        try { await navigator.clipboard.writeText(msg.text || ''); toast('Текст скопирован'); }
        catch (e) { toast('Не удалось скопировать', 'error'); }
      }
      if (action === 'delete' && confirm('Удалить сообщение?')) {
        socket.emit('delete_message', { messageId: msg.id });
      }
    });
  });
  if (navigator.vibrate) navigator.vibrate(6);
}

function setupMessageLongPress() {
  const stream = $('chat-messages-stream');
  if (!stream) return;
  let timer = null;
  let startX = 0;
  let startY = 0;
  let bubble = null;

  const clear = () => { clearTimeout(timer); timer = null; bubble = null; };

  stream.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const target = e.target.closest('.bubble');
    if (!target) return;
    if (e.target.closest('button, a, .msg-reply-quote')) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    bubble = target;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!bubble) return;
      const b = bubble;
      clear();
      openMessageActionsSheet(b);
    }, 480);
  }, { passive: true });

  stream.addEventListener('touchmove', (e) => {
    if (!timer || !e.touches.length) return;
    const dx = Math.abs(e.touches[0].clientX - startX);
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > 9 || dy > 9) clear();
  }, { passive: true });

  stream.addEventListener('touchend', clear);
  stream.addEventListener('touchcancel', clear);
}
