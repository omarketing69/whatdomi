import bcrypt from "bcryptjs";
import { PasswordHasher } from "../domain/business-auth";

/**
 * `bcryptjs` en vez de `bcrypt`: es una implementación en JS puro, sin
 * binarios nativos que compilar — mismo motivo que llevó a elegir `pg`
 * sobre un ORM en este proyecto (ver docs/ARCHITECTURE.md §3), aplicado
 * de nuevo aquí para no arriesgar el build en un entorno con red
 * restringida.
 */
export function createBcryptPasswordHasher(cost = 10): PasswordHasher {
  return {
    hash: (plainPassword) => bcrypt.hash(plainPassword, cost),
    compare: (plainPassword, hash) => bcrypt.compare(plainPassword, hash),
  };
}
