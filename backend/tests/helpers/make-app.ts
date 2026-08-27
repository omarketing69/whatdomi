import { CreateAppDeps, createApp } from "../../src/api/app";
import { BusinessAuthService } from "../../src/domain/business-auth";
import { DispatchService, DispatchServiceOptions } from "../../src/domain/dispatch";
import { AddressNormalizer, GeocodeResult, GeocodingProvider, GeocodingService } from "../../src/domain/geocoding";
import { createBcryptPasswordHasher } from "../../src/infra/password-hasher";
import { createJwtTokenSigner } from "../../src/infra/jwt-token-signer";
import { InMemoryDispatchRepository } from "../../src/testing/in-memory-repository";

export class NoopNormalizer implements AddressNormalizer {
  async normalize(rawText: string): Promise<string> {
    return rawText;
  }
}

export class NoopProvider implements GeocodingProvider {
  async geocode(): Promise<GeocodeResult | null> {
    return null;
  }
}

/** Costo bajo a propósito: bcrypt real, pero rápido para no aletargar la suite de tests. */
const TEST_BCRYPT_COST = 4;
const TEST_JWT_SECRET = "test-secret-no-usar-en-produccion";

/**
 * Arma un `Express` completo con el repositorio en memoria, listo para
 * pruebas de ruta con supertest — mismo objeto de dependencias que arma
 * `server.ts` en producción, con el geocodificador reemplazado por un
 * stub (sin red real) salvo que el test pase el suyo.
 */
export function makeApp(options?: {
  repo?: InMemoryDispatchRepository;
  dispatchOptions?: DispatchServiceOptions;
  geocoding?: GeocodingService;
}) {
  const repo = options?.repo ?? new InMemoryDispatchRepository();
  const dispatch = new DispatchService(repo, options?.dispatchOptions);
  const geocoding = options?.geocoding ?? new GeocodingService(new NoopNormalizer(), new NoopProvider());
  const tokens = createJwtTokenSigner(TEST_JWT_SECRET);
  const businessAuth = new BusinessAuthService(repo, geocoding, createBcryptPasswordHasher(TEST_BCRYPT_COST), tokens);

  const deps: CreateAppDeps = { repo, dispatch, businessAuth, tokens, geocoding };
  const app = createApp(deps);
  return { repo, dispatch, geocoding, tokens, businessAuth, app };
}
