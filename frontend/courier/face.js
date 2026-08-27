// Extracción de descriptores faciales, 100% client-side, con face-api.js
// (vendorizado en frontend/vendor/face-api — ver docs/ARCHITECTURE.md §10).
// La foto nunca sale del navegador: lo único que se manda al backend es el
// arreglo de 128 números que face-api.js calcula localmente.
//
// Si la librería no cargó (ej. falló el request a los pesos del modelo, o
// el navegador no tiene cámara), todo esto degrada en silencio devolviendo
// null — el resto de la PWA sigue funcionando, solo no se podrá completar
// el registro/activación del rostro (que si es obligatorio para activarse).
const FACE_API_AVAILABLE = typeof faceapi !== "undefined";
const MODELS_URL = "../vendor/face-api/models";

if (!FACE_API_AVAILABLE) {
  console.warn("[face] face-api.js no cargó; la captura de rostro queda deshabilitada.");
}

let modelsLoadingPromise = null;

function loadFaceModels() {
  if (!FACE_API_AVAILABLE) return Promise.resolve(false);
  if (!modelsLoadingPromise) {
    modelsLoadingPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODELS_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL),
    ])
      .then(() => true)
      .catch((err) => {
        console.warn("[face] no se pudieron cargar los modelos de face-api.js", err);
        return false;
      });
  }
  return modelsLoadingPromise;
}

async function startCamera(videoEl) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Este navegador no soporta acceso a la cámara.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

function stopCamera(stream) {
  if (stream) stream.getTracks().forEach((track) => track.stop());
}

/**
 * Corre la detección + extracción sobre el frame actual del <video>.
 * Devuelve un arreglo de 128 números, o null si no se detectó ningún
 * rostro (o si face-api.js no está disponible) — quien llame decide qué
 * decirle al usuario en ese caso ("no detectamos tu rostro, intenta de
 * nuevo con mejor luz").
 */
async function captureFaceDescriptor(videoEl) {
  if (!FACE_API_AVAILABLE) return null;
  const loaded = await loadFaceModels();
  if (!loaded) return null;

  const detection = await faceapi
    .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks(true)
    .withFaceDescriptor();

  if (!detection) return null;
  return Array.from(detection.descriptor);
}

window.WhatDomiFace = {
  FACE_API_AVAILABLE,
  loadFaceModels,
  startCamera,
  stopCamera,
  captureFaceDescriptor,
};
