import { isoDate } from "./date";
import { DispatchRepository } from "./repository";
import { PendingSettlementError, SettlementService } from "./settlement";
import { Courier } from "./types";

export class CourierNotFoundError extends Error {
  constructor(courierId: string) {
    super(`Domiciliario ${courierId} no encontrado`);
    this.name = "CourierNotFoundError";
  }
}

export class InvalidActivationCodeError extends Error {
  constructor() {
    super("Código de activación incorrecto");
    this.name = "InvalidActivationCodeError";
  }
}

/**
 * Prende/apaga la disponibilidad de un domiciliario desde su PWA.
 * Activar requiere el código que se le entregó al registrarse (ver
 * `Courier.activationCode`) Y no tener comisión pendiente de días
 * anteriores (ver `SettlementService.canActivate`); desactivarse (dejar de
 * recibir pedidos) no necesita ni código ni estar al día, es una acción
 * sobre la propia sesión.
 */
export class CourierActivationService {
  constructor(
    private readonly repo: DispatchRepository,
    private readonly settlements: SettlementService = new SettlementService(repo),
    private readonly now: () => Date = () => new Date()
  ) {}

  async activate(courierId: string, activationCode: string): Promise<Courier> {
    const courier = await this.repo.getCourier(courierId);
    if (!courier) throw new CourierNotFoundError(courierId);
    if (courier.activationCode !== activationCode) throw new InvalidActivationCodeError();

    const { allowed, pending } = await this.settlements.canActivate(courierId, isoDate(this.now()));
    if (!allowed) throw new PendingSettlementError(pending);

    const updated = await this.repo.setCourierActive(courierId, true);
    if (!updated) throw new CourierNotFoundError(courierId);
    return updated;
  }

  async deactivate(courierId: string): Promise<Courier> {
    const updated = await this.repo.setCourierActive(courierId, false);
    if (!updated) throw new CourierNotFoundError(courierId);
    return updated;
  }
}
