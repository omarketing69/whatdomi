import { DispatchRepository } from "./repository";
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
 * `Courier.activationCode`); desactivarse (dejar de recibir pedidos) no
 * necesita código, es una acción sobre la propia sesión.
 */
export class CourierActivationService {
  constructor(private readonly repo: DispatchRepository) {}

  async activate(courierId: string, activationCode: string): Promise<Courier> {
    const courier = await this.repo.getCourier(courierId);
    if (!courier) throw new CourierNotFoundError(courierId);
    if (courier.activationCode !== activationCode) throw new InvalidActivationCodeError();

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
