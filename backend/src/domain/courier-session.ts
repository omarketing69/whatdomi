/**
 * Puerto para firmar/verificar la sesión del domiciliario — mismo patrón
 * que `TokenSigner` en `business-auth.ts`, pero con su propio claim
 * (`courierId`) y su propio ciclo de vida. Se emite en el momento en que
 * `CourierActivationService.activate()` ya verificó cédula + rostro en
 * vivo: ese es el punto donde de verdad se sabe quién es la persona, así
 * que de ahí en adelante las rutas que actúan "como ese domiciliario"
 * (aceptar/recoger/entregar un pedido, reportar ubicación, desactivarse)
 * exigen este token en vez de confiar en un `courierId` suelto en el
 * body o la URL — ver `docs/ARCHITECTURE.md` §11 y §7.
 */
export interface CourierTokenSigner {
  sign(courierId: string): string;
  /** Devuelve el payload si el token es válido y no expiró, o `null` si no. */
  verify(token: string): { courierId: string } | null;
}
