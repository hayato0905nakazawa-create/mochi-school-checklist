const $app = document.querySelector('#app');
const $toast = document.querySelector('#toast');

const API_BASE = 'https://sjgijtwakgsehlmwbxks.supabase.co/functions/v1/api';
const AUTH_KEY = 'mochi_session_token';
const VAPID_KEY_STORE = 'mochi_vapid_public_key';

const state = {
  user: null,
  view: 'list',
  day: 'today',
  tasks: [],
  preferences: {
    reminderIntervalMinutes: 5,
    quietEnabled: false,
    quietStart: '22:00',
    quietEnd: '06:00',
  },
  pushEnabled: false,
  swReg: null,
};

const api = async (url, options = {}) => {
  const token = localStorage.getItem(AUTH_KEY);
  const res = await fetch(API_BASE + url, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/login') localStorage.removeItem(AUTH_KEY);
  if (!res.ok) throw new Error(data.error || 'エラーが発生しました');
  return data;
};

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => $toast.classList.remove('show'), 1800);
}

function localDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function formatDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }).format(d);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function boot() {
  if ('serviceWorker' in navigator) {
    try { state.swReg = await navigator.serviceWorker.register('/sw.js'); } catch {}
  }
  try {
    const me = await api('/me');
    state.user = me;
    await loadPreferences();
    await detectPush();
    await loadTasks();
    render();
  } catch {
    renderAuth();
  }
}

async function detectPush() {
  if (!state.swReg || !('PushManager' in window)) return;
  let sub = await state.swReg.pushManager.getSubscription();
  if (sub && state.user) {
    try {
      const { publicKey } = await api('/push/public-key');
      const savedKey = localStorage.getItem(VAPID_KEY_STORE);
      if (savedKey !== publicKey) {
        await sub.unsubscribe();
        sub = await state.swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        localStorage.setItem(VAPID_KEY_STORE, publicKey);
      }
      await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
    } catch {
      sub = null;
    }
  }
  state.pushEnabled = !!sub;
}

async function loadTasks() {
  const date = state.day === 'today' ? localDate(0) : localDate(1);
  const overdue = state.day === 'today' ? '&includeOverdue=1' : '';
  const { tasks } = await api(`/tasks?date=${encodeURIComponent(date)}${overdue}`);
  state.tasks = tasks;
}

async function loadPreferences() {
  const { preferences } = await api('/preferences');
  state.preferences = preferences;
}

async function renderAuth() {
  const status = await api('/status').catch(() => ({ hasUsers: true, signupOpen: false }));
  const first = !status.hasUsers;
  $app.innerHTML = `
    <section class="auth-wrap">
      <div class="auth-card">
        <div class="brand"><div class="brand-mark">M</div><div class="brand-name">Mochi</div></div>
        <h1 class="auth-title">${first ? '最初の設定' : 'ログイン'}</h1>
        <p class="auth-sub">${first ? '学校PCとスマホで使うIDとPINを決めます。' : '学校PCでもスマホでも、同じIDで使えます。'}</p>
        <form id="authForm">
          <div class="field">
            <label class="label" for="username">ID</label>
            <input class="input" id="username" name="username" autocomplete="username" maxlength="24" placeholder="例  HAYATO" required />
          </div>
          <div class="field">
            <label class="label" for="pin">PIN</label>
            <input class="input pin-input" id="pin" name="pin" type="password" inputmode="numeric" autocomplete="${first ? 'new-password' : 'current-password'}" maxlength="8" placeholder="••••••" required />
          </div>
          <button class="primary" type="submit">${first ? 'はじめる' : 'ログイン'}</button>
          <div id="authError" class="error"></div>
        </form>
      </div>
    </section>`;
  document.querySelector('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = { username: form.get('username'), pin: form.get('pin') };
    const btn = e.currentTarget.querySelector('button');
    btn.disabled = true;
    document.querySelector('#authError').textContent = '';
    try {
      const result = await api(first ? '/register' : '/login', { method: 'POST', body: JSON.stringify(body) });
      if (result.token) localStorage.setItem(AUTH_KEY, result.token);
      state.user = await api('/me');
      await loadPreferences();
      await detectPush();
      await loadTasks();
      render();
    } catch (err) {
      document.querySelector('#authError').textContent = err.message;
    } finally { btn.disabled = false; }
  });
}

function render() {
  if (!state.user) return renderAuth();
  $app.innerHTML = `
    <header class="topbar">
      <div>
        <div class="hello">${escapeHtml(state.user.username)}</div>
        <div class="date-title">${state.view === 'settings' ? '設定' : formatDate(state.day === 'today' ? localDate(0) : localDate(1))}</div>
      </div>
    </header>
    <section class="content" id="content"></section>
    ${state.view === 'list' ? '<button id="addFab" class="fab" aria-label="追加">＋</button>' : ''}
    <nav class="bottom-nav">
      <button class="nav-btn ${state.view === 'list' ? 'active' : ''}" data-view="list"><span class="nav-icon">✓</span><span>リスト</span></button>
      <button class="nav-btn ${state.view === 'settings' ? 'active' : ''}" data-view="settings"><span class="nav-icon">⚙</span><span>設定</span></button>
    </nav>`;

  document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', async () => {
    state.view = btn.dataset.view;
    if (state.view === 'list') await loadTasks();
    if (state.view === 'settings') await loadPreferences();
    render();
  }));

  if (state.view === 'settings') renderSettings();
  else renderList();
}

function taskRows(tasks, overdue = false) {
  return tasks.map(task => `
    <div class="task ${task.done ? 'done' : ''} ${overdue ? 'overdue-task' : ''}" data-id="${task.id}">
      <button class="check" data-action="toggle" aria-label="${task.done ? '未完了に戻す' : '完了'}">${task.done ? '✓' : ''}</button>
      <div>
        <div class="task-text">${escapeHtml(task.text)}</div>
        <div class="task-time">${overdue
          ? `${escapeHtml(task.date.slice(5).replace('-', '/'))} ${escapeHtml(task.time)}から${state.preferences.reminderIntervalMinutes}分ごとに通知中`
          : `${escapeHtml(task.time)} に通知`}</div>
      </div>
      <button class="task-menu" data-action="menu" aria-label="メニュー">⋯</button>
    </div>`).join('');
}

function emptyBlock(text = '＋から、忘れたくないものを追加できます。') {
  return `
    <div class="empty">
      <div class="empty-icon">✓</div>
      <div class="empty-title">まだ何もありません</div>
      <div class="empty-sub">${text}</div>
    </div>`;
}

function renderList() {
  const $content = document.querySelector('#content');
  const today = localDate(0);
  const isToday = state.day === 'today';
  const overdueTasks = isToday ? state.tasks.filter(t => t.date < today && !t.done) : [];
  const dayTasks = isToday ? state.tasks.filter(t => t.date === today) : state.tasks;
  const dayDone = dayTasks.filter(t => t.done).length;

  $content.innerHTML = `
    <div class="segment">
      <button data-day="today" class="${state.day === 'today' ? 'active' : ''}">今日</button>
      <button data-day="tomorrow" class="${state.day === 'tomorrow' ? 'active' : ''}">明日</button>
    </div>

    ${isToday && overdueTasks.length ? `
      <div class="section-label overdue-label"><span>🔔 未完了</span><span>${overdueTasks.length}件</span></div>
      <div class="card overdue-card">
        <div class="list">${taskRows(overdueTasks, true)}</div>
      </div>
    ` : ''}

    <div class="section-label"><span>${isToday ? '今日' : '明日'}</span><span>${dayTasks.length ? `${dayDone}/${dayTasks.length}` : ''}</span></div>
    <div class="card">
      <div class="list">
        ${dayTasks.length ? taskRows(dayTasks) : emptyBlock(isToday && overdueTasks.length ? '今日の持ち物はまだありません。' : undefined)}
      </div>
    </div>

    ${dayTasks.length > 0 && dayDone === dayTasks.length ? '<div class="complete"><span class="complete-dot">✓</span>準備完了！</div>' : ''}`;

  document.querySelectorAll('[data-day]').forEach(btn => btn.addEventListener('click', async () => {
    state.day = btn.dataset.day;
    await loadTasks();
    render();
  }));
  document.querySelector('#addFab').addEventListener('click', () => openAddSheet());
  document.querySelectorAll('[data-action="toggle"]').forEach(btn => btn.addEventListener('click', async e => {
    const row = e.currentTarget.closest('.task');
    const task = state.tasks.find(t => t.id === row.dataset.id);
    task.done = !task.done;
    render();
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ done: task.done }) });
      await loadTasks();
      render();
    } catch (err) { task.done = !task.done; toast(err.message); await loadTasks(); render(); }
  }));
  document.querySelectorAll('[data-action="menu"]').forEach(btn => btn.addEventListener('click', e => {
    const id = e.currentTarget.closest('.task').dataset.id;
    openTaskSheet(state.tasks.find(t => t.id === id));
  }));
}

function sheet(html) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `<div class="sheet"><div class="grabber"></div>${html}</div>`;
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  document.body.appendChild(wrap);
  return wrap;
}

function openAddSheet() {
  const targetDate = state.day === 'today' ? localDate(0) : localDate(1);
  const wrap = sheet(`
    <div class="sheet-title">追加</div>
    <form id="addForm">
      <div class="field"><label class="label">何を忘れたくない？</label><input id="taskText" class="input" maxlength="80" placeholder="例  体操服" autofocus required></div>
      <div class="field"><label class="label">いつ？</label>
        <div class="quick-days"><button type="button" data-qdate="${localDate(0)}">今日</button><button type="button" data-qdate="${localDate(1)}">明日</button><button type="button" data-show-date>日付</button></div>
        <input id="taskDate" class="input" type="date" value="${targetDate}" required>
      </div>
      <div class="field"><label class="label">通知</label><input id="taskTime" class="input" type="time" value="07:00" required></div>
      <button class="primary" type="submit">登録する</button>
      <div id="addError" class="error"></div>
    </form>`);
  const dateInput = wrap.querySelector('#taskDate');
  wrap.querySelectorAll('[data-qdate]').forEach(btn => {
    if (btn.dataset.qdate === targetDate) btn.classList.add('active');
    btn.addEventListener('click', () => {
      dateInput.value = btn.dataset.qdate;
      wrap.querySelectorAll('[data-qdate]').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  wrap.querySelector('[data-show-date]').addEventListener('click', () => dateInput.showPicker?.());
  wrap.querySelector('#addForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('.primary');
    btn.disabled = true;
    try {
      await api('/tasks', { method: 'POST', body: JSON.stringify({
        text: wrap.querySelector('#taskText').value,
        date: dateInput.value,
        time: wrap.querySelector('#taskTime').value,
      }) });
      wrap.remove();
      const selected = dateInput.value;
      state.day = selected === localDate(1) ? 'tomorrow' : 'today';
      await loadTasks();
      render();
      toast('登録しました');
    } catch (err) {
      wrap.querySelector('#addError').textContent = err.message;
      btn.disabled = false;
    }
  });
  setTimeout(() => wrap.querySelector('#taskText').focus(), 70);
}

function openTaskSheet(task) {
  const wrap = sheet(`
    <div class="sheet-title">${escapeHtml(task.text)}</div>
    <button id="deleteTask" class="secondary danger">削除</button>`);
  wrap.querySelector('#deleteTask').addEventListener('click', async () => {
    try {
      await api(`/tasks/${task.id}`, { method: 'DELETE' });
      wrap.remove();
      await loadTasks();
      render();
      toast('削除しました');
    } catch (err) { toast(err.message); }
  });
}

function renderSettings() {
  const $content = document.querySelector('#content');
  const canPush = 'Notification' in window && 'PushManager' in window && !!state.swReg;
  const p = state.preferences;

  $content.innerHTML = `
    <div class="setting-card">
      <div class="setting-row">
        <div>
          <div class="setting-main">通知</div>
          <div class="setting-sub">指定時刻から、チェックするまで${p.reminderIntervalMinutes}分ごと</div>
        </div>
        <button id="pushBtn" class="small-btn ${state.pushEnabled ? 'on' : ''}" ${!canPush ? 'disabled' : ''}>${state.pushEnabled ? 'ON' : 'OFF'}</button>
      </div>
    </div>

    <form id="notificationPrefsForm" class="prefs-form">
      <div class="setting-card">
        <div class="setting-row">
          <div>
            <div class="setting-main">通知間隔</div>
            <div class="setting-sub">チェックするまで何分ごとに送るか</div>
          </div>
          <div class="interval-control">
            <input id="reminderInterval" class="compact-input number-input" type="number" min="1" max="1440" step="1" value="${p.reminderIntervalMinutes}" required>
            <span>分</span>
          </div>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-main">通知しない時間</div>
            <div class="setting-sub">この時間帯は通知を止める</div>
          </div>
          <label class="quiet-toggle">
            <input id="quietEnabled" type="checkbox" ${p.quietEnabled ? 'checked' : ''}>
            <span>${p.quietEnabled ? 'ON' : 'OFF'}</span>
          </label>
        </div>

        <div id="quietTimes" class="quiet-times ${p.quietEnabled ? '' : 'disabled'}">
          <label>
            <span>開始</span>
            <input id="quietStart" class="compact-input" type="time" value="${escapeHtml(p.quietStart)}" ${p.quietEnabled ? '' : 'disabled'}>
          </label>
          <div class="quiet-arrow">〜</div>
          <label>
            <span>終了</span>
            <input id="quietEnd" class="compact-input" type="time" value="${escapeHtml(p.quietEnd)}" ${p.quietEnabled ? '' : 'disabled'}>
          </label>
        </div>
      </div>

      <button id="savePrefsBtn" class="primary prefs-save" type="submit">通知設定を保存</button>
      <div id="prefsError" class="error"></div>
    </form>

    <div class="setting-card account-card">
      <div class="setting-row">
        <div><div class="setting-main">ログインID</div><div class="setting-sub">${escapeHtml(state.user.username)}</div></div>
      </div>
    </div>

    <button id="testPushBtn" class="secondary">テスト通知を送る</button>
    <button id="logoutBtn" class="secondary logout">ログアウト</button>
    <div class="note">通知間隔は1〜1440分で設定できます。通知しない時間が終わると、未完了の通知を再開します。</div>`;

  if (canPush) document.querySelector('#pushBtn').addEventListener('click', togglePush);

  const quietEnabled = document.querySelector('#quietEnabled');
  const quietTimes = document.querySelector('#quietTimes');
  const quietStart = document.querySelector('#quietStart');
  const quietEnd = document.querySelector('#quietEnd');

  const syncQuietInputs = () => {
    quietStart.disabled = !quietEnabled.checked;
    quietEnd.disabled = !quietEnabled.checked;
    quietTimes.classList.toggle('disabled', !quietEnabled.checked);
    quietEnabled.nextElementSibling.textContent = quietEnabled.checked ? 'ON' : 'OFF';
  };
  quietEnabled.addEventListener('change', syncQuietInputs);

  document.querySelector('#notificationPrefsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const saveBtn = document.querySelector('#savePrefsBtn');
    const error = document.querySelector('#prefsError');
    saveBtn.disabled = true;
    error.textContent = '';

    try {
      const result = await api('/preferences', {
        method: 'PATCH',
        body: JSON.stringify({
          reminderIntervalMinutes: Number(document.querySelector('#reminderInterval').value),
          quietEnabled: quietEnabled.checked,
          quietStart: quietStart.value || '22:00',
          quietEnd: quietEnd.value || '06:00',
        }),
      });
      state.preferences = result.preferences;
      renderSettings();
      toast('通知設定を保存しました');
    } catch (err) {
      error.textContent = err.message;
      saveBtn.disabled = false;
    }
  });

  document.querySelector('#testPushBtn').addEventListener('click', async () => {
    try {
      const result = await api('/push/test', { method: 'POST', body: '{}' });
      toast(`テスト通知を送信しました（${result.sent}台）`);
    } catch (err) {
      toast(err.message);
    }
  });

  document.querySelector('#logoutBtn').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST', body: '{}' }); } catch {}
    localStorage.removeItem(AUTH_KEY);
    state.user = null;
    state.tasks = [];
    renderAuth();
  });
}

async function togglePush() {
  try {
    if (!state.swReg) throw new Error('通知を利用できません');
    const current = await state.swReg.pushManager.getSubscription();
    if (current) {
      await api('/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint: current.endpoint }) });
      await current.unsubscribe();
      localStorage.removeItem(VAPID_KEY_STORE);
      state.pushEnabled = false;
      toast('通知をOFFにしました');
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('通知が許可されていません');
      const { publicKey } = await api('/push/public-key');
      const sub = await state.swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
      localStorage.setItem(VAPID_KEY_STORE, publicKey);
      state.pushEnabled = true;
      toast('通知をONにしました');
    }
    render();
  } catch (err) { toast(err.message); }
}

boot();
