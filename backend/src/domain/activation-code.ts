/**
 * Código numérico de 6 dígitos que un domiciliario usa para activarse desde
 * la PWA (ver Courier.activationCode). No es un mecanismo de seguridad
 * fuerte -no hay hash, no expira, no rota- pero es suficiente para el MVP:
 * evita que cualquiera "active" la sesión de otro domiciliario sin conocer
 * el código que se le entregó al registrarse.
 */
export function generateActivationCode(): string {
  return Math.floor(100_000 + Math.random() * 900_000).toString();
}
