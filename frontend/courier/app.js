const API_BASE_URL = window.DOMI911_API_URL || "http://localhost:3000";
const STORAGE_KEY = "domi911.courier";
const LOCATION_INTERVAL_MS = 15_000;

const registerForm = document.getElementById("register-form");
const registerStatus = document.getElementById("register-status");
const faceRegisterSection = document.getElementById("face-register-section");
const faceRegisterConsent = document.getElementById("face-register-consent");
const faceRegisterVideo = document.getElementById("face-register-video");
const faceRegisterStartBtn = document.getElementById("face-register-start-btn");
const faceRegisterCaptureBtn = document.getElementById("face-register-capture-btn");
const faceRegisterStatus = document.getElementById("face-register-status");
const activationSection = document.getElementById("activation-section");
const activationForm = document.getElementById("activation-form");
const activationStatus = document.getElementById("activation-status");
const activateSubmitBtn = document.getElementById("activate-submit-btn");
const faceActivateVideo = document.getElementById("face-activate-video");
const faceActivateStartBtn = document.getElementById("face-activate-start-btn");
const faceActivateCaptureBtn = document.getElementById("face-activate-capture-btn");
const faceActivateStatus = document.getElementById("face-activate-status");
const statusPill = document.getElementById("status-pill");
const deactivateBtn = document.getElementById("deactivate-btn");
const offerSection = document.getElementById("offer-section");
const offerContainer = document.getElementById("offer-container");

let watchId = null;
let locationTimer = null;
let lastPosition = null;
let socket = null;
let currentOfferOrderId = null;
let faceRegisterStream = null;
let faceActivateStream = null;
let liveFaceDescriptor = null; // capturado en el paso de activación, se manda junto con la cédula

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW no se pudo registrar", err));
}

async function apiFetch(path, options) {
  const stored = getStored();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(stored?.token ? { Authorization: `Bearer ${stored.token}` } : {}),
      ...(options && options.headers),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.toString?.() || `Error ${res.status}`);
  return body;
}

function getStored() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function storeCourier(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function setPill(online) {
  statusPill.textContent = online ? "En línea" : "Desconectado";
  statusPill.className = `pill ${online ? "online" : "offline"}`;
  deactivateBtn.hidden = !online;
}

const stored = getStored();
if (stored?.courierId) {
  faceRegisterSection.hidden = false;
  activationSection.hidden = false;
  activationForm.courierId.value = stored.courierId;
  if (stored.nationalId) activationForm.nationalId.value = stored.nationalId;
  registerStatus.textContent = `Ya registrado como "${stored.name}" en este dispositivo.`;
  registerStatus.className = "status ok";
}

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(registerForm).entries());
  if (!data.vehiclePlate) delete data.vehiclePlate;

  try {
    registerStatus.textContent = "Registrando...";
    registerStatus.className = "status";
    const { courier } = await apiFetch("/api/couriers", { method: "POST", body: JSON.stringify(data) });
    storeCourier({ courierId: courier.id, nationalId: courier.nationalId, name: courier.name });

    registerStatus.textContent = `¡Registrado! Ahora registra tu rostro antes de poder activarte.`;
    registerStatus.className = "status ok";

    faceRegisterSection.hidden = false;
    activationSection.hidden = false;
    activationForm.courierId.value = courier.id;
    activationForm.nationalId.value = courier.nationalId;
  } catch (err) {
    registerStatus.textContent = `No se pudo registrar: ${err.message}`;
    registerStatus.className = "status error";
  }
});

// --- Captura del rostro de referencia (una vez, tras el registro) ---
// Extracción 100% client-side con face-api.js (frontend/courier/face.js);
// solo el descriptor de 128 números viaja al backend, nunca la foto.
const faceApiAvailable = typeof window.Domi911Face !== "undefined" && window.Domi911Face.FACE_API_AVAILABLE;
if (!faceApiAvailable) {
  console.warn("[face] face-api.js no disponible; la captura de rostro queda deshabilitada en esta sesión.");
}

faceRegisterStartBtn.addEventListener("click", async () => {
  try {
    faceRegisterStatus.textContent = "Encendiendo cámara...";
    faceRegisterStatus.className = "status";
    faceRegisterStream = await window.Domi911Face.startCamera(faceRegisterVideo);
    faceRegisterCaptureBtn.disabled = false;
    faceRegisterStatus.textContent = "Cámara lista. Mira al frente y presiona \"Capturar rostro\".";
  } catch (err) {
    faceRegisterStatus.textContent = `No se pudo acceder a la cámara: ${err.message}`;
    faceRegisterStatus.className = "status error";
  }
});

faceRegisterCaptureBtn.addEventListener("click", async () => {
  const stored = getStored();
  if (!stored?.courierId) return;
  if (!faceRegisterConsent.checked) {
    faceRegisterStatus.textContent = "Primero debes aceptar la casilla de consentimiento.";
    faceRegisterStatus.className = "status error";
    return;
  }

  faceRegisterStatus.textContent = "Analizando rostro...";
  faceRegisterStatus.className = "status";
  const descriptor = await window.Domi911Face.captureFaceDescriptor(faceRegisterVideo);
  if (!descriptor) {
    faceRegisterStatus.textContent = "No detectamos tu rostro. Acércate a la cámara, mejora la luz e intenta de nuevo.";
    faceRegisterStatus.className = "status error";
    return;
  }

  try {
    await apiFetch(`/api/couriers/${stored.courierId}/face-reference`, {
      method: "POST",
      body: JSON.stringify({ descriptor, consent: true, nationalId: stored.nationalId }),
    });
    faceRegisterStatus.textContent = "¡Rostro de referencia guardado! Ya puedes activarte todos los días verificándolo.";
    faceRegisterStatus.className = "status ok";
  } catch (err) {
    faceRegisterStatus.textContent = `No se pudo guardar tu rostro: ${err.message}`;
    faceRegisterStatus.className = "status error";
  }
});

// --- Verificación facial en vivo (cada activación) ---
faceActivateStartBtn.addEventListener("click", async () => {
  try {
    faceActivateStatus.textContent = "Encendiendo cámara...";
    faceActivateStatus.className = "status";
    faceActivateStream = await window.Domi911Face.startCamera(faceActivateVideo);
    faceActivateCaptureBtn.disabled = false;
    faceActivateStatus.textContent = "Cámara lista. Mira al frente y presiona \"Verificar rostro\".";
  } catch (err) {
    faceActivateStatus.textContent = `No se pudo acceder a la cámara: ${err.message}`;
    faceActivateStatus.className = "status error";
  }
});

faceActivateCaptureBtn.addEventListener("click", async () => {
  faceActivateStatus.textContent = "Analizando rostro...";
  faceActivateStatus.className = "status";
  const descriptor = await window.Domi911Face.captureFaceDescriptor(faceActivateVideo);
  if (!descriptor) {
    faceActivateStatus.textContent = "No detectamos tu rostro. Acércate a la cámara, mejora la luz e intenta de nuevo.";
    faceActivateStatus.className = "status error";
    liveFaceDescriptor = null;
    activateSubmitBtn.disabled = true;
    return;
  }

  liveFaceDescriptor = descriptor;
  faceActivateStatus.textContent = "Rostro capturado. Ya puedes activarte.";
  faceActivateStatus.className = "status ok";
  activateSubmitBtn.disabled = false;
});

activationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { courierId, nationalId } = Object.fromEntries(new FormData(activationForm).entries());

  if (!liveFaceDescriptor) {
    activationStatus.textContent = "Primero verifica tu rostro con la cámara.";
    activationStatus.className = "status error";
    return;
  }

  try {
    activationStatus.textContent = "Activando...";
    activationStatus.className = "status";
    const { token } = await apiFetch(`/api/couriers/${courierId}/activate`, {
      method: "POST",
      body: JSON.stringify({ nationalId, faceDescriptor: liveFaceDescriptor }),
    });

    storeCourier({ ...getStored(), courierId, nationalId, token });
    activationStatus.textContent = "¡Activo! Ya estás visible para recibir pedidos cercanos.";
    activationStatus.className = "status ok";
    setPill(true);
    offerSection.hidden = false;
    liveFaceDescriptor = null;
    activateSubmitBtn.disabled = true;

    startLocationReporting(courierId);
    connectSocket(courierId);
  } catch (err) {
    activationStatus.textContent = `No se pudo activar: ${err.message}`;
    activationStatus.className = "status error";
  }
});

deactivateBtn.addEventListener("click", async () => {
  const { courierId } = getStored() ?? {};
  if (!courierId) return;
  try {
    await apiFetch(`/api/couriers/${courierId}/deactivate`, { method: "POST" });
  } catch (err) {
    alert(`No se pudo desactivar: ${err.message}`);
    return;
  }
  stopLocationReporting();
  setPill(false);
});

function startLocationReporting(courierId) {
  if (!navigator.geolocation) {
    alert("Este navegador no soporta geolocalización.");
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      lastPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    },
    (err) => console.warn("[geo] error obteniendo ubicación", err),
    { enableHighAccuracy: true, maximumAge: 10_000 }
  );

  const sendLocation = async () => {
    if (!lastPosition) return;
    try {
      await apiFetch(`/api/couriers/${courierId}/location`, {
        method: "POST",
        body: JSON.stringify(lastPosition),
      });
    } catch (err) {
      console.warn("[geo] no se pudo reportar ubicación", err);
    }
  };

  sendLocation();
  locationTimer = setInterval(sendLocation, LOCATION_INTERVAL_MS);
}

function stopLocationReporting() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (locationTimer !== null) clearInterval(locationTimer);
  watchId = null;
  locationTimer = null;
}

function connectSocket(courierId) {
  if (socket) socket.disconnect();
  socket = io(API_BASE_URL);

  socket.on("connect", () => socket.emit("courier:subscribe", courierId));

  socket.on("order:offer", ({ order, distanceMeters }) => {
    renderOffer(order, distanceMeters);
  });

  socket.on("order:offer-cancelled", ({ orderId }) => {
    if (orderId === currentOfferOrderId) {
      currentOfferOrderId = null;
      renderNoOffer();
    }
  });

  socket.on("order:won", (order) => {
    renderActiveService(order);
  });
}

/**
 * Cómo se maneja el cobro de la mercancía (aparte de la tarifa del
 * domicilio) es opcional y varía por pedido — el domiciliario necesita
 * verlo ANTES de aceptar, no después, para saber si va a tener que
 * manejar ese dinero. Ver `PaymentMode` en el backend.
 */
function merchandiseInfoHtml(order) {
  if (!order.merchandiseValue) {
    return `<p class="hint">No manejas cobro de mercancía en este pedido.</p>`;
  }
  const value = order.merchandiseValue;
  const currency = order.currency ?? "";
  const explanations = {
    BUSINESS_REIMBURSES_COURIER: `El negocio ya cobró el pedido (${value} ${currency}); no tienes que cobrarle nada de mercancía al cliente. El negocio te reembolsa tu servicio por fuera de la app.`,
    COURIER_COLLECTS_ON_DELIVERY: `Debes pagarle ${value} ${currency} al negocio al recoger la mercancía, y cobrarle esos ${value} ${currency} más tu tarifa de servicio al cliente al entregar.`,
  };
  const explanation =
    explanations[order.paymentMode] ??
    `Valor de la mercancía: ${value} ${currency}. Confirma con el negocio cómo se maneja el cobro.`;
  return `<p><strong>Mercancía (${value} ${currency}):</strong> ${explanation}</p>`;
}

function renderOffer(order, distanceMeters) {
  currentOfferOrderId = order.id;
  offerContainer.innerHTML = `
    <div class="offer">
      <p><strong>Nuevo pedido a ${(distanceMeters / 1000).toFixed(1)} km</strong></p>
      <p>Recogida: ${order.pickupAddress}</p>
      <p>Entrega: ${order.dropoffAddress}</p>
      ${order.fare ? `<p>Tarifa: ${order.fare} ${order.currency}</p>` : ""}
      ${merchandiseInfoHtml(order)}
      <button id="accept-offer-btn">Aceptar</button>
    </div>
  `;
  document.getElementById("accept-offer-btn").addEventListener("click", async () => {
    try {
      const { order: assigned } = await apiFetch(`/api/orders/${order.id}/accept`, { method: "POST" });
      currentOfferOrderId = null;
      renderActiveService(assigned);
    } catch (err) {
      alert(`No se pudo aceptar: ${err.message}. Puede que ya lo haya tomado otro domiciliario.`);
      renderNoOffer();
    }
  });
}

function renderNoOffer() {
  offerContainer.innerHTML = '<p class="hint">Sin ofertas por ahora. Deja la app abierta para recibir pedidos cercanos.</p>';
}

function renderActiveService(order) {
  offerContainer.innerHTML = `
    <div class="offer">
      <p><strong>Servicio en curso</strong></p>
      <p>Recogida: ${order.pickupAddress}</p>
      <p>Entrega: ${order.dropoffAddress}</p>
      ${merchandiseInfoHtml(order)}
      <div class="row-actions" style="display:flex; gap:0.5rem; margin-top:0.5rem;">
        <button id="picked-up-btn">Recogido</button>
        <button id="delivered-btn">Entregado</button>
      </div>
    </div>
  `;
  document.getElementById("picked-up-btn").addEventListener("click", async () => {
    await apiFetch(`/api/orders/${order.id}/picked-up`, { method: "POST" }).catch((e) => alert(e.message));
  });
  document.getElementById("delivered-btn").addEventListener("click", async () => {
    await apiFetch(`/api/orders/${order.id}/delivered`, { method: "POST" }).catch((e) => alert(e.message));
    renderNoOffer();
  });
}
