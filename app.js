"use strict";

/* ── Состояние и конфиг ──────────────────────────────────────────────── */
const DEFAULT_BACKEND = (window.CONSOLE_CONFIG || {}).BACKEND_URL || "";
const LS = {
  token: "mc_token",
  backend: "mc_backend",
};

const state = {
  token: localStorage.getItem(LS.token) || "",
  backend: localStorage.getItem(LS.backend) || DEFAULT_BACKEND,
  me: "",          // имя вошедшего продавца
  isAdmin: false,  // супер-доступ (ADMIN_SECRET)
  users: [],
  currentId: null,
  currentMsgCount: 0,
  filter: "all",
  q: "",
};

let listTimer = null;
let convTimer = null;

/* ── Хелперы ─────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

function backendBase() {
  return (state.backend || "").replace(/\/+$/, "");
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(backendBase() + path, {
    method,
    headers: {
      "X-Admin-Token": state.token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) {
    const err = new Error("forbidden");
    err.forbidden = true;
    throw err;
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (e) {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

function initials(name) {
  const n = (name || "?").trim();
  const parts = n.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_PALETTE = [
  ["#1a3347", "#0a84ff"],
  ["#1a3d2e", "#30d158"],
  ["#3d2e14", "#ff9f0a"],
  ["#3d1f1a", "#ff6961"],
  ["#2c2c2e", "#8e8e93"],
  ["#1a3535", "#64d2ff"],
  ["#2e2e1a", "#ffd60a"],
  ["#1f2e1a", "#32d74b"],
];

function avatarHash(name) {
  let h = 0;
  const s = name || "?";
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function avatarHtml(name, { size = "", dot = "" } = {}) {
  const init = initials(name);
  const [a, b] = AVATAR_PALETTE[avatarHash(name) % AVATAR_PALETTE.length];
  const cls = ["avatar", size && `avatar-${size}`].filter(Boolean).join(" ");
  const dotHtml = dot ? `<span class="dot ${dot}"></span>` : "";
  return `<div class="${cls}" style="--av-a:${a};--av-b:${b}"><span class="avatar-text">${esc(init)}</span>${dotHtml}</div>`;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function esc(s) {
  return (s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function isWaiting(u) {
  if (!u.last_user_message_at) return false;
  if (!u.last_assistant_message_at) return true;
  return new Date(u.last_user_message_at) > new Date(u.last_assistant_message_at);
}

/* ── Вход / выход ────────────────────────────────────────────────────── */
function showLogin(msg) {
  stopPolling();
  $("app").hidden = true;
  $("login").hidden = false;
  $("login").classList.remove("is-welcome", "is-leaving");
  const card = $("loginCard");
  const copy = $("loginHeroCopy");
  const welcome = $("loginWelcome");
  if (card) card.hidden = false;
  if (copy) copy.hidden = false;
  if (welcome) welcome.hidden = true;
  $("loginToken").value = state.token || "";
  $("loginBtn").disabled = false;
  const err = $("loginError");
  if (msg) { err.textContent = msg; err.hidden = false; } else { err.hidden = true; }
}

function firstName(full) {
  const n = (full || "").trim();
  if (!n) return "друг";
  if (n === "Администратор") return "Администратор";
  return n.split(/\s+/)[0];
}

function playWelcomeThenEnter() {
  const name = firstName(state.me);
  const card = $("loginCard");
  const copy = $("loginHeroCopy");
  const welcome = $("loginWelcome");
  const welcomeName = $("welcomeName");
  if (welcomeName) welcomeName.textContent = "Приветствую, " + name;
  if (card) card.hidden = true;
  if (copy) copy.hidden = true;
  if (welcome) welcome.hidden = false;
  $("login").classList.add("is-welcome");

  // Перезапуск SVG-анимации
  const svg = welcome && welcome.querySelector(".login-welcome-svg");
  if (svg) {
    const clone = svg.cloneNode(true);
    svg.parentNode.replaceChild(clone, svg);
  }

  window.setTimeout(() => {
    $("login").classList.add("is-leaving");
    window.setTimeout(() => enterApp(), 420);
  }, 2100);
}

async function doLogin() {
  const token = $("loginToken").value.trim();
  const backend = DEFAULT_BACKEND;
  if (!token) { showLogin("Введите ключ доступа."); return; }
  const btn = $("loginBtn");
  btn.disabled = true;
  btn.textContent = "Проверка…";
  state.token = token;
  state.backend = backend;
  try {
    const who = await api("/admin/api/whoami");
    state.me = (who && who.name) || "";
    state.isAdmin = !!(who && who.is_admin);
    localStorage.setItem(LS.token, token);
    localStorage.setItem(LS.backend, backend);
    btn.textContent = "Войти";
    playWelcomeThenEnter();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Войти";
    if (e.forbidden) showLogin("Неверный ключ доступа.");
    else showLogin("Не удалось подключиться к серверу.");
  }
}

function logout() {
  localStorage.removeItem(LS.token);
  state.token = "";
  state.me = "";
  state.isAdmin = false;
  state.currentId = null;
  showLogin();
}

function setMe() {
  const el = $("meName");
  if (el) el.textContent = state.me ? (state.isAdmin ? state.me + " · все лиды" : state.me) : "";
}

function enterApp() {
  $("login").hidden = true;
  $("app").hidden = false;
  setMe();
  loadList();
  startPolling();
}

/* ── Список диалогов ─────────────────────────────────────────────────── */
async function loadList() {
  try {
    const data = await api("/admin/api/users?q=" + encodeURIComponent(state.q));
    state.users = data.users || [];
    renderList();
  } catch (e) {
    if (e.forbidden) logout();
  }
}

function filteredUsers() {
  return state.users.filter((u) => {
    if (state.filter === "unassigned") return !u.assigned_manager;
    if (state.filter === "mine") return u.assigned_manager && u.assigned_manager === state.me;
    if (state.filter === "waiting") return isWaiting(u);
    return true;
  });
}

function renderList() {
  const box = $("chatList");
  const list = filteredUsers();
  if (!list.length) {
    box.innerHTML = '<div class="list-empty">Ничего не найдено</div>';
    return;
  }
  box.innerHTML = list.map((u) => {
    const active = u.id === state.currentId ? " is-active" : "";
    const owner = u.assigned_manager || "";
    const mine = owner && owner === state.me;
    const waiting = isWaiting(u);
    let dotClass = "";
    if (owner) dotClass = "manager";
    else if (waiting) dotClass = "waiting";
    const uname = u.telegram_username ? "@" + u.telegram_username : (u.phone || "");
    let tag = "";
    if (mine) tag = '<span class="ci-tag manager">на мне</span>';
    else if (owner) tag = `<span class="ci-tag other" title="${esc(owner)}">${esc(owner)}</span>`;
    else if (waiting) tag = '<span class="ci-tag">ждёт</span>';
    const last = u.last_message_at || u.updated_at;
    const displayName = u.display_name || "Гость";
    return `
      <div class="chat-item${active}" data-id="${u.id}">
        ${avatarHtml(displayName, { dot: dotClass })}
        <div class="ci-body">
          <div class="ci-name">${esc(displayName)}</div>
          <div class="ci-last">${esc(uname || u.current_stage || "")}</div>
        </div>
        <div class="ci-side">
          <span class="ci-time">${fmtTime(last)}</span>
          ${tag}
        </div>
      </div>`;
  }).join("");

  box.querySelectorAll(".chat-item").forEach((el) => {
    el.addEventListener("click", () => openConversation(Number(el.dataset.id)));
  });
}

/* ── Переписка ───────────────────────────────────────────────────────── */
function setChatView(open) {
  const main = $("main");
  if (open) {
    main.classList.add("is-chat");
    $("emptyState").setAttribute("hidden", "");
    $("conversation").removeAttribute("hidden");
  } else {
    main.classList.remove("is-chat");
    $("emptyState").removeAttribute("hidden");
    $("conversation").setAttribute("hidden", "");
  }
}

async function openConversation(id) {
  state.currentId = id;
  state.currentMsgCount = 0;
  $("app").classList.add("viewing");
  setChatView(true);
  renderList();
  await loadConversation(true);
}

async function loadConversation(scrollBottom) {
  const id = state.currentId;
  if (!id) return;
  let data;
  try {
    data = await api("/admin/api/users/" + id);
  } catch (e) {
    if (e.forbidden) logout();
    return;
  }
  if (state.currentId !== id) return; // переключились, пока грузили
  const u = data.user || {};
  const msgs = data.messages || [];

  const displayName = u.display_name || "Гость";
  $("convName").textContent = displayName;
  const avWrap = $("convAvatarWrap");
  if (avWrap) avWrap.innerHTML = avatarHtml(displayName, { size: "sm" });
  const metaBits = [];
  if (u.telegram_username) metaBits.push("@" + u.telegram_username);
  if (u.phone) metaBits.push(u.phone);
  if (u.current_stage) metaBits.push(u.current_stage);
  $("convMeta").textContent = metaBits.join(" · ") || "—";

  const manager = u.chat_control === "manager";
  const owner = u.assigned_manager || "";
  const mine = owner && owner === state.me;
  const canControl = state.isAdmin || !owner || mine;
  const canReturn = state.isAdmin || mine;
  const canWrite = canControl;
  $("controlBadge").hidden = !(manager || owner);
  if (owner && !canControl) {
    $("controlBadge").textContent = "Ведёт: " + owner;
  } else if (manager && canControl) {
    $("controlBadge").textContent = "Чат ведёте вы";
  } else if (owner && mine) {
    $("controlBadge").textContent = "Чат ведёте вы";
  } else {
    $("controlBadge").textContent = "";
  }
  $("controlBadge").classList.toggle("other", !!(manager && owner && !mine));
  // Вернуть Кире может владелец лида или администратор.
  $("returnBtn").hidden = !(manager && canReturn);
  const hint = $("managerHint");
  if (!canWrite) {
    hint.hidden = false;
    hint.textContent = `Лид закреплён за менеджером: ${owner}. У вас нет доступа к этому чату.`;
  } else if (manager) {
    hint.hidden = false;
    hint.textContent = "Вы пишете клиенту как менеджер. Кира молчит, пока вы в диалоге.";
  } else {
    hint.hidden = true;
  }

  // Блокируем ввод, если лид занят другим продавцом (админ — может).
  const input = $("input");
  const sendBtn = $("sendBtn");
  if (input) {
    input.disabled = !canWrite;
    input.placeholder = canWrite ? "Сообщение клиенту…" : "Лид занят другим менеджером";
  }
  if (sendBtn) sendBtn.disabled = !canWrite;

  // Перерисовываем ленту только если что-то изменилось (чтобы не дёргать при поллинге)
  if (msgs.length !== state.currentMsgCount) {
    renderMessages(msgs);
    state.currentMsgCount = msgs.length;
    scrollBottom = true;
  }
  if (scrollBottom) {
    const sc = $("scroll");
    sc.scrollTop = sc.scrollHeight;
  }
}

function roleOf(m) {
  if (m.role === "user") return "client";
  if (m.role === "system") return "system";
  if (m.role === "assistant" && m.model_used === "manager") return "manager";
  return "kira";
}

function parseSystemEvent(text) {
  const t = (text || "").trim();
  if (!t) return null;

  // New format: "Подключился менеджер: Имя"
  let m = t.match(/^Подключился менеджер(?::\s*(.+))?$/i);
  if (m) return { type: "manager_join", name: (m[1] || "").trim() };

  // Legacy format: "[менеджер подключился к диалогу: Имя]"
  m = t.match(/^\[\s*менеджер\s+подключился\s+к\s+диалогу(?::\s*(.+?))?\s*\]$/i);
  if (m) return { type: "manager_join", name: (m[1] || "").trim() };

  return null;
}

function renderMessages(msgs) {
  const sc = $("scroll");
  sc.innerHTML = msgs.map((m) => {
    const r = roleOf(m);
    const body = (m.content || "").trim();
    if (r === "system") {
      if (!body) return "";
      const ev = parseSystemEvent(body);
      if (ev && ev.type === "manager_join") {
        const who = ev.name || "менеджер";
        const time = fmtTime(m.created_at);
        return `
          <div class="msg-event msg-event--join">
            <div class="msg-event-card">
              <div class="msg-event-ico" aria-hidden="true">
                <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
              </div>
              <div class="msg-event-text">
                <div class="msg-event-title">Подключился менеджер</div>
                <div class="msg-event-sub">${esc(who)}</div>
              </div>
              <time class="msg-event-time">${time}</time>
            </div>
          </div>`;
      }
      return `<div class="msg-system"><span>${esc(body)}</span></div>`;
    }
    if (!body) return "";
    const who = r === "client" ? "Клиент" : (r === "manager" ? "Менеджер" : "Кира");
    const time = fmtTime(m.created_at);
    return `
      <div class="msg msg--${r}">
        <div class="msg-head">
          <span class="msg-who">${who}</span>
          <time class="msg-time">${time}</time>
        </div>
        <div class="msg-body">${esc(body)}</div>
      </div>`;
  }).join("");
}

/* ── Отправка / возврат ──────────────────────────────────────────────── */
async function sendMessage() {
  const input = $("input");
  if (!input || input.disabled) return;
  const text = (input.value || "").trim();
  if (!text || !state.currentId) return;
  const btn = $("sendBtn");
  btn.disabled = true;
  try {
    await api("/admin/api/users/" + state.currentId + "/send", {
      method: "POST",
      body: { text },
    });
    input.value = "";
    autoGrow();
    await loadConversation(true);
    loadList();
  } catch (e) {
    const msg = String(e.message || "");
    if (/owned by/i.test(msg)) {
      alert("Этот лид уже забрал другой менеджер. Вам сюда писать нельзя.");
      await loadConversation(false);
      loadList();
    } else {
      alert("Не удалось отправить: " + msg);
    }
  } finally {
    if (!input.disabled) btn.disabled = false;
    if (!input.disabled) input.focus();
  }
}

async function returnToKira() {
  if (!state.currentId) return;
  if (!confirm("Вернуть управление Кире? Она снова начнёт отвечать этому клиенту.")) return;
  try {
    await api("/admin/api/users/" + state.currentId + "/return-to-kira", { method: "POST" });
    await loadConversation(false);
    loadList();
  } catch (e) {
    alert("Ошибка: " + e.message);
  }
}

/* ── Поллинг ─────────────────────────────────────────────────────────── */
function startPolling() {
  stopPolling();
  listTimer = setInterval(loadList, 5000);
  convTimer = setInterval(() => loadConversation(false), 3000);
}
function stopPolling() {
  if (listTimer) clearInterval(listTimer);
  if (convTimer) clearInterval(convTimer);
  listTimer = convTimer = null;
}

/* ── Профиль ─────────────────────────────────────────────────────────── */
const RING_C = 2 * Math.PI * 52;

function calcStats() {
  const users = state.users || [];
  let mine = 0, waiting = 0, free = 0;
  for (const u of users) {
    const owner = u.assigned_manager || "";
    if (owner && owner === state.me) mine += 1;
    if (!owner) free += 1;
    if (isWaiting(u)) waiting += 1;
  }
  return { mine, waiting, free, all: users.length };
}

function setRing(el, fraction, offsetStart) {
  if (!el) return;
  const pct = Math.max(0, Math.min(1, fraction || 0));
  const len = RING_C * pct;
  el.style.strokeDasharray = `${len} ${RING_C}`;
  el.style.strokeDashoffset = String(-(RING_C * (offsetStart || 0)));
}

function renderProfile() {
  const stats = calcStats();
  const name = state.me || "Менеджер";
  $("profileHi").textContent = "Привет, " + name;
  $("profileRole").textContent = state.isAdmin ? "Администратор · все лиды" : "Менеджер";
  $("statMine").textContent = String(stats.mine);
  $("statWaiting").textContent = String(stats.waiting);
  $("statFree").textContent = String(stats.free);
  $("statAll").textContent = String(stats.all);

  const av = $("profileAvatar");
  if (av) av.innerHTML = avatarHtml(name, { size: "lg" });

  const total = Math.max(stats.all, 1);
  const mineF = stats.mine / total;
  const waitF = stats.waiting / total;
  setRing($("profileRingMine"), mineF, 0);
  setRing($("profileRingWait"), waitF, mineF);
}

function openProfile() {
  renderProfile();
  $("profileSheet").hidden = false;
  document.body.classList.add("profile-open");
}

function closeProfile() {
  $("profileSheet").hidden = true;
  document.body.classList.remove("profile-open");
}

/* ── UI-мелочи ───────────────────────────────────────────────────────── */
function autoGrow() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 140) + "px";
}

function bindEvents() {
  const on = (id, event, fn) => {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
  };
  on("loginBtn", "click", doLogin);
  on("loginToken", "keydown", (e) => { if (e.key === "Enter") doLogin(); });
  on("logoutBtn", "click", logout);
  on("refreshBtn", "click", () => { loadList(); loadConversation(false); });
  on("profileBtn", "click", openProfile);
  on("profileClose", "click", closeProfile);
  on("profileBackdrop", "click", closeProfile);
  on("returnBtn", "click", returnToKira);
  on("sendBtn", "click", sendMessage);
  on("backBtn", "click", () => {
    $("app").classList.remove("viewing");
    state.currentId = null;
    setChatView(false);
    renderList();
  });

  const input = $("input");
  if (input) {
    input.addEventListener("input", autoGrow);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
  }

  let searchDebounce = null;
  const search = $("searchInput");
  if (search) {
    search.addEventListener("input", (e) => {
      state.q = e.target.value.trim();
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(loadList, 300);
    });
  }

  document.querySelectorAll(".chip-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".chip-filter").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.filter = btn.dataset.filter;
      renderList();
    });
  });
}

/* ── Старт ───────────────────────────────────────────────────────────── */
function registerPWA() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js?v=7").catch(() => {});
  });
}

async function restoreSession() {
  const err = $("loginError");
  if (err) {
    err.textContent = "Подключение…";
    err.hidden = false;
  }
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) {} }, 8000);
  try {
    const res = await fetch(backendBase() + "/admin/api/whoami", {
      headers: { "X-Admin-Token": state.token },
      signal: ctrl ? ctrl.signal : undefined,
    });
    clearTimeout(timer);
    if (res.status === 403) {
      showLogin("Ключ больше не подходит, войдите снова.");
      return;
    }
    if (!res.ok) {
      showLogin("Сервер временно недоступен. Попробуйте ещё раз.");
      return;
    }
    const who = await res.json();
    state.me = (who && who.name) || "";
    state.isAdmin = !!(who && who.is_admin);
    enterApp();
  } catch (e) {
    clearTimeout(timer);
    showLogin("Не удалось подключиться к серверу. Проверьте интернет.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    registerPWA();
    bindEvents();
    showLogin();
    if (state.token) restoreSession();
  } catch (e) {
    console.error(e);
    try { showLogin("Ошибка интерфейса. Обновите страницу."); } catch (e2) {}
  }
});
