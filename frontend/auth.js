// Login/registro del negocio. Reemplaza el flujo de WhatsApp: el negocio
// ya no escribe su nombre por chat cada vez, se registra una sola vez
// (con credenciales + su ubicación como recogida por defecto) y opera
// desde dashboard.html — ver docs/ARCHITECTURE.md §11.
const API_BASE_URL = window.WHATDOMI_API_URL || "http://localhost:3000";
const SESSION_KEY = "whatdomi.session"; // { token, business }

const tabLogin = document.getElementById("tab-login");
const tabRegister = document.getElementById("tab-register");
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const loginStatus = document.getElementById("login-status");
const registerStatus = document.getElementById("register-status");

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function storeSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

// Si ya hay una sesión guardada, no hace falta loguearse de nuevo.
if (getSession()?.token) {
  window.location.href = "dashboard.html";
}

async function apiFetch(path, options) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options && options.headers) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.error?.formErrors?.join(", ") || body?.error || `Error ${res.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return body;
}

function showTab(which) {
  const isLogin = which === "login";
  tabLogin.classList.toggle("active", isLogin);
  tabRegister.classList.toggle("active", !isLogin);
  loginForm.hidden = !isLogin;
  registerForm.hidden = isLogin;
}

tabLogin.addEventListener("click", () => showTab("login"));
tabRegister.addEventListener("click", () => showTab("register"));

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(loginForm).entries());

  try {
    loginStatus.textContent = "Ingresando...";
    loginStatus.className = "status";
    const { token, business } = await apiFetch("/api/auth/login", { method: "POST", body: JSON.stringify(data) });
    storeSession({ token, business });
    window.location.href = "dashboard.html";
  } catch (err) {
    loginStatus.textContent = `No se pudo ingresar: ${err.message}`;
    loginStatus.className = "status error";
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(registerForm).entries());

  try {
    registerStatus.textContent = "Registrando...";
    registerStatus.className = "status";
    const { token, business } = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
    storeSession({ token, business });
    window.location.href = "dashboard.html";
  } catch (err) {
    registerStatus.textContent = `No se pudo registrar: ${err.message}`;
    registerStatus.className = "status error";
  }
});
