import { isoDate } from "./date";
import { CourierTokenSigner } from "./courier-session";
import {
  DEFAULT_FACE_MATCH_THRESHOLD,
  euclideanDistance,
  isFaceMatch,
} from "./face-verification";
import { DispatchRepository } from "./repository";
import { PendingSettlementError, SettlementService } from "./settlement";
import { Courier } from "./types";

export class CourierNotFoundError extends Error {
  constructor(courierId: string) {
    super(`Domiciliario ${courierId} no encontrado`);
    this.name = "CourierNotFoundError";
  }
}

export class InvalidActivationCredentialError extends Error {
  constructor() {
    super("Número de cédula incorrecto");
    this.name = "InvalidActivationCredentialError";
  }
}

export class FaceReferenceMissingError extends Error {
  constructor() {
    super("Todavía no registraste tu rostro de referencia; hazlo antes de poder activarte");
    this.name = "FaceReferenceMissingError";
  }
}

export class FaceVerificationFailedError extends Error {
  constructor(public readonly distance: number, public readonly threshold: number) {
    super("La verificación facial no coincide con el rostro de referencia registrado");
    this.name = "FaceVerificationFailedError";
  }
}

/**
 * Prende/apaga la disponibilidad de un domiciliario desde su PWA.
 *
 * Activar requiere, en este orden:
 *  1. Su número de cédula (`Courier.nationalId`, ver §7).
 *  2. Una verificación facial en vivo que coincida con su rostro de
 *     referencia (`Courier.faceDescriptor`, ver §10) — la extracción del
 *     descriptor ocurre client-side en `face-api.js`; aquí solo se
 *     compara matemáticamente la distancia contra el umbral, nunca se
 *     confía en que el cliente reporte "coincide" sin verificarlo.
 *  3. No tener comisión pendiente de días anteriores (`SettlementService.canActivate`).
 *
 * Desactivarse (dejar de recibir pedidos) no requiere ninguna de las tres
 * — es una acción sobre la propia sesión.
 */
export class CourierActivationService {
  constructor(
    private readonly repo: DispatchRepository,
    private readonly tokens: CourierTokenSigner,
    private readonly settlements: SettlementService = new SettlementService(repo),
    private readonly now: () => Date = () => new Date(),
    private readonly faceMatchThreshold: number = DEFAULT_FACE_MATCH_THRESHOLD
  ) {}

  /**
   * Este es el único momento en que se sabe con certeza quién es la
   * persona (cédula + rostro en vivo ya verificados abajo), así que es
   * acá donde se emite el token de sesión que las demás rutas del
   * domiciliario van a exigir de ahí en adelante — ver
   * `CourierTokenSigner` y `requireCourierAuth`.
   */
  async activate(
    courierId: string,
    nationalId: string,
    liveFaceDescriptor: number[]
  ): Promise<{ courier: Courier; token: string }> {
    const courier = await this.repo.getCourier(courierId);
    if (!courier) throw new CourierNotFoundError(courierId);
    if (courier.nationalId !== nationalId) throw new InvalidActivationCredentialError();

    if (!courier.faceDescriptor) throw new FaceReferenceMissingError();
    const distance = euclideanDistance(courier.faceDescriptor, liveFaceDescriptor);
    if (!isFaceMatch(courier.faceDescriptor, liveFaceDescriptor, this.faceMatchThreshold)) {
      throw new FaceVerificationFailedError(distance, this.faceMatchThreshold);
    }

    const { allowed, pending } = await this.settlements.canActivate(courierId, isoDate(this.now()));
    if (!allowed) throw new PendingSettlementError(pending);

    const updated = await this.repo.setCourierActive(courierId, true);
    if (!updated) throw new CourierNotFoundError(courierId);
    return { courier: updated, token: this.tokens.sign(courierId) };
  }

  async deactivate(courierId: string): Promise<Courier> {
    const updated = await this.repo.setCourierActive(courierId, false);
    if (!updated) throw new CourierNotFoundError(courierId);
    return updated;
  }
}
