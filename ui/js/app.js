const { invoke } = window.__TAURI__.core;
const opener = window.__TAURI__.opener;

let activityTimer;
['mousemove', 'click', 'keydown', 'wheel', 'touchstart'].forEach((evt) => {
  document.addEventListener(evt, () => {
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
      invoke('user_active').catch(() => {});
    }, 5000);
  }, { passive: true });
});

const $ = (sel) => document.querySelector(sel);
const audio = $('#audio');

const state = {
  view: 'search',
  queue: [],
  queueIndex: -1,
  streams: new Map(),
  liked: new Set(),
  currentTrackId: null,
  silaGenres: [],
  fullSilaQueue: [],
};

const wave = { active: false, source: null, count: 0, name: null };
let hls = null;

const MAX_QUEUE = 10;

const defaultSettings = {
  volume: 80,
  hifi: false,
  discordRpc: true,
  repeat: 'off',
  shuffle: false,
  eq: {
    enabled: false,
    preset: 'flat',
    preamp: 0,
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    custom: {},
  },
  hotkeys: {
    playPause: null,
    prev: null,
    next: null,
  },
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('zvuk.settings')) || {};
    const hotkeys = { ...defaultSettings.hotkeys, ...(raw.hotkeys || {}) };
    for (const k of Object.keys(hotkeys)) {
      if (!(k in defaultSettings.hotkeys)) delete hotkeys[k];
    }
    // eq вложенный — сливаем отдельно и чиним значения от старых версий
    const eqRaw = raw.eq && typeof raw.eq === 'object' ? raw.eq : {};
    const eq = {
      ...defaultSettings.eq,
      ...eqRaw,
      bands: defaultSettings.eq.bands.map((zero, i) => {
        const v = Number(Array.isArray(eqRaw.bands) ? eqRaw.bands[i] : zero);
        if (!isFinite(v)) return 0;
        return Math.max(-12, Math.min(12, v));
      }),
      custom:
        eqRaw.custom && typeof eqRaw.custom === 'object' && !Array.isArray(eqRaw.custom)
          ? eqRaw.custom
          : {},
    };
    return { ...defaultSettings, ...raw, hotkeys, eq };
  } catch {
    return JSON.parse(JSON.stringify(defaultSettings));
  }
}

let settings = loadSettings();
function saveSettings() {
  localStorage.setItem('zvuk.settings', JSON.stringify(settings));
}

const LAST_KEY = 'zvuk.lastTrack';

function saveLastState() {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ q: state.queue, i: state.queueIndex }));
  } catch (e) {}
}

function restoreLastState() {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.q) || !d.q[d.i]) return;
    state.queue = d.q;
    state.queueIndex = d.i;
    const track = d.q[d.i];
    state.currentTrackId = track.id;
    updatePlayerUI(track);
    discordStatus(track, false);
    highlightQueue();
    updateTrackIndicators();
  } catch (e) {
    
  }
}

function applyHotkeys() {
  invoke('set_hotkeys', { hotkeys: settings.hotkeys }).catch(() => {});
}



function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function coverUrl(src, size = '300x300') {
  if (!src) return '';
  let url = src;
  if (url.startsWith('/')) url = 'https://zvuk.com' + url;
  if (url.includes('{size}')) url = url.split('{size}').join(size);
  else if (/size=\d+x\d+/.test(url)) url = url.replace(/size=\d+x\d+/, `size=${size}`);
  return url;
}

function artistString(track) {
  const artists = (track && track.artists) || [];
  if (artists.length) return artists.map((a) => a.title).filter(Boolean).join(', ');
  const template = (track && track.artistTemplate) || '';
  const names = (track && track.artistNames) || [];
  let i = 0;
  return template.replace(/\{(\d+)\}/g, (_, n) => names[Number(n)] || names[i++] || '');
}

function trackImage(track, size) {
  if (track.release && track.release.image) return coverUrl(track.release.image.src, size);
  const artists = track.artists || [];
  if (artists.length && artists[0].image) return coverUrl(artists[0].image.src, size);
  return '';
}

function playlistImage(p, size) {
  if (p.image && p.image.src) return coverUrl(p.image.src, size);
  const tracks = (p.tracks || []).filter((t) => t && t.id);
  for (const t of tracks) {
    const src = trackImage(t, size);
    if (src) return src;
  }
  return '';
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function markActive(view) {
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === view);
  });
}

/* В v1.0.2b тело функции по ошибке заменили на «// ...», из-за чего тосты
   не показывались, а таймер падал с ReferenceError: el is not defined. */
let toastTimer;
function toast(msg, ok = false) {
  const el = $('#toast');
  // по центру кнопки play/pause, а не окна: плеер сдвинут из-за ширины
  // блока трека и громкости
  const play = $('#btn-play');
  const rect = play ? play.getBoundingClientRect() : null;
  el.style.left = rect && rect.width ? `${rect.left + rect.width / 2}px` : '50%';
  el.textContent = msg;
  el.style.color = ok ? 'var(--accent)' : 'var(--text)';
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function setLoginStatus(msg, ok = false) {
  const el = $('#login-status');
  el.textContent = msg;
  el.classList.toggle('ok', !!ok);
}

function setLoginLoading(on) {
  $('#login-btn').disabled = on;
}

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}

async function enterApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  try {
    const d = await invoke('user_tracks');
    const ids = ((d && d.collection && d.collection.tracks) || []).map((t) => t.id).filter(Boolean);
    state.liked = new Set(ids);
  } catch (e) {
    
  }
  restoreLastState();
  showView('home');
}

async function loadMoreTracks() {
  const lastTrack = state.queue[state.queue.length - 1];
  if (!lastTrack) return;
  try {
    const data = await invoke('get_similar_tracks', { trackId: lastTrack.id, limit: 5 });
    const newTracks = (data && data.tracks) || [];
    for (const t of newTracks) {
      if (!state.queue.some(q => q.id === t.id)) {
        state.queue.push(t);
      }
    }
    while (state.queue.length > MAX_QUEUE + 5) {
      if (state.queueIndex > 0) {
        state.queue.shift();
        state.queueIndex--;
      } else {
        state.queue.pop();
      }
    }
  } catch (e) {  }
}

async function loadMoreSilaTracks() {
  if (!state.fullSilaQueue || state.fullSilaQueue.length === 0) return;
  const nextTrack = state.fullSilaQueue[state.queue.length];
  if (nextTrack) state.queue.push(nextTrack);
  if (state.queue.length === state.fullSilaQueue.length) {
    const currentTrack = state.queue[state.queueIndex];
    if (currentTrack) {
      const newTracks = await generateSilaQueue();
      state.fullSilaQueue = newTracks;
      for (const t of newTracks) {
        if (!state.queue.some(q => q.id === t.id)) {
          state.queue.push(t);
        }
      }
    }
  }
}

async function init() {
  audio.volume = settings.volume / 100;
  $('#volume').value = settings.volume;
  renderHotkeys();
  applyHotkeys();
  try {
    const hasToken = await invoke('saved_token_exists');
    if (hasToken) {
      enterApp();
      invoke('verify_session').catch(() => {});
      return;
    }
  } catch (e) {
    
  }
  showLogin();
}

$('#login-btn').addEventListener('click', async () => {
  const token = $('#token-input').value.trim();
  if (!token) {
    setLoginStatus('Введите токен');
    return;
  }
  setLoginLoading(true);
  try {
    await invoke('set_token', { token });
    setLoginStatus('Авторизация успешна', true);
    enterApp();
  } catch (e) {
    setLoginStatus(String(e));
  } finally {
    setLoginLoading(false);
  }
});

$('#open-token-btn').addEventListener('click', () => {
  opener.openUrl('https://zvuk.com/api/tiny/profile');
});

async function logout() {
  try {
    await invoke('clear_token');
  } catch (e) {
    
  }
  invoke('discord_clear').catch(() => {});
  if (hls) {
    hls.destroy();
    hls = null;
  }
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  localStorage.removeItem(LAST_KEY);
  closeQueue();
  $('#search-input').value = '';
  state.lastSearchData = null;
  showLogin();
}



if (window.__TAURI__ && window.__TAURI__.event) {
  window.__TAURI__.event.listen('tray-play-pause', () => togglePlay());
  window.__TAURI__.event.listen('tray-prev', () => prev());
  window.__TAURI__.event.listen('tray-next', () => next());
  window.__TAURI__.event.listen('hotkey', (e) => {
    if (captureHotkey) return;
    const action = e.payload;
    if (action === 'playPause') togglePlay();
    else if (action === 'prev') prev();
    else if (action === 'next') next();
  });
}



document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    showView(item.dataset.view);
  });
});

function showView(view) {
  state.view = view;
  document
    .querySelectorAll('.nav-item[data-view="settings"]')
    .forEach((n) => n.classList.remove('active'));
  markActive(view);
  
  if (view === 'home') {
    renderContent(renderHomeContent);
  } else if (view === 'search') {
    if (state.lastSearchData) {
      renderContent(renderSearchResultsContent, state.lastSearchData);
    } else {
      renderContent(renderPlaceholderContent, '🔎', 'Начните вводить запрос, чтобы найти треки, артистов, альбомы и плейлисты');
    }
    $('#search-input').focus();
  } else if (view === 'library') {
    renderContent(loadLibraryContent);
  } else if (view === 'playlists') {
    renderContent(loadPlaylistsContent);
  } else if (view === 'settings') {
    renderContent(renderSettingsContent);
  }
}

function spinnerBlock() {
  const p = document.createElement('div');
  p.className = 'placeholder';
  p.innerHTML = '<div class="spinner" style="position:static;transform:none;margin:0 auto 14px;"></div>';
  return p;
}

function section(title, count) {
  const s = document.createElement('div');
  s.className = 'section';
  const h = document.createElement('div');
  h.className = 'section-header';
  const t = document.createElement('div');
  t.className = 'section-title';
  t.textContent = title;
  const c = document.createElement('div');
  c.className = 'section-count';
  c.textContent = count;
  h.append(t, c);
  s.append(h);
  return s;
}



const GENRES = ['Поп', 'Рок', 'Хип-хоп', 'Электроника', 'Джаз', 'Классика', 'Лоу-фай', 'Инди', 'Танцевальная'];

async function renderHomeContent() {
  const content = $('#content');
  content.innerHTML = '';
  
  const title = document.createElement('div');
  title.className = 'view-title';
  title.textContent = 'Главное';
  content.append(title);

  content.append(silaPanel());

  const aw = section('Волны по артистам', '');
  const aGrid = document.createElement('div');
  aGrid.className = 'card-grid';
  aw.append(aGrid);
  content.append(aw);

  try {
    const coll = await invoke('user_collection');
    const ids = ((coll && coll.collection && coll.collection.artists) || [])
      .map((a) => a.id)
      .filter(Boolean);
    if (ids.length) {
      const data = await invoke('get_artists', { ids });
      const arts = ((data && data.getArtists) || []).filter((a) => a && a.id);
      aGrid.append(...arts.map(artistWaveCard));
      
      setTimeout(() => {
        document.querySelectorAll('.card').forEach((card, i) => {
          setTimeout(() => {
            card.classList.add('visible');
          }, i * 50 + 50);
        });
      }, 100);
      
    } else {
      const p = document.createElement('div');
      p.className = 'placeholder';
      p.style.padding = '30px 20px';
      p.textContent = 'Лайкните артистов на zvuk.com, чтобы включить волны по ним';
      aGrid.append(p);
    }
  } catch (e) {
    // 
  }
}

function silaPanel() {
  const panel = document.createElement('div');
  panel.className = 'sila-panel';

  const header = document.createElement('div');
  header.className = 'sila-header';
  const left = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'sila-title';
  t.innerHTML = 'Сила звука <span class="badge">волна</span>';
  const d = document.createElement('div');
  d.className = 'sila-desc';
  d.textContent = 'Волна строится из ваших любимых треков и артистов. Настройте параметры и запустите — Звук подберёт подходящую музыку.';
  left.append(t, d);
  header.append(left);
  panel.append(header);

  const controls = document.createElement('div');
  controls.className = 'sila-controls';
  controls.append(silaSlider('sila-energy', 'Энергичность', 'спокойная', 'энергичная', 50));
  controls.append(silaSlider('sila-mood', 'Настроение', 'грустная', 'весёлая', 50));
  controls.append(silaSlider('sila-pop', 'Популярность', 'редкая', 'хиты', 50));

  const genreBlock = document.createElement('div');
  genreBlock.className = 'sila-slider';
  const glabel = document.createElement('label');
  glabel.innerHTML = '<span>Жанры</span>';
  const chips = document.createElement('div');
  chips.className = 'chips';
  GENRES.forEach((g) => {
    const c = document.createElement('div');
    c.className = 'chip';
    c.textContent = g;
    c.addEventListener('click', () => {
      c.classList.toggle('on');
      const i = state.silaGenres.indexOf(g);
      if (i >= 0) state.silaGenres.splice(i, 1);
      else state.silaGenres.push(g);
    });
    chips.append(c);
  });
  genreBlock.append(glabel, chips);
  controls.append(genreBlock);

  panel.append(controls);

  const actions = document.createElement('div');
  actions.className = 'sila-actions';
  
  const leftGroup = document.createElement('div');
  leftGroup.className = 'sila-left-group';
  
  const start = document.createElement('button');
  start.id = 'sila-start';
  start.className = 'btn btn-primary';
  start.textContent = 'Запустить волну';
  start.addEventListener('click', () => startSilaWave());
  
  const reset = document.createElement('button');
  reset.id = 'sila-reset';
  reset.className = 'btn hidden';
  reset.textContent = 'Сбросить';
  reset.addEventListener('click', resetSila);
  
  const status = document.createElement('div');
  status.id = 'sila-status';
  status.className = 'wave-status';
  
  leftGroup.append(start, reset, status);
  actions.append(leftGroup);
  panel.append(actions);

  if (wave.active) {
    if (wave.source === 'sila') start.textContent = 'Перезапустить волну';
    reset.classList.remove('hidden');
    status.innerHTML = `Волна играет · <b>${wave.count} треков</b>`;
  }

  return panel;
}

function silaSlider(id, label, low, high, value) {
  const block = document.createElement('div');
  block.className = 'sila-slider';
  const l = document.createElement('label');
  l.innerHTML = `<span>${label}</span><b id="${id}-val">${value}</b>`;
  const input = document.createElement('input');
  input.id = id;
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.value = String(value);
  input.addEventListener('input', () => {
    document.getElementById(`${id}-val`).textContent = input.value;
  });
  const ends = document.createElement('div');
  ends.className = 'ends';
  const a = document.createElement('span');
  a.textContent = low;
  const b = document.createElement('span');
  b.textContent = high;
  ends.append(a, b);
  block.append(l, input, ends);
  return block;
}

function artistWaveCard(a) {
  const card = document.createElement('div');
  card.className = 'card artist-wave-card';
  const isArtistActive = wave.active && wave.source === 'artist' && wave.name === a.title;
  if (isArtistActive) card.classList.add('active');
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.src = a.image ? coverUrl(a.image.src, '300x300') : '';
  img.alt = '';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = a.title || '';
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = isArtistActive ? `Волна играет · ${wave.count} треков` : 'Артист';
  const play = document.createElement('button');
  play.className = 'wave-play';
  play.textContent = '▶';
  play.title = 'Запустить волну';
  play.addEventListener('click', (e) => {
    e.stopPropagation();
    startArtistWave(a.id, a.title);
  });
  card.append(img, t, sub, play);
  card.addEventListener('click', () => openArtist(a.id));
  return card;
}



function silaVal(id, fallback) {
  const el = document.getElementById(id);
  return el ? Number(el.value) : fallback;
}

async function generateSilaQueue() {
  const [tracksData, coll] = await Promise.all([invoke('user_tracks'), invoke('user_collection')]);
  const likedIds = ((tracksData && tracksData.collection && tracksData.collection.tracks) || [])
    .map((t) => t.id)
    .filter(Boolean);
  const artistIds = ((coll && coll.collection && coll.collection.artists) || [])
    .map((a) => a.id)
    .filter(Boolean);

  const pool = [];
  const seen = new Set();
  const add = (t, src) => {
    if (t && t.id && !seen.has(t.id)) {
      seen.add(t.id);
      pool.push(Object.assign({}, t, { _src: src }));
    }
  };

  if (likedIds.length) {
    try {
      const tr = await invoke('get_tracks', { ids: likedIds.slice(0, 60) });
      ((tr && tr.getTracks) || []).forEach((t) => add(t, 'like'));
    } catch (e) {
      
    }
  }

  if (artistIds.length) {
    try {
      const art = await invoke('get_artists', { ids: artistIds.slice(0, 5), withPopTracks: true });
      ((art && art.getArtists) || []).forEach((a) =>
        ((a && a.popularTracks) || []).forEach((t) => add(t, 'artist'))
      );
    } catch (e) {
      
    }
  }

  const queries = [];
  const energy = silaVal('sila-energy', 50);
  const mood = silaVal('sila-mood', 50);
  if (energy > 60) queries.push('энергичная музыка');
  else if (energy < 40) queries.push('спокойная музыка');
  if (mood > 60) queries.push('весёлая музыка');
  else if (mood < 40) queries.push('грустная музыка');
  state.silaGenres.slice(0, 2).forEach((g) => queries.push(g));
  for (const q of queries) {
    try {
      const s = await invoke('search', { query: q, limit: 8 });
      ((s && s.search && s.search.tracks && s.search.tracks.items) || []).forEach((t) => add(t, 'other'));
    } catch (e) {
      
    }
  }

  let result = pool;

  const pop = silaVal('sila-pop', 50);
  const likedOnly = result.filter((t) => t._src === 'like');
  const artistOnly = result.filter((t) => t._src === 'artist');
  const other = result.filter((t) => t._src !== 'like' && t._src !== 'artist');
  if (pop >= 65) result = [...artistOnly, ...shuffle(other), ...shuffle(likedOnly)];
  else if (pop <= 35) result = [...likedOnly, ...shuffle(other), ...shuffle(artistOnly)];
  else shuffle(result);

  return result;
}

async function startSilaWave() {
  const btn = document.getElementById('sila-start');
  if (btn) btn.disabled = true;
  try {
    const q = await generateSilaQueue();
    if (!q.length) {
      toast('Не удалось собрать волну: добавьте треки в избранное или поищите что-нибудь');
      return;
    }
    const limitedQueue = q.slice(0, MAX_QUEUE);
    state.queue = limitedQueue;
    state.queueIndex = 0;
    state.fullSilaQueue = q;
    wave.active = true;
    wave.source = 'sila';
    wave.count = q.length;
    wave.name = null;
    await playCurrent();  
    const status = document.getElementById('sila-status');
    if (status) status.innerHTML = `Волна играет · <b>${q.length} треков</b>`;
    if (btn) btn.textContent = 'Перезапустить волну';
    const reset = document.getElementById('sila-reset');
    if (reset) reset.classList.remove('hidden');
  } catch (e) {
    toast(String(e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function resetSila() {
  wave.active = false;
  wave.source = null;
  wave.count = 0;
  wave.name = null;
  $('#sila-energy').value = 50;
  $('#sila-mood').value = 50;
  $('#sila-pop').value = 50;
  $('#sila-energy-val').textContent = '50';
  $('#sila-mood-val').textContent = '50';
  $('#sila-pop-val').textContent = '50';
  state.silaGenres = [];
  state.fullSilaQueue = [];
  document.querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
  const start = $('#sila-start');
  if (start) start.textContent = 'Запустить волну';
  $('#sila-reset').classList.add('hidden');
  const status = $('#sila-status');
  if (status) status.innerHTML = '';
}

async function startArtistWave(artistId, name) {
  try {
    const data = await invoke('get_artists', {
      ids: [String(artistId)],
      withPopTracks: true,
      withRelated: true,
    });
    const a = (data && data.getArtists && data.getArtists[0]) || null;
    if (!a) {
      toast('Не удалось загрузить артиста');
      return;
    }
    const tracks = [...((a.popularTracks || []).filter((t) => t && t.id))];
    const rel = (a.relatedArtists || [])[0];
    if (rel && rel.id) {
      try {
        const syn = await invoke('synthesis_build', { first: String(artistId), second: String(rel.id) });
        const st = (syn && syn.synthesisPlaylistBuild && syn.synthesisPlaylistBuild.tracks) || [];
        const seen = new Set(tracks.map((t) => t.id));
        st.forEach((t) => {
          if (t && t.id && !seen.has(t.id)) {
            seen.add(t.id);
            tracks.push(t);
          }
        });
      } catch (e) {
        
      }
    }
    if (!tracks.length) {
      toast('У артиста нет доступных треков');
      return;
    }
    wave.active = true;
    wave.source = 'artist';
    wave.count = tracks.length;
    wave.name = a.title || name;
    playQueue(shuffle(tracks), 0);
    toast(`Волна по артисту: ${name || a.title}`, true);
  } catch (e) {
    toast(String(e));
  }
}

function regenerateWave() {
  if (wave.source === 'sila') {
    startSilaWave();
  } else {
    shuffle(state.queue);
    state.queueIndex = 0;
    playCurrent();
  }
}



function doSearch(query) {
  clearTimeout(state.searchTimer);
  const q = (query || $('#search-input').value).trim();
  if (!q) return;
  $('#search-spinner').classList.remove('hidden');
  state.searchTimer = setTimeout(async () => {
    try {
      const data = await invoke('search', { query: q, limit: 12 });
      state.lastSearch = q;
      state.lastSearchData = data;
      markActive('search');
      renderContent(renderSearchResultsContent, data);
    } catch (e) {
      renderErrorContent(e);
    } finally {
      $('#search-spinner').classList.add('hidden');
    }
  }, 300);
}

$('#search-input').addEventListener('input', () => {
  const q = $('#search-input').value.trim();
  if (!q) {
    state.lastSearch = '';
    state.lastSearchData = null;
    renderContent(renderPlaceholderContent,
      '🔎',
      'Начните вводить запрос, чтобы найти треки, артистов, альбомы и плейлисты'
    );
    return;
  }
  doSearch(q);
});

function renderSearchResultsContent(data) {
  const content = $('#content');
  content.innerHTML = '';
  
  const search = (data && data.search) || {};
  const tracks = (search.tracks && search.tracks.items) || [];
  const artists = (search.artists && search.artists.items) || [];
  const releases = (search.releases && search.releases.items) || [];
  const playlists = (search.playlists && search.playlists.items) || [];

  if (!tracks.length && !artists.length && !releases.length && !playlists.length) {
    renderPlaceholderContent('🙈', `Ничего не найдено по запросу «${esc(state.lastSearch)}»`);
    return;
  }

  if (tracks.length) {
    const sec = section('Треки', `${tracks.length}`);
    renderTrackList(tracks, sec);
    content.append(sec);
  }
  if (artists.length) {
    const sec = section('Артисты', `${artists.length}`);
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    grid.append(...artists.map(artistCard));
    sec.append(grid);
    content.append(sec);
  }
  if (releases.length) {
    const sec = section('Альбомы', `${releases.length}`);
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    grid.append(...releases.map(releaseCard));
    sec.append(grid);
    content.append(sec);
  }
  if (playlists.length) {
    const sec = section('Плейлисты', `${playlists.length}`);
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    grid.append(...playlists.map(playlistCard));
    sec.append(grid);
    content.append(sec);
  }
}

async function loadLibraryContent() {
  const content = $('#content');
  content.innerHTML = '';
  content.append(spinnerBlock());
  
  try {
    const [tracksData, coll] = await Promise.all([invoke('user_tracks'), invoke('user_collection')]);
    const trackIds = ((tracksData && tracksData.collection && tracksData.collection.tracks) || [])
      .map((t) => t.id)
      .filter(Boolean);
    const collPlaylists = (coll && coll.collection && coll.collection.playlists) || [];
    const collReleases = (coll && coll.collection && coll.collection.releases) || [];
    const playlistIds = collPlaylists.map((p) => p.id).filter(Boolean);
    const releaseIds = collReleases.map((r) => r.id).filter(Boolean);

    content.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'view-title';
    title.textContent = 'Моя музыка';
    content.append(title);

    if (!trackIds.length && !releaseIds.length && !playlistIds.length) {
      renderPlaceholderContent('🎵', 'Здесь появятся треки, альбомы и плейлисты, которые вы добавите в избранное на zvuk.com');
      return;
    }

    if (trackIds.length) {
      const sec = section('Любимые треки', `${trackIds.length}`);
      const tr = await invoke('get_tracks', { ids: trackIds });
      const items = ((tr && tr.getTracks) || []).filter((t) => t && t.id);
      items.forEach((t) => state.liked.add(t.id));
      renderTrackList(items, sec);
      content.append(sec);
    }

    if (releaseIds.length) {
      const sec = section('Любимые альбомы', `${releaseIds.length}`);
      const rd = await invoke('get_releases', { ids: releaseIds, withTracks: false });
      const rels = ((rd && rd.getReleases) || []).filter((r) => r && r.id);
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      grid.append(...rels.map(releaseCard));
      sec.append(grid);
      content.append(sec);
    }

    if (playlistIds.length) {
      const sec = section('Любимые плейлисты', `${playlistIds.length}`);
      const pd = await invoke('get_playlists', { ids: playlistIds });
      const pls = ((pd && pd.playlists) || []).filter((p) => p && p.id);
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      grid.append(...pls.map(playlistCard));
      sec.append(grid);
      content.append(sec);
    }
  } catch (e) {
    content.innerHTML = '';
    renderErrorContent(e);
  }
}

function renderErrorContent(e) {
  const content = $('#content');
  content.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'placeholder';
  p.innerHTML = `<div class="big">⚠️</div><div>${esc(String(e))}</div>`;
  content.append(p);
}

async function loadPlaylistsContent() {
  const content = $('#content');
  content.innerHTML = '';
  content.append(spinnerBlock());
  
  try {
    const pd = await invoke('user_playlists');
    const ids = ((pd && pd.collection && pd.collection.playlists) || [])
      .map((p) => p.id)
      .filter(Boolean);
    content.innerHTML = '';
    
    const head = document.createElement('div');
    head.className = 'view-head';
    const title = document.createElement('div');
    title.className = 'view-title';
    title.textContent = 'Плейлисты';
    const create = document.createElement('button');
    create.className = 'btn btn-primary';
    create.textContent = 'Создать плейлист';
    create.addEventListener('click', () => openCreatePlaylist());
    head.append(title, create);
    content.append(head);

    if (!ids.length) {
      renderPlaceholderContent('🗂️', 'Плейлистов пока нет. Создайте первый — это удобно');
      return;
    }
    
    const data = await invoke('get_playlists', { ids });
    const pls = ((data && data.playlists) || []).filter((p) => p && p.id);
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    grid.append(...pls.map(playlistCard));
    content.append(grid);
  } catch (e) {
    content.innerHTML = '';
    renderErrorContent(e);
  }
}

function renderSettingsContent() {
  const content = $('#content');
  content.innerHTML = '';
  
  const title = document.createElement('div');
  title.className = 'view-title';
  title.textContent = 'Настройки';
  content.append(title);

  const body = document.createElement('div');
  body.className = 'settings-body';

  const qGroup = document.createElement('div');
  qGroup.className = 'settings-group';
  const qTitle = document.createElement('div');
  qTitle.className = 'settings-group-title';
  qTitle.textContent = 'Качество звука';
  const qRow = document.createElement('label');
  qRow.className = 'switch-row';
  const qSpan = document.createElement('span');
  const qSmall = document.createElement('small');
  qSmall.textContent = '(FLAC, если доступен)';
  qSpan.append('Hi-Fi звук ', qSmall);
  const qInput = document.createElement('input');
  qInput.type = 'checkbox';
  qInput.id = 'setting-hifi';
  qInput.checked = settings.hifi;
  qInput.addEventListener('change', () => {
    settings.hifi = qInput.checked;
    saveSettings();
    state.streams.clear();
    toast(settings.hifi ? 'Hi-Fi включён (FLAC)' : 'Обычное качество', true);
  });
  qRow.append(qSpan, qInput);
  qGroup.append(qTitle, qRow);
  body.append(qGroup);

  const hGroup = document.createElement('div');
  hGroup.className = 'settings-group';
  const hTitle = document.createElement('div');
  hTitle.className = 'settings-group-title';
  hTitle.textContent = 'Горячие клавиши';
  const hotkeys = document.createElement('div');
  hotkeys.className = 'hotkey-list';
  hotkeys.id = 'hotkey-list';
  hGroup.append(hTitle, hotkeys);
  body.append(hGroup);

  const dGroup = document.createElement('div');
  dGroup.className = 'settings-group';
  const dTitle = document.createElement('div');
  dTitle.className = 'settings-group-title';
  dTitle.textContent = 'Discord';
  const dRow = document.createElement('label');
  dRow.className = 'switch-row';
  const dSpan = document.createElement('span');
  dSpan.append('Показывать статус в Discord');
  const dInput = document.createElement('input');
  dInput.type = 'checkbox';
  dInput.id = 'setting-discord';
  dInput.checked = settings.discordRpc;
  dInput.addEventListener('change', () => {
    settings.discordRpc = dInput.checked;
    saveSettings();
    if (!settings.discordRpc) {
      invoke('discord_clear').catch(() => {});
    } else {
      discordStatus(state.queue[state.queueIndex], !audio.paused);
    }
    toast(settings.discordRpc ? 'Discord RPC включён' : 'Discord RPC выключен', true);
  });
  dRow.append(dSpan, dInput);
  dGroup.append(dTitle, dRow);
  body.append(dGroup);

  const lGroup = document.createElement('div');
  lGroup.className = 'settings-group';
  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'btn btn-danger';
  logoutBtn.style.alignSelf = 'flex-start';
  logoutBtn.textContent = 'Выйти из аккаунта';
  logoutBtn.addEventListener('click', logout);
  lGroup.append(logoutBtn);
  body.append(lGroup);

  content.append(body);
  renderHotkeys();
}

function trackRow(track, index, list, opts = {}) {
  const row = document.createElement('div');
  row.className = 'track-row';
  if (track.id === state.currentTrackId) row.classList.add('playing');
  if (track.id === state.currentTrackId && audio.paused) row.classList.add('paused');
  row.dataset.id = track.id;

  const indicator = document.createElement('div');
  indicator.className = 'track-playing-indicator';
  
  const waveBars = document.createElement('div');
  waveBars.className = 'wave-bars';
  for (let i = 0; i < 5; i++) {
    const bar = document.createElement('span');
    bar.className = 'wave-bar';
    waveBars.appendChild(bar);
  }
  indicator.appendChild(waveBars);
  
  const num = document.createElement('span');
  num.className = 'track-num';
  num.textContent = String(index + 1);
  
  const isPlaying = track.id === state.currentTrackId;
  if (isPlaying) {
    indicator.style.display = 'inline-flex';
    num.style.display = 'none';
  } else {
    indicator.style.display = 'none';
    num.style.display = 'inline';
  }

  const cover = document.createElement('img');
  cover.className = 'track-cover';
  cover.src = trackImage(track, '84x84');
  cover.alt = '';

  const main = document.createElement('div');
  main.className = 'track-main';
  const title = document.createElement('div');
  title.className = 'track-title';
  title.textContent = track.title || '';
  const artist = document.createElement('div');
  artist.className = 'track-artist';
  artist.textContent = artistString(track);
  main.append(title, artist);

  const pl = document.createElement('button');
  pl.className = 'pl-btn';
  pl.title = 'В плейлист';
  pl.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zm10-5l7 4-7 4v-8z"/></svg>`;
  pl.dataset.id = track.id;

  const like = document.createElement('button');
  like.className = 'like-btn';
  const liked = state.liked.has(track.id);
  like.innerHTML = liked 
    ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;

  const dur = document.createElement('span');
  dur.className = 'track-duration';
  dur.textContent = fmtTime(track.duration);

  let rem = null;
  if (opts.remove) {
    rem = document.createElement('button');
    rem.className = 'remove-btn';
    rem.textContent = '✕';
    rem.title = 'Удалить из плейлиста';
    rem.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.remove(track);
    });
  }

  row.append(indicator, num, cover, main, pl, like, rem || dur);
  if (rem) row.append(dur);

  row.addEventListener('click', () => playQueue(list, index));
  pl.addEventListener('click', (e) => {
    e.stopPropagation();
    openAddToPlaylist(track);
  });
  like.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLike(track, like);
  });
  
  return row;
}

let modalState = { track: null };

function openModal() {
  $('#playlist-modal').classList.remove('hidden');
}

function closeModal() {
  $('#playlist-modal').classList.add('hidden');
  $('#modal-new-name').value = '';
  modalState = { track: null };
}

async function openAddToPlaylist(track) {
  modalState = { track };
  $('#modal-title').textContent = 'Добавить в плейлист';
  $('#modal-new-btn').textContent = 'Создать и добавить';
  openModal();
  const listEl = $('#modal-playlists');
  listEl.innerHTML = '<div class="modal-playlist-empty">Загрузка…</div>';
  try {
    const pd = await invoke('user_playlists');
    const ids = ((pd && pd.collection && pd.collection.playlists) || [])
      .map((p) => p.id)
      .filter(Boolean);
    if (!ids.length) {
      listEl.innerHTML =
        '<div class="modal-playlist-empty">Плейлистов пока нет — создайте первый ниже</div>';
      return;
    }
    const data = await invoke('get_playlists', { ids });
    const pls = ((data && data.playlists) || []).filter((p) => p && p.id);
    listEl.innerHTML = '';
    pls.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'modal-playlist-item';
      const img = document.createElement('img');
      img.src = playlistImage(p, '100x100');
      img.alt = '';
      const meta = document.createElement('div');
      meta.style.minWidth = '0';
      meta.style.flex = '1';
      const t = document.createElement('div');
      t.className = 'pl-title';
      t.textContent = p.title || '';
      const s = document.createElement('div');
      s.className = 'pl-sub';
      s.textContent = p.tracks && p.tracks.length ? `${p.tracks.length} треков` : 'Плейлист';
      meta.append(t, s);
      row.append(img, meta);
      row.addEventListener('click', () => addToPlaylist(p.id, p.title));
      listEl.append(row);
    });
  } catch (e) {
    listEl.innerHTML = `<div class="modal-playlist-empty">${esc(String(e))}</div>`;
  }
}

function openCreatePlaylist() {
  modalState = { track: null };
  $('#modal-title').textContent = 'Новый плейлист';
  $('#modal-new-btn').textContent = 'Создать';
  $('#modal-playlists').innerHTML =
    '<div class="modal-playlist-empty">Введите название нового плейлиста</div>';
  openModal();
  $('#modal-new-name').focus();
}

async function addToPlaylist(playlistId, title) {
  if (!modalState.track) return;
  try {
    await invoke('add_tracks_to_playlist', {
      id: String(playlistId),
      items: [{ type: 'track', item_id: modalState.track.id }],
    });
    toast(`Добавлено в «${title}»`, true);
    closeModal();
  } catch (e) {
    toast(String(e));
  }
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal-new-btn').addEventListener('click', async () => {
  const name = $('#modal-new-name').value.trim();
  if (!name) {
    toast('Введите название');
    return;
  }
  const items = modalState.track ? [{ type: 'track', item_id: modalState.track.id }] : [];
  try {
    await invoke('create_playlist', { name, items });
    toast(`Плейлист «${name}» создан`, true);
    closeModal();
    if (state.view === 'playlists')
      renderContent(loadPlaylistsContent);
  } catch (e) {
    toast(String(e));
  }
});

$('#playlist-modal').addEventListener('click', (e) => {
  if (e.target.id === 'playlist-modal') closeModal();
});

async function openPlaylist(id) {
  const content = $('#content');
  content.innerHTML = '';
  content.append(spinnerBlock());
  try {
    const data = await invoke('get_playlists', { ids: [String(id)] });
    const pl = (data && data.playlists && data.playlists[0]) || null;
    if (!pl || !pl.id) {
      renderContent(renderErrorContent, 'Плейлист не найден');
      return;
    }
    renderDetail(content, { kind: 'playlist', item: pl });
  } catch (e) {
    content.innerHTML = '';
    renderContent(renderErrorContent, e);
  }
}

async function openRelease(id) {
  const content = $('#content');
  content.innerHTML = '';
  content.append(spinnerBlock());
  try {
    const data = await invoke('get_releases', { ids: [String(id)], withTracks: true });
    const rel = (data && data.getReleases && data.getReleases[0]) || null;
    if (!rel || !rel.id) {
      renderContent(renderErrorContent, 'Альбом не найден');
      return;
    }
    renderDetail(content, { kind: 'release', item: rel });
  } catch (e) {
    content.innerHTML = '';
    renderContent(renderErrorContent, e);
  }
}

async function renderContent(renderFn, ...args) {
  const content = $('#content');
  
  if (content.children.length > 0) {
    content.classList.add('fade-out');
    await new Promise(resolve => setTimeout(resolve, 300));
    content.innerHTML = '';
    content.classList.remove('fade-out');
    await renderFn(...args);
    content.classList.add('fade-in');
    setTimeout(() => {
      content.classList.remove('fade-in');
    }, 500);
  } else {
    await renderFn(...args);
    content.classList.add('fade-in');
    setTimeout(() => {
      content.classList.remove('fade-in');
    }, 500);
  }
}

function renderPlaceholderContent(icon, text) {
  const content = $('#content');
  content.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'placeholder';
  const big = document.createElement('div');
  big.className = 'big';
  big.textContent = icon;
  const t = document.createElement('div');
  t.textContent = text || '';
  p.append(big, t);
  content.append(p);
}

function renderDetail(content, { kind, item }) {
  content.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'detail-header';
  const img = document.createElement('img');
  img.className = 'detail-cover';
  img.src = playlistImage(item, '400x400');
  img.alt = '';
  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  const type = document.createElement('div');
  type.className = 'detail-type';
  type.textContent = kind === 'playlist' ? 'Плейлист' : (item.type || 'Альбом');
  const title = document.createElement('div');
  title.className = 'detail-title';
  title.textContent = item.title || '';
  const sub = document.createElement('div');
  sub.className = 'detail-sub';
  sub.textContent = artistString(item);
  meta.append(type, title, sub);
  if (kind === 'playlist') {
    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    const del = document.createElement('button');
    del.className = 'btn btn-danger';
    del.textContent = 'Удалить плейлист';
    let armed = false;
    let armTimer = null;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Точно удалить?';
        clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          armed = false;
          del.textContent = 'Удалить плейлист';
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      try {
        await invoke('delete_playlist', { id: String(item.id) });
        toast('Плейлист удалён', true);
        showView('playlists');
        renderContent(loadPlaylistsContent);
      } catch (e) {
        toast(String(e));
      }
    });
    actions.append(del);
    meta.append(actions);
  }
  header.append(img, meta);
  content.append(header);

  const tracks = (item.tracks || []).filter((t) => t && t.id);
  if (!tracks.length) {
    renderPlaceholderContent('📻', 'В этом плейлисте пока нет треков');
    return;
  }
  tracks.forEach((t) => {
    const stream = t.stream || {};
    const url = stream.high || stream.mid || stream.flac;
    if (url) state.streams.set(t.id, url);
  });
  const opts =
    kind === 'playlist' ? { remove: (track) => removeFromPlaylist(item, track) } : {};
  renderTrackList(tracks, content, opts);
}

async function removeFromPlaylist(playlist, track) {
  const remaining = (playlist.tracks || [])
    .filter((t) => t && t.id && t.id !== track.id)
    .map((t) => ({ type: 'track', item_id: t.id }));
  try {
    await invoke('update_playlist', {
      id: String(playlist.id),
      items: remaining,
      isPublic: !!playlist.isPublic,
      name: playlist.title || '',
    });
    toast(`Удалено из «${playlist.title || ''}»`, true);
    openPlaylist(playlist.id);
  } catch (e) {
    toast(String(e));
  }
}



async function openArtist(id) {
  const content = $('#content');
  content.innerHTML = '';
  content.append(spinnerBlock());
  try {
    const data = await invoke('get_artists', {
      ids: [String(id)],
      withReleases: true,
      withPopTracks: true,
      withRelated: true,
      withDesc: true,
    });
    const a = (data && data.getArtists && data.getArtists[0]) || null;
    if (!a || !a.id) {
      content.innerHTML = '';
      renderContent(renderErrorContent, 'Артист не найден');
      return;
    }
    content.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'detail-header';
    const img = document.createElement('img');
    img.className = 'detail-cover';
    img.src = a.image ? coverUrl(a.image.src, '400x400') : '';
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'detail-meta';
    const type = document.createElement('div');
    type.className = 'detail-type';
    type.textContent = 'Артист';
    const title = document.createElement('div');
    title.className = 'detail-title';
    title.textContent = a.title || '';
    const sub = document.createElement('div');
    sub.className = 'detail-sub';
    const trackCount = (a.popularTracks || []).length;
    sub.textContent = trackCount ? `${trackCount} популярных треков` : '';
    meta.append(type, title, sub);
    if (a.description) {
      const bio = document.createElement('div');
      bio.className = 'artist-bio';
      bio.textContent = a.description;
      const toggle = document.createElement('button');
      toggle.className = 'btn btn-ghost bio-toggle';
      toggle.textContent = 'Подробнее';
      let expanded = false;
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        bio.classList.toggle('expanded', expanded);
        toggle.textContent = expanded ? 'Скрыть' : 'Подробнее';
      });
      bio.style.marginTop = '10px';
      meta.append(bio, toggle);
    }
    header.append(img, meta);
    content.append(header);

    const tracks = (a.popularTracks || []).filter((t) => t && t.id);
    if (tracks.length) {
      const sec = section('Популярные треки', `${tracks.length}`);
      renderTrackList(tracks, sec);
      content.append(sec);
    }

    const rels = (a.releases || []).filter((r) => r && r.id);
    if (rels.length) {
      const sec = section('Альбомы', `${rels.length}`);
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      grid.append(...rels.map(releaseCard));
      sec.append(grid);
      content.append(sec);
    }

    const related = (a.relatedArtists || []).filter((r) => r && r.id);
    if (related.length) {
      const sec = section('Похожие артисты', `${related.length}`);
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      grid.append(...related.map(artistCard));
      sec.append(grid);
      content.append(sec);
    }
  } catch (e) {
    content.innerHTML = '';
    renderContent(renderErrorContent, e);
  }
}



function playlistCard(p) {
  const card = document.createElement('div');
  card.className = 'card';
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.src = playlistImage(p, '300x300');
  img.alt = '';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = p.title || '';
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = p.tracks && p.tracks.length ? `${p.tracks.length} треков` : 'Плейлист';
  card.append(img, t, sub);
  card.addEventListener('click', () => openPlaylist(p.id));
  return card;
}

function releaseCard(r) {
  const card = document.createElement('div');
  card.className = 'card';
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.src = r.image ? coverUrl(r.image.src, '300x300') : '';
  img.alt = '';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = r.title || '';
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = artistString(r) || 'Альбом';
  card.append(img, t, sub);
  card.addEventListener('click', () => openRelease(r.id));
  return card;
}

function artistCard(a) {
  const card = document.createElement('div');
  card.className = 'card';
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.src = a.image ? coverUrl(a.image.src, '300x300') : '';
  img.alt = '';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = a.title || '';
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = 'Артист';
  card.append(img, t, sub);
  card.addEventListener('click', () => openArtist(a.id));
  return card;
}



function renderTrackList(tracks, container, opts = {}) {
  const list = document.createElement('div');
  list.className = 'track-list';
  tracks.forEach((t, i) => list.append(trackRow(t, i, tracks, opts)));
  container.append(list);
}

async function toggleLike(track, btn) {
  const id = track.id;
  const liked = state.liked.has(id);
  try {
    if (liked) {
      await invoke('remove_from_collection', { id, itemType: 'track' });
      state.liked.delete(id);
    } else {
      await invoke('add_to_collection', { id, itemType: 'track' });
      state.liked.add(id);
    }
    syncLikeButtons();
  } catch (e) {
    toast(String(e));
  }
}

function syncLikeButtons() {
  const liked = state.liked;
  document.querySelectorAll('.like-btn[data-id]').forEach((b) => {
    const isLiked = liked.has(b.dataset.id);
    b.innerHTML = isLiked 
      ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
    b.classList.toggle('liked', isLiked);
    b.title = isLiked ? 'Убрать из избранного' : 'В избранное';
  });
  const pb = $('#player-like');
  if (state.currentTrackId) {
    const isLiked = liked.has(state.currentTrackId);
    pb.innerHTML = isLiked 
      ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
    pb.classList.toggle('liked', isLiked);
  }
}



async function playQueue(list, index) {
  const track = list[index];
  if (track && state.currentTrackId === track.id) {
    togglePlay();
    return;
  }
  state.queue = list;
  state.queueIndex = index;
  await playCurrent();
}

async function playCurrent(opts = {}) {
  const track = state.queue[state.queueIndex];
  if (!track) return;
  state.currentTrackId = track.id;
  updatePlayerUI(track);
  discordStatus(track, true);
  highlightQueue();
  updateTrackIndicators();
  saveLastState();
  let url = state.streams.get(track.id);
  if (!url) {
    try {
      const data = await invoke('get_stream', { ids: [track.id] });
      const items = (data && data.mediaContents) || [];
      const stream = items[0] && items[0].stream;
      url = settings.hifi
        ? (stream && (stream.flac || stream.high || stream.mid)) || null
        : (stream && (stream.high || stream.mid || stream.flac)) || null;
      if (url) state.streams.set(track.id, url);
    } catch (e) {
      toast(String(e));
      return;
    }
  }
  if (!url) {
    toast('Не удалось получить поток трека');
    return;
  }

  // Web Audio требует CORS, а CDN его не отдаёт — заворачиваем прямые
  // ссылки в локальный прокси. HLS идёт через MSE (blob) и не нуждается.
  const isHls = /\.m3u8($|\?)/i.test(url);
  if (!isHls && (settings.eq.enabled || audioCtx)) {
    try {
      url = await invoke('stream_proxy', { url });
    } catch (e) {
      toast('Эквалайзер недоступен: ' + String(e));
    }
  }

  setupSource(url);
  ensureEqActive();

  if (opts.position) {
    const seek = () => {
      try {
        audio.currentTime = Math.min(opts.position, audio.duration || opts.position);
      } catch (e) {}
    };
    if (audio.readyState >= 1) seek();
    else audio.addEventListener('loadedmetadata', seek, { once: true });
  }

  if (audio.paused && opts.autoplay !== false) {
    try {
      await audio.play();
    } catch (e) {
      if (e.name !== 'AbortError') {
        toast('Не удалось начать воспроизведение');
      }
    }
  }
  updatePlayBtn();
}

function setupSource(url) {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  audio.pause();
  // Эквалайзеру нужен CORS-источник, поэтому такие ссылки идут через
  // локальный прокси. Обычное воспроизведение — без crossOrigin: CDN не
  // отдаёт CORS для подписанных ссылок, и браузер отклоняет такой ответ.
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
    audio.crossOrigin = 'anonymous';
  } else {
    audio.removeAttribute('crossorigin');
  }
  audio.removeAttribute('src');
  audio.load();

  const isHls = /\.m3u8($|\?)/i.test(url);
  if (isHls && window.Hls && Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(audio);
    hls.on(Hls.Events.ERROR, (e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else {
        toast('Ошибка воспроизведения стрима');
        hls.destroy();
        hls = null;
      }
    });
  } else {
    audio.src = url;
  }
}

function updatePlayerUI(track) {
  $('#player').classList.remove('hidden');
  $('#player-cover').src = trackImage(track, '200x200');
  $('#player-title').textContent = track.title || '';
  $('#player-artist').textContent = artistString(track);
  syncLikeButtons();
  if (navigator.mediaSession) {
    const art = trackImage(track, '512x512');
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || '',
      artist: artistString(track),
      album: (track.release && track.release.title) || '',
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  }
}


/* ============================== Эквалайзер ==============================
   Граф: <audio> → MediaElementSource → Gain(preamp) → 10×BiquadFilter → output.
   MediaElementSource создаётся один раз (ограничение Web Audio), поэтому при
   выключенном эквалайзере источник подключается прямо к destination. */
const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_BAND_NAMES = ['32 Гц', '64 Гц', '125 Гц', '250 Гц', '500 Гц', '1 кГц', '2 кГц', '4 кГц', '8 кГц', '16 кГц'];
const EQ_MIN = -12;
const EQ_MAX = 12;
const EQ_Q = 1.41;
const EQ_CUSTOM = '__custom__';

const EQ_PRESETS = {
  flat:      { title: 'Плоский',     preamp: 0,  bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass:      { title: 'Бас',         preamp: -4, bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  vocal:     { title: 'Вокал',       preamp: -3, bands: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  rock:      { title: 'Рок',         preamp: -4, bands: [5, 4, 3, 1, -1, -1, 0, 2, 3, 4] },
  pop:       { title: 'Поп',         preamp: -3, bands: [-1, 0, 2, 4, 4, 2, 0, -1, -1, -1] },
  jazz:      { title: 'Джаз',        preamp: -3, bands: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  electro:   { title: 'Электроника', preamp: -4, bands: [5, 4, 1, 0, -2, 2, 1, 1, 4, 5] },
  acoustic:  { title: 'Акустика',    preamp: -3, bands: [4, 3, 2, 1, 2, 2, 3, 3, 2, 1] },
  loudness:  { title: 'Громкость',   preamp: -5, bands: [6, 4, 0, -2, -3, -1, 2, 4, 5, 6] },
};

let audioCtx = null;
let eqSource = null;
let eqPreampNode = null;
let eqFilters = [];
let eqValueTimer = null;
let eqSaveConfirm = '';

function clampEq(value) {
  const n = Number(value);
  if (!isFinite(n)) return 0;
  return Math.max(EQ_MIN, Math.min(EQ_MAX, Math.round(n * 2) / 2));
}

/* Заливка растёт от нижнего края (−12 дБ) до ползунка —
   как у громкости, только вертикально. */
function setEqFill(input, value) {
  if (!input) return;
  const v = clampEq(value);
  const percent = ((v - EQ_MIN) / (EQ_MAX - EQ_MIN)) * 100;
  input.style.setProperty('--eq-progress', percent + '%');
}

function normalizeBands(bands) {
  return EQ_FREQS.map((_, i) => clampEq(Array.isArray(bands) ? bands[i] : 0));
}

function ensureAudioGraph() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    audioCtx = new Ctx();
    eqSource = audioCtx.createMediaElementSource(audio);
    eqPreampNode = audioCtx.createGain();
    eqFilters = EQ_FREQS.map((freq) => {
      const filter = audioCtx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = EQ_Q;
      filter.gain.value = 0;
      return filter;
    });
  } catch (e) {
    audioCtx = null;
    eqSource = null;
    eqPreampNode = null;
    eqFilters = [];
    return null;
  }
  return audioCtx;
}

function applyEqValues() {
  if (!audioCtx) return;
  if (eqPreampNode) {
    eqPreampNode.gain.value = Math.pow(10, clampEq(settings.eq.preamp) / 20);
  }
  eqFilters.forEach((filter, i) => {
    filter.gain.value = clampEq(settings.eq.bands[i]);
  });
}

function applyEqRouting() {
  if (!audioCtx || !eqSource) return;
  try { eqSource.disconnect(); } catch (e) {}
  if (eqPreampNode) {
    try { eqPreampNode.disconnect(); } catch (e) {}
  }
  eqFilters.forEach((filter) => {
    try { filter.disconnect(); } catch (e) {}
  });

  if (!settings.eq.enabled) {
    eqSource.connect(audioCtx.destination);
    return;
  }
  let node = eqSource;
  if (eqPreampNode) {
    node.connect(eqPreampNode);
    node = eqPreampNode;
  }
  eqFilters.forEach((filter) => {
    node.connect(filter);
    node = filter;
  });
  node.connect(audioCtx.destination);
}

/* Вызывается перед каждым play(): граф нужен только при включённом эквалайзере,
   но контекст должен быть разбужен пользовательским жестом. */
function ensureEqActive() {
  if (!settings.eq.enabled) return;
  const ctx = ensureAudioGraph();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  applyEqValues();
  applyEqRouting();
}

function setEqEnabled(on) {
  const wasEnabled = settings.eq.enabled;
  settings.eq.enabled = !!on;
  saveSettings();
  if (on) {
    const ctx = ensureAudioGraph();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    applyEqValues();
  }
  applyEqRouting();
  syncEqUI();

  // Текущий источник загружен без CORS — перезагружаем через прокси,
  // сохраняя позицию и состояние паузы.
  const track = state.queue[state.queueIndex];
  const src = audio.currentSrc || audio.src || '';
  const proxied = /^http:\/\/127\.0\.0\.1:\d+\//.test(src);
  if (on && !wasEnabled && track && !hls && !proxied) {
    const position = audio.currentTime || 0;
    const autoplay = !audio.paused;
    playCurrent({ position, autoplay });
  }

  toast(on ? 'Эквалайзер включён' : 'Эквалайзер выключен', on);
}

function ensurePresetValid() {
  const p = settings.eq.preset;
  if (p === EQ_CUSTOM) return;
  if (EQ_PRESETS[p]) return;
  if (p && p.startsWith('custom:') && settings.eq.custom && settings.eq.custom[p.slice(7)]) return;
  settings.eq.preset = 'flat';
}

function presetBands(value) {
  if (value.startsWith('custom:')) {
    const preset = settings.eq.custom && settings.eq.custom[value.slice(7)];
    if (!preset) return null;
    return { preamp: clampEq(preset.preamp), bands: normalizeBands(preset.bands) };
  }
  const builtin = EQ_PRESETS[value];
  if (!builtin) return null;
  return { preamp: clampEq(builtin.preamp), bands: normalizeBands(builtin.bands) };
}

function applyEqPreset(value) {
  if (value === EQ_CUSTOM) return;
  const preset = presetBands(value);
  if (!preset) return;
  settings.eq.preset = value;
  settings.eq.preamp = preset.preamp;
  settings.eq.bands = preset.bands;
  saveSettings();
  syncEqUI();
  applyEqValues();
  ensureEqActive();
}

/* «Сохранить» показываем только когда положение ползунков отличается от
   выбранного пресета (или это ещё не сохранённый «Свой»). */
function eqHasChanges() {
  if (settings.eq.preset === EQ_CUSTOM) return true;
  const preset = presetBands(settings.eq.preset);
  if (!preset) return true;
  if (clampEq(settings.eq.preamp) !== clampEq(preset.preamp)) return true;
  return settings.eq.bands.some((value, i) => clampEq(value) !== preset.bands[i]);
}

function updateEqSaveBtn() {
  const button = $('#eq-save');
  if (!button) return;
  button.classList.toggle('hidden', !eqHasChanges());
}

function markEqCustom() {
  if (settings.eq.preset === EQ_CUSTOM) return;
  settings.eq.preset = EQ_CUSTOM;
  renderEqPresetOptions();
  updateEqDeleteBtn();
}

function renderEqPresetOptions() {
  const select = $('#eq-preset');
  if (!select) return;
  select.innerHTML = '';
  Object.entries(EQ_PRESETS).forEach(([key, preset]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = preset.title;
    select.append(option);
  });
  const names = Object.keys(settings.eq.custom || {}).sort((a, b) => a.localeCompare(b, 'ru'));
  if (names.length) {
    const group = document.createElement('optgroup');
    group.label = 'Свои';
    names.forEach((name) => {
      const option = document.createElement('option');
      option.value = 'custom:' + name;
      option.textContent = name;
      group.append(option);
    });
    select.append(group);
  }
  if (settings.eq.preset === EQ_CUSTOM) {
    const option = document.createElement('option');
    option.value = EQ_CUSTOM;
    option.textContent = 'Свой';
    select.append(option);
  }
  select.value = settings.eq.preset;
}

function updateEqDeleteBtn() {
  const btn = $('#eq-delete');
  if (!btn) return;
  btn.classList.toggle('hidden', !settings.eq.preset.startsWith('custom:'));
}

function syncEqUI() {
  ensurePresetValid();
  const eq = settings.eq;
  const enabled = $('#eq-enabled');
  if (enabled) enabled.checked = !!eq.enabled;
  renderEqPresetOptions();
  const preamp = $('#eq-preamp');
  if (preamp) {
    preamp.value = String(clampEq(eq.preamp));
    setEqFill(preamp, eq.preamp);
  }
  document.querySelectorAll('#eq-bands input[type="range"]').forEach((input) => {
    const value = clampEq(eq.bands[Number(input.dataset.band)]);
    input.value = String(value);
    setEqFill(input, value);
  });
  updateEqDeleteBtn();
  updateEqSaveBtn();
  const button = $('#player-eq');
  if (button) button.classList.toggle('active', !!eq.enabled);
}

function buildEqSliders() {
  const host = $('#eq-bands');
  if (!host) return;
  host.innerHTML = '';
  EQ_FREQS.forEach((freq, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'eq-slider';
    const bubble = document.createElement('span');
    bubble.className = 'eq-value';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(EQ_MIN);
    input.max = String(EQ_MAX);
    input.step = '0.5';
    input.value = String(clampEq(settings.eq.bands[index]));
    input.title = EQ_BAND_NAMES[index];
    input.setAttribute('aria-label', EQ_BAND_NAMES[index]);
    input.setAttribute('aria-orientation', 'vertical');
    input.dataset.band = String(index);
    setEqFill(input, settings.eq.bands[index]);
    input.addEventListener('input', () => {
      settings.eq.bands[index] = clampEq(Number(input.value));
      markEqCustom();
      saveSettings();
      applyEqValues();
      updateEqSaveBtn();
      setEqFill(input, settings.eq.bands[index]);
      showEqValue(wrap, settings.eq.bands[index]);
    });
    wrap.append(bubble, input);
    host.append(wrap);
  });
}

function showEqValue(wrap, value) {
  if (!wrap) return;
  const bubble = wrap.querySelector('.eq-value');
  if (!bubble) return;
  const v = Number(value);
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  bubble.textContent = sign + Math.abs(v).toFixed(1).replace('.0', '') + ' дБ';
  wrap.classList.add('show-value');
  clearTimeout(eqValueTimer);
  eqValueTimer = setTimeout(() => {
    document.querySelectorAll('.eq-slider.show-value').forEach((n) => n.classList.remove('show-value'));
  }, 900);
}

function resetEq() {
  settings.eq.preset = 'flat';
  settings.eq.preamp = 0;
  settings.eq.bands = normalizeBands([]);
  saveSettings();
  syncEqUI();
  applyEqValues();
  ensureEqActive();
}

function openEqPanel() {
  closeQueue();
  syncEqUI();
  $('#eq-panel').classList.remove('hidden');
}

function closeEqPanel() {
  const panel = $('#eq-panel');
  if (panel) panel.classList.add('hidden');
}

function openEqSaveDialog() {
  const input = $('#eq-save-name');
  const current = settings.eq.preset.startsWith('custom:') ? settings.eq.preset.slice(7) : '';
  input.value = current;
  $('#eq-save-error').classList.add('hidden');
  $('#eq-save-ok').textContent = 'Сохранить';
  eqSaveConfirm = '';
  $('#eq-save-modal').classList.remove('hidden');
  setTimeout(() => {
    input.focus();
    input.select();
  }, 30);
}

function closeEqSaveDialog() {
  $('#eq-save-modal').classList.add('hidden');
  eqSaveConfirm = '';
}

function eqSaveError(message) {
  const error = $('#eq-save-error');
  error.textContent = message;
  error.classList.remove('hidden');
}

function submitEqSave() {
  const name = $('#eq-save-name').value.trim();
  if (!name) {
    eqSaveError('Введите название пресета');
    return;
  }
  const reserved = Object.values(EQ_PRESETS).some(
    (preset) => preset.title.toLowerCase() === name.toLowerCase()
  );
  if (reserved) {
    eqSaveError('Это имя встроенного пресета');
    return;
  }
  const current = settings.eq.preset.startsWith('custom:') ? settings.eq.preset.slice(7) : '';
  const exists = !!(settings.eq.custom && settings.eq.custom[name]);
  if (exists && name !== current && eqSaveConfirm !== name) {
    eqSaveConfirm = name;
    $('#eq-save-ok').textContent = 'Заменить';
    eqSaveError(`Пресет «${name}» уже есть. Заменить?`);
    return;
  }

  settings.eq.custom = settings.eq.custom || {};
  settings.eq.custom[name] = {
    preamp: clampEq(settings.eq.preamp),
    bands: normalizeBands(settings.eq.bands),
  };
  settings.eq.preset = 'custom:' + name;
  saveSettings();
  closeEqSaveDialog();
  syncEqUI();
  applyEqValues();
  toast(`Пресет «${name}» сохранён`, true);
}

function deleteEqPreset() {
  const preset = settings.eq.preset;
  if (!preset.startsWith('custom:')) return;
  const name = preset.slice(7);
  if (settings.eq.custom) delete settings.eq.custom[name];
  settings.eq.preset = 'flat';
  settings.eq.preamp = EQ_PRESETS.flat.preamp;
  settings.eq.bands = normalizeBands(EQ_PRESETS.flat.bands);
  saveSettings();
  syncEqUI();
  applyEqValues();
  toast(`Пресет «${name}» удалён`, true);
}

function initEq() {
  buildEqSliders();
  syncEqUI();

  $('#player-eq').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('#eq-panel').classList.contains('hidden')) openEqPanel();
    else closeEqPanel();
  });
  $('#eq-enabled').addEventListener('change', () => setEqEnabled($('#eq-enabled').checked));
  $('#eq-preset').addEventListener('change', () => applyEqPreset($('#eq-preset').value));
  $('#eq-delete').addEventListener('click', deleteEqPreset);
  $('#eq-reset').addEventListener('click', resetEq);
  $('#eq-save').addEventListener('click', openEqSaveDialog);
  $('#eq-save-cancel').addEventListener('click', closeEqSaveDialog);
  $('#eq-save-ok').addEventListener('click', submitEqSave);
  $('#eq-save-name').addEventListener('input', () => {
    eqSaveConfirm = '';
    $('#eq-save-ok').textContent = 'Сохранить';
    $('#eq-save-error').classList.add('hidden');
  });
  $('#eq-save-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitEqSave();
    }
  });
  $('#eq-save-modal').addEventListener('click', (e) => {
    if (e.target.id === 'eq-save-modal') closeEqSaveDialog();
  });

  $('#eq-preamp').addEventListener('input', () => {
    settings.eq.preamp = clampEq(Number($('#eq-preamp').value));
    markEqCustom();
    saveSettings();
    applyEqValues();
    updateEqSaveBtn();
    setEqFill($('#eq-preamp'), settings.eq.preamp);
    showEqValue($('#eq-preamp-wrap'), settings.eq.preamp);
  });

  document.addEventListener('click', (e) => {
    const panel = $('#eq-panel');
    if (!panel || panel.classList.contains('hidden')) return;
    if (panel.contains(e.target)) return;
    if ($('#eq-save-modal').contains(e.target)) return;
    const button = $('#player-eq');
    if (button && button.contains(e.target)) return;
    closeEqPanel();
  });
}

function discordStatus(track, playing) {
  if (!track || !settings.discordRpc) return;
  invoke('discord_update', {
    status: {
      title: track.title || '',
      artist: artistString(track) || '',
      cover: trackImage(track, '512x512') || '',
      playing: !!playing,
    },
  }).catch(() => {});
}

function highlightQueue() {
  const currentId = state.currentTrackId;
  document.querySelectorAll('.track-row').forEach((row) => {
    row.classList.toggle('playing', row.dataset.id === currentId);
  });
}

function next() {
  if (!state.queue.length) return;
  if (settings.shuffle && state.queue.length > 1) {
    const prevIdx = state.queueIndex;
    state.queueIndex = Math.floor(Math.random() * state.queue.length);
    if (state.queueIndex === prevIdx) {
      state.queueIndex = (state.queueIndex + 1) % state.queue.length;
    }
    playCurrent();
    return;
  }
  if (state.queueIndex >= state.queue.length - 2) {
    if (wave.active && wave.source === 'sila') {
      loadMoreSilaTracks();
    } else {
      loadMoreTracks();
    }
  }
  if (state.queueIndex < state.queue.length - 1) {
    state.queueIndex++;
    playCurrent();
  } else if (wave.active) {
    regenerateWave();
  } else if (settings.repeat === 'all') {
    state.queueIndex = 0;
    playCurrent();
  } else {
    audio.pause();
    audio.currentTime = 0;
    updatePlayBtn();
  }
}

function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (state.queueIndex > 0) state.queueIndex--;
  else state.queueIndex = 0;
  playCurrent();
}

function updatePlayBtn() {
  const playing = !audio.paused;
  const playIcon = document.querySelector('#play-icon');
  const pauseIcon = document.querySelector('#pause-icon');
  
  if (playing) {
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
  } else {
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
  }
}

function togglePlay() {
  if (audio.paused) {
    ensureEqActive();
    audio.play().catch(e => {
      if (e.name !== 'AbortError') {
        toast('Не удалось начать воспроизведение');
      }
    });
  } else {
    audio.pause();
  }
}

function toggleRepeat() {
  const order = ['off', 'all', 'one'];
  const i = order.indexOf(settings.repeat);
  settings.repeat = order[(i + 1) % order.length];
  saveSettings();
  updateRepeatBtn();
}

function toggleShuffle() {
  settings.shuffle = !settings.shuffle;
  saveSettings();
  updateShuffleBtn();
}

function updateRepeatBtn() {
  const btn = $('#btn-repeat');
  btn.classList.toggle('active', settings.repeat !== 'off');
  btn.classList.toggle('repeat-one', settings.repeat === 'one');
  const titles = { off: 'Повтор выключен', all: 'Повтор всего', one: 'Повтор трека' };
  btn.title = titles[settings.repeat];
}

function updateTrackIndicators() {
  const currentId = state.currentTrackId;
  const isPaused = audio.paused;
  
  document.querySelectorAll('.track-row').forEach((row) => {
    const isPlaying = row.dataset.id === currentId;
    const indicator = row.querySelector('.track-playing-indicator');
    const num = row.querySelector('.track-num');
    
    if (indicator && num) {
      if (isPlaying) {
        indicator.style.display = 'inline-flex';
        num.style.display = 'none';
        row.classList.add('playing');
        if (isPaused) {
          row.classList.add('paused');
        } else {
          row.classList.remove('paused');
        }
      } else {
        indicator.style.display = 'none';
        num.style.display = 'inline';
        row.classList.remove('playing', 'paused');
      }
    }
  });
}

function updateShuffleBtn() {
  const btn = $('#btn-shuffle');
  btn.classList.toggle('active', settings.shuffle);
  btn.title = settings.shuffle ? 'Случайное: вкл' : 'Случайное воспроизведение';
}

audio.addEventListener('timeupdate', () => {
  if (!audio.duration || !isFinite(audio.duration)) return;
  const progress = (audio.currentTime / audio.duration) * 100;
  $('#seek').value = progress;
  $('#seek').style.setProperty('--progress', progress + '%');
  $('#pos-current').textContent = fmtTime(audio.currentTime);
  $('#pos-total').textContent = fmtTime(audio.duration);
});

audio.addEventListener('loadedmetadata', () => {
  $('#pos-total').textContent = fmtTime(audio.duration);
  $('#seek').style.setProperty('--progress', '0%');
});

audio.addEventListener('ended', () => {
  if (settings.repeat === 'one' && state.queue[state.queueIndex]) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  next();
});
audio.addEventListener('play', () => {
  updatePlayBtn();
  discordStatus(state.queue[state.queueIndex], true);
  updateTrackIndicators();
});
audio.addEventListener('pause', () => {
  updatePlayBtn();
  discordStatus(state.queue[state.queueIndex], false);
  updateTrackIndicators();
});
audio.addEventListener('error', () => {
  toast('Ошибка воспроизведения');
  updatePlayBtn();
});

$('#seek').addEventListener('input', () => {
  if (audio.duration && isFinite(audio.duration)) {
    audio.currentTime = (Number($('#seek').value) / 100) * audio.duration;
  }
});

$('#volume').addEventListener('input', () => {
  const v = Number($('#volume').value);
  audio.volume = v / 100;
  settings.volume = v;
  saveSettings();
  $('#volume').style.setProperty('--volume-progress', v + '%');
});

$('#volume').style.setProperty('--volume-progress', settings.volume + '%');

if (navigator.mediaSession) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => {
    ensureEqActive();
    audio.play();
  });
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('nexttrack', next);
  ms.setActionHandler('stop', () => audio.pause());
  ms.setActionHandler('seekto', (d) => {
    if (d.seekTime != null) audio.currentTime = d.seekTime;
  });
}

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-next').addEventListener('click', next);
$('#btn-prev').addEventListener('click', prev);
$('#btn-repeat').addEventListener('click', toggleRepeat);
$('#btn-shuffle').addEventListener('click', toggleShuffle);
updateRepeatBtn();
updateShuffleBtn();

$('#player-like').addEventListener('click', () => {
  const track = state.queue[state.queueIndex];
  if (track) toggleLike(track, $('#player-like'));
});

$('#player-add-playlist').addEventListener('click', () => {
  const track = state.queue[state.queueIndex];
  if (track) openAddToPlaylist(track);
});

$('#player-download').addEventListener('click', () => {
  toast('Скачивание треков появится позже');
});

$('#player-queue').addEventListener('click', toggleQueue);
$('#queue-close').addEventListener('click', closeQueue);

function toggleQueue() {
  if ($('#queue-panel').classList.contains('hidden')) openQueue();
  else closeQueue();
}

function openQueue() {
  closeEqPanel();
  renderQueue();
  $('#queue-panel').classList.remove('hidden');
}

function closeQueue() {
  $('#queue-panel').classList.add('hidden');
}

function renderQueue() {
  const list = $('#queue-list');
  list.innerHTML = '';
  if (!state.queue.length) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = 'Очередь пуста. Включите трек или запустите волну.';
    list.append(empty);
    return;
  }
  state.queue.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'queue-row';
    if (i === state.queueIndex) row.classList.add('playing');
    const img = document.createElement('img');
    img.src = trackImage(t, '72x72');
    img.alt = '';
    const main = document.createElement('div');
    main.className = 'queue-main';
    const name = document.createElement('div');
    name.className = 'queue-name';
    name.textContent = t.title || '';
    const artist = document.createElement('div');
    artist.className = 'queue-artist';
    artist.textContent = artistString(t);
    main.append(name, artist);
    row.append(img, main);
    row.addEventListener('click', () => {
      if (i === state.queueIndex && !audio.paused) {
        closeQueue();
        return;
      }
      playQueue(state.queue, i);
      closeQueue();
    });
    list.append(row);
  });
}



const HOTKEY_ACTIONS = [
  { key: 'playPause', name: 'Пауза / Плей' },
  { key: 'prev', name: 'Предыдущий трек' },
  { key: 'next', name: 'Следующий трек' },
];

let captureHotkey = null;

function prettyCombo(combo) {
  if (!combo) return '—';
  return combo
    .split('+')
    .map((p) => (p === 'Space' ? 'Пробел' : p === 'ArrowRight' ? '→' : p === 'ArrowLeft' ? '←' : p === 'ArrowUp' ? '↑' : p === 'ArrowDown' ? '↓' : p))
    .join('+');
}

function renderHotkeys() {
  const list = $('#hotkey-list');
  if (!list) return;
  list.innerHTML = '';
  HOTKEY_ACTIONS.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'hotkey-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = a.name;
    const combo = document.createElement('button');
    combo.className = 'combo';
    const active = !settings.hotkeys[a.key];
    combo.classList.toggle('active', active);
    combo.textContent = prettyCombo(settings.hotkeys[a.key]);
    if (captureHotkey === a.key) combo.classList.add('capture');
    combo.addEventListener('click', () => {
      if (captureHotkey === a.key) {
        captureHotkey = null;
        renderHotkeys();
        return;
      }
      captureHotkey = a.key;
      renderHotkeys();
    });
    row.append(name, combo);
    list.append(row);
  });
}

function setHotkey(action, combo) {
  for (const k of Object.keys(settings.hotkeys)) {
    if (k !== action && settings.hotkeys[k] === combo) settings.hotkeys[k] = null;
  }
  settings.hotkeys[action] = combo;
  saveSettings();
  applyHotkeys();
  captureHotkey = null;
  renderHotkeys();
  toast('Горячая клавиша обновлена', true);
}

function eventCombo(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return parts.length ? parts.join('+') : '';
  if (key === ' ') return [...parts, 'Space'].join('+');
  if (key === 'Escape') return [...parts, 'Escape'].join('+');
  if (key.length === 1) return [...parts, key.toLowerCase()].join('+');
  return [...parts, key].join('+');
}

document.addEventListener('keydown', (e) => {
  if (captureHotkey) {
    e.preventDefault();
    e.stopPropagation();
    const combo = eventCombo(e);
    if (combo === 'Escape') {
      captureHotkey = null;
      renderHotkeys();
      return;
    }
    if (combo && !['Ctrl', 'Alt', 'Shift'].includes(combo)) setHotkey(captureHotkey, combo);
  }
});

/* Escape закрывает диалог сохранения пресета и панель эквалайзера. */
document.addEventListener('keydown', (e) => {
  if (captureHotkey || e.key !== 'Escape') return;
  if (!$('#eq-save-modal').classList.contains('hidden')) {
    closeEqSaveDialog();
    return;
  }
  if (!$('#eq-panel').classList.contains('hidden')) closeEqPanel();
});

initEq();
init();
