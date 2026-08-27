import { GeocodingFailedError, GeocodingService } from "./geocoding";
import { DispatchRepository } from "./repository";
import { Business } from "./types";

/**
 * Puertos de infraestructura que necesita el login: hashear/verificar
 * contraseñas y firmar/verificar tokens de sesión. Se inyectan (en vez de
 * llamar directamente a bcryptjs/jsonwebtoken desde aquí) por la misma
 * razón que `DispatchRepository` es una interfaz — poder probar
 * `BusinessAuthService` sin depender de la implementación concreta, y
 * poder cambiarla (ej. sesiones en vez de JWT) sin tocar este archivo.
 */
export interface PasswordHasher {
  hash(plainPassword: string): Promise<string>;
  compare(plainPassword: string, hash: string): Promise<boolean>;
}

export interface TokenSigner {
  sign(businessId: string): string;
  /** Devuelve el payload si el token es válido y no expiró, o `null` si no. */
  verify(token: string): { businessId: string } | null;
}

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("Ya existe una cuenta registrada con ese email");
    this.name = "EmailAlreadyRegisteredError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Email o contraseña incorrectos");
    this.name = "InvalidCredentialsError";
  }
}

export class AddressNotFoundError extends Error {
  constructor(rawAddress: string) {
    super(`No se pudo ubicar la dirección del negocio: "${rawAddress}"`);
    this.name = "AddressNotFoundError";
  }
}

export interface RegisterBusinessInput {
  name: string;
  phone: string;
  email: string;
  password: string;
  /** Dirección en texto libre, igual que las direcciones de pedidos — se geocodifica una sola vez aquí. */
  address: string;
}

/**
 * Registro y login del negocio. Reemplaza el canal de WhatsApp: el
 * negocio ya no escribe un nombre por chat cada vez, sino que se
 * registra una vez (con su ubicación, que queda como punto de recogida
 * por defecto) y opera desde su dashboard autenticado — ver
 * `docs/ARCHITECTURE.md` §11.
 */
export class BusinessAuthService {
  constructor(
    private readonly repo: DispatchRepository,
    private readonly geocoding: GeocodingService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenSigner,
    private readonly locationContext: { city?: string; country?: string } = {}
  ) {}

  async register(input: RegisterBusinessInput): Promise<{ business: Business; token: string }> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.repo.getBusinessByEmail(email);
    if (existing) throw new EmailAlreadyRegisteredError();

    let resolved;
    try {
      resolved = await this.geocoding.resolve(input.address, this.locationContext);
    } catch (err) {
      if (err instanceof GeocodingFailedError) throw new AddressNotFoundError(input.address);
      throw err;
    }

    const passwordHash = await this.hasher.hash(input.password);
    const business = await this.repo.createBusiness({
      name: input.name,
      phone: input.phone,
      email,
      passwordHash,
      address: resolved.formattedAddress,
      location: { lat: resolved.lat, lng: resolved.lng },
    });

    return { business, token: this.tokens.sign(business.id) };
  }

  async login(rawEmail: string, password: string): Promise<{ business: Business; token: string }> {
    const email = rawEmail.trim().toLowerCase();
    const business = await this.repo.getBusinessByEmail(email);
    if (!business?.passwordHash) throw new InvalidCredentialsError();

    const matches = await this.hasher.compare(password, business.passwordHash);
    if (!matches) throw new InvalidCredentialsError();

    return { business, token: this.tokens.sign(business.id) };
  }
}

/** Nunca debe viajar al cliente el hash de la contraseña. */
export function toPublicBusiness(business: Business): Omit<Business, "passwordHash"> {
  const { passwordHash: _passwordHash, ...rest } = business;
  return rest;
}
