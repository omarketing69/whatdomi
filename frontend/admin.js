const API_BASE_URL = window.DOMI911_API_URL || "http://localhost:3000";
const POLL_MS = 4000;
const ADMIN_KEY_STORAGE = "domi911.adminKey";

const FILTERS = [
  { label: "Activos", statuses: ["CREATED", "QUOTED", "SEARCHING", "ASSIGNED", "IN_PROGRESS"] },
  { label: "Sin asignar (necesitan acción)", statuses: ["UNASSIGNED"] },
  { label: "Entregados", statuses: ["DELIVERED"] },
  { label: "Cancelados / sin domiciliario", statuses: ["CANCELLED", "NO_COURIERS_AVAILABLE"] },
  { label: "Todos", statuses: [] },
];

const STATUS_LABELS = {
  CREATED: "Creado",
  QUOTED: "Cotizado",
  SEARCHING: "Buscando domiciliario",
  ASSIGNED: "Asignado",
  IN_PROGRESS: "En camino",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
  NO_COURIERS_AVAILABLE: "Sin domiciliarios",
  UNASSIGNED: "Sin asignar (nadie aceptó a tiempo)",
};

const STATS_RANGES = [
  { label: "Hoy", value: "day" },
  { label: "Últimos 7 días", value: "week" },
];

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function getAdminKey() {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || "";
}

async function apiFetch(path, options) {
  const adminKey = getAdminKey();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(adminKey ? { "X-Admin-Key": adminKey } : {}),
      ...(options && options.headers),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.toString?.() || `Error ${res.status}`);
  return body;
}

// --- Clave de administrador ---
const adminKeyForm = document.getElementById("admin-key-form");
const adminKeyInput = document.getElementById("admin-key-input");
adminKeyInput.value = getAdminKey();
adminKeyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  localStorage.setItem(ADMIN_KEY_STORAGE, adminKeyInput.value.trim());
  loadEverything();
});

// --- Estadísticas ---
const statsGridEl = document.getElementById("stats-grid");
const statsRangeFiltersEl = document.getElementById("stats-range-filters");
let activeStatsRange = "day";

STATS_RANGES.forEach((range, index) => {
  const btn = document.createElement("button");
  btn.textContent = range.label;
  btn.className = index === 0 ? "active" : "";
  btn.addEventListener("click", () => {
    activeStatsRange = range.value;
    Array.from(statsRangeFiltersEl.children).forEach((child, i) => (child.className = i === index ? "active" : ""));
    loadStats();
  });
  statsRangeFiltersEl.appendChild(btn);
});

async function loadStats() {
  try {
    const stats = await apiFetch(`/api/admin/stats?range=${activeStatsRange}`);
    statsGridEl.innerHTML = `
      <div class="stat-card"><div class="value">${stats.serviceCount}</div><div class="label">Servicios entregados</div></div>
      <div class="stat-card"><div class="value">${stats.totalRevenue} ${stats.currency}</div><div class="label">Total cobrado</div></div>
      <div class="stat-card"><div class="value">${stats.totalCommission} ${stats.currency}</div><div class="label">Comisión de la plataforma (aprox.)</div></div>
    `;
  } catch (err) {
    statsGridEl.innerHTML = `<p class="empty">Error: ${err.message}</p>`;
  }
}

// --- Configuración de tarifas/comisión ---
const configForm = document.getElementById("config-form");
const configStatus = document.getElementById("config-status");

async function loadConfig() {
  try {
    const { config } = await apiFetch("/api/admin/config");
    configForm.baseFare.value = config.baseFare;
    configForm.pricePerKm.value = config.pricePerKm;
    configForm.minFare.value = config.minFare;
    configForm.commissionPercentage.value = config.commissionPercentage;
    configForm.currency.value = config.currency;
  } catch (err) {
    configStatus.textContent = `No se pudo cargar la configuración: ${err.message}`;
    configStatus.className = "status error";
  }
}

configForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = Object.fromEntries(new FormData(configForm).entries());
  const payload = {
    baseFare: Number(raw.baseFare),
    pricePerKm: Number(raw.pricePerKm),
    minFare: Number(raw.minFare),
    commissionPercentage: Number(raw.commissionPercentage),
    currency: raw.currency,
  };
  try {
    configStatus.textContent = "Guardando...";
    configStatus.className = "status";
    await apiFetch("/api/admin/config", { method: "PUT", body: JSON.stringify(payload) });
    configStatus.textContent = "Configuración actualizada.";
    configStatus.className = "status ok";
    loadStats();
  } catch (err) {
    configStatus.textContent = `No se pudo guardar: ${err.message}`;
    configStatus.className = "status error";
  }
});

// --- Liquidaciones y registro de servicios por día ---
const settlementsDateInput = document.getElementById("settlements-date");
const settlementsContainer = document.getElementById("settlements-container");
const serviceLogContainer = document.getElementById("service-log-container");
settlementsDateInput.value = todayISODate();
settlementsDateInput.addEventListener("change", () => {
  loadSettlements();
  loadServiceLog();
});

async function loadSettlements() {
  const date = settlementsDateInput.value || todayISODate();
  try {
    const { settlements } = await apiFetch(`/api/admin/settlements?date=${date}`);
    if (settlements.length === 0) {
      settlementsContainer.innerHTML = '<p class="empty">Sin liquidaciones para este día todavía.</p>';
      return;
    }
    const rows = settlements
      .map(
        (s) => `
        <tr>
          <td>${s.courierName ?? s.courierId}</td>
          <td>${s.serviceCount}</td>
          <td>${s.totalEarned} </td>
          <td>${s.commissionPercentage}%</td>
          <td>${s.commissionAmount}</td>
          <td class="${s.status === "PAID" ? "badge-paid" : "badge-pending"}">${s.status === "PAID" ? "Pagada" : "Pendiente"}</td>
          <td>${
            s.status === "PENDING"
              ? `<button data-courier="${s.courierId}" data-date="${s.date}" class="pay-btn">Marcar pagada</button>`
              : "—"
          }</td>
        </tr>`
      )
      .join("");
    settlementsContainer.innerHTML = `
      <table>
        <thead><tr><th>Domiciliario</th><th>Servicios</th><th>Total cobrado</th><th>% Comisión</th><th>Comisión</th><th>Estado</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    settlementsContainer.querySelectorAll(".pay-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await apiFetch(`/api/admin/settlements/${btn.dataset.courier}/${btn.dataset.date}/pay`, {
            method: "POST",
          });
          await loadSettlements();
        } catch (err) {
          alert(`No se pudo marcar como pagada: ${err.message}`);
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    settlementsContainer.innerHTML = `<p class="empty">Error: ${err.message}</p>`;
  }
}

async function loadServiceLog() {
  const date = settlementsDateInput.value || todayISODate();
  try {
    const { services } = await apiFetch(`/api/admin/service-log?date=${date}`);
    if (services.length === 0) {
      serviceLogContainer.innerHTML = '<p class="empty">Sin servicios entregados este día.</p>';
      return;
    }
    const rows = services
      .map(
        (s) => `
        <tr>
          <td>${new Date(s.deliveredAt).toLocaleTimeString()}</td>
          <td>${s.courierName ?? "—"}</td>
          <td>${s.pickupAddress}</td>
          <td>${s.dropoffAddress}</td>
          <td>${s.fare ?? "—"} ${s.currency ?? ""}</td>
        </tr>`
      )
      .join("");
    serviceLogContainer.innerHTML = `
      <table>
        <thead><tr><th>Hora</th><th>Domiciliario</th><th>Recogida</th><th>Entrega</th><th>Tarifa</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch (err) {
    serviceLogContainer.innerHTML = `<p class="empty">Error: ${err.message}</p>`;
  }
}

// --- Pedidos en vivo (monitoreo + reasignar/cancelar) ---
const filtersEl = document.getElementById("filters");
const ordersContainerEl = document.getElementById("orders-container");
let activeFilterIndex = 0;

FILTERS.forEach((filter, index) => {
  const btn = document.createElement("button");
  btn.textContent = filter.label;
  btn.className = index === activeFilterIndex ? "active" : "";
  btn.addEventListener("click", () => {
    activeFilterIndex = index;
    Array.from(filtersEl.children).forEach((child, i) => (child.className = i === index ? "active" : ""));
    loadOrders();
  });
  filtersEl.appendChild(btn);
});

function formatMoney(order) {
  if (order.fare === null || order.fare === undefined) return "—";
  return `${order.fare} ${order.currency ?? ""}`.trim();
}

function renderOrders(orders) {
  if (orders.length === 0) {
    ordersContainerEl.innerHTML = '<p class="empty">No hay pedidos en este filtro.</p>';
    return;
  }

  const rows = orders
    .map((order) => {
      const canReassignOrCancel = !["DELIVERED", "CANCELLED", "NO_COURIERS_AVAILABLE"].includes(order.status);
      const isUnassigned = order.status === "UNASSIGNED";
      return `
        <tr data-order-id="${order.id}">
          <td>${new Date(order.createdAt).toLocaleString()}</td>
          <td>${order.requesterName ?? "—"}</td>
          <td>${order.pickupAddress}</td>
          <td>${order.dropoffAddress}</td>
          <td>${formatMoney(order)}</td>
          <td>${STATUS_LABELS[order.status] ?? order.status}</td>
          <td>${order.courierId ?? "—"}</td>
          <td>
            ${
              canReassignOrCancel
                ? `<div class="row-actions">
                    ${isUnassigned ? '<button data-action="assign">Asignar</button>' : ""}
                    <button data-action="reassign">${isUnassigned ? "Reintentar automático" : "Reasignar"}</button>
                    <button data-action="cancel" class="danger">Cancelar</button>
                  </div>`
                : ""
            }
          </td>
        </tr>`;
    })
    .join("");

  ordersContainerEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Fecha</th><th>Solicitante</th><th>Recogida</th><th>Entrega</th>
          <th>Tarifa</th><th>Estado</th><th>Domiciliario</th><th>Acciones</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  ordersContainerEl.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.closest("tr").dataset.orderId;
      const action = btn.dataset.action;
      btn.disabled = true;
      try {
        if (action === "assign") {
          const courierId = prompt("ID del domiciliario a asignar manualmente:");
          if (!courierId) {
            btn.disabled = false;
            return;
          }
          await apiFetch(`/api/orders/${orderId}/assign`, {
            method: "POST",
            body: JSON.stringify({ courierId: courierId.trim() }),
          });
        } else if (action === "reassign") {
          await apiFetch(`/api/orders/${orderId}/reassign`, { method: "POST" });
        } else if (action === "cancel") {
          if (!confirm("¿Cancelar este pedido?")) {
            btn.disabled = false;
            return;
          }
          await apiFetch(`/api/orders/${orderId}/cancel`, { method: "POST" });
        }
        await loadOrders();
      } catch (err) {
        alert(`No se pudo completar la acción: ${err.message}`);
        btn.disabled = false;
      }
    });
  });
}

async function loadOrders() {
  const filter = FILTERS[activeFilterIndex];
  const query = filter.statuses.length > 0 ? `?status=${filter.statuses.join(",")}` : "";
  try {
    const { orders } = await apiFetch(`/api/orders${query}`);
    renderOrders(orders);
  } catch (err) {
    ordersContainerEl.innerHTML = `<p class="empty">Error cargando pedidos: ${err.message}</p>`;
  }
}

function loadEverything() {
  loadStats();
  loadConfig();
  loadSettlements();
  loadServiceLog();
  loadOrders();
}

loadEverything();
setInterval(() => {
  loadOrders();
  loadStats();
}, POLL_MS);
