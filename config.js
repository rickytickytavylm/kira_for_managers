// Адрес бэкенда Киры (FastAPI, тот же сервер, где живёт бот и админка).
// Локально: http://localhost:8000
// Прод: домен вашего задеплоенного backend (Railway/VPS),
//   например https://shurovai-production.up.railway.app
//
// Ключ НЕ зашиваем: каждый продавец (Ольга/Ирина/Роман/Вячеслав) входит
// своим личным ключом на экране входа. Так бэкенд знает, кто забрал лид.
window.CONSOLE_CONFIG = {
  BACKEND_URL:
    location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? "http://localhost:8000"
      : "https://shurovai-production.up.railway.app",
};
