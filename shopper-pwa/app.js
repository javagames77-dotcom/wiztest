// ═══════════════════════════════════════════════════════════
// GhostAudit / Wizoria — Shopper PWA
// ВЕРСІЯ ФАЙЛУ: 2026-09-07 — вихід з акаунту веде на екран входу PWA, не на лендінг (п.11)
// ═══════════════════════════════════════════════════════════

const API_BASE = 'https://primary-production-4b93e.up.railway.app/webhook';
// VAPID public key (той самой пары, что сгенерирована для проекта) — публичный, безопасно
// держать прямо в клиентском коде, приватный остаётся только в n8n
const VAPID_PUBLIC_KEY = 'BNnz-jdGhB2nz3Meh4yN4A6-VageQqYiQFX_BLpSBjhWxFCrOQ4Sq491vMVVp8qbUTXNHoF4AnfW6L9dJCmSjgE';
const APP_VERSION = 'v19'; // bump this on every real code change — visible on screen bottom-right,
// so it's possible to confirm at a glance whether a new deploy actually reached the device,
// instead of asking "did you upload it?" every time.
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('app-version');
  if (el) el.textContent = APP_VERSION;
});
// also set it immediately in case DOMContentLoaded already fired by the time this script runs
if (document.readyState !== 'loading') {
  const el = document.getElementById('app-version');
  if (el) el.textContent = APP_VERSION;
}

// ─── STATE ────────────────────────────────────────────────
const State = {
  token: localStorage.getItem('ga_token') || null,
  user: JSON.parse(localStorage.getItem('ga_user') || 'null'),
  objects: [],
  tasks: [],
  currentObject: null,
  currentTask: null,       // full task object incl. requirements arrays
  currentSubmissionId: null,
  hubProgress: {},          // { [key]: true } local tracking of what's done this session
  currentReq: null,         // currently open photo/audio requirement
  photoFiles: {},           // { [requirementId]: [File, File...] } collected before "Зберегти"
  quest: null,              // { questionnaireId, criteria: [...], answers: {}, idx: 0, visibleList: [...] }
};

function saveAuth(token, user) {
  State.token = token;
  State.user = user;
  localStorage.setItem('ga_token', token);
  localStorage.setItem('ga_user', JSON.stringify(user));
}

// ─── SESSION PERSISTENCE ──────────────────────────────────
// iOS/WKWebView can reload the page when returning from the native camera (a documented
// platform quirk, not something we can prevent) — this wipes anything held only in memory,
// which is exactly what was happening to State.currentSubmissionId. Persisting the active
// task/submission to localStorage lets the app recover automatically instead of losing the
// in-progress task entirely.
function saveSession() {
  if (State.currentObject && State.currentTask && State.currentSubmissionId) {
    localStorage.setItem('ga_session', JSON.stringify({
      object: State.currentObject,
      task: State.currentTask,
      submissionId: State.currentSubmissionId,
      hubProgress: State.hubProgress
    }));
  }
}

function clearSession() {
  localStorage.removeItem('ga_session');
}

function restoreSession() {
  try {
    const raw = localStorage.getItem('ga_session');
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s.object || !s.task || !s.submissionId) return false;
    State.currentObject = s.object;
    State.currentTask = s.task;
    State.currentSubmissionId = s.submissionId;
    State.hubProgress = s.hubProgress || {};
    Router.show('hub');
    renderHub();
    // reconcile против IndexedDB — сесія в localStorage могла бути записана до того, як
    // пункт потрапив у чергу (наприклад iOS перезавантажив сторінку саме в цей момент)
    OfflineQueue.reconcile().then(() => { renderHub(); OfflineQueue.trySync(); });
    return true;
  } catch (e) {
    return false;
  }
}

function doLogout() {
  if (!confirm('Вийти з акаунту ' + (State.user?.first_name || '') + '?')) return;
  localStorage.removeItem('ga_token');
  localStorage.removeItem('ga_user');
  clearSession();
  State.token = null;
  State.user = null;
  // Раніше вело на лендінг ('../index.html') замість екрана входу PWA (п.11).
  // Токен вже видалений вище, тому перезавантаження цієї ж сторінки просто
  // покаже дефолтний екран "Вхід до системи" — INIT-блок нижче не спрацює
  // без State.token, і Router нічого нікуди не перемикає.
  window.location.href = './index.html';
}

// ─── API HELPER ───────────────────────────────────────────
// Returns { status, data, offline }. `offline` is the single signal every caller should
// check to decide "queue this for later" vs "show a real error" — it's true both when
// fetch() itself throws (no connection, SW not active yet) and when the service worker's
// own offline fallback answered instead of the real server (see sw.js, X-GA-Offline header).
// Never throws, so callers no longer need their own try/catch just to avoid an unhandled
// rejection freezing a button mid-spinner.
async function api(path, { method = 'GET', body = null, isForm = false } = {}) {
  const headers = {};
  if (State.token) headers['Authorization'] = 'Bearer ' + State.token;
  if (!isForm && body) headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: isForm ? body : (body ? JSON.stringify(body) : undefined)
    });

    let data;
    try { data = await res.json(); } catch (e) { data = { success: false, error: 'Некоректна відповідь сервера' }; }
    const offline = res.headers.get('X-GA-Offline') === '1';
    return { status: res.status, data, offline };
  } catch (e) {
    return { status: 0, data: { success: false, error: "Немає з'єднання з сервером" }, offline: true };
  }
}

// ─── OFFLINE QUEUE (IndexedDB) ─────────────────────────────
// ТЗ: «Анкета заповнюється без інтернету. Синхронізація при підключенні» — тут разбито
// на фото/аудіо/анкету, все три ідуть через одну й ту саму чергу. IndexedDB, а не
// localStorage: base64-фото/аудіо можуть важити по кілька МБ кожне, а localStorage
// звично обмежений 5–10 МБ на весь домен — легко впертись у квоту й тихо втратити дані.
const OfflineDB = {
  _dbPromise: null,
  open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('ga_offline_db', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('queue')) {
          db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  },
  async add(item) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      const r = tx.objectStore('queue').add(item);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async all() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readonly');
      const r = tx.objectStore('queue').getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async remove(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      const r = tx.objectStore('queue').delete(id);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }
};

const OfflineQueue = {
  syncing: false,

  // Called right when a submit-photo/-audio/-answers call comes back `offline`.
  // `hubKey` matches renderHub()'s own key so the checklist row can show it as queued.
  async enqueue(kind, key, submissionId, payload) {
    await OfflineDB.add({ kind, key, submissionId, payload, createdAt: Date.now() });
    State.hubProgress[key] = 'queued';
    saveSession();
  },

  // Re-derives "queued" flags for the currently open task from what's actually sitting
  // in IndexedDB — needed because a plain page reload wipes State but not IndexedDB, so
  // State.hubProgress alone (even restored from localStorage) could go stale/out of sync.
  async reconcile() {
    if (!State.currentTask || !State.currentSubmissionId) return;
    const items = await OfflineDB.all();
    items
      .filter(it => it.submissionId === State.currentSubmissionId)
      .forEach(it => { if (State.hubProgress[it.key] !== true) State.hubProgress[it.key] = 'queued'; });
  },

  async trySync() {
    if (this.syncing) return;
    this.syncing = true;
    let touchedHub = false;
    try {
      const items = (await OfflineDB.all()).sort((a, b) => a.createdAt - b.createdAt);
      for (const item of items) {
        const outcome = await this._sendOne(item);
        if (outcome === 'offline') break; // still no connection — stop this pass, try again later
        await OfflineDB.remove(item.id);
        if (outcome === 'synced') {
          State.hubProgress[item.key] = true;
        } else if (outcome === 'rejected') {
          // real server-side validation error, not connectivity — don't retry forever;
          // dropping the flag turns the row back into "Нове" so the shopper can redo it
          delete State.hubProgress[item.key];
        }
        if (State.currentSubmissionId === item.submissionId) { saveSession(); touchedHub = true; }
      }
    } finally {
      this.syncing = false;
      if (touchedHub && document.getElementById('screen-hub')?.classList.contains('active')) renderHub();
    }
  },

  async _sendOne(item) {
    if (item.kind === 'photo') {
      for (const f of item.payload.files) {
        const { data, offline } = await api('/ga/shopper/submit-photo', {
          method: 'POST',
          body: {
            submission_id: item.submissionId,
            photo_requirement_id: item.payload.photo_requirement_id,
            comment: item.payload.comment || undefined,
            file_base64: f.file_base64,
            mime_type: f.mime_type
          }
        });
        if (offline) return 'offline';
        if (!data.success) return 'rejected';
      }
      return 'synced';
    }
    if (item.kind === 'audio') {
      const { data, offline } = await api('/ga/shopper/submit-audio', {
        method: 'POST',
        body: {
          submission_id: item.submissionId,
          audio_requirement_id: item.payload.audio_requirement_id,
          duration_sec: item.payload.duration_sec,
          file_base64: item.payload.file_base64,
          mime_type: item.payload.mime_type
        }
      });
      if (offline) return 'offline';
      return data.success ? 'synced' : 'rejected';
    }
    if (item.kind === 'answers') {
      const { data, offline } = await api('/ga/shopper/submit-answers', {
        method: 'POST',
        body: { submission_id: item.submissionId, answers: item.payload.answers }
      });
      if (offline) return 'offline';
      return data.success ? 'synced' : 'rejected';
    }
    return 'rejected';
  }
};

window.addEventListener('online', () => OfflineQueue.trySync());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') OfflineQueue.trySync();
});

// ─── ROUTER ───────────────────────────────────────────────
const Router = {
  show(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
    window.scrollTo(0, 0);
  }
};

// ─── ONLINE / OFFLINE BANNER ──────────────────────────────
function updateOnlineBanner() {
  document.getElementById('online-banner').classList.toggle('show', !navigator.onLine);
}
window.addEventListener('online', updateOnlineBanner);
window.addEventListener('offline', updateOnlineBanner);

// ─── LOGIN ────────────────────────────────────────────────
function setErr(id, msg) {
  const err = document.getElementById('err-' + id);
  const input = document.getElementById(id + '-input');
  if (msg) { err.textContent = msg; err.classList.add('show'); input?.classList.add('is-err'); }
  else { err.textContent = ''; err.classList.remove('show'); input?.classList.remove('is-err'); }
}

async function doLogin() {
  const login = document.getElementById('login-input').value.trim();
  const password = document.getElementById('password-input').value;
  const alertEl = document.getElementById('login-alert');
  alertEl.classList.remove('show');

  let ok = true;
  if (!login) { setErr('login', "Обов'язкове поле"); ok = false; } else setErr('login', null);
  if (!password) { setErr('password', "Обов'язкове поле"); ok = false; } else setErr('password', null);
  if (!ok) return;

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spin"></span>';

  try {
    const { data } = await api('/ga/auth/login', { method: 'POST', body: { login, password } });
    if (data.success && data.token) {
      saveAuth(data.token, data.user);
      if (data.user.role === 'client') {
        Router.show('client-reports');
        Client.loadReports();
      } else {
        Router.show('objects');
        Objects.load();
        PushSetup.init();
      }
    } else {
      alertEl.textContent = data.error || 'Не вдалося увійти';
      alertEl.classList.add('show');
    }
  } catch (e) {
    alertEl.textContent = "Немає з'єднання з сервером";
    alertEl.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Увійти';
  }
}
document.getElementById('btn-login').addEventListener('click', doLogin);
document.getElementById('password-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// ─── SCREEN: OBJECTS ──────────────────────────────────────
const Objects = {
  async load() {
      const list = document.getElementById('objects-list');
    const empty = document.getElementById('objects-empty');
    list.innerHTML = '<div class="card-sub" style="text-align:center;padding:20px 0">Завантаження…</div>';
    empty.style.display = 'none';
    try {
      const { data } = await api('/ga/shopper/objects');
      if (!data.success) {
        list.innerHTML = `<div class="fm-alert show err">${escapeHtml(data.error || "Не вдалося завантажити об'єкти")}</div>
          <button class="fm-btn outline sm" style="margin-top:10px" onclick="doLogout()">Вийти з акаунту</button>`;
        return;
      }
      State.objects = data.objects;
      // Активні (є що робити) — завжди зверху, здані — знизу. Без цього другий/новий
      // завданий об'єкт міг опинитись нижче вже зданого і "загубитись" у списку.
      State.objects.sort((a, b) => (a.all_done === b.all_done) ? 0 : (a.all_done ? 1 : -1));
      this.render();
    } catch (e) {
      list.innerHTML = `<div class="fm-alert show err">Немає з'єднання з сервером: ${escapeHtml(e.message)}</div>`;
    }
  },
  render() {
    const list = document.getElementById('objects-list');
    const empty = document.getElementById('objects-empty');
    list.innerHTML = '';
    if (State.objects.length === 0 || State.objects.every(o => o.all_done)) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    let firstActiveSeen = false;

    State.objects.forEach(o => {
      if (o.all_done) return; // клієнт прямо просив: здане прибирати зі списку, не показувати навіть заглушкою
      const card = document.createElement('div');
      {
        const isPrimary = !firstActiveSeen;
        firstActiveSeen = true;
        card.className = 'card' + (isPrimary ? ' highlight' : '');
        card.innerHTML = `
          <div class="card-row">
            <div class="card-title">${escapeHtml(o.object_name)}</div>
            <span class="badge ${isPrimary ? 'accent' : 'warn'}">${o.remaining_tasks} завд.</span>
          </div>
          <div class="card-sub"${isPrimary ? ' style="margin-bottom:6px"' : ''}>${escapeHtml(o.city || o.address || '')}</div>
          ${isPrimary ? `<button class="fm-btn sm" type="button" style="width:100%">Перейти <i class="ti ti-arrow-right" aria-hidden="true"></i></button>` : ''}
        `;
        const navigate = () => Tasks.open(o);
        if (isPrimary) {
          card.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); navigate(); });
        }
        card.addEventListener('click', navigate);
      }
      list.appendChild(card);
    });
  }
};

// ─── SCREEN: TASKS ────────────────────────────────────────
const Tasks = {
  async open(obj) {
    State.currentObject = obj;
    document.getElementById('tasks-object-name').textContent = obj.object_name;
    Router.show('tasks');
    const list = document.getElementById('tasks-list');
    list.innerHTML = '<div class="card-sub" style="text-align:center;padding:20px 0">Завантаження…</div>';
    try {
      const { data } = await api('/ga/shopper/tasks?object_id=' + obj.object_id);
      if (!data.success) {
        list.innerHTML = `<div class="fm-alert show err">${escapeHtml(data.error || 'Не вдалося завантажити завдання')}</div>`;
        return;
      }
      // Клієнт прямо просив: здане завдання не сортувати вниз, а взагалі прибирати
      // зі списку — воно не редагується гостем і не має "висіти" в кабінеті.
      // Історію виконаних завдань і так видно окремо в "Мої звіти".
      // ВАЖЛИВО: приховувати треба не лише 'submitted', а й уже перевірені
      // супервайзером статуси ('approved'/'rejected') — інакше саме вони й "застрягали".
      const HIDDEN_STATUSES = ['submitted', 'approved', 'rejected'];
      State.tasks = data.tasks.filter(t => !HIDDEN_STATUSES.includes(t.status));
      if (data.object_progress) {
        document.getElementById('tasks-progress').textContent =
          `${data.object_progress.completed_tasks}/${data.object_progress.total_tasks} виконано`;
      }
      this.render();
    } catch (e) {
      list.innerHTML = `<div class="fm-alert show err">Немає з'єднання з сервером: ${escapeHtml(e.message)}</div>`;
    }
  },
  render() {
    const list = document.getElementById('tasks-list');
    const empty = document.getElementById('tasks-empty');
    list.innerHTML = '';
    if (State.tasks.length === 0) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    State.tasks.forEach(t => {
      const isDone = t.status === 'submitted';
      const card = document.createElement('div');
      card.className = 'card' + (isDone ? ' done' : '');

      // Порядок — той самий order_index, що й у хабі (адмін задає вручну під кожне
      // завдання). Раніше групувалось по типу (усі фото, потім усі аудіо, потім усі
      // анкети) без жодного сортування всередині групи.
      const orderOfReq = r => (r.order_index === null || r.order_index === undefined) ? Infinity : r.order_index;
      const combinedReqs = [
        ...t.photo_requirements.map(r => ({ kind: 'photo', r })),
        ...t.audio_requirements.map(r => ({ kind: 'audio', r })),
        ...t.questionnaires.map(r => ({ kind: 'quest', r }))
      ].sort((a, b) => orderOfReq(a.r) - orderOfReq(b.r));

      const reqRows = combinedReqs.map(({ kind, r }) => {
        if (kind === 'photo') return reqRowHtml('photo', r.title, `${r.required_count} фото`);
        if (kind === 'audio') return reqRowHtml('audio', r.title, `Мін. ${r.min_duration_sec} сек`);
        return reqRowHtml('quest', r.title, `${r.criteria_count} питань`);
      });

      card.innerHTML = `
        <div style="margin-bottom:${reqRows.length ? '8px' : '0'}">${reqRows.join('')}</div>
        ${isDone
          ? `<span class="badge success">Здано</span>`
          : `<button class="fm-btn sm" type="button">${t.status === 'in_progress' ? 'Продовжити' : 'Виконати'} <i class="ti ti-arrow-right" aria-hidden="true"></i></button>`}
      `;
      if (!isDone) {
        card.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); Task.open(t); });
      }
      list.appendChild(card);
    });
  }
};

function reqRowHtml(kind, title, sub) {
  const icons = { photo: 'ti-camera', audio: 'ti-microphone', quest: 'ti-clipboard-check' };
  return `
    <div class="req-row">
      <div class="req-icon ${kind}"><i class="ti ${icons[kind]}" aria-hidden="true"></i></div>
      <div class="req-info"><div class="t">${escapeHtml(title)}</div><div class="s">${escapeHtml(sub)}</div></div>
    </div>
  `;
}

// ─── TASK FLOW (geo → hub → photo/audio/quest → submit) ──
const Task = {
  async open(task) {
    State.currentTask = task;
    State.hubProgress = {};
    State.photoFiles = {};
    State.currentSubmissionId = null; // always clear first — never let a stale id from a
    // previously opened task leak into this one if something below fails to set a fresh one

    if (task.status === 'in_progress') {
      // resume — a submission already exists for this task from a previous geo-check.
      // ga-shopper-tasks now returns submission_id for exactly this reason (was missing
      // before, which caused every subsequent photo/audio/answers call to fail validation).
      if (!task.submission_id) {
        Router.show('hub');
        renderHub(); // renders with no working buttons — see the guard inside renderHub itself
        document.getElementById('hub-alert').textContent = 'Не вдалося знайти submission для цього завдання. Поверніться до списку завдань і спробуйте ще раз.';
        document.getElementById('hub-alert').className = 'fm-alert show err';
        return;
      }
      State.currentSubmissionId = task.submission_id;
      saveSession();
      Router.show('hub');
      renderHub();
      OfflineQueue.reconcile().then(() => { renderHub(); OfflineQueue.trySync(); });
    } else {
      // ТИМЧАСОВО (за прямим запитом користувача): не блокуємо покупця екраном
      // підтвердження геолокації — GPS в приміщенні (кінотеатр) ловить погано,
      // а фото/аудіо, які покупець і так робить, самі по собі підтверджують
      // присутність краще за неточний GPS. Локація все одно фіксується в фоні
      // (перше відкриття завдання) і показується Supervisor'у як довідкова
      // інформація на карті — просто більше нікого не блокує і не зупиняє.
      // Щоб повернути як було — див. backup / попередню версію Task.open().
      Router.show('hub');
      document.getElementById('hub-alert').className = 'fm-alert';
      document.getElementById('hub-list').innerHTML = '<div class="loading-spin" style="margin:40px auto;display:block"></div>';
      captureLocationSilently();
    }
  }
};

// ─── Тиха фонова фіксація геолокації (без блокування покупця) ──
function captureLocationSilently() {
  const finish = async (lat, lng, method, accuracyM) => {
    try {
      const { data } = await api('/ga/shopper/geo-check', {
        method: 'POST',
        body: { task_id: State.currentTask.task_id, lat, lng, method, accuracy_m: accuracyM }
      });
      if (data && data.success) {
        State.currentSubmissionId = data.submission_id;
        saveSession();
      }
    } catch (e) {
      console.error('Silent geo-check failed:', e);
    }
    renderHub();
  };

  // Немає геолокації в браузері взагалі — все одно відкриваємо завдання,
  // як «заглушку» пишемо координати самого об'єкту (чесно позначено методом 'cell',
  // щоб Supervisor бачив — це не реальний GPS-засік).
  if (!('geolocation' in navigator)) {
    finish(State.currentObject.latitude, State.currentObject.longitude, 'cell', null);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => finish(pos.coords.latitude, pos.coords.longitude, 'gps', Math.round(pos.coords.accuracy)),
    () => finish(State.currentObject.latitude, State.currentObject.longitude, 'cell', null), // відмова/таймаут — не блокуємо
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

// ─── SCREEN: GEO ──────────────────────────────────────────
function resetGeoScreen() {
  document.getElementById('geo-object-name').textContent = State.currentObject.object_name;
  document.getElementById('geo-method').textContent = '—';
  document.getElementById('geo-accuracy').textContent = '—';
  document.getElementById('geo-distance').textContent = '—';
  document.getElementById('geo-distance').classList.remove('ok');
  document.getElementById('geo-time').textContent = '—';
  document.getElementById('geo-alert').classList.remove('show');
  const btn = document.getElementById('btn-geo-confirm');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spin"></span>';
  initGeoMap();
  detectAndConfirmLocation();
}

// ─── LEAFLET MAP (object location + live user position) ──
let geoMap = null;
let geoObjectMarker = null;
let geoUserMarker = null;
let geoRadiusCircle = null;

const accentDivIcon = (color) => L.divIcon({
  className: '',
  html: `<div style="width:13px;height:13px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 4px ${color}33"></div>`,
  iconSize: [13, 13],
  iconAnchor: [6, 6]
});

function initGeoMap() {
  const obj = State.currentObject;
  const container = document.getElementById('geo-map');
  if (geoMap) { geoMap.remove(); geoMap = null; geoUserMarker = null; }

  const hasCoords = obj && obj.latitude && obj.longitude;
  const center = hasCoords ? [obj.latitude, obj.longitude] : [49.588, 34.551];

  geoMap = L.map(container, { zoomControl: false, attributionControl: false }).setView(center, 17);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(geoMap);

  if (hasCoords) {
    geoObjectMarker = L.marker(center, { icon: accentDivIconSquare() }).addTo(geoMap);
    if (obj.geo_radius_m) {
      geoRadiusCircle = L.circle(center, {
        radius: obj.geo_radius_m,
        color: '#8C64C9',
        weight: 1,
        fillOpacity: 0.08
      }).addTo(geoMap);
    }
  }

  setTimeout(() => geoMap && geoMap.invalidateSize(), 150);
}

function accentDivIconSquare() {
  return L.divIcon({
    className: '',
    html: `<div style="width:20px;height:14px;background:#8C64C933;border:1px solid #8C64C9;border-radius:3px"></div>`,
    iconSize: [20, 14],
    iconAnchor: [10, 7]
  });
}

function updateUserMarkerOnMap(lat, lng) {
  if (!geoMap) return;
  if (geoUserMarker) {
    geoUserMarker.setLatLng([lat, lng]);
  } else {
    geoUserMarker = L.marker([lat, lng], { icon: accentDivIcon('#8C64C9') }).addTo(geoMap);
  }
  const obj = State.currentObject;
  if (obj && obj.latitude && obj.longitude) {
    geoMap.fitBounds([[lat, lng], [obj.latitude, obj.longitude]], { padding: [24, 24], maxZoom: 18 });
  } else {
    geoMap.setView([lat, lng], 17);
  }
  setTimeout(() => geoMap && geoMap.invalidateSize(), 100);
}

let geoConfirmedAndReady = false;

function detectAndConfirmLocation() {
  geoConfirmedAndReady = false;
  if (!('geolocation' in navigator)) {
    showGeoError("Геолокація не підтримується цим браузером");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = Math.round(pos.coords.accuracy);
      // Раніше тут вгадувався ярлик GPS/WIFI/CELL по радіусу похибки — це була видумка,
      // телефон ніколи не повідомляє, що реально спрацювало. Тепер чесно: завжди 'gps',
      // а супервайзер бачить реальну похибку в метрах, а не вигаданий ярлик.
      const method = 'gps';

      updateUserMarkerOnMap(lat, lng);

      document.getElementById('geo-method').textContent = method.toUpperCase();
      document.getElementById('geo-accuracy').textContent = `±${accuracy} м`;
      document.getElementById('geo-time').textContent = new Date().toLocaleTimeString('uk-UA');

      const { data } = await api('/ga/shopper/geo-check', {
        method: 'POST',
        body: { task_id: State.currentTask.task_id, lat, lng, method, accuracy_m: accuracy }
      });

      if (data.success) {
        State.currentSubmissionId = data.submission_id;
        saveSession();
        document.getElementById('geo-distance').innerHTML = `~${data.distance_to_object_m} м <i class="ti ti-check" aria-hidden="true"></i>`;
        document.getElementById('geo-distance').classList.add('ok');
        geoConfirmedAndReady = true;
        const btn = document.getElementById('btn-geo-confirm');
        btn.disabled = false;
        btn.textContent = 'Підтвердити та перейти';
      } else if (data.reason === 'too_far') {
        document.getElementById('geo-distance').textContent = `~${data.distance_to_object_m} м`;
        showGeoError(`Ви задалеко від об'єкту (потрібно бути ближче ${data.geo_radius_m} м). Підійдіть ближче і спробуйте ще раз.`, 'warn');
      } else {
        showGeoError(data.error || 'Сталася помилка');
      }
    },
    (err) => showGeoError('Не вдалося визначити місцезнаходження: ' + err.message),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

document.getElementById('btn-geo-confirm').addEventListener('click', () => {
  if (geoConfirmedAndReady) {
    // location already confirmed server-side during auto-detection — this tap just proceeds
    Router.show('hub');
    renderHub();
  } else {
    // "Спробувати ще раз" state (auto-detect failed or was too far) — retry detection
    const btn = document.getElementById('btn-geo-confirm');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spin"></span>';
    document.getElementById('geo-alert').classList.remove('show');
    detectAndConfirmLocation();
  }
});

function showGeoError(msg, cls = 'err') {
  const alertEl = document.getElementById('geo-alert');
  alertEl.textContent = msg;
  alertEl.className = 'fm-alert show ' + cls;
  const btn = document.getElementById('btn-geo-confirm');
  btn.disabled = false;
  btn.textContent = 'Спробувати ще раз';
}

// ─── SCREEN: HUB (checklist for current task) ────────────
function hubKey(kind, id) { return kind + '-' + id; }

function renderHub() {
  const t = State.currentTask;
  document.getElementById('hub-object-name').textContent = State.currentObject.object_name;
  document.getElementById('hub-alert').classList.remove('show');
  const list = document.getElementById('hub-list');
  list.innerHTML = '';

  const blocked = !State.currentSubmissionId;
  const guard = (fn) => blocked ? (() => {}) : fn;
  let firstPendingSeen = false;

  // Порядок — order_index, який задає Admin (вручну, під кожне завдання окремо, п.7).
  // Раніше сортувалось вгадуванням за назвою секції ("базові 6") — не працювало для
  // реальних анкет з довільними назвами (vhid_ccv, kasa_cck тощо). Записи без
  // order_index (створені до цієї зміни) лишаються в кінці, у стабільному порядку.
  const orderOf = r => (r.order_index === null || r.order_index === undefined) ? Infinity : r.order_index;
  const combined = [
    ...t.photo_requirements.map(r => ({ kind: 'photo', r })),
    ...t.audio_requirements.map(r => ({ kind: 'audio', r })),
    ...t.questionnaires.map(r => ({ kind: 'quest', r }))
  ].sort((a, b) => orderOf(a.r) - orderOf(b.r));

  combined.forEach(({ kind, r }) => {
    let key, sub, onOpen;
    if (kind === 'photo') {
      key = hubKey('photo', r.id); sub = `${r.required_count} фото`; onOpen = () => Photo.open(r);
    } else if (kind === 'audio') {
      key = hubKey('audio', r.id); sub = `Мін. ${r.min_duration_sec} сек`; onOpen = () => Audio.open(r);
    } else {
      key = hubKey('quest', r.questionnaire_id); sub = `${r.criteria_count} питань`; onOpen = () => Quest.open(r);
    }
    const done = State.hubProgress[key];
    const isPrimary = !done && !firstPendingSeen;
    if (!done) firstPendingSeen = true;
    list.appendChild(hubRow(kind, r.title, sub, done, guard(onOpen), blocked, isPrimary));
  });

  document.getElementById('btn-hub-submit').disabled = blocked;
}

function hubRow(kind, title, sub, done, onClick, blocked = false, isPrimary = false) {
  const icons = { photo: 'ti-camera', audio: 'ti-microphone', quest: 'ti-clipboard-check' };
  const themeBadge = { photo: 'accent', audio: 'warn', quest: 'success' };
  const card = document.createElement('div');
  const queued = done === 'queued';
  const finished = done === true; // подтверджено сервером, на відміну від локально відкладеного
  const hideButton = finished || queued;
  card.className = 'card' + (isPrimary ? ' highlight' : '');
  if (finished) card.style.opacity = '.6';
  const badgeClass = finished ? 'success' : (queued ? 'muted' : (isPrimary ? 'accent' : themeBadge[kind]));
  const badgeText = finished ? 'Здано' : (queued ? 'Очікує синхр.' : 'Нове');
  const btnHtml = hideButton ? '' : (
    isPrimary
      ? `<button class="fm-btn sm" type="button" ${blocked ? 'disabled' : ''}>Виконати <i class="ti ti-arrow-right" aria-hidden="true"></i></button>`
      : `<button class="fm-btn sm outline" type="button" ${blocked ? 'disabled' : ''}>Виконати <i class="ti ti-arrow-right" aria-hidden="true"></i></button>`
  );
  card.innerHTML = `
    <div style="display:flex;gap:9px;align-items:center;margin-bottom:${hideButton ? '0' : '8px'}">
      <div class="req-icon ${kind}"><i class="ti ${icons[kind]}" aria-hidden="true"></i></div>
      <div class="req-info"><div class="t">${escapeHtml(title)}</div><div class="s">${escapeHtml(sub)}</div></div>
      <span class="badge ${badgeClass}">${badgeText}</span>
    </div>
    ${btnHtml}
  `;
  if (!hideButton) card.querySelector('button').addEventListener('click', onClick);
  return card;
}

async function doSubmit(force) {
  const btn = document.getElementById('btn-hub-submit');
  const alertEl = document.getElementById('hub-alert');
  alertEl.classList.remove('show');

  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spin"></span>';

  const { data } = await api('/ga/shopper/submit', {
    method: 'POST',
    body: { submission_id: State.currentSubmissionId, force }
  });

  btn.disabled = false;
  btn.innerHTML = 'Відправити на перевірку';

  if (data.success) {
    clearSession();
    Router.show('success');
  } else if (data.missing) {
    showIncompleteModal(data.missing);
  } else {
    alertEl.textContent = data.error || 'Сталася помилка';
    alertEl.className = 'fm-alert show err';
  }
}

function showIncompleteModal(missing) {
  const rows = [];
  if (missing.photos.length) rows.push(`<div>📷 Фото: не вистачає ${missing.photos.length} шт.</div>`);
  if (missing.audio.length) rows.push(`<div>🎙 Аудіо: не записано ${missing.audio.length} шт.</div>`);
  if (missing.criteria.length) rows.push(`<div>📋 Анкета: не відповіли на ${missing.criteria.length} питань.</div>`);
  document.getElementById('incomplete-modal-list').innerHTML = rows.join('');
  document.getElementById('incomplete-modal-overlay').style.display = 'flex';
}
document.getElementById('btn-incomplete-cancel').addEventListener('click', () => {
  document.getElementById('incomplete-modal-overlay').style.display = 'none';
});
document.getElementById('btn-incomplete-confirm').addEventListener('click', () => {
  document.getElementById('incomplete-modal-overlay').style.display = 'none';
  doSubmit(true);
});

document.getElementById('btn-hub-submit').addEventListener('click', async () => {
  const alertEl = document.getElementById('hub-alert');
  alertEl.classList.remove('show');

  // Не б'ємо по /submit, якщо по цьому ж submission ще лежать несинхронізовані пункти —
  // сервер чесно відповість "missing", але для користувача, який щойно все заповнив
  // офлайн, це виглядатиме як втрата даних. Замість цього — зрозуміле повідомлення + sync.
  const pendingHere = (await OfflineDB.all()).some(it => it.submissionId === State.currentSubmissionId);
  if (pendingHere) {
    alertEl.textContent = navigator.onLine
      ? 'Дані ще синхронізуються, зачекайте кілька секунд і спробуйте ще раз.'
      : "Дані збережено локально й надішляться автоматично, коли з'явиться інтернет.";
    alertEl.className = 'fm-alert show warn';
    OfflineQueue.trySync();
    return;
  }

  doSubmit(false);
});

// ─── SCREEN: PHOTO ────────────────────────────────────────
const Photo = {
  open(requirement) {
    State.currentReq = requirement;
    State.photoFiles[requirement.id] = State.photoFiles[requirement.id] || [];
    document.getElementById('photo-title').textContent = requirement.title;
    document.getElementById('photo-count').textContent = `Потрібно ${requirement.required_count} фото`;
    document.getElementById('photo-desc').textContent = requirement.description || '';
    document.getElementById('photo-comment').value = '';
    document.getElementById('photo-alert').classList.remove('show');
    this.renderGrid();
    Router.show('photo');
  },
  renderGrid() {
    const grid = document.getElementById('photo-grid');
    const req = State.currentReq;
    const files = State.photoFiles[req.id] || [];
    grid.innerHTML = '';
    for (let i = 0; i < req.required_count; i++) {
      const slot = document.createElement('div');
      const file = files[i];
      if (file) {
        slot.className = 'photo-slot filled';
        slot.innerHTML = `<i class="ti ti-check" style="font-size:18px;color:var(--accent)" aria-hidden="true"></i><span class="lbl" style="color:var(--accent)">фото ${i + 1}</span>`;
      } else {
        slot.className = 'photo-slot empty';
        slot.innerHTML = `<i class="ti ti-camera" style="font-size:20px" aria-hidden="true"></i><span class="lbl">фото ${i + 1}</span>`;
        slot.addEventListener('click', () => this.captureSlot(i));
      }
      grid.appendChild(slot);
    }
  },
  captureSlot(index) {
    const input = document.getElementById('photo-file-input');
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      State.photoFiles[State.currentReq.id][index] = file;
      this.renderGrid();
      input.value = '';
    };
    input.click();
  },
  async save() {
    const req = State.currentReq;
    const files = (State.photoFiles[req.id] || []).filter(Boolean);
    const alertEl = document.getElementById('photo-alert');
    if (files.length < req.required_count) {
      alertEl.textContent = `Потрібно ще ${req.required_count - files.length} фото`;
      alertEl.className = 'fm-alert show warn';
      return;
    }
    const btn = document.getElementById('btn-photo-back');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spin"></span>';

    const comment = document.getElementById('photo-comment').value.trim();
    const key = hubKey('photo', req.id);
    let allOk = true;
    let wentOffline = false;

    for (let i = 0; i < files.length; i++) {
      const base64 = await fileToBase64(files[i]);
      const { data, offline } = await api('/ga/shopper/submit-photo', {
        method: 'POST',
        body: {
          submission_id: State.currentSubmissionId,
          photo_requirement_id: req.id,
          comment: comment || undefined,
          file_base64: base64,
          mime_type: files[i].type
        }
      });
      if (offline) {
        // жодне фото від i-го й далі ще не доїхало до сервера — кладемо всі разом,
        // одним пунктом черги, щоб рядок у хабі відповідав одному стану "в очікуванні"
        const remaining = await Promise.all(files.slice(i).map(async f => ({
          file_base64: await fileToBase64(f),
          mime_type: f.type
        })));
        await OfflineQueue.enqueue('photo', key, State.currentSubmissionId, {
          photo_requirement_id: req.id,
          comment: comment || undefined,
          files: remaining
        });
        wentOffline = true;
        break;
      }
      if (!data.success) {
        allOk = false;
        alertEl.textContent = data.error || 'Помилка завантаження';
        alertEl.className = 'fm-alert show err';
        break;
      }
    }

    btn.disabled = false;
    btn.innerHTML = 'Зберегти <i class="ti ti-arrow-right" aria-hidden="true"></i>';

    if (wentOffline) {
      Router.show('hub');
      renderHub();
    } else if (allOk) {
      State.hubProgress[key] = true;
      saveSession();
      Router.show('hub');
      renderHub();
    }
  }
};
document.getElementById('btn-photo-back').addEventListener('click', () => Photo.save());

// ─── SCREEN: AUDIO ────────────────────────────────────────
const Audio = {
  mediaRecorder: null,
  chunks: [],
  blob: null,
  duration: 0,
  recStart: null,
  timerInterval: null,
  wakeLock: null,

  open(requirement) {
    State.currentReq = requirement;
    this.blob = null;
    this.duration = 0;
    document.getElementById('audio-title').textContent = requirement.title;
    document.getElementById('audio-min').textContent = `Мін. ${requirement.min_duration_sec} сек`;
    document.getElementById('audio-instr').textContent = requirement.instruction || '';
    document.getElementById('rec-timer').textContent = `00:00 / мін. ${formatMMSS(requirement.min_duration_sec)}`;
    document.getElementById('audio-playback').style.display = 'none';
    document.getElementById('wake-note').style.display = 'none';
    document.getElementById('audio-alert').classList.remove('show');
    document.getElementById('btn-audio-save').disabled = true;
    document.getElementById('rec-circle').classList.remove('recording');
    document.getElementById('rec-hint').textContent = 'Натисніть для запису';
    Router.show('audio');
  },

  async toggle() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.chunks = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
                     : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.chunks.push(e.data); };
      this.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(this.timerInterval);
        if (this.wakeLock) { try { await this.wakeLock.release(); } catch (_) {} this.wakeLock = null; }
        document.getElementById('wake-note').style.display = 'none';
        this.blob = new Blob(this.chunks, { type: mimeType || 'audio/webm' });
        this.duration = Math.round((Date.now() - this.recStart) / 1000);
        const audioEl = document.getElementById('audio-playback');
        audioEl.src = URL.createObjectURL(this.blob);
        audioEl.style.display = 'block';
        document.getElementById('rec-circle').classList.remove('recording');
        document.getElementById('rec-hint').textContent = 'Натисніть щоб перезаписати';
        const min = State.currentReq.min_duration_sec;
        document.getElementById('btn-audio-save').disabled = this.duration < min;
        const alertEl = document.getElementById('audio-alert');
        if (this.duration < min) {
          alertEl.textContent = `Занадто коротко (мін. ${formatMMSS(min)}). Перезапишіть.`;
          alertEl.className = 'fm-alert show warn';
        } else {
          alertEl.classList.remove('show');
        }
      };
      this.recStart = Date.now();
      this.mediaRecorder.start(250);
      if ('wakeLock' in navigator) {
        try { this.wakeLock = await navigator.wakeLock.request('screen'); document.getElementById('wake-note').style.display = 'flex'; } catch (_) {}
      }
      document.getElementById('rec-circle').classList.add('recording');
      document.getElementById('rec-hint').textContent = 'Натисніть щоб зупинити';
      let secs = 0;
      const min = State.currentReq.min_duration_sec;
      this.timerInterval = setInterval(() => {
        secs++;
        document.getElementById('rec-timer').textContent = `${formatMMSS(secs)} / мін. ${formatMMSS(min)}`;
      }, 1000);
    } catch (e) {
      const alertEl = document.getElementById('audio-alert');
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        // Браузер один раз запам'ятовує відмову і більше сам ніколи не перепитує —
        // без явних дій самого гостя в налаштуваннях доступ не повернути.
        // iOS та Android відкривають цей дозвіл в геть різних місцях, тому визначаємо платформу.
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isIOS) {
          alertEl.innerHTML = 'Доступ до мікрофону заблоковано. Щоб виправити на iPhone: '
            + '<b>Налаштування</b> → <b>Додатки</b> → <b>Safari</b> (або Chrome, якщо через нього) → '
            + '<b>Мікрофон</b> → поставте <b>«Дозволити»</b>. Потім поверніться сюди і <b>перезавантажте сторінку</b>.';
        } else {
          alertEl.innerHTML = 'Доступ до мікрофону заблоковано в браузері. Щоб виправити: '
            + 'натисніть на значок замка/інформації <b>зліва від адресного рядка</b> → '
            + '<b>Дозволи сайту</b> → <b>Мікрофон</b> → <b>Дозволити</b> → після цього '
            + '<b>перезавантажте сторінку</b> і спробуйте ще раз.';
        }
      } else if (e.name === 'NotFoundError') {
        alertEl.textContent = 'На цьому пристрої не знайдено мікрофон.';
      } else {
        alertEl.textContent = 'Немає доступу до мікрофону: ' + e.message;
      }
      alertEl.className = 'fm-alert show err';
    }
  },

  async save() {
    const req = State.currentReq;
    const btn = document.getElementById('btn-audio-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spin"></span>';

    const audioBase64 = await fileToBase64(this.blob);
    const audioMime = this.blob.type || 'audio/webm';
    const key = hubKey('audio', req.id);

    const { data, offline } = await api('/ga/shopper/submit-audio', {
      method: 'POST',
      body: {
        submission_id: State.currentSubmissionId,
        audio_requirement_id: req.id,
        duration_sec: this.duration,
        file_base64: audioBase64,
        mime_type: audioMime
      }
    });
    btn.disabled = false;
    btn.innerHTML = 'Зберегти <i class="ti ti-arrow-right" aria-hidden="true"></i>';

    if (offline) {
      await OfflineQueue.enqueue('audio', key, State.currentSubmissionId, {
        audio_requirement_id: req.id,
        duration_sec: this.duration,
        file_base64: audioBase64,
        mime_type: audioMime
      });
      Router.show('hub');
      renderHub();
    } else if (data.success) {
      State.hubProgress[key] = true;
      saveSession();
      Router.show('hub');
      renderHub();
    } else {
      const alertEl = document.getElementById('audio-alert');
      alertEl.textContent = data.error || 'Помилка завантаження';
      alertEl.className = 'fm-alert show err';
    }
  }
};
document.getElementById('rec-circle').addEventListener('click', () => Audio.toggle());
document.getElementById('btn-audio-save').addEventListener('click', () => Audio.save());
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && Audio.mediaRecorder && Audio.mediaRecorder.state === 'recording' && 'wakeLock' in navigator) {
    try { Audio.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
});

// ─── SCREEN: QUESTIONNAIRE ────────────────────────────────
const Quest = {
  async open(questionnaireRef) {
    // task-details gives us the full criteria list (task list summary doesn't include it)
    const { data } = await api('/ga/shopper/task-details?task_id=' + State.currentTask.task_id);
    if (!data.success) return;
    const questionnaire = data.questionnaires.find(q => q.questionnaire_id === questionnaireRef.questionnaire_id);
    if (!questionnaire) return;

    await api('/ga/shopper/questionnaire-open', { method: 'POST', body: { submission_id: State.currentSubmissionId } });

    // Клік "← Завдання" не видаляє State.quest — це просто перемикання екрану.
    // Якщо гість повертається до ТІЄЇ Ж анкети (не завершивши її), продовжуємо
    // з того самого місця, а не скидаємо відповіді назад до нуля.
    const resuming = State.quest && State.quest.questionnaireId === questionnaire.questionnaire_id;
    if (!resuming) {
      State.quest = {
        questionnaireId: questionnaire.questionnaire_id,
        sectionTitle: questionnaire.title,
        criteria: questionnaire.criteria,
        answers: {},
        idx: 0
      };
    }
    Router.show('quest');
    this.renderCurrent();
  },

  visibleCriteria() {
    const { criteria, answers } = State.quest;
    return criteria.filter(c => {
      if (c.parent_criterion_id === null || c.parent_criterion_id === undefined) return true;
      return answers[c.parent_criterion_id] === c.condition_value;
    });
  },

  renderCurrent() {
    const visible = this.visibleCriteria();
    const q = State.quest;
    if (q.idx >= visible.length) { this.finish(); return; }
    const c = visible[q.idx];

    document.getElementById('q-progress-txt').textContent = `${q.idx + 1}/${visible.length}`;
    document.getElementById('q-progress-fill').style.width = `${Math.round(((q.idx + 1) / visible.length) * 100)}%`;
    document.getElementById('q-section-label').textContent = q.sectionTitle;
    document.getElementById('q-alert').classList.remove('show');

    const body = document.getElementById('q-body');
    const btn = document.getElementById('btn-q-next');
    btn.disabled = true;

    const scaleMatch = /^scale_(\d+)_(\d+)$/.exec(c.answer_type || '');

    if (c.answer_type === 'yes_no') {
      body.innerHTML = `<div class="q-question">${escapeHtml(c.question_text)}</div>
        <div class="yn-row">
          <div class="yn-btn" data-val="yes"><i class="ti ti-check" aria-hidden="true"></i> Так</div>
          <div class="yn-btn" data-val="no">Ні</div>
        </div>`;
      body.querySelectorAll('.yn-btn').forEach(b => b.addEventListener('click', () => {
        body.querySelectorAll('.yn-btn').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        q.answers[c.id] = b.dataset.val;
        btn.disabled = false;
      }));
      if (q.answers[c.id] !== undefined) {
        const prev = body.querySelector(`.yn-btn[data-val="${q.answers[c.id]}"]`);
        if (prev) { prev.classList.add('selected'); btn.disabled = false; }
      }
    } else if (scaleMatch) {
      const min = parseInt(scaleMatch[1], 10), max = parseInt(scaleMatch[2], 10);
      let opts = '';
      for (let n = min; n <= max; n++) opts += `<div class="scale-btn" data-val="${n}">${n}</div>`;
      body.innerHTML = `<div class="q-question">${escapeHtml(c.question_text)}</div><div class="scale-row">${opts}</div>`;
      body.querySelectorAll('.scale-btn').forEach(b => b.addEventListener('click', () => {
        body.querySelectorAll('.scale-btn').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        q.answers[c.id] = b.dataset.val;
        btn.disabled = false;
      }));
      if (q.answers[c.id] !== undefined) {
        const prev = body.querySelector(`.scale-btn[data-val="${q.answers[c.id]}"]`);
        if (prev) { prev.classList.add('selected'); btn.disabled = false; }
      }
    } else {
      body.innerHTML = `<div class="q-question">${escapeHtml(c.question_text)}</div>
        <textarea class="fm-input" style="height:90px" id="q-text-input" placeholder="Ваша відповідь...">${escapeHtml(q.answers[c.id] || '')}</textarea>`;
      const ta = document.getElementById('q-text-input');
      ta.addEventListener('input', () => {
        q.answers[c.id] = ta.value.trim();
        btn.disabled = ta.value.trim() === '';
      });
      if (q.answers[c.id]) btn.disabled = false;
    }
    btn.textContent = '';
    btn.innerHTML = (q.idx === visible.length - 1) ? 'Завершити <i class="ti ti-check" aria-hidden="true"></i>' : 'Далі <i class="ti ti-arrow-right" aria-hidden="true"></i>';

    // Кнопку пропуску показуємо тільки якщо адмін позначив саме це питання як
    // "можна пропустити" — рішення, де саме дозволити пропуск, приймає адмін (п.42).
    document.getElementById('btn-q-skip').style.display = c.is_skippable ? 'block' : 'none';
  },

  skip() {
    // Свідомий пропуск: відповідь НЕ записується взагалі (не порожній рядок,
    // не false) — далі по конвеєру (перевірка повноти, AI) це трактується
    // так само, як "питання не було", а не як "відповіли пусткою".
    delete State.quest.answers[this._currentCriterionId()];
    State.quest.idx++;
    this.renderCurrent();
  },

  _currentCriterionId() {
    const visible = this.visibleCriteria();
    const c = visible[State.quest.idx];
    return c ? c.id : null;
  },

  next() {
    State.quest.idx++;
    this.renderCurrent();
  },

  async finish() {
    const btn = document.getElementById('btn-q-next');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spin"></span>';

    const answers = Object.entries(State.quest.answers).map(([criterion_id, answer_value]) => ({
      criterion_id: Number(criterion_id), answer_value
    }));
    const key = hubKey('quest', State.quest.questionnaireId);

    const { data, offline } = await api('/ga/shopper/submit-answers', {
      method: 'POST',
      body: { submission_id: State.currentSubmissionId, answers }
    });

    if (offline) {
      await OfflineQueue.enqueue('answers', key, State.currentSubmissionId, { answers });
      Router.show('hub');
      renderHub();
    } else if (data.success) {
      State.hubProgress[key] = true;
      saveSession();
      Router.show('hub');
      renderHub();
    } else {
      Router.show('hub');
      renderHub();
      const alertEl = document.getElementById('hub-alert');
      alertEl.textContent = data.error || 'Не вдалося зберегти анкету';
      alertEl.className = 'fm-alert show err';
    }
  }
};
document.getElementById('btn-q-next').addEventListener('click', () => {
  const visible = Quest.visibleCriteria();
  if (State.quest.idx >= visible.length - 1) Quest.finish();
  else Quest.next();
});

document.getElementById('btn-q-skip').addEventListener('click', () => Quest.skip());

// ─── UTILS ────────────────────────────────────────────────
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatMMSS(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── PUSH SUBSCRIBE ────────────────────────────────────────
// Клієнтська частина push (permission + показ) вже була готова в sw.js — тут лише
// не вистачало підписки: попросити дозвіл, отримати PushSubscription від браузера і
// віддати її на сервер, щоб n8n знав, куди слати push при новому завданні.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

const PushSetup = {
  async init() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return; // iOS <16.4 у Safari-вкладці, наприклад
    if (Notification.permission === 'denied') return; // не набридаємо повторним запитом

    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();

      if (!sub) {
        if (Notification.permission === 'default') {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') return;
        }
        if (Notification.permission !== 'granted') return;
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      }

      // Шлемо щоразу (навіть якщо підписка вже була) — це просто UPSERT на сервері,
      // ідемпотентно, і підстраховує на випадок якщо попередня спроба відправки не дійшла
      await api('/ga/shopper/push-subscribe', { method: 'POST', body: sub.toJSON() });
    } catch (e) {
      console.warn('Push subscribe failed', e); // не критично для роботи застосунку — просто не буде push
    }
  }
};

// ─── SERVICE WORKER ───────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update(); // check for a newer sw.js immediately instead of waiting
    // NOTE: deliberately NOT auto-reloading on activation anymore — an earlier version of
    // this did `window.location.reload()` here, which could fire mid-task (e.g. right as
    // the SW installs for the first time in a fresh/private context) and silently wipe
    // in-memory state like State.currentSubmissionId. That's worse than a stale cache.
    // Instead, just let the already-fixed network-first fetch handler keep things current;
    // no forced reload is needed for updates to take effect on next natural navigation.
  }).catch(e => console.warn('SW registration failed', e));
}

// ─── CLIENT (роль client — окремий, простий кабінет: звіти по своїй мережі + профіль) ──
const Client = {
  filters: { object_id: '', date_from: '', date_to: '', decision: '' },

  async loadReports() {
    const list = document.getElementById('client-reports-list');
    const empty = document.getElementById('client-reports-empty');
    list.innerHTML = '<div class="card-sub" style="text-align:center;padding:20px 0">Завантаження…</div>';
    const q = new URLSearchParams();
    Object.entries(Client.filters).forEach(([k, v]) => { if (v) q.set(k, v); });
    try {
      const { data } = await api('/ga/shopper/my-reports?' + q.toString());
      if (!data.success) {
        list.innerHTML = `<div class="fm-alert show err">${escapeHtml(data.error || 'Не вдалося завантажити звіти')}</div>`;
        return;
      }
      const rows = data.submissions || [];
      list.innerHTML = '';
      empty.style.display = rows.length === 0 ? 'block' : 'none';

      // Заповнюємо фільтр "Об'єкт" унікальними значеннями з отриманих звітів --
      // окремого ендпоінта під список об'єктів клієнта поки нема, а тут дані вже є.
      const objSelect = document.getElementById('cf-object');
      if (objSelect.options.length === 1) {
        const seen = new Set();
        rows.forEach(r => {
          if (seen.has(r.object_id)) return;
          seen.add(r.object_id);
          const opt = document.createElement('option');
          opt.value = r.object_id; opt.textContent = r.object_name;
          objSelect.appendChild(opt);
        });
      }
      const DECISION_LABELS = {
        pending: ['Очікує', 'muted'], auto_approved: ['Схвалено', 'success'],
        approved: ['Схвалено', 'success'], rejected: ['Відхилено', 'warn'], needs_revision: ['На доопрацюванні', 'warn']
      };
      rows.forEach(r => {
        const [label, cls] = DECISION_LABELS[r.decision] || ['—', 'muted'];
        const score = r.object_score !== null && r.object_score !== undefined ? Math.round(r.object_score) : '—';
        const date = r.submitted_at ? new Date(r.submitted_at).toLocaleDateString('uk-UA') : '—';
        list.insertAdjacentHTML('beforeend', `
          <div class="card done" style="cursor:default">
            <div class="card-row">
              <div class="card-title">${escapeHtml(r.object_name)}</div>
              <span class="badge ${cls === 'success' ? 'success' : cls === 'warn' ? 'warn' : 'muted'}">${score}</span>
            </div>
            <div class="card-row">
              <div class="card-sub">${date}</div>
              <span class="badge ${cls === 'success' ? 'success' : cls === 'warn' ? 'warn' : 'muted'}">${label}</span>
            </div>
          </div>
        `);
      });
    } catch (e) {
      list.innerHTML = `<div class="fm-alert show err">Немає з'єднання з сервером</div>`;
    }
  },

  async loadProfile() {
    document.getElementById('cp-name').value = '';
    document.getElementById('cp-phone').value = '';
    document.getElementById('cp-password').value = '';
    try {
      const { data } = await api('/ga/shopper/my-profile');
      if (!data.success) return;
      const u = data.user;
      State.user = { ...State.user, ...u };
      localStorage.setItem('ga_user', JSON.stringify(State.user));
      document.getElementById('cp-name').value = `${u.first_name || ''} ${u.last_name || ''}`.trim();
      document.getElementById('cp-phone').value = u.phone || '';
    } catch (e) { /* лишаємо поля порожніми, форма все одно робоча */ }
  },

  async saveProfile() {
    const btn = document.getElementById('btn-client-profile-save');
    const alertEl = document.getElementById('client-profile-alert');
    alertEl.className = 'fm-alert';
    const [first_name, ...rest] = document.getElementById('cp-name').value.trim().split(' ');
    const body = { user_id: State.user.id, first_name, last_name: rest.join(' '), phone: document.getElementById('cp-phone').value.trim() };
    const pwd = document.getElementById('cp-password').value;
    if (pwd) body.password = pwd;

    btn.disabled = true; btn.textContent = 'Зберігаємо…';
    try {
      const { data } = await api('/ga/admin/users/update', { method: 'POST', body });
      if (!data.success) { alertEl.textContent = data.error || 'Помилка'; alertEl.className = 'fm-alert show err'; return; }
      State.user = { ...State.user, ...data.user };
      localStorage.setItem('ga_user', JSON.stringify(State.user));
      document.getElementById('cp-password').value = '';
      alertEl.textContent = 'Профіль збережено.'; alertEl.className = 'fm-alert show ok';
    } catch (e) {
      alertEl.textContent = "Немає з'єднання з сервером"; alertEl.className = 'fm-alert show err';
    } finally {
      btn.disabled = false; btn.textContent = 'Зберегти профіль';
    }
  }
};

document.getElementById('btn-shopper-profile-open')?.addEventListener('click', () => {
  Router.show('client-profile');
  Client.loadProfile();
});
document.getElementById('btn-shopper-profile-open-2')?.addEventListener('click', () => {
  Router.show('client-profile');
  Client.loadProfile();
});
document.getElementById('btn-shopper-reports-open')?.addEventListener('click', () => {
  Router.show('client-reports');
  Client.loadReports();
});
document.getElementById('btn-shopper-reports-open-2')?.addEventListener('click', () => {
  Router.show('client-reports');
  Client.loadReports();
});
document.getElementById('btn-shopper-reports-back')?.addEventListener('click', () => {
  Router.show('objects');
  Objects.load();
});
document.getElementById('cf-apply')?.addEventListener('click', () => {
  Client.filters.object_id = document.getElementById('cf-object').value;
  Client.filters.date_from = document.getElementById('cf-date-from').value;
  Client.filters.date_to = document.getElementById('cf-date-to').value;
  Client.filters.decision = document.getElementById('cf-decision').value;
  Client.loadReports();
});
document.getElementById('btn-client-profile-open')?.addEventListener('click', () => {
  Router.show('client-profile');
  Client.loadProfile();
});
document.getElementById('btn-client-profile-back')?.addEventListener('click', () => {
  Router.show('objects');
  Objects.load();
});
document.getElementById('btn-client-profile-save')?.addEventListener('click', Client.saveProfile);

// ─── INIT ─────────────────────────────────────────────────
updateOnlineBanner();
if (State.token && State.user) {
  if (State.user.role === 'client') {
    Router.show('client-reports');
    Client.loadReports();
  } else {
    const resumed = restoreSession();
    if (!resumed) {
      Router.show('objects');
      Objects.load();
    }
    PushSetup.init();
  }
}
