# Arquitectura de WhatDomi

Este documento describe la arquitectura técnica del MVP y las decisiones de
stack detrás de ella. Para instrucciones de instalación y ejecución ver el
[README](../README.md).

## 1. Visión general

```
                      ┌──────────────────────┐
                      │  Negocio (solicitante) │
                      └──────────┬────────────┘
                 WhatsApp        │        Web directa
         ┌──────────────────────┴──────────────────────┐
         │                                              │
┌────────▼──────────────┐                    ┌─────────▼─────────┐
│  WhatsApp Business      │  bot conversacional │  Frontend web      │
│  (webhook Meta/Twilio)  │  (nombre, origen,    │  (formulario       │
│                         │   destino, tarifa)   │   directo)         │
└────────┬────────────────┘                    └─────────┬─────────┘
         │ nombre + direcciones en texto libre             │ lat/lng ya resueltas
         │                                                  │
┌────────▼────────────────┐                                │
│  Geocodificación         │                                │
│  LLM (normaliza texto)   │                                │
│  → Nominatim/OSM (geocod)│                                │
└────────┬────────────────┘                                │
         │ lat/lng + distancia + tarifa                     │
         └───────────────────────┬──────────────────────────┘
                                  │ HTTP (POST /api/orders, /api/orders/:id/accept, etc.)
                          ┌───────▼────────┐
                          │   Backend API   │   (Node.js + TypeScript + Express)
                          │  DispatchService│
                          └───┬─────────┬───┘
                              │         │
                 SQL (pg) ┌───▼───┐ ┌───▼──────────┐ Socket.io + WhatsApp saliente
                          │Postgres│ │  Notificador  │───────────▶ PWA del domiciliario
                          │+PostGIS│ │  (dispatch)   │───────────▶ Tablero admin (monitoreo)
                          └────────┘ └──────────────┘───────────▶ WhatsApp del negocio
```

Flujo completo de un pedido (WhatsApp, el canal principal):

1. El negocio escribe al bot de WhatsApp. El bot saluda y pide el
   **nombre** de quien solicita el servicio.
2. Pide la dirección de **recogida** y la de **entrega**, ambas en
   **texto libre** (ej. *"frente al parque central, al lado de la
   panadería"*) — deliberadamente sin pedir ubicación GPS, porque escribir
   es más rápido que compartir ubicación para el usuario típico de este
   mercado.
3. Ambas direcciones se resuelven a coordenadas vía geocodificación
   asistida por IA (ver §5). Con las coordenadas, el backend calcula
   distancia y tarifa (ver §6) y se la muestra al solicitante para que
   confirme (*SI*/*NO*).
4. Si confirma: se crea el pedido, pasa a `SEARCHING`, y el backend busca
   domiciliarios **activos** dentro de un radio configurable, ordenados por
   distancia (PostGIS).
5. Se le ofrece el pedido por WebSocket, **de a uno a la vez**, empezando
   por el más cercano: 60 segundos para aceptar desde su PWA, y si no
   responde se le ofrece automáticamente al siguiente más cercano (ver
   §4). El primero que acepta gana el pedido (`ASSIGNED`); la asignación
   en sí se resuelve con una operación atómica en la base de datos, no con
   lógica en el servidor de aplicación. Es 100% automático — no hay
   asignación manual en este camino. Si se agota la lista completa sin que
   nadie acepte, el pedido queda `UNASSIGNED` para que un admin lo asigne
   a mano como último recurso.
6. Al asignarse (automática o manualmente): el **domiciliario** recibe por
   WhatsApp los datos del servicio (recogida, entrega, tarifa); el
   **negocio** recibe nombre, placa y teléfono del domiciliario.
7. El domiciliario recoge (`IN_PROGRESS`) el pedido desde su PWA y avanza
   hacia el punto de entrega. El cierre se intenta primero **automático
   por geocerca** (si su ubicación en vivo cae dentro de un radio
   configurable del destino, `DELIVERY_GEOFENCE_METERS`) y siempre tiene
   como respaldo el botón manual "Entregado" en su PWA — cualquiera de los
   dos marca el pedido `DELIVERED`, avisa por WhatsApp al negocio, y
   recalcula la liquidación de comisión del día del domiciliario (ver
   §7-8).
8. En paralelo, el **admin** ve todo esto en vivo desde su panel (polling
   corto sobre la misma API): pedidos en curso (solo monitoreo, con
   reasignar/asignar/cancelar como fallback operativo), tarifa/comisión
   configurables, y liquidaciones diarias por domiciliario.

El formulario web directo (`frontend/index.html`) es un segundo canal para
negocios que no quieren usar WhatsApp: ya manda lat/lng resueltas, así que
se salta la cotización y arranca directo en `SEARCHING`.

## 2. Roles, entidades y ciclo de vida

WhatDomi tiene 3 niveles de acceso (`PlatformRole` en `types.ts`, ver el
comentario ahí para el detalle):

- **Admin**: el dueño de la plataforma. Configura tarifa/comisión y ve
  monitoreo/estadísticas globales. **No** es una fila en `businesses` ni
  en `couriers`, ni una tabla `admins` con usuario/contraseña: es acceso a
  `/api/admin/*` (y a `GET /api/orders` / `POST /api/orders/:id/reassign`)
  protegido por una clave compartida (`ADMIN_API_KEY`, cabecera
  `X-Admin-Key`, ver `requireAdminKey` en `api/routes/admin.ts`). Es una
  decisión deliberada: el admin es la única pieza del sistema que toca
  dinero de la plataforma (tarifas, comisión, cuánto le debe cada
  domiciliario), así que necesita algo más que "no hay verificación" —
  pero un login completo (usuario/contraseña, sesiones) es más de lo que
  un MVP de un solo operador necesita. Ver §13 para cómo evolucionar esto.
- **Business** (negocio): quien solicita domicilios. Nombre, teléfono,
  dirección. Por WhatsApp se crea automáticamente la primera vez que un
  número escribe (no hay registro previo ni verificación de identidad).
- **Courier** (domiciliario): quien los entrega. Nombre, teléfono/WhatsApp,
  placa, `isActive`, `nationalId` (cédula: identificador único y también
  la credencial con la que se activa desde su PWA, ver §7), un descriptor
  facial de referencia (`faceDescriptor`, requerido para activarse junto
  con la cédula, ver §10) y la marca de su consentimiento
  (`faceConsentGivenAt`), ubicación en vivo (`lat`/`lng`), `lastSeenAt`.

Business y Courier se modelan como **entidades separadas**, no como filas
de una tabla `users` con un campo `role`: sus datos y ciclo de vida no se
parecen en nada (uno pide, el otro reporta ubicación y se activa), así que
forzarlos a un esquema común solo agregaría columnas nulas y `if`s por
rol. Es la opción explícitamente permitida junto con la tabla de roles al
plantear este diseño, y la que mejor encaja con SQL relacional.

Además de esas 3 entidades de negocio, dos más soportan el modelo de
monetización (ver §6-7):

- **PlatformConfig**: fila única (singleton) con tarifa base, costo/km,
  tarifa mínima, % de comisión, moneda y recargos declarados — editable
  por el admin, nunca hardcodeada.
- **CourierSettlement**: liquidación diaria de comisión por domiciliario
  (una fila por `courierId` + fecha).

- **Order** (pedido/solicitud de domicilio): negocio, nombre del
  solicitante, punto de recogida, punto de entrega, distancia, tarifa,
  moneda, `status`, domiciliario asignado, y `paymentLink`/`paymentStatus`
  (sin usar todavía, ver §12).

Ciclo de vida de un pedido (`OrderStatus`):

```
                 QUOTED (solo WhatsApp: tarifa calculada,
                    │     esperando confirmación del solicitante)
                    │
CREATED ────────────┼──▶ SEARCHING ──▶ ASSIGNED ──▶ IN_PROGRESS ──▶ DELIVERED
(web directa)       │        │  ▲
                    │        │  └─ cascada: 60s por candidato (§4)
                    │        ├─▶ NO_COURIERS_AVAILABLE (nadie activo cerca, ni para empezar)
                    │        └─▶ UNASSIGNED ──▶ ASSIGNED (solo asignación manual del admin, §8)
                    └──────────────▶ CANCELLED (desde cualquier estado activo)
```

Ver `backend/src/domain/types.ts` para las definiciones exactas y
`backend/src/domain/dispatch.ts` para las transiciones permitidas
(`createDeliveryRequest` para el camino directo, `createQuote` +
`confirmQuote` para el camino de WhatsApp, ambos comparten la misma
búsqueda/notificación de candidatos vía `searchAndOffer`).

## 3. Stack elegido y por qué

| Componente        | Elección                                | Razón |
|--------------------|------------------------------------------|-------|
| Backend            | Node.js + TypeScript + Express            | Ecosistema maduro, fácil de desplegar, mismo lenguaje en todo el stack (incluido el frontend). |
| Base de datos      | PostgreSQL + PostGIS                      | Consultas geoespaciales (`ST_DWithin`, `ST_Distance`) nativas y con índice GiST; es la opción estándar para "quién está cerca de quién". |
| Acceso a datos     | `pg` (node-postgres) con SQL crudo        | Se evitó un ORM (ej. Prisma) para no depender de la descarga de binarios de motor en tiempo de build/CI, que puede fallar en entornos con red restringida. El dominio está detrás de una interfaz (`DispatchRepository`), así que cambiar a un ORM más adelante es un cambio localizado. |
| Tiempo real        | Socket.io                                 | Notificar domiciliarios candidatos y actualizar el estado del pedido sin polling agresivo. El tablero admin sí usa polling HTTP corto, por simplicidad — no necesita la latencia de un socket para una vista de monitoreo. |
| Geocodificación    | LLM (normaliza texto) + Nominatim/OSM (resuelve coordenadas) | Ver §5: separar "entender la dirección informal" de "resolver coordenadas reales" en dos pasos, en vez de pedirle coordenadas a un LLM directamente. |
| WhatsApp           | Flujo conversacional propio sobre un webhook compatible con Meta Cloud API (ver §11) | Sin credenciales reales todavía, pero toda la lógica de negocio (estado de la conversación, cotización, confirmación) ya está implementada y probada; solo falta conectar el envío/recepción real. |
| Frontend           | HTML/CSS/JS plano, sin build              | Tres páginas simples (formulario de negocio, tablero admin, PWA de domiciliario) no justifican un framework ni un paso de build. |
| Mapa               | Leaflet + tiles de OpenStreetMap, vendorizados localmente (ver §9) | Gratis y sin API key, misma lógica que ya llevó a elegir Nominatim para geocodificar; vendorizado (no CDN) para no depender de un tercero externo en cada carga. |
| Verificación facial | face-api.js, vendorizado localmente (ver §10) | Librería gratuita, de código abierto, que corre 100% en el navegador (WebGL/CPU, sin servidor de inferencia); vendorizada por el mismo motivo que Leaflet: no depender de un tercero externo en cada carga. |
| PWA del domiciliario | Web App Manifest + Service Worker mínimo | El mercado objetivo son ciudades pequeñas con celulares de gama baja: una PWA instalable evita la fricción (y el costo de distribución) de una app nativa. |
| Tests              | Vitest sobre un repositorio en memoria    | La lógica de asignación, el flujo conversacional y la geocodificación se prueban sin depender de una base de datos ni de red real. |

## 4. Cascada de asignación: candidato más cercano, 60s, siguiente

Este es el punto más delicado del negocio. La regla de producto es:
ofrecerle el pedido al domiciliario activo más cercano, darle 60 segundos
para aceptar, y si no responde, ofrecérselo automáticamente al siguiente
más cercano — así hasta que alguien acepte o se agote la lista. Es 100%
automático: el tablero de administración solo observa, salvo por
"reasignar" (reintenta la cascada completa) y "asignar" sobre un pedido
`UNASSIGNED` (§7), ninguno de los dos es el camino principal.

`DispatchService` mantiene, en memoria, un mapa `orderId → estado de la
cascada` (`candidates`, `currentIndex`, el `setTimeout` vigente):

1. Al pasar a `SEARCHING`, se le notifica (Socket.io) solo al candidato
   en `candidates[0]` y se arma un timer de `OFFER_TIMEOUT_MS` (60s).
2. Si el timer se cumple sin que nadie haya aceptado, se le retira la
   oferta a ese candidato (`onOfferExpired`, evento
   `order:offer-cancelled` a su sala), se avanza `currentIndex`, y se le
   ofrece al siguiente con un timer nuevo.
3. Si se acaba la lista, el pedido pasa a `UNASSIGNED` y se dispara
   `onOrderUnassigned` (aviso al negocio, aparece en el panel de admin).
4. Si alguien acepta, se limpia el timer y la entrada del mapa.

**La asignación en sí sigue siendo la operación atómica de siempre** — la
cascada solo decide *a quién ofrecérsela en cada momento*, no reemplaza la
garantía de fondo:

```sql
UPDATE orders
SET status = 'ASSIGNED', courier_id = $2, assigned_at = now()
WHERE id = $1 AND status = 'SEARCHING' AND courier_id IS NULL
RETURNING *;
```

Postgres serializa los `UPDATE` concurrentes sobre la misma fila: si dos
domiciliarios aceptan "al mismo tiempo", uno de los dos `UPDATE` se ejecuta
primero y cambia el estado; cuando el segundo se ejecuta, la cláusula
`WHERE` ya no coincide (el estado dejó de ser `SEARCHING`) y no afecta
ninguna fila. La aplicación simplemente revisa si `RETURNING` trajo una fila
o no — sin locks explícitos, sin transacciones manuales, sin necesidad de
`SELECT ... FOR UPDATE`.

Encima de esa garantía, `DispatchService.acceptOrder` agrega una capa: si
hay una cascada viva para el pedido, solo el candidato al que le toca el
turno puede intentar aceptar — cualquier otro se rechaza de inmediato
(`OrderAlreadyTakenError`, sin tocar la base de datos) aunque técnicamente
el pedido siga en `SEARCHING`. Es una comprobación en memoria, no en la
base de datos: si el proceso se reinicia y la cascada en memoria se
pierde, `acceptOrder` se degrada al comportamiento atómico simple (gana
quien primero llegue), en vez de dejar el pedido inaceptable para
siempre — ver §13 sobre qué le falta a esto para un despliegue con más de
una instancia.

Esta misma lógica de asignación atómica se implementó en el repositorio en
memoria usado en tests (`InMemoryDispatchRepository.tryAssignOrder`),
cediendo el control del event loop antes de escribir, para poder
reproducir la carrera de verdad en los tests (ver
`backend/tests/dispatch.test.ts`, incluye una carrera de 20 domiciliarios
aceptando el mismo pedido). La cascada en sí — avanzar al siguiente
candidato tras el timeout, congelarse al aceptar, agotarse en
`UNASSIGNED` — se prueba con los timers falsos de Vitest en
`backend/tests/dispatch-cascade.test.ts`, sin esperar 60 segundos reales.

## 5. Geocodificación de direcciones en texto libre

El dueño del producto fue explícito: el solicitante escribe la dirección
como se la describiría a un vecino ("frente al parque central, al lado de
la panadería"), no comparte un pin de ubicación. En ciudades pequeñas de
LatAm, muchas direcciones no tienen nomenclatura de calle confiable, así
que un geocodificador tradicional (que espera algo tipo "Calle 10 #5-30")
falla seguido con ese tipo de texto.

**Se descartó** pedirle coordenadas directamente a un LLM: los modelos de
lenguaje "alucinan" lat/lng plausibles con facilidad, y no hay forma de
distinguir un acierto real de una alucinación sin ya conocer la respuesta
correcta — es la peor combinación posible (falla en silencio, con
confianza).

**Solución implementada, en dos pasos** (`backend/src/domain/geocoding.ts`):

1. **Normalización con LLM** (`AddressNormalizer`): si hay
   `ANTHROPIC_API_KEY` configurada, se usa Claude para reescribir el texto
   informal en una consulta más apta para un geocodificador — expandir
   abreviaturas, resolver referencias a lugares conocidos, agregar la
   ciudad/país de contexto. Si no hay API key, se usa un normalizador
   "passthrough" que solo le agrega la ciudad/país configurados por
   defecto (`PassthroughAddressNormalizer`) — el sistema funciona sin LLM,
   solo con menos capacidad de interpretar direcciones muy ambiguas.
2. **Geocodificación real** (`GeocodingProvider`): el texto (normalizado o
   no) se manda a Nominatim (OpenStreetMap), que devuelve coordenadas
   reales. Se eligió Nominatim para el MVP porque no requiere API key ni
   tarjeta de crédito; para más volumen o mejor cobertura en zonas rurales
   conviene evaluar Google Maps Geocoding o Mapbox (basta con implementar
   `GeocodingProvider` de nuevo, el resto del sistema no cambia).

`GeocodingService.resolve()` compone ambos pasos y, si el texto normalizado
no resuelve nada, reintenta con el texto original tal cual lo escribió el
solicitante, por si la normalización lo empeoró. Si ninguno de los dos
resuelve, el bot le pide al solicitante que describa la dirección de otra
forma (ver `WhatsAppConversationService`) en vez de crear un pedido con
coordenadas erróneas.

## 6. Tarifa y comisión (configurables por el admin)

Modelo deliberadamente simple para el MVP: tarifa base + costo por
kilómetro + un piso (tarifa mínima, para que un trayecto muy corto no
cueste casi nada) — ver `backend/src/domain/fare.ts`. La distancia se
calcula con la fórmula de Haversine entre recogida y entrega (línea recta,
no ruta real por calles); es una aproximación razonable para un MVP y
evita depender de una API de ruteo.

**Todo lo relacionado a tarifas vive en `PlatformConfig`, una fila única en
la tabla `platform_config`, no en variables de entorno ni hardcodeado**:
tarifa base, costo/km, tarifa mínima, % de comisión, moneda, y una lista de
recargos declarados (`surcharges`, ej. "nocturno", "zona rural") que el
admin puede registrar pero que **todavía no se aplican** en el cálculo —
es una extensión declarada para no cerrar la puerta, no una regla activa.
El admin la edita desde `PUT /api/admin/config`; el flujo de WhatsApp lee
la config vigente en cada cotización (`WhatsAppConversationService` llama
a `repo.getPlatformConfig()` en el momento, no guarda una copia al
arrancar el servidor), así que un cambio del admin aplica de inmediato a
la siguiente conversación.

Las variables `FARE_BASE`/`FARE_PER_KM`/`FARE_MIN`/`FARE_CURRENCY`/
`COMMISSION_PERCENTAGE` en `.env` solo **siembran** la fila inicial de
`platform_config` en Postgres (vía `db/schema.sql`) — una vez que existe,
son la única fuente de verdad y esas variables ya no se vuelven a leer.
Para el repositorio en memoria (tests / desarrollo sin Postgres) sí siguen
siendo la fuente en cada arranque, porque ahí no hay una base de datos
persistente que las reemplace.

**Importante**: la comisión NO se suma a lo que paga el cliente. El
solicitante paga `baseFare + pricePerKm × distancia` (con el piso); el %
de comisión es aparte, y describe cuánto de esa tarifa el domiciliario le
debe a la plataforma — ver §7.

## 7. Activación del domiciliario y comisión diaria

El domiciliario se registra una sola vez (`POST /api/couriers`) con su
nombre, su número de WhatsApp, su placa, y su **número de cédula**
(`nationalId`) — no hay un código de activación generado aparte: la
cédula misma es la credencial. Para "prender" su sesión y empezar a
recibir pedidos, la usa en su PWA junto con una verificación facial en
vivo (`POST /api/couriers/:id/activate`, ver §10 para el detalle de esa
verificación); a partir de ahí reporta su ubicación en vivo y queda
visible para la búsqueda de candidatos. Desactivarse
(`POST /api/couriers/:id/deactivate`) no requiere ni la cédula ni el
rostro — es una acción sobre la propia sesión.

Esto **no** es un mecanismo de autenticación fuerte (la cédula no se
verifica contra ninguna fuente oficial, no está hasheada en la base de
datos) — es intencional para el MVP: no hay verificación de identidad
real en ningún actor del sistema todavía (ni domiciliarios ni
solicitantes). Además, un número de cédula es un dato personal sensible
(PII): antes de operar a escala conviene, como mínimo, no loguearlo nunca
en texto plano (hoy no se loguea en ningún punto del código), restringir
qué respuestas de la API lo devuelven, y evaluar cifrarlo en reposo;
verificarlo contra una fuente oficial (Registraduría) y/o complementarlo
con un login por OTP de SMS/WhatsApp queda como mejora de identidad real.

**Activarse también depende de estar al día con la comisión.** Cada vez
que un domiciliario entrega un pedido (`DispatchService.markDelivered`),
se recalcula su `CourierSettlement` del día (`SettlementService.
recomputeSettlement`): cuántos servicios hizo, cuánto cobró, y cuánto le
corresponde a la plataforma con el `commissionPercentage` **vigente en ese
momento** (queda congelado en esa fila, no cambia si el admin ajusta la
comisión general después). Mientras la liquidación de un día siga
`PENDING`, se puede recalcular libremente (llegan más entregas ese mismo
día); una vez el admin la marca `PAID`
(`POST /api/admin/settlements/:courierId/:date/pay`, acción manual/offline,
igual que el cobro del servicio), queda **congelada** — una entrega
tardía del mismo día ya no la reabre.

Antes de activarse, `CourierActivationService.activate` llama a
`SettlementService.canActivate(courierId, hoy)`: si hay **alguna
liquidación `PENDING` de un día *anterior* a hoy**, la activación se
rechaza con `402 Payment Required` (no `403`, para distinguirlo de un
código de activación incorrecto) y el detalle de qué días quedaron sin
pagar. La liquidación del propio día en curso nunca bloquea — el bloqueo
es específicamente por deuda de días ya cerrados, para no crear una
paradoja de "no puedo trabajar hoy para pagar lo de ayer". Ver
`backend/tests/settlement.test.ts` y `backend/tests/courier-activation.test.ts`
para el detalle de esta regla probado explícitamente (incluida la
concurrencia de recalcular la misma liquidación dos veces).

## 8. Panel de administración

`frontend/admin.html` es la única superficie que usa el rol admin. Cuatro
capacidades, todas detrás de `requireAdminKey`:

1. **Monitoreo de pedidos** (`GET /api/orders` con polling corto,
   filtrando por estado, incluido `UNASSIGNED`) — recogida, entrega,
   tarifa, estado y domiciliario de cada uno. **Es solo para monitoreo**:
   la asignación sigue siendo 100% automática, con dos acciones de
   fallback:
   - **"Reasignar"** (`POST /api/orders/:id/reassign`): libera la
     asignación actual y reintenta la cascada completa desde cero
     (excluyendo al domiciliario anterior) — para cuando el domiciliario
     asignado avisa que no puede cumplir.
   - **"Asignar"** (`POST /api/orders/:id/assign`, solo disponible sobre
     un pedido `UNASSIGNED`): el admin elige directamente al
     domiciliario. Es el único lugar de todo el sistema donde un humano
     asigna a mano — último recurso cuando la cascada automática se
     agotó sin que nadie aceptara, nunca el camino principal.
2. **Configuración de tarifa/comisión** (`GET`/`PUT /api/admin/config`) —
   ver §6.
3. **Registro de servicios y liquidaciones por día**
   (`GET /api/admin/service-log`, `GET /api/admin/settlements`, ambos con
   `?date=YYYY-MM-DD`): quién hizo cada servicio, cuánto cobró, origen y
   destino; y, agrupado por domiciliario, cuántos servicios, cuánto
   cobró en total, cuánto le corresponde de comisión, y si ya la pagó
   (`POST /api/admin/settlements/:courierId/:date/pay`) — ver §7.
4. **Estadísticas agregadas** (`GET /api/admin/stats?range=day|week`):
   total de servicios e ingresos, y una estimación de la comisión total de
   la plataforma usando la tasa **vigente** sobre todo el rango (una
   aproximación para una vista rápida — el monto "oficial" por día es el
   que quedó congelado en cada `CourierSettlement`, no este agregado).

## 9. Mapa en vivo del negocio: Leaflet + OpenStreetMap

`frontend/index.html` muestra un mapa en cuanto el negocio completa el
punto de recogida: domiciliarios activos cerca (puntos verdes,
`GET /api/couriers/nearby`) antes de asignar, y después la posición del
domiciliario asignado con una línea de trayecto
(`GET /api/orders/:id/courier-location`) — ambos con polling cada ~4s, no
WebSocket, porque es una vista de solo lectura de baja frecuencia donde el
polling ya es simple y suficiente (el mismo patrón que usa el tablero de
admin).

**El trayecto en vivo tiene dos tramos**, y el mapa cambia el destino
visual de la línea según el estado del pedido:

1. **`ASSIGNED`** (domiciliario → recogida): la línea apunta al punto de
   recogida, igual que antes de que existiera el segundo tramo.
2. **`IN_PROGRESS`** (recogida → entrega, una vez el domiciliario marcó
   que recogió el pedido): la línea cambia de destino al punto de
   **entrega**, y aparece un marcador nuevo ahí. Es el mismo mecanismo de
   ubicación en vivo (`courier-location`) que ya se usaba para el primer
   tramo — lo único que cambia es cuál punto se usa como destino visual
   (`frontend/app.js`, variable `currentOrderStatus`).

**Cierre del servicio por geocerca**: mientras el pedido está
`IN_PROGRESS`, cada reporte de ubicación del domiciliario
(`POST /api/couriers/:id/location`, cada ~15s desde su PWA) también
revisa, del lado del servidor (`DispatchService.reportCourierLocation`),
si esa posición cayó dentro de `DELIVERY_GEOFENCE_METERS` (100m por
defecto, configurable) del punto de entrega — si es así, el pedido se
marca `DELIVERED` automáticamente, sin que el domiciliario tenga que
hacer nada. Es deliberadamente **best-effort**: un GPS impreciso o un
reporte de ubicación perdido no deben dejar un pedido atascado, así que
el botón manual "Entregado" en la PWA del domiciliario sigue funcionando
siempre como respaldo (y es el único camino si el cierre automático no
aplicara, ej. el domicilio se entrega en la puerta de al lado y nunca
cae dentro del radio configurado). Cualquiera de los dos caminos termina
en el mismo `DispatchService.markDelivered` — recalcula la liquidación
del domiciliario y dispara el aviso de entrega por WhatsApp al negocio
(`whatsapp/notifier.ts`, `onOrderStatusChanged`).

**Por qué Leaflet + OpenStreetMap y no Google Maps/Mapbox**: el público
son ciudades pequeñas de LatAm, donde cuidar el costo operativo es una
prioridad explícita del producto — Leaflet es gratis y sin límite de uso,
y OSM no requiere una API key ni tarjeta de crédito, igual que Nominatim
(ya elegido para geocodificar direcciones en el flujo de WhatsApp, ver
§5). Es la misma decisión de fondo aplicada dos veces: evitar depender de
un proveedor de pago para un producto que necesita mantenerse barato de
operar.

**Por qué vendorizado localmente y no un CDN** (`frontend/vendor/leaflet/`,
no `unpkg.com` ni similar): al construir esto se detectó un bug real
probándolo en un entorno con el CDN bloqueado — como el código inicial
creaba los íconos de Leaflet (`new L.DivIcon(...)`) en la parte superior
del script, si `L` no estaba definido (porque el CDN no cargó), **todo**
`app.js` fallaba con un `ReferenceError` sin ejecutar una sola línea más:
ni siquiera el registro del negocio funcionaba, muy lejos de "solo el mapa
no carga". La causa de fondo no era el CDN en sí, sino que nada dependía
de verificar si Leaflet había cargado. Se corrigió en dos frentes:
1. Vendorizar Leaflet (JS + CSS + íconos, ~190KB) como archivos locales,
   para no depender de que un tercero externo esté disponible en cada
   carga — más robusto para el público objetivo (conexiones modestas).
2. Guardas defensivas en `app.js` (`mapAvailable = typeof L !== "undefined"`):
   si por lo que sea Leaflet no carga, el mapa se omite en silencio y el
   resto de la página (registrar negocio, pedir domicilio, seguir el
   estado) sigue funcionando exactamente igual. El mapa es una mejora de
   experiencia, nunca una dependencia del flujo de negocio.

**Limitación deliberada**: la línea de cada tramo (hacia la recogida o
hacia la entrega) es la distancia en **línea recta** (Haversine, la misma
que ya se usa para tarifa y cercanía), no una ruta real por calles — no
hay integración con un
servicio de ruteo (OSRM, Mapbox Directions) en este MVP. Es la misma
decisión de simplicidad que ya se tomó para la distancia de la tarifa
(§6): un MVP no necesita ruteo real para ser útil, y agregar ruteo real
es un cambio localizado a futuro (solo tocaría cómo se dibuja la línea,
no el resto del sistema).

Esta funcionalidad se probó manualmente en un navegador real (Playwright +
Chromium) contra un backend con el repositorio en memoria: registro de
negocio, aparición del punto de recogida y de un domiciliario sembrado
cerca, creación del pedido, aceptación simulada del domiciliario, y
verificación de que aparecen el marcador rojo y la línea de trayecto. Los
tiles de mapa en sí (`tile.openstreetmap.org`) no cargaron en ese entorno
de prueba por una política de red del sandbox — no un defecto del código —
así que las capturas muestran los marcadores sobre un fondo gris en vez de
calles reales; en un despliegue con acceso normal a internet, los tiles
cargan igual que cualquier imagen de una página web.

## 10. Verificación facial en la activación diaria

Además de la cédula (§7), activarse cada día requiere una **verificación
facial en vivo**: la primera vez, el domiciliario captura un rostro de
referencia desde su PWA (`POST /api/couriers/:id/face-reference`); a
partir de ahí, cada activación exige una selfie nueva que se compara
contra esa referencia (`POST /api/couriers/:id/activate`, ahora con un
tercer requisito además de la cédula).

**Dónde corre cada parte, y por qué**:

1. **Extracción, 100% client-side** (`frontend/courier/face.js`, sobre
   `face-api.js`): el navegador del domiciliario detecta el rostro
   (`TinyFaceDetector`) y calcula un **descriptor de 128 números**
   (`FaceRecognitionNet`) a partir del video de su cámara. La foto **nunca
   sale del dispositivo** — lo único que viaja al backend es ese arreglo
   de números, que no se puede revertir a una imagen reconocible. Es la
   misma razón por la que se guarda el descriptor y no la foto en
   `Courier.faceDescriptor`.
2. **Comparación, 100% server-side** (`backend/src/domain/
   face-verification.ts`, sin ninguna dependencia de ML): el backend
   nunca confía en que el cliente le diga "coincide" — recibe los dos
   descriptores (el guardado como referencia y el de la selfie en vivo) y
   calcula él mismo la distancia euclidiana entre ambos
   (`euclideanDistance`), comparándola contra un umbral
   (`FACE_MATCH_THRESHOLD`, 0.6 por defecto — el valor que la propia
   documentación de face-api.js recomienda para su modelo de
   reconocimiento). Es la misma filosofía que la asignación atómica de
   pedidos (§4): la parte que importa para la seguridad del sistema no se
   deja en manos del cliente.

`CourierActivationService.activate` encadena los tres requisitos **en
este orden**: cédula correcta → rostro registrado y coincidente → sin
comisión pendiente de un día anterior (§7). Si falta el rostro de
referencia (nunca lo capturó) se rechaza con `428 Precondition Required`;
si no coincide, con `403` (incluyendo la distancia calculada y el umbral,
para debugging — nunca la imagen). Ver
`backend/tests/courier-activation.test.ts` y
`backend/tests/courier-face-api.test.ts` para el detalle probado de cada
combinación.

**Por qué face-api.js vendorizado localmente**
(`frontend/vendor/face-api/`, no un CDN): mismo motivo exacto que Leaflet
(§9) — es una librería gratuita y de código abierto que no requiere
servidor de inferencia propio ni API key, y vendorizarla evita depender
de que un tercero externo esté disponible en cada carga. El mismo patrón
de guarda defensiva que se usó para Leaflet
(`mapAvailable = typeof L !== "undefined"`) se repite aquí
(`FACE_API_AVAILABLE = typeof faceapi !== "undefined"` en `face.js`): si
la librería no carga, la captura de rostro se deshabilita en silencio en
vez de romper el resto de la PWA — aunque, a diferencia del mapa, esta sí
es una dependencia dura del flujo de activación (sin rostro capturado, no
hay forma de activarse).

**Limitación conocida — sin detección de vida (liveness/anti-spoofing)**:
este MVP verifica que el rostro capturado **coincide** con el de
referencia, pero no verifica que sea una persona real frente a la cámara
en ese momento — una foto impresa o la pantalla de otro celular mostrando
la foto de referencia podría, en principio, pasar la verificación. Se
consideró deliberadamente fuera de alcance del MVP: implementar liveness
real (parpadeo, movimiento de cabeza bajo instrucción, o un modelo de
detección de "presentation attacks") es un problema no trivial que
justifica su propio ciclo de trabajo. **Recomendación para la siguiente
iteración**: evaluar una librería de liveness activo (ej. pedirle al
domiciliario que gire la cabeza o parpadee, verificado con los mismos
landmarks de `face-api.js`) o un proveedor especializado de verificación
de identidad (ej. servicios que combinan reconocimiento facial con prueba
de vida y verificación de documento) antes de depender de esto como único
control anti-fraude en producción.

**Nota legal — datos biométricos y habeas data**: un descriptor facial es
un dato biométrico, y varias jurisdicciones de LatAm lo tratan como dato
sensible bajo su marco de *habeas data* (ej. la Ley 1581 de 2012 en
Colombia y su regulación de datos sensibles). Este MVP implementa el
requisito mínimo — una casilla de consentimiento explícito antes de
capturar el rostro, registrada con fecha/hora
(`Courier.faceConsentGivenAt`) — pero **no** un flujo legal completo
(política de tratamiento de datos formal, mecanismo de revocación,
registro ante la autoridad correspondiente, etc.). Antes de operar esto en
producción, el equipo debería revisar la normativa de protección de datos
biométricos vigente en cada país de operación con asesoría legal local.

## 11. Integración con WhatsApp: opciones y recomendación

No había credenciales de WhatsApp Business al momento de construir el MVP.
Lo que sí se construyó y está probado end-to-end es toda la lógica de
negocio del bot (`backend/src/whatsapp/conversation.ts`): la máquina de
estados completa (saludo → nombre → recogida → entrega → cotización →
confirmación → creación del pedido), independiente de qué proveedor la
transporte. Lo que falta es solo la capa de transporte real:

- `backend/src/whatsapp/webhook.ts` ya tiene la forma correcta de un
  webhook de Meta Cloud API (verificación `hub.challenge` + recepción de
  mensajes) y ya delega al motor conversacional.
- `backend/src/whatsapp/sender.ts` es un *stub* que solo loguea los
  mensajes salientes; hay que reemplazarlo por una llamada real a la Graph
  API (Meta) o al SDK de Twilio.

Dos proveedores posibles para esa capa de transporte:

- **Meta Cloud API (directo)**: gratis por conversación iniciada por el
  negocio dentro de la ventana de 24h, pero requiere verificación de
  negocio en Meta Business Manager (puede tardar días) y manejo manual de
  plantillas de mensaje aprobadas para iniciar conversación.
- **Twilio (o similar: 360dialog, MessageBird)**: onboarding más rápido,
  mejor DX (SDKs, sandbox de pruebas inmediato), pero con costo adicional
  por mensaje sobre el de Meta.

**Recomendación**: empezar con **Twilio** para probar el flujo end-to-end
rápido en su sandbox de WhatsApp sin esperar la verificación de Meta, y
migrar a Meta Cloud API directo cuando el volumen justifique ahorrarse el
margen de Twilio. Cambiar de proveedor implica reemplazar `webhook.ts` y
`sender.ts` — la máquina de estados conversacional no cambia.

Pendiente de implementar en cuanto haya credenciales:
- Verificar `X-Hub-Signature-256` (Meta) o el token de Twilio antes de
  confiar en el body del webhook.
- Enviar mensajes salientes de verdad vía la Graph API / API de Twilio.
- Persistir el estado de la conversación (`ConversationStore`) en Redis o
  Postgres en vez de en memoria, para que sobreviva reinicios y funcione
  con más de una instancia del backend corriendo a la vez.

## 12. Fuera de alcance en este MVP

- **Pagos**: tanto el cobro del servicio (negocio → domiciliario) como el
  pago de la comisión (domiciliario → plataforma) se manejan
  manual/offline. Lo que SÍ está implementado es el *registro* de esa
  comisión (`CourierSettlement`, ver §7) y su efecto (bloquear la
  activación si queda pendiente) — lo que falta es cualquier pasarela que
  mueva dinero de verdad. `Order` ya tiene `paymentLink`/`paymentStatus`
  reservados para conectar una pasarela del lado del cobro del servicio
  más adelante, sin migrar el esquema otra vez.
- **Recargos (surcharges)**: el admin puede *declarar* recargos
  (nocturno, por zona) en `PlatformConfig.surcharges`, pero
  `calculateFare` todavía no los aplica — es una extensión con el espacio
  ya reservado, no una regla activa. Aplicarlos requeriría decidir cómo se
  activan (¿por horario del servidor? ¿por zona geográfica del punto de
  recogida?), que quedó fuera del alcance de este ajuste.
- **Verificación de identidad real de negocio y domiciliario**: ni el
  solicitante (un nombre por chat, sin cuenta) ni el domiciliario (su
  cédula, sin verificarla contra ninguna fuente oficial, ver §7) pasan por
  un mecanismo de autenticación fuerte. Es una decisión de producto
  deliberada para mantener el costo operativo bajo en el mercado objetivo,
  no un descuido. El admin sí tiene una barrera (`ADMIN_API_KEY`), pero
  tampoco es un login completo — ver el siguiente punto.
- **Ruteo real en el mapa**: el trayecto del domiciliario, en cualquiera
  de los dos tramos (§9), se dibuja en línea recta, no por una ruta real
  de calles — misma simplificación que ya se aplica a la distancia usada
  para la tarifa (§6).
- **Liveness/anti-spoofing en la verificación facial**: la comparación
  facial (§10) verifica que el rostro coincida con la referencia, pero no
  que haya una persona real frente a la cámara en ese momento — una foto o
  la pantalla de otro celular podría, en principio, pasar la
  verificación. Ver §10 para la recomendación de qué evaluar antes de
  producción.

## 13. Consideraciones para producción (fuera del alcance del MVP)

- **Autenticación/autorización real para los 3 roles**: hoy el admin se
  protege con una clave compartida por cabecera (suficiente para un solo
  operador de la plataforma, no para un equipo), y negocio/domiciliario no
  tienen cuenta en absoluto. Antes de producción a mayor escala: cuentas
  con usuario/contraseña o magic link para admins (con roles si hay más de
  un operador), API key o JWT por negocio, y verificar la cédula del
  domiciliario contra una fuente oficial en vez de solo tomarla tal cual
  la escribió.
- **Rate limiting** en los endpoints públicos y en el webhook de WhatsApp.
- **Dato biométrico en reposo**: `Courier.faceDescriptor` (§10) hoy se
  guarda tal cual en Postgres (columna `JSONB`), igual que la cédula. Antes
  de producción conviene cifrarlo en reposo, restringir qué respuestas de
  la API lo devuelven (hoy `GET /api/couriers/:id` lo incluye completo), y
  definir una política de retención/borrado si un domiciliario deja la
  plataforma — además de resolver el punto legal de habeas data que ya
  señala §10.
- **Estado de la cascada de asignación en memoria** (§4): el mapa
  `orderId → cascada` vive en el proceso de Node, no en la base de datos.
  Con una sola instancia del backend (el caso del MVP) esto es correcto;
  con más de una instancia detrás de un balanceador, dos réplicas podrían
  cada una arrancar su propia cascada para el mismo pedido, o perder el
  timer si el proceso que la inició se reinicia a mitad de una ventana de
  60s. Antes de escalar a múltiples instancias conviene mover ese estado a
  algo compartido (Redis con TTL, o un job programado que revise pedidos
  `SEARCHING` estancados más de `OFFER_TIMEOUT_MS`) en vez de `setTimeout`
  en memoria de proceso.
- **Radio de búsqueda ampliado si se agota la lista**: hoy, si la cascada
  agota los candidatos dentro de `SEARCH_RADIUS_METERS`, el pedido pasa
  directo a `UNASSIGNED`; una mejora natural es reintentar una vez con un
  radio mayor antes de pedir intervención manual.
- **Observabilidad**: logging estructurado, métricas de tiempo de
  asignación, alertas de zonas sin domiciliarios activos.
- **Migraciones versionadas**: `db/schema.sql` es suficiente para el MVP;
  con más de un cambio de esquema conviene una herramienta de migraciones
  (ej. `node-pg-migrate`) para no reescribir el archivo a mano.
- **Ruteo real**: la distancia hoy es línea recta (Haversine) tanto para
  la tarifa como para la línea del mapa hacia la recogida (§9); para
  tarifas más precisas y un trayecto real por calles conviene una API de
  ruteo (OSRM propio, Mapbox Directions).
