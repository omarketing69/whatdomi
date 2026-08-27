// Frontend mínimo, sin build step: se puede abrir directamente o servir con
// cualquier servidor estático. Configura la URL del backend con
// `window.WHATDOMI_API_URL` (ver config.js) o cae por defecto a localhost:3000.
const API_BASE_URL = window.WHATDOMI_API_URL || "http://localhost:3000";
const STORAGE_KEY = "whatdomi.businessId";
const MAP_POLL_MS = 4000;
// Mismo radio por defecto que usa el backend para buscar domiciliarios (SEARCH_RADIUS_METERS).
const NEARBY_RADIUS_METERS = 5000;

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

// --- Mapa: domiciliarios cercanos antes de asignar, trayecto del asignado después ---
// Leaflet + tiles de OpenStreetMap: gratis, sin API key, coherente con Nominatim/OSM que
// ya se usa para geocodificar direcciones por WhatsApp (ver docs/ARCHITECTURE.md §5, §9).
// Vendorizado en frontend/vendor/leaflet (no un CDN) para no depender de que un tercero
// externo esté disponible en cada carga. Aun así, si por lo que sea Leaflet no cargó
// (`L` no definido), el mapa se omite en silencio: pedir un domicilio no debe depender
// de que el mapa funcione.
const mapAvailable = typeof L !== "undefined";
if (!mapAvailable) {
  console.warn("[map] Leaflet no cargó; el mapa queda deshabilitado, el resto de la página sigue funcionando.");
  const mapHint = document.getElementById("map-hint");
  if (mapHint) mapHint.textContent = "Mapa no disponible en este momento.";
}

let map = null;
let pickupMarker = null;
let courierMarkersById = new Map();
let assignedMarker = null;
let trajectoryLine = null;
let pickupPoint = null;
let nearbyTimer = null;
let trackingTimer = null;

const courierIcon = mapAvailable
  ? new L.DivIcon({
      className: "",
      html: '<div style="width:12px;height:12px;border-radius:50%;background:#16794f;border:2px solid white;box-shadow:0 0 2px rgba(0,0,0,.5);"></div>',
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
  pickupPoint = { lat, lng }; // se guarda igual sin mapa: startTrackingAssignedCourier lo necesita.
  if (!mapAvailable) return;
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
  startNearbyPolling();
}

async function refreshNearbyCouriers() {
  if (!mapAvailable || !pickupPoint) return;
  try {
    const { couriers } = await apiFetch(
      `/api/couriers/nearby?lat=${pickupPoint.lat}&lng=${pickupPoint.lng}&radiusMeters=${NEARBY_RADIUS_METERS}`
    );
    const seenIds = new Set();
    for (const courier of couriers) {
      seenIds.add(courier.id);
      const existing = courierMarkersById.get(courier.id);
      if (existing) {
        existing.setLatLng([courier.lat, courier.lng]);
      } else {
        const marker = L.marker([courier.lat, courier.lng], { icon: courierIcon })
          .addTo(map)
          .bindPopup(courier.name);
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

async function refreshAssignedCourierLocation() {
  if (!mapAvailable || !currentOrderId || !pickupPoint) return;
  try {
    const { location } = await apiFetch(`/api/orders/${currentOrderId}/courier-location`);
    if (!location) return;

    const latlng = [location.lat, location.lng];
    if (assignedMarker) {
      assignedMarker.setLatLng(latlng);
    } else {
      assignedMarker = L.marker(latlng, { icon: assignedIcon }).addTo(map).bindPopup("Tu domiciliario");
    }

    const pickupLatLng = [pickupPoint.lat, pickupPoint.lng];
    if (trajectoryLine) {
      trajectoryLine.setLatLngs([latlng, pickupLatLng]);
    } else {
      trajectoryLine = L.polyline([latlng, pickupLatLng], { color: "#16794f", dashArray: "6 6" }).addTo(map);
    }
    map.fitBounds([latlng, pickupLatLng], { padding: [30, 30] });
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

function handlePickupInputChange() {
  const lat = Number(orderForm.pickupLat.value);
  const lng = Number(orderForm.pickupLng.value);
  if (Number.isFinite(lat) && Number.isFinite(lng) && orderForm.pickupLat.value && orderForm.pickupLng.value) {
    setPickupPoint(lat, lng);
  }
}

orderForm.pickupLat.addEventListener("change", handlePickupInputChange);
orderForm.pickupLng.addEventListener("change", handlePickupInputChange);

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
      handlePickupInputChange();
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
  QUOTED: "Cotizado",
  SEARCHING: "Buscando domiciliario",
  ASSIGNED: "Domiciliario asignado",
  IN_PROGRESS: "En camino",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
  NO_COURIERS_AVAILABLE: "Sin domiciliarios disponibles cerca",
  UNASSIGNED: "Nadie aceptó a tiempo, un administrador lo asignará",
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

  if (["ASSIGNED", "IN_PROGRESS"].includes(order.status)) {
    if (!trackingTimer) startTrackingAssignedCourier();
  } else {
    stopTrackingAssignedCourier();
  }
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
        stopTrackingAssignedCourier();
      }
    } catch {
      // Si el pedido deja de estar disponible momentáneamente, no interrumpe el polling.
    }
  }, 3000);
}
