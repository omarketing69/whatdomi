import { describe, expect, it } from "vitest";
import {
  DEFAULT_FACE_MATCH_THRESHOLD,
  euclideanDistance,
  FACE_DESCRIPTOR_LENGTH,
  InvalidFaceDescriptorError,
  isFaceMatch,
  loadFaceMatchThresholdFromEnv,
} from "../src/domain/face-verification";

function makeDescriptor(fill: number): number[] {
  return Array(FACE_DESCRIPTOR_LENGTH).fill(fill);
}

describe("euclideanDistance", () => {
  it("es 0 para descriptores idénticos", () => {
    const d = makeDescriptor(0.5);
    expect(euclideanDistance(d, d)).toBe(0);
  });

  it("crece con la diferencia entre descriptores", () => {
    const a = makeDescriptor(0);
    const bClose = [...makeDescriptor(0)];
    bClose[0] = 0.1;
    const bFar = [...makeDescriptor(0)];
    bFar[0] = 5;

    expect(euclideanDistance(a, bClose)).toBeLessThan(euclideanDistance(a, bFar));
  });

  it("rechaza descriptores con una longitud distinta a 128", () => {
    expect(() => euclideanDistance(makeDescriptor(0), [1, 2, 3])).toThrow(InvalidFaceDescriptorError);
  });

  it("rechaza descriptores con valores no finitos (NaN/Infinity)", () => {
    const bad = makeDescriptor(0);
    bad[10] = NaN;
    expect(() => euclideanDistance(makeDescriptor(0), bad)).toThrow(InvalidFaceDescriptorError);
  });
});

describe("isFaceMatch", () => {
  it("acepta cuando la distancia está dentro del umbral", () => {
    const reference = makeDescriptor(0);
    const live = [...reference];
    live[0] = 0.05; // distancia pequeña
    expect(isFaceMatch(reference, live, DEFAULT_FACE_MATCH_THRESHOLD)).toBe(true);
  });

  it("rechaza cuando la distancia supera el umbral", () => {
    const reference = makeDescriptor(0);
    const live = makeDescriptor(2); // distancia grande: sqrt(128 * 4) ≈ 22.6
    expect(isFaceMatch(reference, live, DEFAULT_FACE_MATCH_THRESHOLD)).toBe(false);
  });

  it("respeta un umbral configurado explícitamente", () => {
    const reference = makeDescriptor(0);
    const live = [...reference];
    live[0] = 0.5;
    const distance = euclideanDistance(reference, live);

    expect(isFaceMatch(reference, live, distance + 0.01)).toBe(true);
    expect(isFaceMatch(reference, live, distance - 0.01)).toBe(false);
  });
});

describe("loadFaceMatchThresholdFromEnv", () => {
  it("usa el valor por defecto documentado por face-api.js si no hay variable de entorno", () => {
    expect(loadFaceMatchThresholdFromEnv({})).toBe(DEFAULT_FACE_MATCH_THRESHOLD);
  });

  it("lee un valor configurado por entorno", () => {
    expect(loadFaceMatchThresholdFromEnv({ FACE_MATCH_THRESHOLD: "0.45" } as NodeJS.ProcessEnv)).toBe(0.45);
  });
});
