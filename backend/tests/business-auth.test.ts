import { describe, expect, it } from "vitest";
import request from "supertest";
import { GeocodeResult, GeocodingProvider, GeocodingService } from "../src/domain/geocoding";
import { NoopNormalizer, makeApp } from "./helpers/make-app";

class FixedProvider implements GeocodingProvider {
  constructor(private readonly result: GeocodeResult | null) {}
  async geocode(): Promise<GeocodeResult | null> {
    return this.result;
  }
}

const FIXED_ADDRESS: GeocodeResult = { lat: 4.65, lng: -74.08, formattedAddress: "Calle 100 #10-10, Bogotá" };

function makeAppWithGeocoding(result: GeocodeResult | null) {
  const geocoding = new GeocodingService(new NoopNormalizer(), new FixedProvider(result));
  return makeApp({ geocoding });
}

describe("POST /api/auth/register", () => {
  it("registra un negocio nuevo, geocodifica su dirección una sola vez, y devuelve un token", async () => {
    const { app } = makeAppWithGeocoding(FIXED_ADDRESS);

    const res = await request(app).post("/api/auth/register").send({
      name: "Restaurante La Esquina",
      phone: "+573000000001",
      email: "dueno@laesquina.com",
      password: "clave-super-secreta",
      address: "frente al parque central",
    });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.business.email).toBe("dueno@laesquina.com");
    expect(res.body.business.location).toEqual({ lat: FIXED_ADDRESS.lat, lng: FIXED_ADDRESS.lng });
    expect(res.body.business.address).toBe(FIXED_ADDRESS.formattedAddress);
    // Nunca debe viajar el hash de la contraseña al cliente.
    expect(res.body.business.passwordHash).toBeUndefined();
  });

  it("rechaza un registro con email ya usado", async () => {
    const { app } = makeAppWithGeocoding(FIXED_ADDRESS);
    const payload = {
      name: "Negocio",
      phone: "+573000000002",
      email: "repetido@negocio.com",
      password: "clave-super-secreta",
      address: "cerca de la iglesia",
    };

    await request(app).post("/api/auth/register").send(payload);
    const second = await request(app).post("/api/auth/register").send(payload);

    expect(second.status).toBe(409);
  });

  it("422 si no se pudo geocodificar la dirección del negocio", async () => {
    const { app } = makeAppWithGeocoding(null);

    const res = await request(app).post("/api/auth/register").send({
      name: "Negocio",
      phone: "+573000000003",
      email: "sin-direccion@negocio.com",
      password: "clave-super-secreta",
      address: "una dirección que no existe en ningún mapa",
    });

    expect(res.status).toBe(422);
  });

  it("400 con contraseña demasiado corta", async () => {
    const { app } = makeAppWithGeocoding(FIXED_ADDRESS);
    const res = await request(app).post("/api/auth/register").send({
      name: "Negocio",
      phone: "+573000000004",
      email: "corta@negocio.com",
      password: "123",
      address: "cualquier dirección",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("loguea con email/contraseña correctos y devuelve un token", async () => {
    const { app } = makeAppWithGeocoding(FIXED_ADDRESS);
    await request(app).post("/api/auth/register").send({
      name: "Negocio",
      phone: "+573000000005",
      email: "login@negocio.com",
      password: "clave-super-secreta",
      address: "dirección válida",
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "login@negocio.com", password: "clave-super-secreta" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("401 con contraseña incorrecta", async () => {
    const { app } = makeAppWithGeocoding(FIXED_ADDRESS);
    await request(app).post("/api/auth/register").send({
      name: "Negocio",
      phone: "+573000000006",
      email: "malaclave@negocio.com",
      password: "clave-correcta-123",
      address: "dirección válida",
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "malaclave@negocio.com", password: "clave-incorrecta" });

    expect(res.status).toBe(401);
  });

  it("401 con un email que no existe", async () => {
    const { app } = makeAppWithGeocoding(FIXED_ADDRESS);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "no-existe@negocio.com", password: "lo-que-sea" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("401 sin token", async () => {
    const { app } = makeAppWithGeocoding(FIXED_ADDRESS);
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("devuelve el perfil del negocio autenticado con un token válido", async () => {
    const { app } = makeAppWithGeocoding(FIXED_ADDRESS);
    const registerRes = await request(app).post("/api/auth/register").send({
      name: "Negocio Perfil",
      phone: "+573000000007",
      email: "perfil@negocio.com",
      password: "clave-super-secreta",
      address: "dirección válida",
    });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${registerRes.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.business.name).toBe("Negocio Perfil");
  });

  it("401 con un token con formato inválido", async () => {
    const { app } = makeAppWithGeocoding(FIXED_ADDRESS);
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer token-inventado");
    expect(res.status).toBe(401);
  });
});
