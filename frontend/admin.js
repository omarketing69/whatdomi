const API_BASE_URL = window.WHATDOMI_API_URL || "http://localhost:3000";
const POLL_MS = 4000;

const FILTERS = [
  { label: "Activos", statuses: ["CREATED", "QUOTED", "SEARCHING", "ASSIGNED", "IN_PROGRESS"] },
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
};

const filtersEl = document.getElementById("filters");
const containerEl = document.getElementById("orders-container");

let activeFilterIndex = 0;

FILTERS.forEach((filter, index) => {
  const btn = document.createElement("button");
  btn.textContent = filter.label;
  btn.className = index === activeFilterIndex ? "active" : "";
  btn.addEventListener("click", () => {
    activeFilterIndex = index;
    Array.from(filtersEl.children).forEach((child, i) => {
      child.className = i === index ? "active" : "";
    });
    loadOrders();
  });
  filtersEl.appendChild(btn);
});

async function apiFetch(path, options) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options && options.headers) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.toString?.() || `Error ${res.status}`);
  return body;
}

function formatMoney(order) {
  if (order.fare === null || order.fare === undefined) return "—";
  return `${order.fare} ${order.currency ?? ""}`.trim();
}

function renderOrders(orders) {
  if (orders.length === 0) {
    containerEl.innerHTML = '<p class="empty">No hay pedidos en este filtro.</p>';
    return;
  }

  const rows = orders
    .map((order) => {
      const canReassignOrCancel = !["DELIVERED", "CANCELLED", "NO_COURIERS_AVAILABLE"].includes(
        order.status
      );
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
                    <button data-action="reassign">Reasignar</button>
                    <button data-action="cancel" class="danger">Cancelar</button>
                  </div>`
                : ""
            }
          </td>
        </tr>`;
    })
    .join("");

  containerEl.innerHTML = `
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

  containerEl.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.closest("tr").dataset.orderId;
      const action = btn.dataset.action;
      btn.disabled = true;
      try {
        if (action === "reassign") {
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
    containerEl.innerHTML = `<p class="empty">Error cargando pedidos: ${err.message}</p>`;
  }
}

loadOrders();
setInterval(loadOrders, POLL_MS);
