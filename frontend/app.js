// Frontend mínimo, sin build step: se puede abrir directamente o servir con
// cualquier servidor estático. Configura la URL del backend con
// `window.WHATDOMI_API_URL` (ver config.js) o cae por defecto a localhost:3000.
const API_BASE_URL = window.WHATDOMI_API_URL || "http://localhost:3000";
const STORAGE_KEY = "whatdomi.businessId";

const businessForm = document.getElementById("business-form");
const businessStatus = document.getElementById("business-status");
const orderSection = document.getElementById("order-section");
const orderForm = document.getElementById("order-form");
const trackingSection = document.getElementById("tracking-section");
const orderSummary = document.getElementById("order-summary");
const useMyLocationBtn = document.getElementById("use-my-location");

let currentOrderId = null;
let pollTimer = null;

function setBusinessStatus(message, kind) {
  businessStatus.textContent = message;
  businessStatus.className = `status ${kind ?? ""}`;
}

function getStoredBusinessId() {
  return localStorage.getItem(STORAGE_KEY);
}

function storeBusinessId(id) {
  localStorage.setItem(STORAGE_KEY, id);
}

function unlockOrderSection() {
  orderSection.hidden = false;
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

// Si ya hay un negocio guardado en este navegador, no hay que volver a crearlo.
if (getStoredBusinessId()) {
  setBusinessStatus("Negocio ya registrado en este navegador.", "ok");
  unlockOrderSection();
}

businessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(businessForm).entries());
  if (!data.address) delete data.address;

  try {
    setBusinessStatus("Guardando...", "");
    const { business } = await apiFetch("/api/businesses", {
      method: "POST",
      body: JSON.stringify(data),
    });
    storeBusinessId(business.id);
    setBusinessStatus(`Negocio "${business.name}" registrado correctamente.`, "ok");
    unlockOrderSection();
  } catch (err) {
    setBusinessStatus(`No se pudo registrar el negocio: ${err.message}`, "error");
  }
});

useMyLocationBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("Este navegador no soporta geolocalización; ingresa las coordenadas manualmente.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      orderForm.pickupLat.value = pos.coords.latitude;
      orderForm.pickupLng.value = pos.coords.longitude;
    },
    () => alert("No se pudo obtener tu ubicación. Ingresa las coordenadas manualmente.")
  );
});

orderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const businessId = getStoredBusinessId();
  if (!businessId) {
    alert("Registra primero tu negocio.");
    return;
  }

  const raw = Object.fromEntries(new FormData(orderForm).entries());
  const payload = {
    businessId,
    pickupAddress: raw.pickupAddress,
    pickup: { lat: Number(raw.pickupLat), lng: Number(raw.pickupLng) },
    dropoffAddress: raw.dropoffAddress,
    dropoff: { lat: Number(raw.dropoffLat), lng: Number(raw.dropoffLng) },
  };
  if (raw.customerName) payload.customerName = raw.customerName;
  if (raw.customerPhone) payload.customerPhone = raw.customerPhone;
  if (raw.notes) payload.notes = raw.notes;

  try {
    const { order, candidatesOffered } = await apiFetch("/api/orders", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    currentOrderId = order.id;
    trackingSection.hidden = false;
    renderOrder(order, candidatesOffered);
    startPolling();
  } catch (err) {
    alert(`No se pudo crear el pedido: ${err.message}`);
  }
});

const STATUS_LABELS = {
  CREATED: "Creado",
  SEARCHING: "Buscando domiciliario",
  ASSIGNED: "Domiciliario asignado",
  IN_PROGRESS: "En camino",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
  NO_COURIERS_AVAILABLE: "Sin domiciliarios disponibles cerca",
};

function renderOrder(order, candidatesOffered) {
  const label = STATUS_LABELS[order.status] ?? order.status;
  orderSummary.innerHTML = `
    <span class="badge">${label}</span>
    <div><strong>Pedido:</strong> ${order.id}</div>
    <div><strong>Recogida:</strong> ${order.pickupAddress}</div>
    <div><strong>Entrega:</strong> ${order.dropoffAddress}</div>
    ${
      typeof candidatesOffered === "number"
        ? `<div><strong>Domiciliarios notificados:</strong> ${candidatesOffered}</div>`
        : ""
    }
  `;
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!currentOrderId) return;
    try {
      const { order } = await apiFetch(`/api/orders/${currentOrderId}`);
      renderOrder(order);
      if (["DELIVERED", "CANCELLED", "NO_COURIERS_AVAILABLE"].includes(order.status)) {
        clearInterval(pollTimer);
      }
    } catch {
      // Si el pedido deja de estar disponible momentáneamente, no interrumpe el polling.
    }
  }, 3000);
}
