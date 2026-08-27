# WhatDomi

Plataforma de despacho de domiciliarios (repartidores en moto) para
restaurantes y tiendas online en ciudades pequeñas de Latinoamérica.

El flujo principal es por **WhatsApp**: el negocio escribe, el bot le pide
su nombre y las direcciones de recogida/entrega **en texto libre** (sin
compartir ubicación GPS), el sistema geocodifica esas direcciones, calcula
una tarifa y se la confirma. Si el solicitante acepta, la plataforma le
ofrece el pedido al domiciliario **activo** más **cercano**, en tiempo
real desde su PWA; tiene **60 segundos** para aceptar, y si no responde se
le ofrece automáticamente al siguiente más cercano, y así sucesivamente
(ver "Cascada de asignación" más abajo). El negocio recibe entonces el
nombre, la placa y el teléfono del domiciliario asignado. Si nadie acepta
a tiempo, el pedido queda para que un admin lo asigne a mano, como último
recurso. También existe un formulario web directo como alternativa a
WhatsApp, y un panel de administración con configuración de tarifas,
liquidaciones, y monitoreo.

Para el diseño técnico completo (diagrama, decisiones de stack, cómo se
resuelve la condición de carrera de la asignación, por qué la
geocodificación combina un LLM con un geocodificador real, y qué queda
fuera del MVP) ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Los 3 roles

- **Admin** (dueño de la plataforma): configura tarifa/comisión desde el
  panel, ve el monitoreo y las estadísticas globales. No es una cuenta con
  usuario/contraseña — el panel se protege con una clave compartida
  (`ADMIN_API_KEY`).
- **Negocio**: quien solicita domicilios, por WhatsApp o por el formulario
  web directo.
- **Domiciliario**: quien los entrega, desde su PWA.

Negocio y domiciliario se modelan como entidades separadas (`Business`,
`Courier`), no como filas de una tabla `users` con un campo `role` —
ver `docs/ARCHITECTURE.md` §2.

## Estructura del repo

```
whatdomi/
├── backend/            API (Node.js + TypeScript + Express + Postgres/PostGIS)
├── frontend/
│   ├── index.html       Formulario web directo (alternativa a WhatsApp)
│   ├── admin.html        Tablero de administración (monitoreo + reasignar/cancelar)
│   └── courier/           PWA del domiciliario (activación, ubicación, ofertas)
├── docs/                Documentación de arquitectura
└── docker-compose.yml    Postgres + PostGIS para desarrollo local
```

## Requisitos

- Node.js 20+
- Docker (para levantar Postgres+PostGIS localmente) o una instancia propia
  de Postgres con la extensión PostGIS disponible.

## Correr el proyecto localmente

### 1. Base de datos

```bash
docker compose up -d db
```

Esto levanta Postgres+PostGIS en `localhost:5432` con las credenciales de
`.env.example` (usuario/clave `whatdomi`, base `whatdomi`).

### 2. Backend

```bash
cd backend
cp .env.example .env    # ajusta valores si hace falta (tarifa, geocoding, WhatsApp)
npm install
npm run db:migrate      # crea las tablas, extensión PostGIS, triggers e índices
npm run dev             # http://localhost:3000
```

Correr las pruebas (lógica de asignación, flujo conversacional de
WhatsApp, geocodificación, tarifa y activación de domiciliarios):

```bash
npm test
```

### 3. Frontend(s)

Todo el frontend es HTML/CSS/JS plano, sin paso de build. Basta con
servirlo con cualquier servidor estático desde la carpeta `frontend/`:

```bash
cd frontend
npx serve .              # o: python3 -m http.server 5173
```

- `index.html` — formulario web directo para negocios (alternativa a WhatsApp).
- `admin.html` — panel del admin: configuración de tarifa/comisión,
  liquidaciones y registro de servicios por día, estadísticas, y monitoreo
  de pedidos en vivo (reasignar/cancelar). Pide la `X-Admin-Key` si el
  backend la exige.
- `courier/index.html` — PWA del domiciliario (registro, activación por
  código, ubicación en vivo, recibir y aceptar ofertas).

Si tu backend no corre en `http://localhost:3000`, ajusta
`window.WHATDOMI_API_URL` en el `<script>` de cada página.

### 4. Probar el flujo por WhatsApp (sin credenciales reales)

Sin una cuenta de WhatsApp Business todavía, se puede simular un mensaje
entrante llamando directamente al webhook con el formato que manda Meta:

```bash
curl -X POST http://localhost:3000/whatsapp/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{ "changes": [{ "value": { "messages": [
      { "from": "573001112233", "text": { "body": "hola" } }
    ]}}]}]
  }'
```

Repite el `curl` cambiando el texto (`"Carlos de la tienda"`, `"frente al
parque central"`, `"al lado de la iglesia mayor"`, `"si"`) para avanzar la
conversación paso a paso. Cada respuesta del bot queda en los logs del
backend (`[whatsapp] -> <teléfono>: ...`), porque el envío real todavía es
un stub (ver §5 de `docs/ARCHITECTURE.md`).

### 5. Probar el flujo directo (formulario web + API) a mano

```bash
# 1. Registrar un negocio
curl -X POST http://localhost:3000/api/businesses \
  -H "Content-Type: application/json" \
  -d '{"name":"Restaurante La Esquina","phone":"+573000000001"}'

# 2. Registrar un domiciliario (la cédula es su identificador y su credencial de activación)
curl -X POST http://localhost:3000/api/couriers \
  -H "Content-Type: application/json" \
  -d '{"name":"Carlos","phone":"+573000000002","nationalId":"1020304050"}'

# 3. El domiciliario se activa con su cédula y reporta ubicación
curl -X POST http://localhost:3000/api/couriers/<courierId>/activate \
  -H "Content-Type: application/json" -d '{"nationalId":"1020304050"}'
curl -X POST http://localhost:3000/api/couriers/<courierId>/location \
  -H "Content-Type: application/json" -d '{"lat":4.6533,"lng":-74.0836}'

# 4. El negocio crea el pedido directamente (sin cotización, ya con coordenadas)
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "businessId":"<businessId>",
    "pickup":{"lat":4.6533,"lng":-74.0836}, "pickupAddress":"Calle 100 #10-10",
    "dropoff":{"lat":4.66,"lng":-74.09}, "dropoffAddress":"Cra 15 #85-20"
  }'

# 5. El domiciliario acepta (solo funciona si le toca el turno en la cascada)
curl -X POST http://localhost:3000/api/orders/<orderId>/accept \
  -H "Content-Type: application/json" -d '{"courierId":"<courierId>"}'
```

## Ciclo de vida de un pedido

```
CREATED ──▶ SEARCHING ──▶ ASSIGNED ──▶ IN_PROGRESS ──▶ DELIVERED
   ▲            │  ▲
   │            │  └─ cascada: 60s por candidato, pasa al siguiente si no responde
   │            ├─▶ NO_COURIERS_AVAILABLE (nadie activo cerca, ni para empezar)
   │            └─▶ UNASSIGNED (se agotó la cascada sin que nadie aceptara)
QUOTED (solo flujo WhatsApp, esperando confirmación del solicitante)
   │
   └─▶ CANCELLED (desde cualquier estado activo)

UNASSIGNED ──▶ ASSIGNED  (solo vía asignación manual del admin, POST /api/orders/:id/assign)
```

`QUOTED` es exclusivo del flujo de WhatsApp: el pedido ya tiene tarifa
calculada pero todavía no se buscó domiciliario, a la espera de que el
solicitante responda *SI*. El formulario web directo (`POST /api/orders`)
se salta ese paso y arranca directo en `SEARCHING`.

## Cascada de asignación (timeout + reintento)

Al pasar a `SEARCHING`, el pedido no se ofrece a todos los candidatos a la
vez: se le ofrece solo al **más cercano**, con una ventana de
`OFFER_TIMEOUT_MS` (60s por defecto) para aceptar desde su PWA. Si no
responde a tiempo:

1. Se le retira la oferta (evento `order:offer-cancelled` a su sala).
2. Se le ofrece al siguiente más cercano, con otros 60s.
3. Así hasta que alguien acepte, o se agote la lista de candidatos activos.

Si se agota la lista sin que nadie acepte, el pedido pasa a `UNASSIGNED` y
aparece en el panel de admin para asignación manual
(`POST /api/orders/:id/assign` con `{"courierId": "..."}`) — el único
lugar de todo el sistema donde un humano asigna a mano, y solo como
fallback de última instancia. El admin también puede pedir un
`POST /api/orders/:id/reassign` para que se reintente la cascada completa
en vez de elegir a mano.

Solo el candidato al que le toca el turno puede aceptar en un momento dado
(`POST /api/orders/:id/accept` rechaza a cualquier otro con `409`), pero la
asignación en sí sigue resolviéndose con la misma operación atómica de
base de datos que antes — ver `docs/ARCHITECTURE.md` §4.

## API (resumen)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/businesses` | Registrar un negocio |
| POST | `/api/couriers` | Registrar un domiciliario (nombre, WhatsApp, `nationalId`/cédula, placa) |
| POST | `/api/couriers/:id/activate` | Activarse con la cédula (`402` si tiene comisión pendiente de días anteriores) |
| POST | `/api/couriers/:id/deactivate` | Desactivarse (sin necesitar la cédula) |
| POST | `/api/couriers/:id/location` | Reportar ubicación en vivo |
| POST | `/api/orders` | Crear una solicitud de domicilio directa (arranca la cascada de asignación) |
| GET | `/api/orders` | Listar pedidos, opcional `?status=SEARCHING,ASSIGNED,UNASSIGNED,...` (tablero de administración) |
| GET | `/api/orders/:id` | Consultar estado de un pedido |
| POST | `/api/orders/:id/accept` | El domiciliario al que le toca el turno acepta el pedido (`409` si no es su turno o ya no está disponible) |
| POST | `/api/orders/:id/picked-up` | Marcar como recogido / en curso |
| POST | `/api/orders/:id/delivered` | Marcar como entregado |
| POST | `/api/orders/:id/cancel` | Cancelar el pedido |
| POST | `/api/orders/:id/reassign` | Fallback del admin: libera la asignación actual y reintenta la cascada completa desde cero |
| POST | `/api/orders/:id/assign` | Última instancia del admin: asigna a mano un pedido `UNASSIGNED` con `{"courierId": "..."}` |
| GET/POST | `/whatsapp/webhook` | Webhook de WhatsApp Business (flujo conversacional completo, ver más abajo) |
| GET | `/api/admin/config` | Configuración vigente de tarifa/comisión |
| PUT | `/api/admin/config` | Actualizar tarifa base, costo/km, tarifa mínima, comisión, moneda o recargos |
| GET | `/api/admin/service-log?date=` | Servicios entregados ese día: quién, cuánto, origen/destino, hora |
| GET | `/api/admin/settlements?date=` | Totales por domiciliario ese día: servicios, cobrado, comisión, si ya liquidó |
| POST | `/api/admin/settlements/:courierId/:date/pay` | Marcar como pagada la comisión de ese domiciliario ese día |
| GET | `/api/admin/stats?range=day\|week` | Totales agregados: servicios, ingresos, comisión de la plataforma |

`GET /api/orders`, `POST /api/orders/:id/reassign`, `POST /api/orders/:id/assign`
y todo `/api/admin/*` están protegidos por la clave de administrador
(`ADMIN_API_KEY`, cabecera `X-Admin-Key`) — ver "Los 3 roles" arriba y
`docs/ARCHITECTURE.md` §2.

Eventos de Socket.io emitidos por el backend: `order:offer` (a cada
domiciliario candidato), `order:won` (al ganador), `order:status` (a quien
siga la sala `order:<id>`), `order:offer-cancelled`.

## El flujo de WhatsApp

1. El bot saluda y pide el nombre de quien solicita el servicio.
2. Pregunta la dirección de **recogida** en texto libre (ej: *"frente al
   parque central, al lado de la panadería"*), sin pedir ubicación GPS.
3. Pregunta la dirección de **entrega**, también en texto libre.
4. Ambas direcciones se geocodifican (ver `docs/ARCHITECTURE.md` §5: un LLM
   normaliza el texto informal, y un geocodificador real —Nominatim/OSM—
   resuelve las coordenadas). Se calcula distancia y tarifa (base + costo
   por km + piso mínimo, configurables en vivo por el admin desde
   `/api/admin/config`), y se le muestra al solicitante para que responda
   *SI* o *NO*.
5. Si confirma: se crea el pedido y arranca la cascada de asignación
   (ver más abajo), igual que el flujo directo.
6. Al asignarse: el **domiciliario** recibe los datos del servicio
   (recogida, entrega, tarifa) y el **negocio** recibe nombre, placa y
   teléfono del domiciliario.

Toda la máquina de estados vive en
`backend/src/whatsapp/conversation.ts` y está cubierta por tests
(`backend/tests/whatsapp-conversation.test.ts`) que no dependen de tener
credenciales de WhatsApp ni de red real.

## Comisión y liquidación diaria

La plataforma se queda con un **% configurable** (`commissionPercentage`
en `/api/admin/config`) de lo que cada domiciliario cobra en sus
servicios. Al final de cada entrega se recalcula su **liquidación del
día** (`GET /api/admin/settlements?date=...`): cuántos servicios hizo,
cuánto cobró, cuánto le corresponde a la plataforma, y si ya la pagó
(acción manual del admin, `POST /api/admin/settlements/:courierId/:date/pay`
— el pago en sí sigue siendo offline, igual que el cobro del servicio).

**Un domiciliario con comisión pendiente de un día anterior no puede
activarse al día siguiente**: `POST /api/couriers/:id/activate` responde
`402 Payment Required` con el detalle de qué días quedaron sin pagar. La
liquidación del día en curso nunca bloquea su propia activación — solo la
de días ya cerrados. Ver `backend/src/domain/settlement.ts`
(`SettlementService`) y sus tests
(`backend/tests/settlement.test.ts`) para el detalle de esta regla.

## Fuera de alcance en este MVP

- **Pagos**: no hay pasarela integrada; se maneja manual/offline entre
  negocio y domiciliario. El modelo de datos ya tiene `paymentLink` /
  `paymentStatus` en `Order` para conectar una pasarela más adelante sin
  migrar el esquema otra vez.
- **Verificación de identidad real**: tanto el solicitante (por WhatsApp)
  como el domiciliario (su cédula, sin verificarla contra ninguna fuente
  oficial) se identifican sin un mecanismo de autenticación fuerte —
  suficiente para el MVP, no para producción a gran escala (ver
  `docs/ARCHITECTURE.md` §7).

## Variables de entorno

Ver [`.env.example`](.env.example) para la lista completa comentada
(Postgres, radio de búsqueda, semilla inicial de tarifa/comisión,
`ADMIN_API_KEY`, geocodificación, credenciales de WhatsApp Business). Nunca
subas un `.env` real con secretos: el `.gitignore` ya lo excluye.

## Estado del WhatsApp Business

Todavía no hay credenciales de una cuenta de WhatsApp Business real. El
webhook (`backend/src/whatsapp/webhook.ts`) ya tiene la forma correcta para
Meta Cloud API (verificación + recepción de mensajes) y ejecuta el flujo
conversacional completo; el envío de mensajes salientes es un *stub* que
solo loguea (`backend/src/whatsapp/sender.ts`) hasta que haya credenciales
reales. Ver la sección 5 de `docs/ARCHITECTURE.md` para la comparación Meta
Cloud API vs. Twilio y la recomendación.
