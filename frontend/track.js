// Seguimiento público del pedido para el cliente final del negocio — sin
// cuenta, solo con el `orderId` que el negocio le comparte directamente.
// Consume el endpoint público `GET /api/orders/:id/track` (ver
// backend/src/api/routes/orders.ts), deliberadamente minimalista: no hay
// datos del negocio, del cliente ni de pagos, solo lo que hace falta para
// saber en qué va el pedido.
const API_BASE_URL = window.DOMI911_API_URL || "http://localhost:3000";
const LOCATION_POLL_MS = 4000;

const trackForm = document.getElementById("track-form");
const orderIdInput = document.getElementById("order-id-input");
const trackStatus = document.getElementById("track-status");
const resultSection = document.getElementById("result-section");
const orderSummary = document.getElementById("order-summary");
const courierContact = document.getElementById("courier-contact");
const mapSection = document.getElementById("map-section");
const mapHint = document.getElementById("map-hint");

let currentOrderId = null;
let locationTimer = null;

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

async function apiFetch(path) {
  const res = await fetch(`${API_BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.toString?.() || `Error ${res.status}`);
  return body;
}

trackForm.addEventListener("submit", (event) => {
  event.preventDefault();
  trackOrder(orderIdInput.value.trim());
});

async function trackOrder(orderId) {
  if (!orderId) return;
  stopLocationPolling();
  currentOrderId = orderId;
  trackStatus.textContent = "Buscando...";
  trackStatus.className = "status";
  resultSection.hidden = true;
  mapSection.hidden = true;

  try {
    const order = await apiFetch(`/api/orders/${orderId}/track`);
    trackStatus.textContent = "";
    renderOrder(order);
  } catch (err) {
    trackStatus.textContent = `No encontramos ese pedido: ${err.message}`;
    trackStatus.className = "status error";
  }
}

function renderOrder(order) {
  resultSection.hidden = false;
  const label = STATUS_LABELS[order.status] ?? order.status;
  orderSummary.innerHTML = `
    <span class="badge">${label}</span>
    <div><strong>Recogida:</strong> ${order.pickupAddress}</div>
    <div><strong>Entrega:</strong> ${order.dropoffAddress}</div>
  `;

  if (order.courier) {
    courierContact.hidden = false;
    courierContact.innerHTML = `
      <div><strong>Domiciliario:</strong> ${order.courier.name}</div>
      ${order.courier.vehiclePlate ? `<div><strong>Placa:</strong> ${order.courier.vehiclePlate}</div>` : ""}
      <div><strong>Teléfono:</strong> ${order.courier.phone}</div>
    `;
  } else {
    courierContact.hidden = true;
  }

  if (["ASSIGNED", "IN_PROGRESS"].includes(order.status)) {
    startLocationPolling();
  }
}

// --- Mapa: solo el punto en vivo del domiciliario (sin recogida/entrega,
// que el endpoint público no expone en coordenadas) — mismo Leaflet
// vendorizado que dashboard.js, ver docs/ARCHITECTURE.md §9.
const mapAvailable = typeof L !== "undefined";
if (!mapAvailable) {
  console.warn("[map] Leaflet no cargó; el mapa queda deshabilitado, el resto de la página sigue funcionando.");
}

let map = null;
let courierMarker = null;

const courierIcon = mapAvailable
  ? new L.DivIcon({
      className: "",
      html: '<div style="width:16px;height:16px;border-radius:50%;background:#f2701d;border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,.6);"></div>',
      iconSize: [16, 16],
    })
  : null;

async function refreshCourierLocation() {
  if (!mapAvailable || !currentOrderId) return;
  try {
    const { location } = await apiFetch(`/api/orders/${currentOrderId}/courier-location`);
    if (!location) return;

    mapSection.hidden = false;
    mapHint.textContent = "Ubicación en vivo de tu domiciliario.";
    const latlng = [location.lat, location.lng];
    if (!map) {
      map = L.map("map").setView(latlng, 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap",
        maxZoom: 19,
      }).addTo(map);
    }
    if (courierMarker) {
      courierMarker.setLatLng(latlng);
    } else {
      courierMarker = L.marker(latlng, { icon: courierIcon }).addTo(map).bindPopup("Tu domiciliario");
      map.setView(latlng, 15);
    }
  } catch {
    // Un fallo puntual de polling no debería interrumpir el resto de la página.
  }
}

function startLocationPolling() {
  if (!mapAvailable || locationTimer) return;
  refreshCourierLocation();
  locationTimer = setInterval(refreshCourierLocation, LOCATION_POLL_MS);
}

function stopLocationPolling() {
  if (locationTimer) clearInterval(locationTimer);
  locationTimer = null;
  if (map) map.remove();
  map = null;
  courierMarker = null;
}

// Si llegan por un link tipo track.html?id=<orderId> (el que el negocio le
// comparte al cliente), busca directo sin que tenga que volver a escribirlo.
const idFromQuery = new URLSearchParams(window.location.search).get("id");
if (idFromQuery) {
  orderIdInput.value = idFromQuery;
  trackOrder(idFromQuery);
}
