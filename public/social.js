/* ==================================================================
   Runa — истории, профильные вкладки и розыгрыши в каналах
   Подключается после app.js и использует его глобальные хелперы.
   ================================================================== */
'use strict';

const SO = {
  stories: [],
  viewer: null,
  storyTimer: null,
  selfTab: 'stories',
  upTab: 'stories',
  selfStories: [],
  selfGifts: [],
  selfPhrases: [],
  upStories: [],
  upGifts: [],
  upPhrases: [],
  upUserId: null,
  selfLoadId: 0,
  upLoadId: 0,
  giveaways: [],
  gwTimer: null,
  gwChatId: null,
  draft: { file: null, previewUrl: '', mediaType: 'image' }
};

const SO_REDUCED = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ */
/*  МЕЛКИЕ ХЕЛПЕРЫ                                                     */
/* ------------------------------------------------------------------ */
function soInitial(name) {
  return String(name || '?').trim().charAt(0).toUpperCase() || '?';
}

function soAvatarHtml(user, cls = 'avatar-circle-md') {
  const name = user.displayName || user.username || '?';
  if (user.avatar) {
    return `<span class="${cls} has-img"><img src="${escapeAttr(user.avatar)}" alt=""></span>`;
  }
  return `<span class="${cls}" style="background:${gradientFor(name)}">${escapeHtml(soInitial(name))}</span>`;
}

function soAgo(value) {
  const date = parseDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  const diff = Math.max(0, Date.now() - date.getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

function soCountdown(endsAt) {
  const end = parseDate(endsAt).getTime();
  const left = end - Date.now();
  if (!Number.isFinite(left) || left <= 0) return 'завершён';
  const total = Math.floor(left / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d} д ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function soPlural(n, one, few, many) {
  const abs = Math.abs(Number(n) || 0) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function soIcons() {
  if (window.lucide) lucide.createIcons();
}

/* ------------------------------------------------------------------ */
/*  ИСТОРИИ: ЛЕНТА                                                     */
/* ------------------------------------------------------------------ */
async function loadStoriesStrip() {
  if (!currentUser) return;
  try {
    SO.stories = await api('/api/stories');
  } catch (e) {
    SO.stories = [];
  }
  renderStoriesStrip();
}

function renderStoriesStrip() {
  const strip = $('stories-strip');
  if (!strip) return;
  if (!currentUser) { strip.innerHTML = ''; return; }

  const mine = SO.stories.find(g => g.user.id === currentUser.id) || null;
  const others = SO.stories.filter(g => g.user.id !== currentUser.id);
  const myName = currentUser.displayName || currentUser.username;

  let html = `<div class="story-item my-story ${mine ? 'has-stories' : ''}" data-story-mine="1" role="button" tabindex="0" title="${mine ? 'Моя история' : 'Добавить историю'}">
    <div class="story-avatar-wrap ${mine ? 'active-ring' : ''}">
      ${soAvatarHtml({ avatar: currentUser.avatar, displayName: myName })}
      <button class="add-story-plus" type="button" data-story-add="1" title="Добавить историю"><i data-lucide="plus"></i></button>
    </div>
    <span class="story-author">Моя</span>
  </div>`;

  others.forEach(group => {
    const unviewed = group.stories.some(s => !s.viewed);
    const name = group.user.displayName || group.user.username;
    html += `<div class="story-item ${unviewed ? 'story-unviewed' : 'story-viewed'}" data-story-user="${escapeAttr(group.user.id)}" role="button" tabindex="0" title="${escapeAttr(name)}">
      <div class="story-avatar-wrap ${unviewed ? 'active-ring' : 'viewed-ring'}">
        ${soAvatarHtml(group.user)}
      </div>
      <span class="story-author">${escapeHtml(name.split(' ')[0])}</span>
    </div>`;
  });

  strip.innerHTML = html;
  soIcons();
}

function setupStoriesStrip() {
  const strip = $('stories-strip');
  if (!strip) return;
  strip.addEventListener('click', (e) => {
    if (e.target.closest('[data-story-add]')) {
      e.stopPropagation();
      openStoryCreate();
      return;
    }
    const userItem = e.target.closest('[data-story-user]');
    if (userItem) {
      openStoryViewer(userItem.dataset.storyUser, 0);
      return;
    }
    const mineItem = e.target.closest('[data-story-mine]');
    if (mineItem) {
      const mine = SO.stories.find(g => g.user.id === currentUser.id);
      if (mine) openStoryViewer(currentUser.id, 0);
      else openStoryCreate();
    }
  });
  strip.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('[data-story-user], [data-story-mine]');
    if (!item) return;
    e.preventDefault();
    item.click();
  });
}

/* ------------------------------------------------------------------ */
/*  ИСТОРИИ: ПРОСМОТР                                                  */
/* ------------------------------------------------------------------ */
function openStoryViewer(userId, index = 0) {
  const group = SO.stories.find(g => g.user.id === userId);
  if (!group || !group.stories.length) {
    toast('У этого пользователя нет активных историй', 'info');
    return;
  }
  SO.viewer = { group, index: Math.max(0, Math.min(index, group.stories.length - 1)) };
  $('story-viewer').style.display = 'flex';
  document.body.classList.add('story-viewer-open');
  renderStoryViewer();
}

function renderStoryViewer() {
  if (!SO.viewer) return;
  const { group, index } = SO.viewer;
  const story = group.stories[index];
  if (!story) { closeStoryViewer(); return; }
  clearTimeout(SO.storyTimer);

  const user = group.user;
  const name = user.displayName || user.username;
  const avatar = $('story-viewer-avatar');
  avatar.innerHTML = soAvatarHtml({ avatar: user.avatar, displayName: name }, 'story-viewer-av');
  $('story-viewer-name').textContent = name;
  $('story-viewer-time').textContent = soAgo(story.createdAt);

  const progress = $('story-progress');
  progress.innerHTML = group.stories.map((s, i) => {
    if (i < index) return '<span class="story-seg done"><i></i></span>';
    if (i > index) return '<span class="story-seg"><i></i></span>';
    return '<span class="story-seg current"><i></i></span>';
  }).join('');

  const media = $('story-viewer-media');
  media.innerHTML = '';
  let duration = 6000;
  if (story.mediaType === 'video') {
    const video = document.createElement('video');
    video.src = story.mediaUrl;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.loop = false;
    video.className = 'story-media-video';
    media.appendChild(video);
    const finish = () => { if (SO.viewer && SO.viewer.group.stories[SO.viewer.index] === story) nextStory(); };
    video.addEventListener('ended', finish);
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        duration = Math.min(30000, video.duration * 1000);
        animateStoryProgress(duration);
      }
    });
    const play = video.play();
    if (play && play.catch) play.catch(() => {});
  } else {
    const img = document.createElement('img');
    img.src = story.mediaUrl;
    img.alt = story.caption || 'История';
    img.className = 'story-media-image';
    media.appendChild(img);
    animateStoryProgress(duration);
  }

  $('story-viewer-caption').textContent = story.caption || '';
  $('story-viewer-caption').style.display = story.caption ? 'block' : 'none';

  const views = $('story-viewer-views');
  if (story.own || (currentUser && currentUser.isAdmin)) {
    views.style.display = 'inline-flex';
    views.innerHTML = `<i data-lucide="eye"></i><span>${Number(story.views || 0)} ${soPlural(story.views, 'просмотр', 'просмотра', 'просмотров')}</span>`;
  } else {
    views.style.display = 'none';
  }

  const del = $('story-delete-btn');
  del.style.display = (story.own || (currentUser && currentUser.isAdmin)) ? 'inline-flex' : 'none';

  $('story-prev').style.display = index > 0 ? 'flex' : 'none';
  $('story-next').style.display = 'flex';

  if (!story.own && !story.viewed) markStoryViewed(story);
  soIcons();
}

function animateStoryProgress(duration) {
  const current = document.querySelector('#story-progress .story-seg.current i');
  if (!current) return;
  if (SO_REDUCED()) {
    current.style.width = '100%';
  } else {
    current.style.transition = 'none';
    current.style.width = '0%';
    // force reflow, чтобы анимация стартовала заново
    void current.offsetWidth;
    current.style.transition = `width ${duration}ms linear`;
    current.style.width = '100%';
  }
  clearTimeout(SO.storyTimer);
  SO.storyTimer = setTimeout(nextStory, duration);
}

async function markStoryViewed(story) {
  story.viewed = true;
  try {
    await api(`/api/stories/${encodeURIComponent(story.id)}/view`, { method: 'POST' });
    story.views = Number(story.views || 0) + 1;
    renderStoriesStrip();
    if (SO.viewer) {
      const views = $('story-viewer-views');
      if (views && story.own) views.querySelector('span').textContent = `${story.views} ${soPlural(story.views, 'просмотр', 'просмотра', 'просмотров')}`;
    }
  } catch (e) { /* не мешаем просмотру */ }
}

function nextStory() {
  if (!SO.viewer) return;
  const { group, index } = SO.viewer;
  if (index < group.stories.length - 1) {
    SO.viewer.index = index + 1;
    renderStoryViewer();
  } else {
    closeStoryViewer();
  }
}

function prevStory() {
  if (!SO.viewer) return;
  if (SO.viewer.index > 0) {
    SO.viewer.index -= 1;
    renderStoryViewer();
  } else {
    closeStoryViewer();
  }
}

function closeStoryViewer() {
  clearTimeout(SO.storyTimer);
  SO.storyTimer = null;
  SO.viewer = null;
  const viewer = $('story-viewer');
  if (viewer) viewer.style.display = 'none';
  document.body.classList.remove('story-viewer-open');
}

async function deleteCurrentStory() {
  if (!SO.viewer) return;
  const story = SO.viewer.group.stories[SO.viewer.index];
  if (!story) return;
  if (!confirm('Удалить эту историю?')) return;
  try {
    await api(`/api/stories/${encodeURIComponent(story.id)}`, { method: 'DELETE' });
    const group = SO.viewer.group;
    group.stories = group.stories.filter(s => s.id !== story.id);
    SO.stories = SO.stories.map(g => (g.user.id === group.user.id ? { ...g, stories: group.stories } : g))
      .filter(g => g.stories.length);
    toast('История удалена');
    renderStoriesStrip();
    if (!group.stories.length) closeStoryViewer();
    else {
      SO.viewer.index = Math.min(SO.viewer.index, group.stories.length - 1);
      renderStoryViewer();
    }
    refreshOpenProfileSocial();
  } catch (e) { toast(e.message, 'error'); }
}

function setupStoryViewer() {
  const viewer = $('story-viewer');
  if (!viewer) return;
  $('story-viewer-close').addEventListener('click', closeStoryViewer);
  $('story-prev').addEventListener('click', (e) => { e.stopPropagation(); prevStory(); });
  $('story-next').addEventListener('click', (e) => { e.stopPropagation(); nextStory(); });
  $('story-delete-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteCurrentStory(); });
  $('story-viewer-user').addEventListener('click', () => {
    if (!SO.viewer) return;
    const userId = SO.viewer.group.user.id;
    closeStoryViewer();
    openUserProfile(userId);
  });
  viewer.addEventListener('click', (e) => {
    if (e.target === viewer) closeStoryViewer();
  });
  const media = $('story-viewer-media');
  media.addEventListener('click', (e) => {
    const rect = media.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width * 0.32) prevStory();
    else nextStory();
  });
  document.addEventListener('keydown', (e) => {
    if (viewer.style.display === 'none') return;
    if (e.key === 'Escape') closeStoryViewer();
    else if (e.key === 'ArrowRight') nextStory();
    else if (e.key === 'ArrowLeft') prevStory();
  });
}

/* ------------------------------------------------------------------ */
/*  ИСТОРИИ: СОЗДАНИЕ                                                  */
/* ------------------------------------------------------------------ */
function openStoryCreate() {
  const modal = $('modal-story-create');
  if (!modal) return;
  SO.draft = { file: null, previewUrl: '', mediaType: 'image' };
  $('story-file-input').value = '';
  $('story-caption-input').value = '';
  $('story-create-preview').style.display = 'none';
  $('story-create-preview').innerHTML = '';
  $('story-create-drop').style.display = 'flex';
  const publish = $('story-publish-btn');
  publish.disabled = true;
  publish.classList.remove('loading');
  publish.innerHTML = '<i data-lucide="send"></i> Опубликовать историю';
  openAnimated(modal);
  soIcons();
}

function setupStoryCreate() {
  const modal = $('modal-story-create');
  if (!modal) return;
  const input = $('story-file-input');
  $('story-create-drop').addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!/^(image|video)\//.test(file.type)) {
      toast('Выберите фото или видео', 'error');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      toast('Файл больше 50 МБ', 'error');
      return;
    }
    SO.draft.file = file;
    SO.draft.mediaType = file.type.startsWith('video/') ? 'video' : 'image';
    if (SO.draft.previewUrl) URL.revokeObjectURL(SO.draft.previewUrl);
    SO.draft.previewUrl = URL.createObjectURL(file);
    const preview = $('story-create-preview');
    preview.innerHTML = SO.draft.mediaType === 'video'
      ? `<video src="${escapeAttr(SO.draft.previewUrl)}" autoplay muted playsinline loop></video>`
      : `<img src="${escapeAttr(SO.draft.previewUrl)}" alt="Предпросмотр">`;
    preview.style.display = 'block';
    $('story-create-drop').style.display = 'none';
    $('story-publish-btn').disabled = false;
  });

  $('story-publish-btn').addEventListener('click', async () => {
    if (!SO.draft.file) return;
    const btn = $('story-publish-btn');
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = '<i data-lucide="loader-2"></i> Публикуем…';
    soIcons();
    try {
      const fd = new FormData();
      fd.append('file', SO.draft.file);
      const uploaded = await api('/api/upload', { method: 'POST', body: fd });
      await api('/api/stories', {
        method: 'POST',
        body: {
          mediaUrl: uploaded.url,
          mediaType: SO.draft.mediaType,
          caption: $('story-caption-input').value.trim()
        }
      });
      closeAnimated(modal);
      toast('История опубликована', 'message');
      await loadStoriesStrip();
      const mine = SO.stories.find(g => g.user.id === currentUser.id);
      if (mine) openStoryViewer(currentUser.id, mine.stories.length - 1);
      refreshOpenProfileSocial();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.innerHTML = '<i data-lucide="send"></i> Опубликовать историю';
      soIcons();
    }
  });
}

/* ------------------------------------------------------------------ */
/*  ПРОФИЛЬ: ВКЛАДКИ «ИСТОРИИ / ПОДАРКИ»                               */
/* ------------------------------------------------------------------ */
function profileStoryGrid(stories, context) {
  if (!stories.length) {
    return `<div class="profile-social-empty">
      <span class="profile-social-empty-icon"><i data-lucide="circle-play"></i></span>
      <b>Историй пока нет</b>
      <small>${context === 'self' ? 'Поделитесь моментом — история исчезнет через 24 часа.' : 'Пользователь ещё не публиковал истории.'}</small>
      ${context === 'self' ? '<button class="profile-social-action" data-social-action="create-story"><i data-lucide="plus"></i> Добавить историю</button>' : ''}
    </div>`;
  }
  return `<div class="profile-story-grid">${stories.map((s, i) => `
    <button type="button" class="profile-story-thumb" data-profile-story-id="${escapeAttr(s.id)}" data-profile-story-user="${escapeAttr(s.userId)}" data-profile-story-index="${i}">
      <span class="profile-story-media">
        ${s.mediaType === 'video'
          ? `<video src="${escapeAttr(s.mediaUrl)}" muted playsinline preload="metadata"></video>`
          : `<img src="${escapeAttr(s.mediaUrl)}" alt="${escapeAttr(s.caption || 'История')}" loading="lazy">`}
      </span>
      <span class="profile-story-views"><i data-lucide="eye"></i>${Number(s.views || 0)}</span>
      ${s.own ? '<span class="profile-story-own">Ваша</span>' : ''}
      ${s.mediaType === 'video' ? '<span class="profile-story-play"><i data-lucide="play"></i></span>' : ''}
    </button>`).join('')}</div>`;
}

function profileGiftGrid(gifts, context) {
  if (!gifts.length) {
    return `<div class="profile-social-empty">
      <span class="profile-social-empty-icon"><i data-lucide="gift"></i></span>
      <b>Подарков пока нет</b>
      <small>${context === 'self' ? 'Выберите подарок из маркета и оставьте его в своей коллекции.' : 'Подарки, отправленные этому пользователю, появятся здесь.'}</small>
      ${context === 'self' ? '<button class="profile-social-action" data-social-action="gift-self"><i data-lucide="gift"></i> Подарить себе подарок</button>' : ''}
    </div>`;
  }
  return `<div class="profile-gift-grid">${gifts.map(g => `
    <button type="button" class="profile-gift-card" data-profile-gift-id="${escapeAttr(g.giftId || g.id)}" data-profile-gift-title="${escapeAttr(g.title || '')}" title="${escapeAttr(g.title || 'Подарок')}">
      <span class="profile-gift-media">${giftMediaHtml(g)}</span>
      <span class="profile-gift-name">${escapeHtml(g.title || 'Подарок')}</span>
      <span class="profile-gift-from">${g.anonymous ? 'Анонимно' : (g.from && g.from.username ? 'от @' + escapeHtml(g.from.username) : 'в коллекции')}</span>
    </button>`).join('')}
    ${context === 'self' ? `<button type="button" class="profile-gift-add" data-social-action="gift-self"><i data-lucide="plus"></i><span>Подарить себе</span></button>` : ''}
  </div>`;
}

function profilePhraseGrid(phrases, context) {
  if (!phrases.length) {
    return `<div class="profile-social-empty">
      <span class="profile-social-empty-icon"><i data-lucide="quote"></i></span>
      <b>NFT-фраз пока нет</b>
      <small>${context === 'self' ? 'Общайтесь в чатах: иногда вам будет выпадать шанс создать свою фразу.' : 'Коллекционные фразы пользователя появятся здесь.'}</small>
      ${context === 'self' ? '<button class="profile-social-action" data-action="market-phrases"><i data-lucide="shopping-bag"></i> Маркет фраз</button>' : ''}
    </div>`;
  }
  return `<div class="profile-phrase-grid">${phrases.map(phrase => `
    <article class="profile-phrase-card">
      <div class="profile-phrase-label"><span>✦ NFT-ФРАЗА</span><span title="ID: ${escapeAttr(phrase.id)}">#${escapeHtml(phrase.id.slice(0, 8).toUpperCase())}</span></div>
      <p>«${escapeHtml(phrase.text)}»</p>
      <div class="profile-phrase-footer">
        <small>${phrase.creatorUsername ? `Автор @${escapeHtml(phrase.creatorUsername)}` : 'Автор недоступен'}</small>
        <span>${phrase.forSale ? `${Number(phrase.price).toLocaleString('ru-RU')} 💎` : 'В коллекции'}</span>
      </div>
      ${phrase.mine
        ? (phrase.forSale
          ? `<button type="button" class="profile-phrase-action" data-action="phrase-unlist" data-id="${escapeAttr(phrase.id)}">Снять с продажи</button>`
          : `<button type="button" class="profile-phrase-action" data-action="phrase-sell" data-id="${escapeAttr(phrase.id)}" data-text="${escapeAttr(phrase.text)}">Продать</button>`)
        : (phrase.forSale ? `<button type="button" class="profile-phrase-action" data-action="phrase-buy" data-id="${escapeAttr(phrase.id)}" data-text="${escapeAttr(phrase.text)}" data-price="${Number(phrase.price) || 0}">Купить</button>` : '')}
    </article>`).join('')}</div>`;
}

function applyProfileTab(container, tab, context) {
  const prefix = context === 'self' ? 'self' : 'up';
  const storiesPanel = $(`${prefix}-tab-stories`);
  const giftsPanel = $(`${prefix}-tab-gifts`);
  const phrasesPanel = $(`${prefix}-tab-phrases`);
  if (!storiesPanel || !giftsPanel || !phrasesPanel) return;
  storiesPanel.hidden = tab !== 'stories';
  giftsPanel.hidden = tab !== 'gifts';
  phrasesPanel.hidden = tab !== 'phrases';
  const tabs = $(`${prefix}-profile-tabs`);
  if (tabs) tabs.querySelectorAll('.profile-bottom-tab').forEach(btn => {
    btn.classList.toggle('active', (context === 'self' ? btn.dataset.selfTab : btn.dataset.upTab) === tab);
  });
  if (context === 'self') SO.selfTab = tab; else SO.upTab = tab;
}

function renderSelfSocial() {
  const storiesPanel = $('self-tab-stories');
  const giftsPanel = $('self-tab-gifts');
  const phrasesPanel = $('self-tab-phrases');
  if (!storiesPanel || !giftsPanel || !phrasesPanel) return;
  storiesPanel.innerHTML = profileStoryGrid(SO.selfStories, 'self');
  giftsPanel.innerHTML = profileGiftGrid(SO.selfGifts, 'self');
  phrasesPanel.innerHTML = profilePhraseGrid(SO.selfPhrases, 'self');
  const sc = $('self-tab-stories-count');
  const gc = $('self-tab-gifts-count');
  const pc = $('self-tab-phrases-count');
  if (sc) sc.textContent = SO.selfStories.length ? String(SO.selfStories.length) : '';
  if (gc) gc.textContent = SO.selfGifts.length ? String(SO.selfGifts.length) : '';
  if (pc) pc.textContent = SO.selfPhrases.length ? String(SO.selfPhrases.length) : '';
  applyProfileTab($('self-profile-social'), SO.selfTab, 'self');
  soIcons();
}

function renderUpSocial() {
  const storiesPanel = $('up-tab-stories');
  const giftsPanel = $('up-tab-gifts');
  const phrasesPanel = $('up-tab-phrases');
  if (!storiesPanel || !giftsPanel || !phrasesPanel) return;
  storiesPanel.innerHTML = profileStoryGrid(SO.upStories, 'user');
  giftsPanel.innerHTML = profileGiftGrid(SO.upGifts, 'user');
  phrasesPanel.innerHTML = profilePhraseGrid(SO.upPhrases, currentUser && SO.upUserId === currentUser.id ? 'self' : 'user');
  const sc = $('up-tab-stories-count');
  const gc = $('up-tab-gifts-count');
  const pc = $('up-tab-phrases-count');
  if (sc) sc.textContent = SO.upStories.length ? String(SO.upStories.length) : '';
  if (gc) gc.textContent = SO.upGifts.length ? String(SO.upGifts.length) : '';
  if (pc) pc.textContent = SO.upPhrases.length ? String(SO.upPhrases.length) : '';
  applyProfileTab($('up-profile-social'), SO.upTab, 'user');
  soIcons();
}

async function loadSelfProfileSocial() {
  if (!currentUser) return;
  const userId = currentUser.id;
  const loadId = ++SO.selfLoadId;
  ['stories', 'gifts', 'phrases'].forEach(tab => {
    $(`self-tab-${tab}`).innerHTML = '<div class="profile-social-loading"><span class="gifts-spinner"></span></div>';
  });
  const [storyRes, gifts, phrases] = await Promise.all([
    api(`/api/stories/user/${encodeURIComponent(userId)}`).catch(() => ({ stories: [] })),
    api(`/api/users/${encodeURIComponent(userId)}/gifts`).catch(() => []),
    api(`/api/users/${encodeURIComponent(userId)}/nft-phrases`).catch(() => [])
  ]);
  if (!currentUser || currentUser.id !== userId || SO.selfLoadId !== loadId) return;
  SO.selfStories = (storyRes && storyRes.stories) || [];
  SO.selfGifts = gifts || [];
  SO.selfPhrases = phrases || [];
  renderSelfSocial();
}

async function loadUpProfileSocial(userId) {
  if (!userId) return;
  SO.upUserId = userId;
  const loadId = ++SO.upLoadId;
  ['stories', 'gifts', 'phrases'].forEach(tab => {
    $(`up-tab-${tab}`).innerHTML = '<div class="profile-social-loading"><span class="gifts-spinner"></span></div>';
  });
  const [storyRes, gifts, phrases] = await Promise.all([
    api(`/api/stories/user/${encodeURIComponent(userId)}`).catch(() => ({ stories: [] })),
    api(`/api/users/${encodeURIComponent(userId)}/gifts`).catch(() => []),
    api(`/api/users/${encodeURIComponent(userId)}/nft-phrases`).catch(() => [])
  ]);
  if (SO.upUserId !== userId || SO.upLoadId !== loadId) return;
  SO.upStories = (storyRes && storyRes.stories) || [];
  SO.upGifts = gifts || [];
  SO.upPhrases = phrases || [];
  renderUpSocial();
}

function refreshOpenProfileSocial() {
  const selfModal = $('modal-profile-card');
  if (selfModal && selfModal.style.display !== 'none') loadSelfProfileSocial();
  const upModal = $('modal-user-profile');
  if (upModal && upModal.style.display !== 'none' && SO.upUserId) loadUpProfileSocial(SO.upUserId);
  loadStoriesStrip();
}

// A market event should refresh only profiles which actually display the
// affected owners, not cause every connected client to reload its stories.
window.refreshPhraseProfiles = function refreshPhraseProfiles(ownerIds) {
  const affected = id => !Array.isArray(ownerIds) || ownerIds.includes(id);
  const selfModal = $('modal-profile-card');
  if (currentUser && selfModal && selfModal.style.display !== 'none' && affected(currentUser.id)) loadSelfProfileSocial();
  const upModal = $('modal-user-profile');
  if (SO.upUserId && upModal && upModal.style.display !== 'none' && affected(SO.upUserId)) loadUpProfileSocial(SO.upUserId);
};

function setupProfileSocial() {
  const selfTabs = $('self-profile-tabs');
  if (selfTabs) selfTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-self-tab]');
    if (btn) applyProfileTab($('self-profile-social'), btn.dataset.selfTab, 'self');
  });
  const upTabs = $('up-profile-tabs');
  if (upTabs) upTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-up-tab]');
    if (btn) applyProfileTab($('up-profile-social'), btn.dataset.upTab, 'user');
  });

  const selfSocial = $('self-profile-social');
  if (selfSocial) selfSocial.addEventListener('click', handleProfileSocialClick);
  const upSocial = $('up-profile-social');
  if (upSocial) upSocial.addEventListener('click', handleProfileSocialClick);
}

function handleProfileSocialClick(e) {
  const storyThumb = e.target.closest('[data-profile-story-user]');
  if (storyThumb) {
    const userId = storyThumb.dataset.profileStoryUser;
    const index = Number(storyThumb.dataset.profileStoryIndex) || 0;
    if (!SO.stories.find(g => g.user.id === userId)) {
      toast('История уже недоступна', 'info');
      return;
    }
    openStoryViewer(userId, index);
    return;
  }
  const giftCard = e.target.closest('[data-profile-gift-id]');
  if (giftCard) {
    const id = giftCard.dataset.profileGiftId;
    const catalog = (lastGiftCatalog || []).find(g => g.id === id);
    if (catalog) openGiftSend(catalog, { self: false });
    else openGifts('catalog');
    return;
  }
  const action = e.target.closest('[data-social-action]');
  if (!action) return;
  if (action.dataset.socialAction === 'create-story') openStoryCreate();
  if (action.dataset.socialAction === 'gift-self') openGifts('catalog');
}

/* ------------------------------------------------------------------ */
/*  РОЗЫГРЫШИ В КАНАЛЕ                                                 */
/* ------------------------------------------------------------------ */
function activeGiveaway() {
  return SO.giveaways.find(g => g.status === 'active' && !g.ended) || SO.giveaways.find(g => g.status === 'active') || null;
}

async function loadGiveaways(chatId) {
  SO.gwChatId = chatId;
  try {
    SO.giveaways = await api(`/api/chats/${encodeURIComponent(chatId)}/giveaways`);
  } catch (e) {
    SO.giveaways = [];
  }
  renderGiveawayBanner();
  if (chatSettings && chatSettings.tab === 'giveaways' && chatSettings.data && chatSettings.data.id === chatId) {
    renderGiveawaySettingsList();
  }
}

function renderGiveawayBanner() {
  const banner = $('channel-giveaway-banner');
  if (!banner) return;
  if (!currentChat || currentChat.type !== 'channel' || !SO.giveaways.length) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }
  const g = activeGiveaway();
  if (!g) { banner.style.display = 'none'; banner.innerHTML = ''; return; }

  const ended = g.status !== 'active' || String(g.endsAt) <= new Date().toISOString();
  banner.style.display = 'block';
  banner.innerHTML = `<div class="gw-banner ${ended ? 'is-ended' : ''}">
    <span class="gw-banner-icon"><i data-lucide="party-popper"></i></span>
    <div class="gw-banner-main">
      <div class="gw-banner-title">${escapeHtml(g.title || 'Розыгрыш')}</div>
      <div class="gw-banner-sub">
        <span><i data-lucide="gift"></i>${escapeHtml(g.prizeLabel)}</span>
        <span><i data-lucide="users"></i>${g.participantsCount} ${soPlural(g.participantsCount, 'участник', 'участника', 'участников')}</span>
      </div>
      <div class="gw-banner-countdown" data-gw-countdown="${escapeAttr(g.endsAt)}">
        <i data-lucide="timer"></i>${ended ? 'Завершается…' : soCountdown(g.endsAt)}
      </div>
    </div>
    <div class="gw-banner-actions">
      ${g.joined
        ? '<span class="gw-joined"><i data-lucide="check"></i>Вы участвуете</span>'
        : `<button type="button" class="gw-join-btn" data-gw-join="${escapeAttr(g.id)}" ${ended ? 'disabled' : ''}><i data-lucide="sparkles"></i>Участвовать</button>`}
      ${g.canManage ? `<button type="button" class="gw-manage-btn" data-gw-draw="${escapeAttr(g.id)}" title="Завершить розыгрыш"><i data-lucide="flag"></i></button>` : ''}
    </div>
  </div>`;
  soIcons();
}

function updateGiveawayCountdowns() {
  document.querySelectorAll('[data-gw-countdown]').forEach(el => {
    const left = parseDate(el.dataset.gwCountdown).getTime() - Date.now();
    if (left <= 0) {
      el.innerHTML = `<i data-lucide="timer"></i>Завершается…`;
      return;
    }
    el.innerHTML = `<i data-lucide="timer"></i>${soCountdown(el.dataset.gwCountdown)}`;
  });
}

function startGiveawayTicker() {
  if (SO.gwTimer) return;
  SO.gwTimer = setInterval(updateGiveawayCountdowns, 1000);
}

function stopGiveawayTicker() {
  clearInterval(SO.gwTimer);
  SO.gwTimer = null;
}

async function joinGiveaway(id) {
  try {
    const res = await api(`/api/giveaways/${encodeURIComponent(id)}/join`, { method: 'POST' });
    toast('Вы участвуете в розыгрыше. Удачи!', 'message');
    if (res.giveaway) {
      const idx = SO.giveaways.findIndex(g => g.id === id);
      if (idx >= 0) SO.giveaways[idx] = res.giveaway;
    }
    renderGiveawayBanner();
  } catch (e) { toast(e.message, 'error'); }
}

async function drawGiveaway(id) {
  if (!confirm('Завершить розыгрыш и выбрать победителей сейчас?')) return;
  try {
    const res = await api(`/api/giveaways/${encodeURIComponent(id)}/draw`, { method: 'POST' });
    const winners = (res.giveaway && res.giveaway.winners) || [];
    toast(winners.length ? `Победители: ${winners.map(w => '@' + w.username).join(', ')}` : 'Розыгрыш завершён', 'message');
    await loadGiveaways(SO.gwChatId);
  } catch (e) { toast(e.message, 'error'); }
}

function setupGiveawayBanner() {
  const banner = $('channel-giveaway-banner');
  if (!banner) return;
  banner.addEventListener('click', (e) => {
    const join = e.target.closest('[data-gw-join]');
    if (join) { joinGiveaway(join.dataset.gwJoin); return; }
    const draw = e.target.closest('[data-gw-draw]');
    if (draw) drawGiveaway(draw.dataset.gwDraw);
  });
}

/* ---------------------- Настройки канала ------------------------- */
window.giveawaysTabHtml = function giveawaysTabHtml() {
  return `<div class="cs-section">
    <div class="cs-section-title">Розыгрыши канала</div>
    <p class="cs-hint">Запустите розыгрыш рубинов, подарка или своего приза. Участники нажимают «Участвовать» в баннере канала, победители выбираются случайно.</p>
    <button type="button" class="cs-primary-btn" data-gw-action="open-create"><i data-lucide="plus"></i> Новый розыгрыш</button>
    <div class="cs-giveaways-list" id="cs-giveaways-list">
      <div class="cs-loading"><span class="cs-spinner"></span>Загрузка…</div>
    </div>
  </div>`;
};

window.bindGiveawaysTab = function bindGiveawaysTab() {
  const body = $('cs-body');
  if (!body || body.dataset.gwWired === '1') return;
  body.dataset.gwWired = '1';
  body.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-gw-action="open-create"]');
    if (openBtn) { openGiveawayCreate(); return; }
    const draw = e.target.closest('[data-gw-op="draw"]');
    if (draw) { drawGiveaway(draw.dataset.gwId); return; }
    const cancel = e.target.closest('[data-gw-op="cancel"]');
    if (cancel) cancelGiveaway(cancel.dataset.gwId);
  });
  loadGiveawaysTab();
};

async function loadGiveawaysTab() {
  const list = $('cs-giveaways-list');
  if (!list || !currentChat) return;
  try {
    const items = await api(`/api/chats/${encodeURIComponent(currentChat.id)}/giveaways`);
    SO.giveaways = items;
    renderGiveawaySettingsList();
    renderGiveawayBanner();
  } catch (e) {
    list.innerHTML = `<p class="cs-hint">${escapeHtml(e.message)}</p>`;
  }
}

function renderGiveawaySettingsList() {
  const list = $('cs-giveaways-list');
  if (!list) return;
  if (!SO.giveaways.length) {
    list.innerHTML = '<div class="cs-gw-empty"><i data-lucide="party-popper"></i><b>Розыгрышей пока нет</b><small>Создайте первый розыгрыш для подписчиков канала.</small></div>';
    soIcons();
    return;
  }
  list.innerHTML = SO.giveaways.map(g => {
    const active = g.status === 'active';
    const statusText = active ? 'Активен' : g.status === 'canceled' ? 'Отменён' : 'Завершён';
    return `<div class="cs-gw-row ${active ? 'active' : ''}">
      <div class="cs-gw-main">
        <b>${escapeHtml(g.title || 'Розыгрыш')}</b>
        <small>${escapeHtml(g.prizeLabel)} · ${g.participantsCount} ${soPlural(g.participantsCount, 'участник', 'участника', 'участников')} · ${statusText}</small>
        <span class="cs-gw-date" data-gw-countdown="${escapeAttr(g.endsAt)}">${active ? soCountdown(g.endsAt) : new Date(g.finishedAt || g.endsAt).toLocaleDateString('ru-RU')}</span>
      </div>
      <div class="cs-gw-actions">
        ${active && g.canManage ? `<button type="button" class="cs-mini-btn" data-gw-op="draw" data-gw-id="${escapeAttr(g.id)}">Завершить</button>
        <button type="button" class="cs-mini-btn danger" data-gw-op="cancel" data-gw-id="${escapeAttr(g.id)}">Отмена</button>` : ''}
      </div>
    </div>`;
  }).join('');
  soIcons();
}

async function cancelGiveaway(id) {
  if (!confirm('Отменить розыгрыш? Участники не получат приз.')) return;
  try {
    await api(`/api/giveaways/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    toast('Розыгрыш отменён');
    await loadGiveawaysTab();
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------------------- Создание розыгрыша ----------------------- */
async function openGiveawayCreate() {
  if (!currentChat || currentChat.type !== 'channel') return;
  const modal = $('modal-giveaway-create');
  if (!modal) return;
  $('gw-title').value = '';
  $('gw-prize-type').value = 'rubies';
  $('gw-prize-rubies').value = '1000';
  $('gw-prize-custom').value = '';
  $('gw-winners').value = '1';
  $('gw-duration').value = '1440';
  syncGiveawayPrizeFields();
  const giftSelect = $('gw-prize-gift');
  giftSelect.innerHTML = '<option value="">Загрузка…</option>';
  openAnimated(modal);
  soIcons();
  try {
    const gifts = await api('/api/gifts');
    giftSelect.innerHTML = gifts.length
      ? gifts.map(g => `<option value="${escapeAttr(g.id)}">${escapeHtml(g.title)} — ${Number(g.price).toLocaleString('ru-RU')} 💎</option>`).join('')
      : '<option value="">В маркете нет подарков</option>';
  } catch (e) {
    giftSelect.innerHTML = '<option value="">Не удалось загрузить</option>';
  }
}

function syncGiveawayPrizeFields() {
  const type = $('gw-prize-type').value;
  $('gw-rubies-field').style.display = type === 'rubies' ? '' : 'none';
  $('gw-gift-field').style.display = type === 'gift' ? '' : 'none';
  $('gw-custom-field').style.display = type === 'custom' ? '' : 'none';
}

function setupGiveawayCreate() {
  const modal = $('modal-giveaway-create');
  if (!modal) return;
  $('gw-prize-type').addEventListener('change', syncGiveawayPrizeFields);
  $('gw-create-submit').addEventListener('click', async () => {
    if (!currentChat || currentChat.type !== 'channel') return;
    const type = $('gw-prize-type').value;
    const prizeValue = type === 'rubies'
      ? $('gw-prize-rubies').value
      : type === 'gift' ? $('gw-prize-gift').value : $('gw-prize-custom').value.trim();
    if (type === 'gift' && !prizeValue) { toast('Выберите подарок', 'error'); return; }
    if (type === 'custom' && !prizeValue) { toast('Опишите приз', 'error'); return; }
    const btn = $('gw-create-submit');
    btn.disabled = true;
    try {
      await api(`/api/chats/${encodeURIComponent(currentChat.id)}/giveaways`, {
        method: 'POST',
        body: {
          title: $('gw-title').value.trim(),
          prizeType: type,
          prizeValue,
          winnersCount: Number($('gw-winners').value) || 1,
          durationMinutes: Number($('gw-duration').value) || 1440
        }
      });
      closeAnimated(modal);
      toast('Розыгрыш запущен', 'message');
      await loadGiveaways(currentChat.id);
      if (chatSettings && chatSettings.tab === 'giveaways') loadGiveawaysTab();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ */
/*  ХУКИ ИЗ APP.JS                                                     */
/* ------------------------------------------------------------------ */
window.onRunaMainReady = function onRunaMainReady() {
  loadStoriesStrip();
  startGiveawayTicker();
};

window.onRunaChatOpened = function onRunaChatOpened(chat) {
  if (chat && chat.type === 'channel') {
    loadGiveaways(chat.id);
    startGiveawayTicker();
  } else {
    SO.giveaways = [];
    SO.gwChatId = null;
    renderGiveawayBanner();
  }
};

window.onRunaChatClosed = function onRunaChatClosed() {
  SO.giveaways = [];
  SO.gwChatId = null;
  renderGiveawayBanner();
  stopGiveawayTicker();
};

window.onRunaUserProfileShown = function onRunaUserProfileShown(user) {
  if (!user) return;
  if (currentUser && user.id === currentUser.id) {
    // Данные уже могут быть загружены для карточки профиля.
    if (SO.selfStories.length || SO.selfGifts.length) {
      applyProfileTab($('up-profile-social'), SO.upTab, 'user');
    }
  }
  loadUpProfileSocial(user.id);
};

window.onRunaSocketReady = function onRunaSocketReady(sock) {
  sock.on('stories_updated', () => loadStoriesStrip());
  sock.on('story_views', ({ storyId, views }) => {
    SO.stories.forEach(group => group.stories.forEach(s => {
      if (s.id === storyId) s.views = views;
    }));
    if (SO.viewer) {
      const current = SO.viewer.group.stories[SO.viewer.index];
      if (current && current.id === storyId) {
        const viewsEl = $('story-viewer-views');
        if (viewsEl) viewsEl.innerHTML = `<i data-lucide="eye"></i><span>${Number(views || 0)} ${soPlural(views, 'просмотр', 'просмотра', 'просмотров')}</span>`;
        soIcons();
      }
    }
  });
  sock.on('giveaway_updated', ({ chatId }) => {
    if (currentChat && currentChat.id === chatId) loadGiveaways(chatId);
    if (chatSettings && chatSettings.data && chatSettings.data.id === chatId && chatSettings.tab === 'giveaways') loadGiveawaysTab();
  });
};

/* ------------------------------------------------------------------ */
/*  ИНИЦИАЛИЗАЦИЯ                                                      */
/* ------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  setupStoriesStrip();
  setupStoryViewer();
  setupStoryCreate();
  setupProfileSocial();
  setupGiveawayBanner();
  setupGiveawayCreate();
  renderStoriesStrip();
});
