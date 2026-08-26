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
5. Se notifica a los N más cercanos por WebSocket a sus PWA. El primero que
   acepta gana el pedido (`ASSIGNED`); el resto deja de verlo disponible.
   Esto se resuelve con una operación atómica en la base de datos, no con
   lógica en el servidor de aplicación (ver §4). Es 100% automático — no
   hay asignación manual en el camino principal.
6. Al asignarse: el **domiciliario** recibe por WhatsApp los datos del
   servicio (recogida, entrega, tarifa); el **negocio** recibe nombre,
   placa y teléfono del domiciliario.
7. El domiciliario recoge (`IN_PROGRESS`) y entrega (`DELIVERED`) el
   pedido desde su PWA.
8. En paralelo, el **tablero de administración** ve todo esto en vivo
   (polling corto sobre la misma API): es solo para monitoreo, con un
   botón de reasignar/cancelar como fallback operativo si un domiciliario
   asignado no puede cumplir.

El formulario web directo (`frontend/index.html`) es un segundo canal para
negocios que no quieren usar WhatsApp: ya manda lat/lng resueltas, así que
se salta la cotización y arranca directo en `SEARCHING`.

## 2. Entidades y ciclo de vida

- **Business** (negocio): nombre, teléfono, dirección. Por WhatsApp se
  crea automáticamente la primera vez que un número escribe (no hay
  registro previo ni verificación de identidad — ver §7).
- **Courier** (domiciliario): nombre, teléfono, placa, `isActive`,
  `activationCode` (código con el que se activa desde su PWA), ubicación
  en vivo (`lat`/`lng`), `lastSeenAt`.
- **Order** (pedido/solicitud de domicilio): negocio, nombre del
  solicitante, punto de recogida, punto de entrega, distancia, tarifa,
  moneda, `status`, domiciliario asignado, y `paymentLink`/`paymentStatus`
  (sin usar todavía, ver §8).

Ciclo de vida de un pedido (`OrderStatus`):

```
                 QUOTED (solo WhatsApp: tarifa calculada,
                    │     esperando confirmación del solicitante)
                    │
CREATED ────────────┼──▶ SEARCHING ──▶ ASSIGNED ──▶ IN_PROGRESS ──▶ DELIVERED
(web directa)       │        │
                    │        └─▶ NO_COURIERS_AVAILABLE
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
| WhatsApp           | Flujo conversacional propio sobre un webhook compatible con Meta Cloud API (ver §9) | Sin credenciales reales todavía, pero toda la lógica de negocio (estado de la conversación, cotización, confirmación) ya está implementada y probada; solo falta conectar el envío/recepción real. |
| Frontend           | HTML/CSS/JS plano, sin build              | Tres páginas simples (formulario de negocio, tablero admin, PWA de domiciliario) no justifican un framework ni un paso de build. |
| PWA del domiciliario | Web App Manifest + Service Worker mínimo | El mercado objetivo son ciudades pequeñas con celulares de gama baja: una PWA instalable evita la fricción (y el costo de distribución) de una app nativa. |
| Tests              | Vitest sobre un repositorio en memoria    | La lógica de asignación, el flujo conversacional y la geocodificación se prueban sin depender de una base de datos ni de red real. |

## 4. Asignación atómica: "el primero que acepta, gana"

Este es el punto más delicado del negocio: varios domiciliarios pueden
recibir la oferta del mismo pedido al mismo tiempo, y solo uno debe quedarse
con él. Es 100% automático: el tablero de administración solo observa,
salvo por un botón de "reasignar" que es un fallback operativo explícito
(§8), no un camino de asignación manual alternativo.

**Antipatrón evitado**: leer el estado del pedido, comprobar en la
aplicación si sigue disponible, y luego escribir la asignación. Esto tiene
una condición de carrera clásica (TOCTOU): dos requests pueden leer
"disponible" antes de que cualquiera de las dos escriba.

**Solución**: una única sentencia SQL condicional, `UPDATE ... WHERE status
= 'SEARCHING' AND courier_id IS NULL`, ejecutada directamente por Postgres:

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

Esta misma lógica se implementó en el repositorio en memoria usado en tests
(`InMemoryDispatchRepository.tryAssignOrder`), cediendo el control del event
loop antes de escribir, para poder reproducir la carrera de verdad en los
tests (ver `backend/tests/dispatch.test.ts`, incluye una carrera de 20
domiciliarios aceptando el mismo pedido).

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

## 6. Tarifa

Modelo deliberadamente simple para el MVP: tarifa base + costo por
kilómetro, ambos configurables por entorno (`FARE_BASE`, `FARE_PER_KM`,
`FARE_CURRENCY`) sin tocar código — ver `backend/src/domain/fare.ts`. La
distancia se calcula con la fórmula de Haversine entre recogida y entrega
(línea recta, no ruta real por calles); es una aproximación razonable para
un MVP y evita depender de una API de ruteo.

## 7. Activación del domiciliario (PWA)

El domiciliario se registra una sola vez (`POST /api/couriers`) y recibe
un `activationCode` de 6 dígitos. Para "prender" su sesión y empezar a
recibir pedidos, lo usa en su PWA (`POST /api/couriers/:id/activate`); a
partir de ahí reporta su ubicación en vivo y queda visible para la
búsqueda de candidatos. Desactivarse (`POST /api/couriers/:id/deactivate`)
no requiere el código — es una acción sobre la propia sesión.

Esto **no** es un mecanismo de autenticación fuerte (el código no expira,
no rota, no está hasheado en la base de datos) — es intencional para el
MVP: no hay verificación de identidad real en ningún actor del sistema
todavía (ni domiciliarios ni solicitantes). Antes de operar a escala
conviene: hashear el código, rotarlo, o reemplazarlo por un login con
OTP por SMS/WhatsApp.

## 8. Tablero de administración

`frontend/admin.html` lista los pedidos (con polling corto sobre
`GET /api/orders`) filtrando por estado, y muestra recogida, entrega,
tarifa, estado y domiciliario asignado de cada uno. **Es solo para
monitoreo**: la asignación sigue siendo 100% automática. La única acción
disponible además de cancelar es "Reasignar"
(`POST /api/orders/:id/reassign`), pensada como fallback operativo — por
ejemplo, si el domiciliario asignado avisa que no puede cumplir el
servicio. Reasignar libera la asignación actual y vuelve a correr la misma
búsqueda automática de candidatos (excluyendo al domiciliario anterior),
no asigna a nadie a mano.

## 9. Integración con WhatsApp: opciones y recomendación

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

## 10. Fuera de alcance en este MVP

- **Pagos**: se manejan manual/offline entre negocio y domiciliario.
  `Order` ya tiene `paymentLink`/`paymentStatus` reservados para conectar
  una pasarela más adelante sin migrar el esquema otra vez.
- **Verificación de identidad real**: ni el solicitante (un nombre por
  chat, sin cuenta) ni el domiciliario (código de activación simple, ver
  §7) pasan por un mecanismo de autenticación fuerte. Es una decisión de
  producto deliberada para mantener el costo operativo bajo en el mercado
  objetivo, no un descuido.

## 11. Consideraciones para producción (fuera del alcance del MVP)

- **Autenticación/autorización**: hoy los endpoints no requieren
  credenciales más allá del código de activación del domiciliario. Antes
  de producción: API key o JWT para negocios, y un mecanismo de identidad
  más fuerte para domiciliarios.
- **Rate limiting** en los endpoints públicos y en el webhook de WhatsApp.
- **Notificación en cascada por cercanía**: hoy se notifica a los N más
  cercanos a la vez; una mejora natural es notificar primero al más cercano
  y ampliar el círculo si no acepta en X segundos.
- **Reintentos/expiración de oferta**: si ningún candidato acepta en un
  tiempo límite, reintentar la búsqueda con un radio mayor o marcar el
  pedido para atención manual.
- **Observabilidad**: logging estructurado, métricas de tiempo de
  asignación, alertas de zonas sin domiciliarios activos.
- **Migraciones versionadas**: `db/schema.sql` es suficiente para el MVP;
  con más de un cambio de esquema conviene una herramienta de migraciones
  (ej. `node-pg-migrate`) para no reescribir el archivo a mano.
- **Ruteo real**: la distancia hoy es línea recta (Haversine); para tarifas
  más precisas conviene una API de ruteo (OSRM propio, Mapbox Directions).
