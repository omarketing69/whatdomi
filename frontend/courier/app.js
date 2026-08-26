const API_BASE_URL = window.WHATDOMI_API_URL || "http://localhost:3000";
const STORAGE_KEY = "whatdomi.courier";
const LOCATION_INTERVAL_MS = 15_000;

const registerForm = document.getElementById("register-form");
const registerStatus = document.getElementById("register-status");
const activationSection = document.getElementById("activation-section");
const activationForm = document.getElementById("activation-form");
const activationStatus = document.getElementById("activation-status");
const statusPill = document.getElementById("status-pill");
const deactivateBtn = document.getElementById("deactivate-btn");
const offerSection = document.getElementById("offer-section");
const offerContainer = document.getElementById("offer-container");

let watchId = null;
let locationTimer = null;
let lastPosition = null;
let socket = null;
let currentOfferOrderId = null;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW no se pudo registrar", err));
}

async function apiFetch(path, options) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options && options.headers) },
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
  activationSection.hidden = false;
  activationForm.courierId.value = stored.courierId;
  if (stored.activationCode) activationForm.activationCode.value = stored.activationCode;
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
    storeCourier({ courierId: courier.id, activationCode: courier.activationCode, name: courier.name });

    registerStatus.textContent = `¡Registrado! Tu código de activación es ${courier.activationCode} (ya quedó guardado en este dispositivo).`;
    registerStatus.className = "status ok";

    activationSection.hidden = false;
    activationForm.courierId.value = courier.id;
    activationForm.activationCode.value = courier.activationCode;
  } catch (err) {
    registerStatus.textContent = `No se pudo registrar: ${err.message}`;
    registerStatus.className = "status error";
  }
});

activationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { courierId, activationCode } = Object.fromEntries(new FormData(activationForm).entries());

  try {
    activationStatus.textContent = "Activando...";
    activationStatus.className = "status";
    await apiFetch(`/api/couriers/${courierId}/activate`, {
      method: "POST",
      body: JSON.stringify({ activationCode }),
    });

    storeCourier({ ...getStored(), courierId, activationCode });
    activationStatus.textContent = "¡Activo! Ya estás visible para recibir pedidos cercanos.";
    activationStatus.className = "status ok";
    setPill(true);
    offerSection.hidden = false;

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
    renderOffer(order, distanceMeters, courierId);
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

function renderOffer(order, distanceMeters, courierId) {
  currentOfferOrderId = order.id;
  offerContainer.innerHTML = `
    <div class="offer">
      <p><strong>Nuevo pedido a ${(distanceMeters / 1000).toFixed(1)} km</strong></p>
      <p>Recogida: ${order.pickupAddress}</p>
      <p>Entrega: ${order.dropoffAddress}</p>
      ${order.fare ? `<p>Tarifa: ${order.fare} ${order.currency}</p>` : ""}
      <button id="accept-offer-btn">Aceptar</button>
    </div>
  `;
  document.getElementById("accept-offer-btn").addEventListener("click", async () => {
    try {
      const { order: assigned } = await apiFetch(`/api/orders/${order.id}/accept`, {
        method: "POST",
        body: JSON.stringify({ courierId }),
      });
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
