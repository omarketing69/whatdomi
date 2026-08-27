/**
 * Fecha en formato YYYY-MM-DD (UTC), usada como clave del día para la
 * liquidación diaria de comisiones. Simplificación consciente para el MVP:
 * usa un único huso horario (UTC) en vez del huso local de cada
 * domiciliario/ciudad — ver docs/ARCHITECTURE.md.
 */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
