// Dashboard del negocio: botón "Pedir domiciliario" en vez de escribirle a
// un bot de WhatsApp. Cotiza (recogida = ubicación registrada del negocio,
// salvo que se sobreescriba puntualmente) → confirma → arranca la misma
// cascada de asignación automática de siempre — ver docs/ARCHITECTURE.md §11.
const API_BASE_URL = window.DOMI911_API_URL || "http://localhost:3000";
const SESSION_KEY = "domi911.session";
const MAP_POLL_MS = 4000;
const ORDER_POLL_MS = 3000;

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

const session = getSession();
if (!session?.token) {
  window.location.href = "index.html";
}

async function apiFetch(path, options) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
      ...(options && options.headers),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = "index.html";
    throw new Error("Sesión expirada");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.error?.formErrors?.join(", ") || body?.error || `Error ${res.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return body;
}

document.getElementById("business-name").textContent = `${session.business.name} · ${session.business.email}`;
document.getElementById("pickup-hint").textContent = session.business.address
  ? `Punto de recogida por defecto: ${session.business.address}`
  : "Tu negocio no tiene una dirección registrada; indica una para cada pedido.";

document.getElementById("logout-btn").addEventListener("click", () => {
  localStorage.removeItem(SESSION_KEY);
  window.location.href = "index.html";
});

// --- Elementos ---
const bigRequestBtn = document.getElementById("big-request-btn");
const quoteForm = document.getElementById("quote-form");
const quoteStatus = document.getElementById("quote-status");
const cancelQuoteFormBtn = document.getElementById("cancel-quote-form-btn");
const overridePickupCheck = document.getElementById("override-pickup-check");
const overridePickupLabel = document.getElementById("override-pickup-label");

const quoteSection = document.getElementById("quote-section");
const quoteSummary = document.getElementById("quote-summary");
const confirmOrderBtn = document.getElementById("confirm-order-btn");
const cancelOrderBtn = document.getElementById("cancel-order-btn");
const confirmStatus = document.getElementById("confirm-status");

const trackingSection = document.getElementById("tracking-section");
const orderSummary = document.getElementById("order-summary");
const courierContact = document.getElementById("courier-contact");
const newOrderBtn = document.getElementById("new-order-btn");

const mapSection = document.getElementById("map-section");
const mapHint = document.getElementById("map-hint");

let currentOrderId = null;
let orderPollTimer = null;

/**
 * `currentOrderId` solo vive en esta variable de JS: un refresh de la
 * página (F5, cerrar y volver a abrir la pestaña) lo perdía sin ninguna
 * forma de recuperar el pedido en curso, aunque el pedido siguiera activo
 * del lado del servidor. Al cargar el dashboard, se pregunta si el
 * negocio tiene un pedido no terminado y, si lo tiene, se reconstruye la
 * vista correspondiente en vez de arrancar siempre en el estado inicial.
 */
async function restoreActiveOrder() {
  try {
    const { order, quote } = await apiFetch("/api/business/orders/active");
    if (!order) return;

    currentOrderId = order.id;
    bigRequestBtn.hidden = true;

    if (order.status === "QUOTED") {
      showQuote(order, quote ?? { distanceKm: (order.distanceMeters ?? 0) / 1000, fare: order.fare, currency: order.currency });
      return;
    }

    startTracking(order);
  } catch {
    // Si la recuperación falla por lo que sea, se deja la vista inicial normal en vez de trabar el dashboard.
  }
}

restoreActiveOrder();

overridePickupCheck.addEventListener("change", () => {
  overridePickupLabel.hidden = !overridePickupCheck.checked;
});

bigRequestBtn.addEventListener("click", () => {
  bigRequestBtn.hidden = true;
  quoteForm.hidden = false;
});

cancelQuoteFormBtn.addEventListener("click", () => {
  quoteForm.hidden = true;
  bigRequestBtn.hidden = false;
  quoteForm.reset();
});

quoteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = Object.fromEntries(new FormData(quoteForm).entries());
  const payload = { dropoffAddress: raw.dropoffAddress };
  if (overridePickupCheck.checked && raw.pickupAddress) payload.pickupAddress = raw.pickupAddress;
  if (raw.customerName) payload.customerName = raw.customerName;
  if (raw.customerPhone) payload.customerPhone = raw.customerPhone;
  if (raw.notes) payload.notes = raw.notes;
  if (raw.merchandiseValue) payload.merchandiseValue = Number(raw.merchandiseValue);
  if (raw.paymentMode) payload.paymentMode = raw.paymentMode;

  try {
    quoteStatus.textContent = "Calculando tarifa...";
    quoteStatus.className = "status";
    const { order, quote } = await apiFetch("/api/business/orders/quote", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    currentOrderId = order.id;
    quoteStatus.textContent = "";
    quoteForm.hidden = true;
    showQuote(order, quote);
  } catch (err) {
    quoteStatus.textContent = `No se pudo cotizar: ${err.message}`;
    quoteStatus.className = "status error";
  }
});

const MERCHANDISE_PAYMENT_MODE_LABELS = {
  BUSINESS_REIMBURSES_COURIER: "El negocio recibe todo y le reembolsa su servicio al domiciliario",
  COURIER_COLLECTS_ON_DELIVERY: "El domiciliario paga la mercancía al recoger, y cobra todo al cliente al entregar",
};

function showQuote(order, quote) {
  quoteSection.hidden = false;
  quoteSummary.innerHTML = `
    <div><strong>Recogida:</strong> ${order.pickupAddress}</div>
    <div><strong>Entrega:</strong> ${order.dropoffAddress}</div>
    <div><strong>Distancia:</strong> ${quote.distanceKm.toFixed(1)} km</div>
    <div><strong>Tarifa:</strong> ${quote.fare} ${quote.currency}</div>
    ${
      order.merchandiseValue
        ? `<div><strong>Valor de la mercancía:</strong> ${order.merchandiseValue} ${quote.currency}
           (${MERCHANDISE_PAYMENT_MODE_LABELS[order.paymentMode] ?? "modalidad no especificada"})</div>`
        : ""
    }
  `;
  setPickupPoint(order.pickup.lat, order.pickup.lng);
  mapHint.textContent = "Puntos verdes: domiciliarios activos cerca de la recogida.";
  startNearbyPolling();
}

cancelOrderBtn.addEventListener("click", async () => {
  if (!currentOrderId) return;
  try {
    await apiFetch(`/api/orders/${currentOrderId}/cancel`, { method: "POST" });
  } catch {
    // Si ya no se puede cancelar (ej. alguien más lo tocó), igual reseteamos la vista.
  }
  resetToIdle();
});

confirmOrderBtn.addEventListener("click", async () => {
  if (!currentOrderId) return;
  try {
    confirmStatus.textContent = "Confirmando...";
    confirmStatus.className = "status";
    const { order, candidatesOffered } = await apiFetch(`/api/business/orders/${currentOrderId}/confirm`, {
      method: "POST",
    });
    quoteSection.hidden = true;
    startTracking(order, candidatesOffered);
  } catch (err) {
    confirmStatus.textContent = `No se pudo confirmar: ${err.message}`;
    confirmStatus.className = "status error";
  }
});

function resetToIdle() {
  currentOrderId = null;
  stopNearbyPolling();
  stopTrackingAssignedCourier();
  if (orderPollTimer) clearInterval(orderPollTimer);
  quoteForm.hidden = true;
  quoteForm.reset();
  quoteSection.hidden = true;
  trackingSection.hidden = true;
  mapSection.hidden = true;
  courierContact.hidden = true;
  newOrderBtn.hidden = true;
  bigRequestBtn.hidden = false;
  overridePickupLabel.hidden = true;
  overridePickupCheck.checked = false;
}

newOrderBtn.addEventListener("click", resetToIdle);

const STATUS_LABELS = {
  CREATED: "Creado",
  QUOTED: "Cotizado",
  SEARCHING: "Buscando domiciliario",
  ASSIGNED: "Domiciliario asignado",
  IN_PROGRESS: "En camino",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
  NO_COURIERS_AVAILABLE: "Sin domiciliarios disponibles cerca",
  UNASSIGNED: "Nadie aceptó a tiempo, un administrador lo asignará",
};

function startTracking(order, candidatesOffered) {
  trackingSection.hidden = false;
  renderOrder(order, candidatesOffered);
  orderPollTimer = setInterval(async () => {
    if (!currentOrderId) return;
    try {
      const { order } = await apiFetch(`/api/orders/${currentOrderId}`);
      renderOrder(order);
      if (["DELIVERED", "CANCELLED", "NO_COURIERS_AVAILABLE"].includes(order.status)) {
        clearInterval(orderPollTimer);
        stopTrackingAssignedCourier();
        newOrderBtn.hidden = false;
      }
    } catch {
      // Un fallo puntual de polling no debería interrumpir el resto del flujo.
    }
  }, ORDER_POLL_MS);
}

function renderOrder(order, candidatesOffered) {
  currentOrderStatus = order.status;
  if (!dropoffPoint && order.dropoff) dropoffPoint = order.dropoff;
  const label = STATUS_LABELS[order.status] ?? order.status;
  orderSummary.innerHTML = `
    <span class="badge">${label}</span>
    <div><strong>Recogida:</strong> ${order.pickupAddress}</div>
    <div><strong>Entrega:</strong> ${order.dropoffAddress}</div>
    ${typeof candidatesOffered === "number" ? `<div><strong>Domiciliarios notificados:</strong> ${candidatesOffered}</div>` : ""}
  `;

  if (["ASSIGNED", "IN_PROGRESS"].includes(order.status)) {
    if (!trackingTimer) startTrackingAssignedCourier();
    refreshCourierContact();
  } else {
    stopTrackingAssignedCourier();
    if (order.status !== "QUOTED" && order.status !== "SEARCHING") courierContact.hidden = true;
  }
}

async function refreshCourierContact() {
  if (!currentOrderId) return;
  try {
    const { courier } = await apiFetch(`/api/orders/${currentOrderId}/courier-contact`);
    if (!courier) return;
    courierContact.hidden = false;
    courierContact.innerHTML = `
      <strong>Domiciliario asignado</strong><br/>
      Nombre: ${courier.name}<br/>
      Placa: ${courier.vehiclePlate ?? "sin registrar"}<br/>
      Teléfono: ${courier.phone}
    `;
  } catch {
    // El contacto se refresca cada poll de todos modos; un fallo puntual no importa.
  }
}

// --- Mapa: mismo patrón que el formulario directo original (Leaflet vendorizado,
// ver docs/ARCHITECTURE.md §9) — domiciliarios cercanos antes de asignar, trayecto
// del asignado (recogida→entrega, en dos tramos) después.
const mapAvailable = typeof L !== "undefined";
if (!mapAvailable) {
  console.warn("[map] Leaflet no cargó; el mapa queda deshabilitado, el resto del dashboard sigue funcionando.");
}

let map = null;
let pickupMarker = null;
let dropoffMarker = null;
let courierMarkersById = new Map();
let assignedMarker = null;
let trajectoryLine = null;
let pickupPoint = null;
let dropoffPoint = null;
let currentOrderStatus = null;
let nearbyTimer = null;
let trackingTimer = null;

const courierIcon = mapAvailable
  ? new L.DivIcon({
      className: "",
      html: '<div style="width:12px;height:12px;border-radius:50%;background:#f2701d;border:2px solid white;box-shadow:0 0 2px rgba(0,0,0,.5);"></div>',
      iconSize: [12, 12],
    })
  : null;
const assignedIcon = mapAvailable
  ? new L.DivIcon({
      className: "",
      html: '<div style="width:16px;height:16px;border-radius:50%;background:#b3261e;border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,.6);"></div>',
      iconSize: [16, 16],
    })
  : null;
const dropoffIcon = mapAvailable
  ? new L.DivIcon({
      className: "",
      html: '<div style="width:14px;height:14px;background:#1c1e21;border-radius:2px;"></div>',
      iconSize: [14, 14],
    })
  : null;

function ensureMap(lat, lng) {
  if (map) return map;
  map = L.map("map").setView([lat, lng], 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap",
    maxZoom: 19,
  }).addTo(map);
  return map;
}

function setPickupPoint(lat, lng) {
  pickupPoint = { lat, lng };
  mapSection.hidden = false;
  if (!mapAvailable) {
    mapHint.textContent = "Mapa no disponible en este momento.";
    return;
  }
  ensureMap(lat, lng);
  map.setView([lat, lng], 14);
  if (pickupMarker) {
    pickupMarker.setLatLng([lat, lng]);
  } else {
    pickupMarker = L.marker([lat, lng], {
      icon: new L.DivIcon({
        className: "",
        html: '<div style="width:14px;height:14px;background:#1c1e21;transform:rotate(45deg);"></div>',
        iconSize: [14, 14],
      }),
    })
      .addTo(map)
      .bindPopup("Punto de recogida");
  }
}

async function refreshNearbyCouriers() {
  if (!mapAvailable || !pickupPoint) return;
  try {
    const { couriers } = await apiFetch(`/api/couriers/nearby?lat=${pickupPoint.lat}&lng=${pickupPoint.lng}`);
    const seenIds = new Set();
    for (const courier of couriers) {
      seenIds.add(courier.id);
      const existing = courierMarkersById.get(courier.id);
      if (existing) {
        existing.setLatLng([courier.lat, courier.lng]);
      } else {
        const marker = L.marker([courier.lat, courier.lng], { icon: courierIcon }).addTo(map).bindPopup(courier.name);
        courierMarkersById.set(courier.id, marker);
      }
    }
    for (const [id, marker] of courierMarkersById) {
      if (!seenIds.has(id)) {
        map.removeLayer(marker);
        courierMarkersById.delete(id);
      }
    }
  } catch {
    // Un fallo puntual del mapa no debería interrumpir el resto del flujo.
  }
}

function startNearbyPolling() {
  if (!mapAvailable) return;
  stopNearbyPolling();
  refreshNearbyCouriers();
  nearbyTimer = setInterval(refreshNearbyCouriers, MAP_POLL_MS);
}

function stopNearbyPolling() {
  if (nearbyTimer) clearInterval(nearbyTimer);
  nearbyTimer = null;
  if (!mapAvailable) return;
  for (const marker of courierMarkersById.values()) map.removeLayer(marker);
  courierMarkersById.clear();
}

function ensureDropoffMarker() {
  if (!mapAvailable || !dropoffPoint || dropoffMarker) return;
  dropoffMarker = L.marker([dropoffPoint.lat, dropoffPoint.lng], { icon: dropoffIcon }).addTo(map).bindPopup("Punto de entrega");
}

async function refreshAssignedCourierLocation() {
  if (!mapAvailable || !currentOrderId || !pickupPoint) return;
  const target = currentOrderStatus === "IN_PROGRESS" ? dropoffPoint : pickupPoint;
  if (!target) return;
  if (currentOrderStatus === "IN_PROGRESS") {
    ensureDropoffMarker();
    mapHint.textContent = "Tu domiciliario va camino a la entrega.";
  } else {
    mapHint.textContent = "Tu domiciliario va camino a la recogida.";
  }

  try {
    const { location } = await apiFetch(`/api/orders/${currentOrderId}/courier-location`);
    if (!location) return;

    const latlng = [location.lat, location.lng];
    if (assignedMarker) {
      assignedMarker.setLatLng(latlng);
    } else {
      assignedMarker = L.marker(latlng, { icon: assignedIcon }).addTo(map).bindPopup("Tu domiciliario");
    }

    const targetLatLng = [target.lat, target.lng];
    if (trajectoryLine) {
      trajectoryLine.setLatLngs([latlng, targetLatLng]);
    } else {
      trajectoryLine = L.polyline([latlng, targetLatLng], { color: "#f2701d", dashArray: "6 6" }).addTo(map);
    }
    map.fitBounds([latlng, targetLatLng], { padding: [30, 30] });
  } catch {
    // Igual que arriba: un fallo puntual no debería tumbar el resto de la página.
  }
}

function startTrackingAssignedCourier() {
  if (!mapAvailable) return;
  stopNearbyPolling();
  if (trackingTimer) clearInterval(trackingTimer);
  refreshAssignedCourierLocation();
  trackingTimer = setInterval(refreshAssignedCourierLocation, MAP_POLL_MS);
}

function stopTrackingAssignedCourier() {
  if (trackingTimer) clearInterval(trackingTimer);
  trackingTimer = null;
}
