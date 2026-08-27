/**
 * `FaceRecognitionNet` de face-api.js (la red que corre en el navegador del
 * domiciliario, ver frontend/courier/face.js) siempre devuelve un vector de
 * 128 números — es la dimensión fija de ese modelo, no una elección de
 * este proyecto.
 */
export const FACE_DESCRIPTOR_LENGTH = 128;

/**
 * Distancia por debajo de la cual dos descriptores se consideran la misma
 * persona. 0.6 es el umbral que recomienda la documentación de
 * face-api.js para `FaceRecognitionNet` (basado en el dataset con el que
 * se entrenó); no es un número inventado para este proyecto.
 */
export const DEFAULT_FACE_MATCH_THRESHOLD = 0.6;

export function loadFaceMatchThresholdFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.FACE_MATCH_THRESHOLD ?? DEFAULT_FACE_MATCH_THRESHOLD);
}

export class InvalidFaceDescriptorError extends Error {
  constructor(length: number) {
    super(`Se esperaba un descriptor facial de ${FACE_DESCRIPTOR_LENGTH} números, llegaron ${length}`);
    this.name = "InvalidFaceDescriptorError";
  }
}

function assertValidDescriptor(descriptor: number[]): void {
  if (descriptor.length !== FACE_DESCRIPTOR_LENGTH || descriptor.some((n) => !Number.isFinite(n))) {
    throw new InvalidFaceDescriptorError(descriptor.length);
  }
}

/**
 * Distancia euclidiana entre dos descriptores faciales. Toda la
 * "inteligencia" (detectar la cara, extraer el vector) ocurre client-side
 * en el navegador del domiciliario — el servidor solo hace esta cuenta
 * (una raíz cuadrada de sumas de cuadrados), sin ninguna dependencia de
 * TensorFlow ni de ninguna librería de ML. Ver docs/ARCHITECTURE.md para
 * la justificación de por qué la comparación final se valida acá y no se
 * confía en un booleano que reporte el cliente.
 */
export function euclideanDistance(a: number[], b: number[]): number {
  assertValidDescriptor(a);
  assertValidDescriptor(b);
  let sumSquares = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sumSquares += diff * diff;
  }
  return Math.sqrt(sumSquares);
}

export function isFaceMatch(
  reference: number[],
  live: number[],
  threshold: number = DEFAULT_FACE_MATCH_THRESHOLD
): boolean {
  return euclideanDistance(reference, live) <= threshold;
}
