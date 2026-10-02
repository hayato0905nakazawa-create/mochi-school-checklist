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
    render();
  }));

  if (state.view === 'settings') renderSettings();
  else renderList();
}

function renderList() {
  const $content = document.querySelector('#content');
  const done = state.tasks.filter(t => t.done).length;
  const total = state.tasks.length;
  $content.innerHTML = `
    <div class="segment">
      <button data-day="today" class="${state.day === 'today' ? 'active' : ''}">今日</button>
      <button data-day="tomorrow" class="${state.day === 'tomorrow' ? 'active' : ''}">明日</button>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-title">持ち物</div><div class="card-count">${total ? `${done}/${total}` : ''}</div></div>
      <div class="list">
        ${total ? state.tasks.map(task => `
          <div class="task ${task.done ? 'done' : ''}" data-id="${task.id}">
            <button class="check" data-action="toggle" aria-label="${task.done ? '未完了に戻す' : '完了'}">${task.done ? '✓' : ''}</button>
            <div><div class="task-text">${escapeHtml(task.text)}</div><div class="task-time">${task.date < localDate(0) ? `${escapeHtml(task.date.slice(5).replace('-', '/'))} ${escapeHtml(task.time)}・未完了` : `${escapeHtml(task.time)} に通知`}</div></div>
            <button class="task-menu" data-action="menu" aria-label="メニュー">⋯</button>
          </div>`).join('') : `
          <div class="empty">
            <div class="empty-icon">✓</div>
            <div class="empty-title">まだ何もありません</div>
            <div class="empty-sub">＋から、忘れたくないものを追加できます。</div>
          </div>`}
      </div>
    </div>
    ${total > 0 && done === total ? '<div class="complete"><span class="complete-dot">✓</span>準備完了！</div>' : ''}`;

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
  $content.innerHTML = `
    <div class="setting-card">
      <div class="setting-row">
        <div><div class="setting-main">通知</div><div class="setting-sub">指定時刻から、チェックするまで5分ごと</div></div>
        <button id="pushBtn" class="small-btn ${state.pushEnabled ? 'on' : ''}" ${!canPush ? 'disabled' : ''}>${state.pushEnabled ? 'ON' : 'OFF'}</button>
      </div>
      <div class="setting-row">
        <div><div class="setting-main">ログインID</div><div class="setting-sub">${escapeHtml(state.user.username)}</div></div>
      </div>
    </div>
    <button id="testPushBtn" class="secondary">テスト通知を送る</button>
    <button id="logoutBtn" class="secondary logout">ログアウト</button>
    <div class="note">iPhoneで通知を使う場合は、Safariでこのサイトを「ホーム画面に追加」してから通知をONにしてください。</div>`;
  if (canPush) document.querySelector('#pushBtn').addEventListener('click', togglePush);
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
