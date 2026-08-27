import { DispatchRepository } from "./repository";
import { CourierSettlement } from "./types";

export class PendingSettlementError extends Error {
  constructor(public readonly pending: CourierSettlement[]) {
    super(
      `Tiene comisión pendiente de días anteriores: ` +
        pending.map((s) => `${s.date} (${s.commissionAmount})`).join(", ")
    );
    this.name = "PendingSettlementError";
  }
}

export class SettlementNotFoundError extends Error {
  constructor(courierId: string, date: string) {
    super(`No hay liquidación para el domiciliario ${courierId} en ${date}`);
    this.name = "SettlementNotFoundError";
  }
}

/**
 * Liquidación diaria de comisión: cuánto le cobra la plataforma a cada
 * domiciliario sobre lo que cobró ese día, y si ya la pagó. Es la
 * condición para poder activarse al día siguiente — ver `canActivate`.
 *
 * El pago en sí es manual/offline (igual que el cobro del servicio): esta
 * clase solo lleva el registro y el estado, no procesa ningún cobro.
 */
export class SettlementService {
  constructor(private readonly repo: DispatchRepository) {}

  /**
   * Recalcula la liquidación del día a partir de los pedidos entregados
   * ese día por ese domiciliario, usando la comisión vigente en
   * `PlatformConfig`. Se llama cada vez que se entrega un pedido
   * (`DispatchService.markDelivered`), así que la liquidación de "hoy"
   * siempre refleja las entregas hechas hasta el momento.
   *
   * Si la liquidación de ese día ya está `PAID`, no se toca: queda
   * congelada con los números de cuando se pagó, así el admin no ve un
   * monto "pendiente" reaparecer por una entrega tardía del mismo día.
   * (Ver docs/ARCHITECTURE.md §7 para la implicación de este trade-off.)
   */
  async recomputeSettlement(courierId: string, date: string): Promise<CourierSettlement> {
    const existing = await this.repo.getSettlement(courierId, date);
    if (existing?.status === "PAID") return existing;

    const orders = await this.repo.listDeliveredOrders({ courierId, date });
    const serviceCount = orders.length;
    const totalEarned = orders.reduce((sum, order) => sum + (order.fare ?? 0), 0);

    const config = await this.repo.getPlatformConfig();
    const commissionAmount = Math.round((totalEarned * config.commissionPercentage) / 100);

    return this.repo.upsertSettlement(courierId, date, {
      serviceCount,
      totalEarned,
      commissionPercentage: config.commissionPercentage,
      commissionAmount,
    });
  }

  /**
   * Un domiciliario puede activarse hoy solo si no tiene ninguna
   * liquidación `PENDING` de un día *anterior* a hoy. La liquidación de
   * hoy mismo (si ya trabajó algo hoy) nunca bloquea: el bloqueo es por
   * comisión de días pasados sin pagar, no del día en curso.
   */
  async canActivate(
    courierId: string,
    today: string
  ): Promise<{ allowed: boolean; pending: CourierSettlement[] }> {
    const pending = await this.repo.listPendingSettlementsBefore(courierId, today);
    return { allowed: pending.length === 0, pending };
  }

  async markPaid(courierId: string, date: string): Promise<CourierSettlement> {
    const updated = await this.repo.markSettlementPaid(courierId, date);
    if (!updated) throw new SettlementNotFoundError(courierId, date);
    return updated;
  }
}
