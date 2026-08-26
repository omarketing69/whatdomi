# Arquitectura de WhatDomi

Este documento describe la arquitectura técnica del MVP y las decisiones de
stack detrás de ella. Para instrucciones de instalación y ejecución ver el
[README](../README.md).

## 1. Visión general

```
                      ┌──────────────────────┐
                      │   Negocio (usuario)   │
                      └──────────┬────────────┘
                 WhatsApp        │        Web
         ┌──────────────────────┴──────────────────────┐
         │                                              │
┌────────▼─────────┐                          ┌─────────▼─────────┐
│  WhatsApp Business │  (webhook Meta/Twilio)  │  Frontend web      │
│  (bot / número)    │ ───────────────────────▶│  (formulario)      │
└────────┬───────────┘   link a la web para     └─────────┬─────────┘
         │               completar el pedido               │
         │                                                  │
         └───────────────────────┬──────────────────────────┘
                                  │ HTTP (POST /api/orders, etc.)
                          ┌───────▼────────┐
                          │   Backend API   │   (Node.js + TypeScript + Express)
                          │  DispatchService│
                          └───┬─────────┬───┘
                              │         │
                 SQL (pg) ┌───▼───┐ ┌───▼──────────┐ Socket.io
                          │Postgres│ │  Servidor de  │───────────▶ App del domiciliario
                          │+PostGIS│ │  tiempo real  │───────────▶ Web del negocio (tracking)
                          └────────┘ └──────────────┘
```

Flujo de un pedido:

1. El negocio solicita un domicilio (vía WhatsApp → web, o directo en la web).
2. El backend crea el pedido (`CREATED`) y busca domiciliarios **activos**
   dentro de un radio configurable, ordenados por distancia (PostGIS).
3. Si hay candidatos, el pedido pasa a `SEARCHING` y se notifica a los N más
   cercanos por WebSocket ("te llegó una oferta de domicilio").
4. El primer domiciliario que acepta gana el pedido (`ASSIGNED`); el resto
   deja de verlo disponible. Esto se resuelve con una operación atómica en
   la base de datos, no con lógica en el servidor de aplicación (ver §4).
5. El domiciliario recoge (`IN_PROGRESS`) y entrega (`DELIVERED`) el pedido,
   actualizando su estado desde su app.

## 2. Entidades y ciclo de vida

- **Business** (negocio): nombre, teléfono, dirección.
- **Courier** (domiciliario): nombre, teléfono, `isActive`, ubicación en vivo
  (`lat`/`lng`), `lastSeenAt`.
- **Order** (pedido/solicitud de domicilio): negocio, punto de recogida,
  punto de entrega, datos del cliente final, `status`, domiciliario asignado.

Ciclo de vida de un pedido (`OrderStatus`):

```
CREATED ─┬─▶ SEARCHING ──▶ ASSIGNED ──▶ IN_PROGRESS ──▶ DELIVERED
         │                     │
         └─▶ NO_COURIERS_AVAILABLE   └──▶ CANCELLED (desde cualquier estado activo)
```

Ver `backend/src/domain/types.ts` para las definiciones exactas y
`backend/src/domain/dispatch.ts` para las transiciones permitidas.

## 3. Stack elegido y por qué

| Componente        | Elección                                | Razón |
|--------------------|------------------------------------------|-------|
| Backend            | Node.js + TypeScript + Express            | Ecosistema maduro, fácil de desplegar, mismo lenguaje en todo el stack (incluido el frontend). |
| Base de datos      | PostgreSQL + PostGIS                      | Consultas geoespaciales (`ST_DWithin`, `ST_Distance`) nativas y con índice GiST; es la opción estándar para "quién está cerca de quién". |
| Acceso a datos     | `pg` (node-postgres) con SQL crudo        | Se evitó un ORM (ej. Prisma) para no depender de la descarga de binarios de motor en tiempo de build/CI, que puede fallar en entornos con red restringida. El dominio está detrás de una interfaz (`DispatchRepository`), así que cambiar a un ORM más adelante es un cambio localizado. |
| Tiempo real        | Socket.io                                 | Notificar domiciliarios candidatos y actualizar el estado del pedido en el negocio sin hacer polling agresivo. Fallback de polling HTTP incluido en el frontend por simplicidad. |
| WhatsApp           | Stub compatible con Meta Cloud API (ver §5) | Sin credenciales todavía; el webhook ya tiene la forma correcta (verificación + mensajes entrantes) para conectar credenciales reales sin rediseñar nada. |
| Frontend           | HTML/CSS/JS plano, sin build              | El pedido es "puede ser simple"; evita la complejidad de un framework y un paso de build para un MVP que solo necesita un formulario y polling de estado. |
| Tests              | Vitest sobre un repositorio en memoria    | La lógica de asignación (la más delicada del negocio) se prueba sin depender de una base de datos real, incluida la condición de carrera. |

## 4. Asignación atómica: "el primero que acepta, gana"

Este es el punto más delicado del negocio: varios domiciliarios pueden
recibir la oferta del mismo pedido al mismo tiempo, y solo uno debe quedarse
con él.

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

## 5. Integración con WhatsApp: opciones y recomendación

No había credenciales de WhatsApp Business al momento de construir el MVP,
así que se dejó un **stub** del webhook (`backend/src/whatsapp/webhook.ts`)
con la forma correcta para conectarlo cuando existan.

Dos proveedores posibles:

- **Meta Cloud API (directo)**: gratis por conversación iniciada por el
  negocio dentro de la ventana de 24h, pero requiere verificación de
  negocio en Meta Business Manager (puede tardar días) y manejo manual de
  plantillas de mensaje aprobadas para iniciar conversación.
- **Twilio (o similar: 360dialog, MessageBird)**: onboarding más rápido,
  mejor DX (SDKs, sandbox de pruebas inmediato), pero con costo adicional
  por mensaje sobre el de Meta.

**Recomendación**: empezar con **Twilio** para probar el flujo end-to-end
rápido en el sandbox de WhatsApp de Twilio sin esperar la verificación de
Meta, y migrar a Meta Cloud API directo cuando el volumen justifique
ahorrarse el margen de Twilio. El router del webhook ya está aislado detrás
de una función (`createWhatsAppRouter`) para que ese cambio de proveedor no
afecte al resto del sistema — solo cambia cómo se recibe/envía el mensaje,
no la lógica de despacho.

Pendiente de implementar quien tenga las credenciales:
- Verificar `X-Hub-Signature-256` (Meta) o el token de Twilio antes de
  confiar en el body del webhook.
- Enviar mensajes salientes vía la Graph API / API de Twilio (hoy el stub
  solo loguea lo que respondería).
- Manejar sesión de conversación por número (en qué paso del flujo está).

## 6. Consideraciones para producción (fuera del alcance del MVP)

- **Autenticación/autorización**: hoy los endpoints no requieren
  credenciales. Antes de producción: API key o JWT para negocios, y algún
  mecanismo de identidad para domiciliarios (hoy se identifican solo por
  `courierId`).
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
