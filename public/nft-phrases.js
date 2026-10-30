/* Коллекционные фразы: сервер выдаёт шанс и определяет результат игры. */
'use strict';

const PHRASE_UI = {
  offer: null,
  queued: null,
  busy: false,
  outcome: null,
  version: 0,
  previousFocus: null,
  retryText: null,
  resultTimer: null
};

function showPhraseOffer(offer) {
  if (!offer || !offer.id || !currentUser) return;
  if (PHRASE_UI.busy || PHRASE_UI.outcome || PHRASE_UI.retryText) {
    if (!PHRASE_UI.offer || PHRASE_UI.offer.id !== offer.id) PHRASE_UI.queued = offer;
    return;
  }
  const modal = $('modal-nft-phrase');
  if (PHRASE_UI.offer && PHRASE_UI.offer.id === offer.id && modal.style.display !== 'none') return;
  PHRASE_UI.version++;
  if (modal.style.display === 'none') PHRASE_UI.previousFocus = document.activeElement;
  PHRASE_UI.offer = offer;
  PHRASE_UI.outcome = null;
  PHRASE_UI.retryText = null;
  $('nft-phrase-compose').hidden = false;
  $('nft-phrase-game').hidden = true;
  $('nft-phrase-input').value = '';
  $('nft-phrase-input').readOnly = false;
  $('nft-phrase-count').textContent = '0 / 120';
  const deadline = new Date(offer.expiresAt);
  $('nft-phrase-deadline').textContent = Number.isNaN(deadline.getTime())
    ? 'Шанс доступен 24 часа · при результате «Нет» фраза сбросится'
    : `Шанс действует до ${deadline.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · при результате «Нет» фраза сбросится`;
  $('nft-phrase-spin').innerHTML = 'Испытать удачу <span aria-hidden="true">↗</span>';
  $('nft-phrase-spin').disabled = false;
  $('nft-phrase-skip').disabled = false;
  openAnimated(modal);
  setTimeout(() => { if (modal.style.display !== 'none') $('nft-phrase-input').focus(); }, 80);
}

function hidePhraseOffer() {
  clearTimeout(PHRASE_UI.resultTimer);
  PHRASE_UI.version++;
  PHRASE_UI.offer = null;
  PHRASE_UI.busy = false;
  PHRASE_UI.outcome = null;
  PHRASE_UI.retryText = null;
  $('modal-nft-phrase').style.display = 'none';
  if (PHRASE_UI.previousFocus && PHRASE_UI.previousFocus.isConnected) PHRASE_UI.previousFocus.focus();
  PHRASE_UI.previousFocus = null;
}

async function syncPhraseOffer() {
  if (!token || !currentUser || PHRASE_UI.busy || PHRASE_UI.outcome || PHRASE_UI.retryText) return;
  const version = PHRASE_UI.version;
  try {
    const data = await api('/api/nft-phrases/offer');
    if (version !== PHRASE_UI.version || PHRASE_UI.busy || PHRASE_UI.outcome || PHRASE_UI.retryText) return;
    if (data.offer) showPhraseOffer(data.offer);
    else if (PHRASE_UI.offer) hidePhraseOffer();
  } catch (e) {
    // Keep the current draft if the network is temporarily unavailable.
  }
}

function showQueuedPhraseOffer() {
  const next = PHRASE_UI.queued;
  PHRASE_UI.queued = null;
  if (next) showPhraseOffer(next);
  else syncPhraseOffer();
}

async function skipPhraseOffer() {
  if (!PHRASE_UI.offer || PHRASE_UI.busy) return;
  const id = PHRASE_UI.offer.id;
  PHRASE_UI.busy = true;
  $('nft-phrase-skip').disabled = true;
  $('nft-phrase-spin').disabled = true;
  try {
    await api(`/api/nft-phrases/offer/${encodeURIComponent(id)}`, { method: 'DELETE' });
    hidePhraseOffer();
    showQueuedPhraseOffer();
  } catch (err) {
    PHRASE_UI.busy = false;
    $('nft-phrase-skip').disabled = false;
    $('nft-phrase-spin').disabled = false;
    toast(err.message, 'error');
    if (err.status === 404) PHRASE_UI.retryText = null;
    syncPhraseOffer();
  }
}

function animatePhraseResult(result) {
  const won = result.result === 'yes';
  const reel = $('nft-phrase-reel');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const target = won ? 16 : 17;
  reel.innerHTML = Array.from({ length: 18 }, (_, i) => `<div class="nft-phrase-reel-item ${i % 2 ? 'no' : 'yes'}">${i % 2 ? 'НЕТ' : 'ДА'}</div>`).join('');
  reel.style.transition = 'none';
  reel.style.transform = 'translateY(0)';
  $('nft-phrase-compose').hidden = true;
  $('nft-phrase-game').hidden = false;
  $('nft-phrase-result').textContent = 'Прокручиваем…';
  $('nft-phrase-finish').hidden = true;
  // The server's answer determines the stopping position; the animation never
  // makes or changes the random decision.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    reel.style.transition = reduce ? 'none' : 'transform 2.8s cubic-bezier(.13,.67,.13,1)';
    reel.style.transform = `translateY(-${target * 56}px)`;
  }));
  PHRASE_UI.resultTimer = setTimeout(() => {
    PHRASE_UI.outcome = result.result;
    $('nft-phrase-result').textContent = won
      ? 'Да! NFT-фраза уже в вашем профиле.'
      : 'Нет. Фраза сброшена — продолжайте общаться, и удача вернётся.';
    const finish = $('nft-phrase-finish');
    finish.textContent = won ? 'Посмотреть в профиле' : 'Продолжить общение';
    finish.hidden = false;
    finish.focus();
    if (won && window.refreshPhraseProfiles) window.refreshPhraseProfiles([currentUser.id]);
  }, reduce ? 30 : 2900);
}

async function spinPhraseOffer(event) {
  event.preventDefault();
  if (!PHRASE_UI.offer || PHRASE_UI.busy) return;
  const text = PHRASE_UI.retryText || $('nft-phrase-input').value.trim();
  if (!text || text.length > 120 || /[\u0000-\u001f\u007f]/.test(text)) {
    toast('Введите фразу длиной от 1 до 120 символов в одной строке', 'error');
    $('nft-phrase-input').focus();
    return;
  }
  const id = PHRASE_UI.offer.id;
  PHRASE_UI.busy = true;
  $('nft-phrase-spin').disabled = true;
  $('nft-phrase-skip').disabled = true;
  try {
    const result = await api(`/api/nft-phrases/offer/${encodeURIComponent(id)}/spin`, { method: 'POST', body: { text } });
    animatePhraseResult(result);
  } catch (err) {
    PHRASE_UI.busy = false;
    $('nft-phrase-spin').disabled = false;
    $('nft-phrase-skip').disabled = false;
    if (!err.status || err.status >= 500) {
      // The server may have completed the spin even if the response was lost.
      // Retrying the same offer returns that outcome instead of rerolling.
      PHRASE_UI.retryText = text;
      $('nft-phrase-input').readOnly = true;
      $('nft-phrase-spin').textContent = 'Повторить запрос результата';
      toast('Не удалось получить ответ. Повторите запрос, чтобы увидеть тот же результат.', 'error');
    } else {
      PHRASE_UI.retryText = null;
      $('nft-phrase-input').readOnly = false;
      $('nft-phrase-spin').innerHTML = 'Испытать удачу <span aria-hidden="true">↗</span>';
      toast(err.message, 'error');
      if (err.status === 404) syncPhraseOffer();
    }
  }
}

function finishPhraseOffer() {
  const won = PHRASE_UI.outcome === 'yes';
  hidePhraseOffer();
  if (won) {
    // The offer can arrive over another window (including the market).
    // Closing those backdrops makes the requested profile visible on top.
    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      if (modal.id !== 'modal-profile-card' && modal.style.display !== 'none') closeAnimated(modal);
    });
    openAnimated($('modal-profile-card'));
    const tab = document.querySelector('[data-self-tab="phrases"]');
    if (tab) tab.click();
    if (window.loadSelfProfileSocial) window.loadSelfProfileSocial();
  }
  showQueuedPhraseOffer();
}

window.onNftPhraseSocketReady = function onNftPhraseSocketReady(sock) {
  sock.on('connect', syncPhraseOffer);
  sock.on('nft_phrase_offer', showPhraseOffer);
  sock.on('nft_phrase_offer_closed', ({ id } = {}) => {
    if (PHRASE_UI.queued && PHRASE_UI.queued.id === id) PHRASE_UI.queued = null;
    if (!PHRASE_UI.offer || PHRASE_UI.offer.id !== id || PHRASE_UI.busy || PHRASE_UI.retryText) return;
    hidePhraseOffer();
    toast('Этот шанс уже использован на другом устройстве', 'info');
    showQueuedPhraseOffer();
  });
  sock.on('nft_phrases_updated', ({ ownerIds } = {}) => refreshPhraseViews(ownerIds));
};

document.addEventListener('DOMContentLoaded', () => {
  $('nft-phrase-input').addEventListener('input', event => {
    $('nft-phrase-count').textContent = `${event.target.value.length} / 120`;
  });
  $('nft-phrase-form').addEventListener('submit', spinPhraseOffer);
  $('nft-phrase-skip').addEventListener('click', skipPhraseOffer);
  $('nft-phrase-finish').addEventListener('click', finishPhraseOffer);
  document.addEventListener('keydown', event => {
    if (!PHRASE_UI.offer) return;
    if (event.key === 'Escape' && !PHRASE_UI.busy) {
      event.preventDefault();
      skipPhraseOffer();
    }
    if (event.key === 'Tab') {
      const modal = $('modal-nft-phrase');
      const controls = Array.from(modal.querySelectorAll('button:not(:disabled), input:not(:disabled)'))
        .filter(el => el.getClientRects().length > 0);
      if (!controls.length) return event.preventDefault();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!modal.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
});
