import { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { DispatchNotifier } from "../domain/dispatch";
import { CourierWithDistance, Order } from "../domain/types";

/**
 * Cada domiciliario, al conectar su app, se une a la sala `courier:<id>`.
 * Así el servidor puede notificar solo a los candidatos relevantes en vez
 * de hacer broadcast a todos los sockets conectados.
 */
export function courierRoom(courierId: string): string {
  return `courier:${courierId}`;
}

/** Los negocios se unen a `order:<id>` para seguir el estado de su pedido en vivo. */
export function orderRoom(orderId: string): string {
  return `order:${orderId}`;
}

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN ?? "*" },
  });

  io.on("connection", (socket) => {
    socket.on("courier:subscribe", (courierId: string) => {
      socket.join(courierRoom(courierId));
    });

    socket.on("order:subscribe", (orderId: string) => {
      socket.join(orderRoom(orderId));
    });
  });

  return io;
}

/** Traduce los eventos de negocio del DispatchService a eventos de socket. */
export function createSocketNotifier(io: SocketIOServer): DispatchNotifier {
  return {
    onOrderOffered(order: Order, candidates: CourierWithDistance[]) {
      for (const candidate of candidates) {
        io.to(courierRoom(candidate.id)).emit("order:offer", {
          order,
          distanceMeters: candidate.distanceMeters,
        });
      }
      io.to(orderRoom(order.id)).emit("order:status", order);
    },
    /** El candidato al que le tocaba el turno no respondió a tiempo: se le retira la oferta de su propia sala. */
    onOfferExpired(order: Order, courierId: string) {
      io.to(courierRoom(courierId)).emit("order:offer-cancelled", { orderId: order.id });
    },
    onOrderAssigned(order: Order, winnerCourierId: string) {
      io.to(orderRoom(order.id)).emit("order:status", order);
      io.to(courierRoom(winnerCourierId)).emit("order:won", order);
    },
    onOrderStatusChanged(order: Order) {
      io.to(orderRoom(order.id)).emit("order:status", order);
    },
    onNoCouriersAvailable(order: Order) {
      io.to(orderRoom(order.id)).emit("order:status", order);
    },
    onOrderUnassigned(order: Order) {
      io.to(orderRoom(order.id)).emit("order:status", order);
    },
  };
}
