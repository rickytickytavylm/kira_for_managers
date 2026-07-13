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
  $("loginToken").value = state.token || "";
  $("loginBackend").value = state.backend || "";
  const err = $("loginError");
  if (msg) { err.textContent = msg; err.hidden = false; } else { err.hidden = true; }
}

async function doLogin() {
  const token = $("loginToken").value.trim();
  const backend = $("loginBackend").value.trim() || DEFAULT_BACKEND;
  if (!token) { showLogin("Введите ключ доступа."); return; }
  state.token = token;
  state.backend = backend;
  try {
    const who = await api("/admin/api/whoami");
    state.me = (who && who.name) || "";
    state.isAdmin = !!(who && who.is_admin);
    localStorage.setItem(LS.token, token);
    localStorage.setItem(LS.backend, backend);
    enterApp();
  } catch (e) {
    if (e.forbidden) showLogin("Неверный ключ доступа.");
    else showLogin("Не удалось подключиться к серверу. Проверьте адрес.");
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
    else if (owner) tag = `<span class="ci-tag other">${esc(owner)}</span>`;
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
  $("controlBadge").hidden = !manager;
  $("controlBadge").textContent = mine || !owner ? "Чат ведёте вы" : "Ведёт: " + owner;
  $("controlBadge").classList.toggle("other", !!(manager && owner && !mine));
  // Вернуть Кире может владелец лида или администратор.
  $("returnBtn").hidden = !(manager && (mine || !owner || state.isAdmin));
  const hint = $("managerHint");
  hint.hidden = !manager;
  hint.textContent = mine || !owner
    ? "Вы пишете клиенту как менеджер. Кира молчит, пока вы в диалоге."
    : `Чат ведёт ${owner}. Если напишете — лид перейдёт к вам.`;

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

function renderMessages(msgs) {
  const sc = $("scroll");
  sc.innerHTML = msgs.map((m) => {
    const r = roleOf(m);
    const body = (m.content || "").trim();
    if (r === "system") {
      if (!body) return "";
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
  const text = input.value.trim();
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
    alert("Не удалось отправить: " + e.message);
  } finally {
    btn.disabled = false;
    input.focus();
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

/* ── UI-мелочи ───────────────────────────────────────────────────────── */
function autoGrow() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 140) + "px";
}

function bindEvents() {
  $("loginBtn").addEventListener("click", doLogin);
  $("loginToken").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("logoutBtn").addEventListener("click", logout);
  $("refreshBtn").addEventListener("click", () => { loadList(); loadConversation(false); });
  $("returnBtn").addEventListener("click", returnToKira);
  $("sendBtn").addEventListener("click", sendMessage);
  $("backBtn").addEventListener("click", () => {
    $("app").classList.remove("viewing");
    state.currentId = null;
    setChatView(false);
    renderList();
  });

  const input = $("input");
  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  let searchDebounce = null;
  $("searchInput").addEventListener("input", (e) => {
    state.q = e.target.value.trim();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadList, 300);
  });

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
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

document.addEventListener("DOMContentLoaded", () => {
  registerPWA();
  bindEvents();
  if (state.token) {
    // Восстанавливаем сессию: проверяем ключ и узнаём, кто вошёл.
    (async () => {
      try {
        const who = await api("/admin/api/whoami");
        state.me = (who && who.name) || "";
        state.isAdmin = !!(who && who.is_admin);
        enterApp();
      } catch (e) {
        showLogin(e.forbidden ? "Ключ больше не подходит, войдите снова." : "");
      }
    })();
  } else {
    showLogin();
  }
});
