"use strict";

/* ── Состояние и конфиг ──────────────────────────────────────────────── */
const DEFAULT_BACKEND = (window.CONSOLE_CONFIG || {}).BACKEND_URL || "";
const DEFAULT_VAPID = (window.CONSOLE_CONFIG || {}).VAPID_PUBLIC_KEY || "";
const LS = {
  token: "mc_token",
  backend: "mc_backend",
  pushOk: "mc_push_ok",
  seen: "mc_seen",
};

function loadSeen() {
  try {
    return JSON.parse(localStorage.getItem(LS.seen) || "{}") || {};
  } catch (_) {
    return {};
  }
}

const state = {
  token: localStorage.getItem(LS.token) || "",
  backend: localStorage.getItem(LS.backend) || DEFAULT_BACKEND,
  me: "",
  role: "seller", // admin|seller|marketing|head
  isAdmin: false,
  readOnly: false, // marketing|head — просмотр чатов без ответа
  pushEnabled: false,
  vapidPublicKey: DEFAULT_VAPID,
  users: [],
  currentId: null,
  currentMsgCount: 0,
  convLoading: false,
  scope: "all", // all|mine — tumbler над списком
  q: "",
  statsPeriod: "7d",
  stats: null,
  pushTested: false,
  products: null,
  productsLoading: false,
  seen: loadSeen(),
  pendingChatId: null,
};

let listTimer = null;
let convTimer = null;
let dashTimer = null;

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

function applyWhoami(who) {
  state.me = (who && who.name) || "";
  state.role = (who && who.role) || "seller";
  state.isAdmin = !!(who && who.is_admin) || state.role === "admin";
  state.readOnly = isDashboardRole(state.role);
  state.pushEnabled = !!(who && who.push_enabled);
  const fromServer = (who && who.vapid_public_key) || "";
  state.vapidPublicKey = isValidVapidPublicKey(fromServer) ? fromServer : DEFAULT_VAPID;
}

function isDashboardRole(role) {
  return role === "marketing" || role === "head";
}

function isSellerLike(role) {
  return role === "seller" || role === "admin";
}

function roleSubtitle(role) {
  if (role === "admin") return "Админ · все лиды";
  if (role === "marketing") return "Маркетинг";
  if (role === "head") return "Руководитель";
  return "Менеджер";
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

function lastActivityAt(u) {
  return u.last_message_at || u.last_user_message_at || u.updated_at || null;
}

/* Непрочитанное: клиент написал новее, чем менеджер в последний раз открывал чат. */
function isUnread(u) {
  const owner = u.assigned_manager || "";
  if (!(owner && owner === state.me)) return false;
  if (!isWaiting(u)) return false;
  const last = u.last_user_message_at;
  if (!last) return false;
  const seen = state.seen[u.id];
  if (!seen) return true;
  return new Date(last) > new Date(seen);
}

function markSeen(id, ts) {
  if (!id) return;
  const stamp = ts || new Date().toISOString();
  const prev = state.seen[id];
  if (prev && new Date(prev) >= new Date(stamp)) return;
  state.seen[id] = stamp;
  try { localStorage.setItem(LS.seen, JSON.stringify(state.seen)); } catch (_) {}
}

function isStandalonePwa() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function urlBase64ToUint8Array(base64String) {
  const cleaned = String(base64String || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
  const padding = "=".repeat((4 - (cleaned.length % 4)) % 4);
  const base64 = (cleaned + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isValidVapidPublicKey(key) {
  try {
    const bytes = urlBase64ToUint8Array(key);
    // Uncompressed P-256 point: 0x04 + 32 + 32
    return bytes.length === 65 && bytes[0] === 0x04;
  } catch (_) {
    return false;
  }
}

function resolveVapidPublicKey() {
  const candidates = [state.vapidPublicKey, DEFAULT_VAPID];
  for (const key of candidates) {
    if (key && isValidVapidPublicKey(key)) {
      return String(key).trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
    }
  }
  return "";
}

/* ── Вход / выход ────────────────────────────────────────────────────── */
function showBooting() {
  // Сплэш при восстановлении сессии: заголовок + спиннер вместо мелькающей формы.
  stopPolling();
  stopDashPolling();
  $("app").hidden = true;
  const dash = $("dashboard");
  if (dash) dash.hidden = true;
  $("login").hidden = false;
  $("login").classList.remove("is-welcome", "is-leaving", "is-push");
  const card = $("loginCard");
  const copy = $("loginHeroCopy");
  const welcome = $("loginWelcome");
  const push = $("loginPush");
  const booting = $("loginBooting");
  if (card) card.hidden = true;
  if (copy) copy.hidden = false;
  if (welcome) welcome.hidden = true;
  if (push) push.hidden = true;
  if (booting) booting.hidden = false;
  const err = $("loginError");
  if (err) err.hidden = true;
}

function showLogin(msg) {
  stopPolling();
  stopDashPolling();
  $("app").hidden = true;
  const dash = $("dashboard");
  if (dash) dash.hidden = true;
  $("login").hidden = false;
  $("login").classList.remove("is-welcome", "is-leaving", "is-push");
  const card = $("loginCard");
  const copy = $("loginHeroCopy");
  const welcome = $("loginWelcome");
  const push = $("loginPush");
  const booting = $("loginBooting");
  if (card) card.hidden = false;
  if (copy) copy.hidden = false;
  if (welcome) welcome.hidden = true;
  if (push) push.hidden = true;
  if (booting) booting.hidden = true;
  resetPushGateUi();
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

function leaveLoginAndEnter() {
  $("login").classList.add("is-leaving");
  window.setTimeout(() => {
    if (isDashboardRole(state.role)) enterDashboard();
    else enterApp();
  }, 420);
}

async function afterWelcome() {
  const needPush = await shouldShowPushGate();
  if (needPush) {
    showPushGate();
    return;
  }
  leaveLoginAndEnter();
}

function playWelcomeThenEnter() {
  const name = firstName(state.me);
  const card = $("loginCard");
  const copy = $("loginHeroCopy");
  const welcome = $("loginWelcome");
  const push = $("loginPush");
  const welcomeName = $("welcomeName");
  const booting = $("loginBooting");
  if (welcomeName) welcomeName.textContent = "Приветствую, " + name;
  if (card) card.hidden = true;
  if (copy) copy.hidden = true;
  if (push) push.hidden = true;
  if (booting) booting.hidden = true;
  if (welcome) welcome.hidden = false;
  $("login").classList.remove("is-push");
  $("login").classList.add("is-welcome");

  const svg = welcome && welcome.querySelector(".login-welcome-svg");
  if (svg) {
    const clone = svg.cloneNode(true);
    svg.parentNode.replaceChild(clone, svg);
  }

  window.setTimeout(() => {
    afterWelcome();
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
    applyWhoami(who);
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
  state.role = "seller";
  state.isAdmin = false;
  state.currentId = null;
  state.stats = null;
  showLogin();
}

function setMe() {
  const el = $("meName");
  if (!el) return;
  if (!state.me) {
    el.textContent = "";
    return;
  }
  el.textContent = state.me + " · " + roleSubtitle(state.role);
}

function setDashMe() {
  const el = $("dashMe");
  if (!el) return;
  if (!state.me) {
    el.textContent = "";
    return;
  }
  el.textContent = state.me + " · " + roleSubtitle(state.role);
}

function enterApp() {
  $("login").hidden = true;
  const dash = $("dashboard");
  if (dash) dash.hidden = true;
  $("app").hidden = false;
  document.body.classList.remove("dash-mode");
  document.body.classList.add("app-mode");
  document.body.classList.toggle("readonly-mode", state.readOnly);
  stopDashPolling();
  // Для маркетинга/руководителя — только просмотр: без «Мои», зато с табами раздела.
  const scope = $("sideScope");
  const tabs = $("appTabs");
  if (scope) scope.hidden = state.readOnly;
  if (tabs) tabs.hidden = !state.readOnly;
  const profileBtn = $("profileBtn");
  if (profileBtn) profileBtn.hidden = state.readOnly;
  if (state.readOnly) state.scope = "all";
  setMe();
  syncScopeUi();
  loadList();
  startPolling();
}

function enterDashboard() {
  $("login").hidden = true;
  $("app").hidden = true;
  const dash = $("dashboard");
  if (dash) dash.hidden = false;
  document.body.classList.remove("app-mode");
  document.body.classList.add("dash-mode");
  stopPolling();
  location.hash = "dashboard";
  setDashMe();
  const ringsTitle = $("dashRingsTitle");
  const mgrTitle = $("dashManagersTitle");
  if (state.role === "head") {
    if (ringsTitle) ringsTitle.textContent = "Обзор";
    if (mgrTitle) mgrTitle.textContent = "Рейтинг менеджеров";
  } else {
    if (ringsTitle) ringsTitle.textContent = "Воронка и передачи";
    if (mgrTitle) mgrTitle.textContent = "Менеджеры";
  }
  syncViewTabs("analytics");
  loadDashboard();
  startDashPolling();
}

function syncViewTabs(view) {
  document.querySelectorAll(".dash-tab, #appTabs .scope-btn").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function setView(view) {
  if (view === "chats") {
    stopDashPolling();
    enterApp();
    syncViewTabs("chats");
  } else {
    enterDashboard();
  }
}

/* ── Push onboarding (PWA + sellers) ─────────────────────────────────── */
function resetPushGateUi() {
  state.pushTested = false;
  const toggle = $("pushToggle");
  const btn = $("pushTestBtn");
  const hint = $("pushHint");
  if (toggle) {
    toggle.checked = false;
    toggle.disabled = false;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Тест";
  }
  if (hint) {
    hint.hidden = true;
    hint.textContent = "";
  }
}

async function getExistingPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch (e) {
    return null;
  }
}

async function shouldShowPushGate() {
  // Только продавцы + только установленное PWA (не вкладка браузера)
  if (state.role !== "seller") return false;
  if (!isStandalonePwa()) return false;
  if (!state.pushEnabled && !state.vapidPublicKey) return false;

  const permission =
    typeof Notification !== "undefined" ? Notification.permission : "denied";

  // Если в системе отказали / сняли разрешение — снова требуем онбординг.
  if (permission !== "granted") {
    localStorage.removeItem(LS.pushOk);
    return true;
  }

  const sub = await getExistingPushSubscription();
  if (!sub) {
    localStorage.removeItem(LS.pushOk);
    return true;
  }

  // Разрешение есть и подписка жива — пускаем без окна.
  localStorage.setItem(LS.pushOk, "1");
  return false;
}

function showPushGate() {
  const card = $("loginCard");
  const copy = $("loginHeroCopy");
  const welcome = $("loginWelcome");
  const push = $("loginPush");
  const booting = $("loginBooting");
  if (card) card.hidden = true;
  if (copy) copy.hidden = true;
  if (welcome) welcome.hidden = true;
  if (push) push.hidden = false;
  if (booting) booting.hidden = true;
  $("login").classList.remove("is-leaving");
  $("login").classList.add("is-push");
  resetPushGateUi();
}

function setPushHint(text, isError) {
  const hint = $("pushHint");
  if (!hint) return;
  if (!text) {
    hint.hidden = true;
    hint.textContent = "";
    return;
  }
  hint.hidden = false;
  hint.textContent = text;
  hint.classList.toggle("is-error", !!isError);
}

async function ensurePushSubscription() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Уведомления не поддерживаются на этом устройстве");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Разрешение на уведомления не выдано");
  }
  const key = resolveVapidPublicKey();
  if (!key) throw new Error("VAPID-ключ не настроен или повреждён. Проверьте VAPID_PUBLIC_KEY на сервере.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    try { await sub.unsubscribe(); } catch (_) {}
    sub = null;
  }
  sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  await api("/admin/api/push/subscribe", {
    method: "POST",
    body: {
      subscription: sub.toJSON ? sub.toJSON() : sub,
      userAgent: navigator.userAgent || "",
    },
  });
  return sub;
}

async function onPushToggleChange() {
  const toggle = $("pushToggle");
  const btn = $("pushTestBtn");
  if (!toggle || !btn) return;
  if (!toggle.checked) {
    btn.disabled = true;
    btn.textContent = "Тест";
    state.pushTested = false;
    setPushHint("");
    return;
  }
  toggle.disabled = true;
  setPushHint("Подключаем уведомления…");
  try {
    await ensurePushSubscription();
    setPushHint("Уведомления включены. Нажмите «Тест».");
    btn.disabled = false;
    btn.textContent = "Тест";
    state.pushTested = false;
  } catch (e) {
    toggle.checked = false;
    btn.disabled = true;
    setPushHint(String(e.message || e), true);
  } finally {
    toggle.disabled = false;
  }
}

async function onPushTestOrNext() {
  const btn = $("pushTestBtn");
  if (!btn || btn.disabled) return;
  if (state.pushTested || btn.textContent === "Далее") {
    localStorage.setItem(LS.pushOk, "1");
    leaveLoginAndEnter();
    return;
  }
  btn.disabled = true;
  btn.textContent = "Отправка…";
  setPushHint("Отправляем тестовое уведомление…");
  try {
    await api("/admin/api/push/test", { method: "POST" });
    state.pushTested = true;
    btn.textContent = "Далее";
    btn.disabled = false;
    setPushHint("Готово. Если пуш пришёл — жмите «Далее».");
  } catch (e) {
    btn.textContent = "Тест";
    btn.disabled = false;
    setPushHint("Не удалось отправить тест: " + (e.message || e), true);
  }
}

/* ── Список диалогов ─────────────────────────────────────────────────── */
async function loadList() {
  try {
    const data = await api("/admin/api/users?q=" + encodeURIComponent(state.q));
    state.users = data.users || [];
    renderList();
    if (state.pendingChatId != null) {
      const id = state.pendingChatId;
      state.pendingChatId = null;
      if (state.users.some((u) => u.id === id)) openConversation(id);
    }
  } catch (e) {
    if (e.forbidden) logout();
  }
}

function isClosedDeal(u) {
  const st = (u.deal_status || "").toLowerCase();
  return st === "won" || st === "lost";
}

function filteredUsers() {
  return state.users.filter((u) => {
    const owner = (u.assigned_manager || "").trim();
    const mine = owner && owner === state.me;
    // Маркетинг/руководитель — просмотр всех чатов.
    if (state.readOnly) return true;
    // Завершённые сделки (выиграна/проиграна в amoCRM) убираем из рабочих
    // списков, чтобы не засорять активную работу. Открытый сейчас чат оставляем.
    if (isClosedDeal(u) && u.id !== state.currentId) return false;
    if (state.scope === "mine") return mine;
    // «Все»: свободные диалоги (ведёт Кира) + свои закреплённые. Чат, забранный
    // ДРУГИМ менеджером, из «Все» пропадает. Админ видит вообще всё.
    if (state.isAdmin) return true;
    return !owner || mine;
  });
}

function syncScopeUi() {
  document.querySelectorAll("#sideScope .scope-btn").forEach((b) => {
    const on = b.dataset.scope === state.scope;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function setScope(scope) {
  state.scope = scope;
  syncScopeUi();
  renderList();
}

function renderList() {
  const box = $("chatList");
  if (!box) return;
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
    const unread = isUnread(u) && u.id !== state.currentId;
    let dotClass = "";
    if (owner) dotClass = "manager";
    else if (waiting) dotClass = "waiting";
    const uname = u.telegram_username ? "@" + u.telegram_username : (u.phone || "");
    const paid = (u.deal_status || "").toLowerCase() === "won";
    let tag = "";
    if (paid) tag = '<span class="ci-tag paid">оплачено</span>';
    else if (mine) tag = '<span class="ci-tag manager">на мне</span>';
    else if (owner) tag = `<span class="ci-tag other" title="${esc(owner)}">${esc(firstName(owner))}</span>`;
    else if (waiting) tag = '<span class="ci-tag">ждёт</span>';
    const badge = unread ? '<span class="ci-unread" aria-label="новое сообщение"></span>' : "";
    const last = lastActivityAt(u);
    const displayName = u.display_name || "Гость";
    return `
      <div class="chat-item${active}${unread ? " is-unread" : ""}" data-id="${u.id}">
        ${avatarHtml(displayName, { dot: dotClass })}
        <div class="ci-body">
          <div class="ci-name">${esc(displayName)}</div>
          <div class="ci-last">${esc(uname || u.current_stage || "")}</div>
        </div>
        <div class="ci-side">
          <span class="ci-time">${fmtTime(last)}</span>
          ${badge || tag}
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
  if (state.convLoading) return; // не даём поллингу наложиться на активную загрузку
  state.convLoading = true;
  let data;
  try {
    data = await api("/admin/api/users/" + id);
  } catch (e) {
    if (e.forbidden) logout();
    return;
  } finally {
    state.convLoading = false;
  }
  if (state.currentId !== id) return;
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

  const readOnly = state.readOnly;
  const manager = u.chat_control === "manager";
  const owner = u.assigned_manager || "";
  const mine = owner && owner === state.me;
  const canControl = !readOnly && (state.isAdmin || !owner || mine);
  const canReturn = !readOnly && (state.isAdmin || mine);
  const canWrite = canControl;
  $("controlBadge").hidden = !(manager || owner);
  if (owner && !canControl) {
    $("controlBadge").textContent = "Ведёт: " + firstName(owner);
  } else if (manager && canControl) {
    $("controlBadge").textContent = "Чат ведёте вы";
  } else if (owner && mine) {
    $("controlBadge").textContent = "Чат ведёте вы";
  } else {
    $("controlBadge").textContent = "";
  }
  $("controlBadge").classList.toggle("other", !!(owner && !mine));
  $("returnBtn").hidden = !(manager && canReturn);

  const hint = $("managerHint");
  const notice = $("readonlyNotice");
  const row = $("conversation").querySelector(".composer-row");
  const input = $("input");
  const sendBtn = $("sendBtn");
  if (readOnly) {
    if (notice) notice.hidden = false;
    if (hint) hint.hidden = true;
    if (row) row.hidden = true;
    setProductPickerVisible(false);
  } else {
    if (notice) notice.hidden = true;
    if (row) row.hidden = false;
    if (!canWrite) {
      hint.hidden = false;
      hint.textContent = `Лид закреплён за менеджером: ${owner}. У вас нет доступа к этому чату.`;
    } else {
      // «Кира молчит…» теперь показывается звёздочкой под карточкой события.
      hint.hidden = true;
    }
    const showProducts = !!(manager && canWrite);
    setProductPickerVisible(showProducts);
    if (showProducts) ensureProductsLoaded();
    if (input) {
      input.disabled = !canWrite;
      input.placeholder = canWrite ? "Сообщение клиенту…" : "Лид занят другим менеджером";
    }
    if (sendBtn) sendBtn.disabled = !canWrite;
  }

  if (msgs.length !== state.currentMsgCount) {
    const sc = $("scroll");
    // Расстояние до низа ДО перерисовки: если менеджер читал внизу — держим низ,
    // если отмотал вверх — сохраняем позицию и не «дёргаем» экран вниз.
    const fromBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    const wasNearBottom = fromBottom < 120;
    renderMessages(msgs);
    state.currentMsgCount = msgs.length;
    if (scrollBottom || wasNearBottom) {
      sc.scrollTop = sc.scrollHeight;
    } else {
      sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - fromBottom);
    }
  } else if (scrollBottom) {
    const sc = $("scroll");
    sc.scrollTop = sc.scrollHeight;
  }

  // Отметить чат прочитанным: клиент больше не «висит непрочитанным» в «Мои».
  if (msgs.length) {
    const lastAt = msgs[msgs.length - 1].created_at;
    if (lastAt) markSeen(id, lastAt);
  } else {
    markSeen(id);
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

  let m = t.match(/^Решение Киры\s*[—\-]\s*(?:позвать\s+)?менеджера(?::\s*(.+))?$/i);
  if (m) return { type: "manager_join", name: (m[1] || "").trim() };

  m = t.match(/^Подключился менеджер(?::\s*(.+))?$/i);
  if (m) return { type: "manager_join", name: (m[1] || "").trim() };

  m = t.match(/^\[\s*менеджер\s+подключился\s+к\s+диалогу(?::\s*(.+?))?\s*\]$/i);
  if (m) return { type: "manager_join", name: (m[1] || "").trim() };

  m = t.match(/^Кира вернулась в чат(?:\s*\((.+?)\))?$/i);
  if (m) {
    const inside = (m[1] || "").trim();
    if (/^авто/i.test(inside)) return { type: "kira_return", auto: true };
    return { type: "kira_return", name: inside.replace(/^вернул:\s*/i, "").trim() };
  }

  m = t.match(/^Вернулась Кира(?:\s*\(вернул:\s*(.+?)\))?$/i);
  if (m) return { type: "kira_return", name: (m[1] || "").trim() };

  return null;
}

function renderEventCard({ type, title, sub, time, note }) {
  const isKira = type === "kira_return";
  const ico = isKira
    ? `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a4 4 0 0 1 4 4v1h1a3 3 0 0 1 0 6h-1v1a4 4 0 0 1-8 0v-1H7a3 3 0 0 1 0-6h1V7a4 4 0 0 1 4-4z"/><circle cx="9.5" cy="10.5" r="0.8" fill="currentColor"/><circle cx="14.5" cy="10.5" r="0.8" fill="currentColor"/></svg>`
    : `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  const noteHtml = note ? `<div class="msg-event-note">${esc(note)}</div>` : "";
  return `
    <div class="msg-event msg-event--${isKira ? "kira" : "join"}">
      <div class="msg-event-card">
        <div class="msg-event-ico" aria-hidden="true">${ico}</div>
        <div class="msg-event-text">
          <div class="msg-event-title">${esc(title)}</div>
          <div class="msg-event-sub">${esc(sub)}</div>
        </div>
        <time class="msg-event-time">${time}</time>
      </div>
      ${noteHtml}
    </div>`;
}

function renderMessages(msgs) {
  const sc = $("scroll");
  sc.innerHTML = msgs.map((m) => {
    const r = roleOf(m);
    const body = (m.content || "").trim();
    if (r === "system") {
      if (!body) return "";
      const ev = parseSystemEvent(body);
      const time = fmtTime(m.created_at);
      if (ev && ev.type === "manager_join") {
        return renderEventCard({
          type: "manager_join",
          title: "Решение Киры — позвать менеджера",
          sub: ev.name || "менеджер",
          time,
          note: "* Кира молчит, пока вы ведёте диалог.",
        });
      }
      if (ev && ev.type === "kira_return") {
        return renderEventCard({
          type: "kira_return",
          title: "Кира вернулась в чат",
          sub: ev.auto
            ? "Автовозврат: менеджер долго не отвечал"
            : (ev.name ? `Вернул: ${ev.name}` : "ИИ снова ведёт диалог"),
          time,
        });
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
async function ensureProductsLoaded() {
  if (state.products || state.productsLoading) return;
  state.productsLoading = true;
  try {
    const data = await api("/admin/api/products");
    state.products = (data && data.products) || [];
  } catch (_) {
    state.products = [];
  } finally {
    state.productsLoading = false;
  }
}

function setProductPickerVisible(show) {
  const wrap = $("productPicker");
  if (!wrap) return;
  wrap.hidden = !show;
  if (!show) closeProductSheet();
}

function productCopyText(p) {
  return ((p && p.url) || "").trim() || productOfferText(p);
}

function productOfferText(p) {
  const title = (p.title || "").trim();
  const price = (p.price || "").trim();
  const url = (p.url || "").trim();
  const head = price ? `${title} — ${price}` : title;
  return url ? `${head}\n${url}` : head;
}

function renderProductSheetList() {
  const listEl = $("productSheetList");
  if (!listEl) return;
  const list = state.products || [];
  if (state.productsLoading && !list.length) {
    listEl.innerHTML = `<div class="product-sheet-empty">Загрузка…</div>`;
    return;
  }
  if (!list.length) {
    listEl.innerHTML = `<div class="product-sheet-empty">Продукты пока недоступны</div>`;
    return;
  }
  const copyIco = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
  listEl.innerHTML = list.map((p) => `
    <div class="product-row" role="listitem" data-product-id="${esc(p.id)}">
      <div class="product-row-main">
        <div class="product-row-title">${esc(p.title)}</div>
        <div class="product-row-meta">${esc(p.price || "")}</div>
      </div>
      <button type="button" class="product-copy-btn" data-copy-id="${esc(p.id)}" aria-label="Скопировать ссылку">
        ${copyIco}<span>Копировать</span>
      </button>
      <div class="product-row-url" title="${esc(p.url || "")}">${esc(p.url || "")}</div>
    </div>
  `).join("");
}

async function openProductSheet() {
  await ensureProductsLoaded();
  renderProductSheetList();
  const sheet = $("productSheet");
  if (!sheet) return;
  sheet.hidden = false;
  document.body.classList.add("product-open");
}

function closeProductSheet() {
  const sheet = $("productSheet");
  if (!sheet) return;
  sheet.hidden = true;
  document.body.classList.remove("product-open");
}

async function copyProductLink(productId, btn) {
  const list = state.products || [];
  const p = list.find((x) => x.id === productId);
  if (!p) return;
  const text = productCopyText(p);
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    if (btn) {
      const label = btn.querySelector("span");
      btn.classList.add("is-copied");
      if (label) label.textContent = "Скопировано";
      window.setTimeout(() => {
        btn.classList.remove("is-copied");
        if (label) label.textContent = "Копировать";
      }, 1400);
    }
  } catch (_) {
    alert("Не удалось скопировать. Ссылка: " + text);
  }
}

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

/* ── Дашборд ─────────────────────────────────────────────────────────── */
const RING_R = 42;
const RING_C_DASH = 2 * Math.PI * RING_R;

function ringColor(i) {
  const colors = ["#0a84ff", "#30d158", "#ff9f0a", "#64d2ff", "#bf5af2", "#ff453a", "#ffd60a"];
  return colors[i % colors.length];
}

function pickRings(rings) {
  if (!rings) return [];
  if (state.role === "marketing") {
    return [
      { key: "leads", accent: 0 },
      { key: "silent", accent: 4 },
      { key: "won", accent: 1 },
      { key: "kira_handoffs", accent: 6 },
      { key: "phone", accent: 2 },
    ].map((x) => ({ ...rings[x.key], key: x.key, accent: x.accent })).filter((r) => r && r.label);
  }
  if (state.role === "head") {
    return [
      { key: "leads", accent: 0 },
      { key: "silent", accent: 4 },
      { key: "won", accent: 1 },
      { key: "kira_handoffs", accent: 6 },
      { key: "takeovers", accent: 3 },
      { key: "taken_now", accent: 2 },
    ].map((x) => ({ ...rings[x.key], key: x.key, accent: x.accent })).filter((r) => r && r.label);
  }
  return Object.keys(rings).slice(0, 4).map((key, i) => ({ ...rings[key], key, accent: i }));
}

function ringPct(ring) {
  if (!ring) return 0;
  if (typeof ring.pct === "number") return Math.max(0, Math.min(100, ring.pct)) / 100;
  const max = Math.max(ring.max || ring.value || 1, 1);
  return Math.max(0, Math.min(1, (ring.value || 0) / max));
}

function renderDashRings(data) {
  const box = $("dashRings");
  if (!box) return;
  const items = pickRings(data.rings || {});
  box.innerHTML = items.map((r, i) => {
    const pct = ringPct(r);
    const color = ringColor(r.accent != null ? r.accent : i);
    const val = r.value != null ? r.value : 0;
    const sub = typeof r.pct === "number" ? r.pct + "%" : "";
    return `
      <div class="metric-ring" data-pct="${pct}">
        <svg class="metric-ring-svg" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="metric-ring-track" cx="50" cy="50" r="${RING_R}" fill="none"/>
          <circle class="metric-ring-arc" cx="50" cy="50" r="${RING_R}" fill="none"
            stroke="${color}"
            stroke-dasharray="${RING_C_DASH}"
            stroke-dashoffset="${RING_C_DASH}"
            style="--ring-target:${RING_C_DASH * (1 - pct)}"/>
        </svg>
        <div class="metric-ring-core">
          <div class="metric-ring-n">${esc(String(val))}</div>
          ${sub ? `<div class="metric-ring-pct">${esc(sub)}</div>` : ""}
        </div>
        <div class="metric-ring-label">${esc(r.label || "")}</div>
      </div>`;
  }).join("");

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      box.querySelectorAll(".metric-ring-arc").forEach((el) => {
        el.style.strokeDashoffset = el.style.getPropertyValue("--ring-target") || "0";
      });
    });
  });
}

function renderDashSources(data) {
  const box = $("dashSources");
  const section = $("dashSourcesSection");
  if (!box) return;
  const sources = data.sources || [];
  if (section) {
    section.classList.toggle("is-emphasized", state.role === "marketing");
  }
  if (!sources.length) {
    box.innerHTML = '<div class="dash-empty">Нет данных за период</div>';
    return;
  }
  const max = Math.max(...sources.map((s) => s.count || 0), 1);
  box.innerHTML = sources.map((s, i) => {
    const w = Math.max(4, Math.round(((s.count || 0) / max) * 100));
    return `
      <div class="source-row" style="--i:${i}">
        <div class="source-rank">${i + 1}</div>
        <div class="source-body">
          <div class="source-top">
            <span class="source-name">${esc(s.name || "—")}</span>
            <span class="source-meta">${s.count || 0} · ${s.pct != null ? s.pct : 0}%</span>
          </div>
          <div class="source-bar"><span style="width:${w}%"></span></div>
        </div>
      </div>`;
  }).join("");
}

function renderDashManagers(data) {
  const box = $("dashManagers");
  const section = $("dashManagersSection");
  if (!box) return;
  const managers = data.managers || [];
  if (section) {
    section.classList.toggle("is-emphasized", state.role === "head");
    if (state.role === "head") section.classList.add("is-first-priority");
    else section.classList.remove("is-first-priority");
  }
  if (!managers.length) {
    box.innerHTML = '<div class="dash-empty">Менеджеров пока нет</div>';
    return;
  }
  const maxActive = Math.max(...managers.map((m) => m.active || 0), 1);
  box.innerHTML = `
    <div class="mgr-table">
      <div class="mgr-row mgr-head">
        <span></span>
        <span>Имя</span>
        <span>Активные</span>
        <span>Забрал вручную</span>
      </div>
      ${managers.map((m, i) => {
        const w = Math.max(6, Math.round(((m.active || 0) / maxActive) * 100));
        return `
          <div class="mgr-row" style="--i:${i}">
            <span class="mgr-rank">${i + 1}</span>
            <span class="mgr-name">${esc(m.name || "—")}
              <span class="mgr-mini"><i style="width:${w}%"></i></span>
            </span>
            <span class="mgr-n">${m.active || 0}</span>
            <span class="mgr-n muted">${m.takeovers || 0}</span>
          </div>`;
      }).join("")}
    </div>`;
}

function fmtDealDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

function renderDashDeals(data) {
  const box = $("dashDeals");
  const section = $("dashDealsSection");
  if (!box) return;
  const deals = data.won_deals || [];
  if (section) section.hidden = false;
  if (!deals.length) {
    box.innerHTML = '<div class="dash-empty">Завершённых сделок за период нет</div>';
    return;
  }
  box.innerHTML = deals.map((d, i) => {
    const name = esc(d.name || "Гость");
    const src = esc(d.source || "direct");
    const when = fmtDealDate(d.won_at);
    const idText = d.deal_id ? "#" + d.deal_id : "—";
    const idHtml = d.amo_url
      ? `<a class="deal-id" href="${esc(d.amo_url)}" target="_blank" rel="noopener">${idText}</a>`
      : `<span class="deal-id muted">${idText}</span>`;
    return `
      <div class="deal-row" style="--i:${i}">
        <span class="deal-name">${name}<span class="deal-src">${src}</span></span>
        <span class="deal-when">${when}</span>
        ${idHtml}
      </div>`;
  }).join("");
}

async function loadDashboard() {
  try {
    const data = await api("/admin/api/stats?period=" + encodeURIComponent(state.statsPeriod));
    state.stats = data;
    renderDashRings(data);
    renderDashSources(data);
    renderDashManagers(data);
    renderDashDeals(data);

    // head: managers section first visually via CSS order
    const scroll = document.querySelector(".dash-scroll");
    if (scroll) {
      scroll.classList.toggle("dash-head-layout", state.role === "head");
      scroll.classList.toggle("dash-marketing-layout", state.role === "marketing");
    }
  } catch (e) {
    if (e.forbidden) logout();
    else {
      const rings = $("dashRings");
      if (rings) rings.innerHTML = '<div class="dash-empty">Не удалось загрузить статистику</div>';
    }
  }
}

function setStatsPeriod(period) {
  state.statsPeriod = period;
  document.querySelectorAll(".dash-period").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.period === period);
  });
  loadDashboard();
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
function startDashPolling() {
  stopDashPolling();
  dashTimer = setInterval(loadDashboard, 30000);
}
function stopDashPolling() {
  if (dashTimer) clearInterval(dashTimer);
  dashTimer = null;
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
  $("profileRole").textContent = roleSubtitle(state.role);
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

  const pushBox = $("profilePush");
  if (pushBox) {
    const show = isSellerLike(state.role) && !!(state.pushEnabled || state.vapidPublicKey);
    pushBox.hidden = !show;
    const hint = $("profilePushHint");
    if (hint) { hint.hidden = true; hint.textContent = ""; }
    const btn = $("profilePushTestBtn");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Тест уведомлений";
    }
  }
}

async function onProfilePushTest() {
  const btn = $("profilePushTestBtn");
  const hint = $("profilePushHint");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Отправка…";
  if (hint) {
    hint.hidden = false;
    hint.classList.remove("is-error");
    hint.textContent = "Проверяем подписку и отправляем тест…";
  }
  try {
    await ensurePushSubscription();
    await api("/admin/api/push/test", { method: "POST" });
    localStorage.setItem(LS.pushOk, "1");
    if (hint) {
      hint.classList.remove("is-error");
      hint.textContent = "Отправлено. Проверьте системное уведомление.";
    }
    btn.textContent = "Ещё раз";
  } catch (e) {
    if (hint) {
      hint.classList.add("is-error");
      hint.textContent = "Не удалось: " + (e.message || e);
    }
    btn.textContent = "Тест уведомлений";
  } finally {
    btn.disabled = false;
  }
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
  if (!t) return;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 140) + "px";
}

function spinRefresh(btn) {
  if (!btn) return;
  const ico = btn.querySelector(".ico");
  if (!ico) return;
  ico.classList.remove("is-spinning");
  // reflow, чтобы анимация перезапускалась при частых кликах
  void ico.offsetWidth;
  ico.classList.add("is-spinning");
  ico.addEventListener("animationend", () => ico.classList.remove("is-spinning"), { once: true });
}

function bindEvents() {
  const on = (id, event, fn) => {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
  };
  on("loginBtn", "click", doLogin);
  on("loginToken", "keydown", (e) => { if (e.key === "Enter") doLogin(); });
  on("logoutBtn", "click", logout);
  on("dashLogoutBtn", "click", logout);
  on("dashRefreshBtn", "click", (e) => { spinRefresh(e.currentTarget); loadDashboard(); });
  on("refreshBtn", "click", (e) => { spinRefresh(e.currentTarget); loadList(); loadConversation(false); });
  on("profileBtn", "click", openProfile);
  on("profileClose", "click", closeProfile);
  on("profileBackdrop", "click", closeProfile);
  on("profilePushTestBtn", "click", onProfilePushTest);
  on("returnBtn", "click", returnToKira);
  on("sendBtn", "click", sendMessage);
  on("pushToggle", "change", onPushToggleChange);
  on("pushTestBtn", "click", onPushTestOrNext);
  on("backBtn", "click", () => {
    $("app").classList.remove("viewing");
    state.currentId = null;
    closeProductSheet();
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

  document.querySelectorAll("#sideScope .scope-btn").forEach((btn) => {
    btn.addEventListener("click", () => setScope(btn.dataset.scope));
  });

  document.querySelectorAll(".dash-tab, #appTabs .scope-btn").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  document.querySelectorAll(".dash-period").forEach((btn) => {
    btn.addEventListener("click", () => setStatsPeriod(btn.dataset.period));
  });

  on("productLinksBtn", "click", () => { openProductSheet(); });
  on("productClose", "click", closeProductSheet);
  on("productBackdrop", "click", closeProductSheet);

  const productList = $("productSheetList");
  if (productList) {
    productList.addEventListener("click", (e) => {
      const btn = e.target.closest(".product-copy-btn");
      if (!btn) return;
      copyProductLink(btn.dataset.copyId, btn);
    });
  }
}

/* ── Старт ───────────────────────────────────────────────────────────── */
function registerPWA() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js?v=20").catch(() => {});
  });
}

function readPendingChat() {
  try {
    const id = new URLSearchParams(location.search).get("chat");
    if (id && /^\d+$/.test(id)) {
      state.pendingChatId = Number(id);
      // Убираем ?chat из URL, чтобы обычный рефреш не переоткрывал чат.
      history.replaceState(null, "", location.pathname + location.hash);
    }
  } catch (_) {}
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
    applyWhoami(who);
    // Без welcome-анимации при restore, но push-gate для продавцов в PWA — да
    await afterWelcome();
  } catch (e) {
    clearTimeout(timer);
    showLogin("Не удалось подключиться к серверу. Проверьте интернет.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    registerPWA();
    readPendingChat();
    bindEvents();
    if (state.token) {
      showBooting();
      restoreSession();
    } else {
      showLogin();
    }
  } catch (e) {
    console.error(e);
    try { showLogin("Ошибка интерфейса. Обновите страницу."); } catch (e2) {}
  }
});
