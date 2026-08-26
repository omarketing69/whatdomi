# WhatDomi

Plataforma de despacho de domiciliarios (repartidores en moto) para
restaurantes y tiendas online en ciudades pequeñas de Latinoamérica.

El flujo principal es por **WhatsApp**: el negocio escribe, el bot le pide
su nombre y las direcciones de recogida/entrega **en texto libre** (sin
compartir ubicación GPS), el sistema geocodifica esas direcciones, calcula
una tarifa y se la confirma. Si el solicitante acepta, la plataforma busca
qué domiciliarios están **activos** y **cerca**, les notifica en tiempo
real desde su PWA, y asigna el pedido al **primero que lo acepte**. El
negocio recibe entonces el nombre, la placa y el teléfono del domiciliario
asignado. También existe un formulario web directo como alternativa a
WhatsApp, y un tablero de administración de solo monitoreo.

Para el diseño técnico completo (diagrama, decisiones de stack, cómo se
resuelve la condición de carrera de la asignación, por qué la
geocodificación combina un LLM con un geocodificador real, y qué queda
fuera del MVP) ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

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
- `admin.html` — tablero de monitoreo (pedidos en vivo, reasignar/cancelar).
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

# 2. Registrar un domiciliario (la respuesta trae el activationCode)
curl -X POST http://localhost:3000/api/couriers \
  -H "Content-Type: application/json" \
  -d '{"name":"Carlos","phone":"+573000000002"}'

# 3. El domiciliario se activa con su código y reporta ubicación
curl -X POST http://localhost:3000/api/couriers/<courierId>/activate \
  -H "Content-Type: application/json" -d '{"activationCode":"<código>"}'
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

# 5. El domiciliario acepta (el primero que llame a este endpoint gana)
curl -X POST http://localhost:3000/api/orders/<orderId>/accept \
  -H "Content-Type: application/json" -d '{"courierId":"<courierId>"}'
```

## Ciclo de vida de un pedido

```
CREATED ──▶ SEARCHING ──▶ ASSIGNED ──▶ IN_PROGRESS ──▶ DELIVERED
   ▲            │
   │            └─▶ NO_COURIERS_AVAILABLE
QUOTED (solo flujo WhatsApp, esperando confirmación del solicitante)
   │
   └─▶ CANCELLED (desde cualquier estado activo)
```

`QUOTED` es exclusivo del flujo de WhatsApp: el pedido ya tiene tarifa
calculada pero todavía no se buscó domiciliario, a la espera de que el
solicitante responda *SI*. El formulario web directo (`POST /api/orders`)
se salta ese paso y arranca directo en `SEARCHING`.

## API (resumen)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/businesses` | Registrar un negocio |
| POST | `/api/couriers` | Registrar un domiciliario (responde con `activationCode`) |
| POST | `/api/couriers/:id/activate` | Activarse con el código (empieza a recibir ofertas) |
| POST | `/api/couriers/:id/deactivate` | Desactivarse (sin necesitar el código) |
| POST | `/api/couriers/:id/location` | Reportar ubicación en vivo |
| POST | `/api/orders` | Crear una solicitud de domicilio directa (busca y notifica candidatos de inmediato) |
| GET | `/api/orders` | Listar pedidos, opcional `?status=SEARCHING,ASSIGNED` (tablero de administración) |
| GET | `/api/orders/:id` | Consultar estado de un pedido |
| POST | `/api/orders/:id/accept` | Un domiciliario acepta el pedido (atómico) |
| POST | `/api/orders/:id/picked-up` | Marcar como recogido / en curso |
| POST | `/api/orders/:id/delivered` | Marcar como entregado |
| POST | `/api/orders/:id/cancel` | Cancelar el pedido |
| POST | `/api/orders/:id/reassign` | Fallback manual del admin: libera la asignación y reintenta la búsqueda |
| GET/POST | `/whatsapp/webhook` | Webhook de WhatsApp Business (flujo conversacional completo, ver más abajo) |

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
   por km, configurable en `.env`), y se le muestra al solicitante para que
   responda *SI* o *NO*.
5. Si confirma: se crea el pedido y arranca la búsqueda automática de
   domiciliarios, igual que el flujo directo.
6. Al asignarse: el **domiciliario** recibe los datos del servicio
   (recogida, entrega, tarifa) y el **negocio** recibe nombre, placa y
   teléfono del domiciliario.

Toda la máquina de estados vive en
`backend/src/whatsapp/conversation.ts` y está cubierta por tests
(`backend/tests/whatsapp-conversation.test.ts`) que no dependen de tener
credenciales de WhatsApp ni de red real.

## Fuera de alcance en este MVP

- **Pagos**: no hay pasarela integrada; se maneja manual/offline entre
  negocio y domiciliario. El modelo de datos ya tiene `paymentLink` /
  `paymentStatus` en `Order` para conectar una pasarela más adelante sin
  migrar el esquema otra vez.
- **Verificación de identidad real**: tanto el solicitante (por WhatsApp)
  como el domiciliario (código de activación simple) se identifican sin un
  mecanismo de autenticación fuerte — suficiente para el MVP, no para
  producción a gran escala (ver `docs/ARCHITECTURE.md` §7).

## Variables de entorno

Ver [`.env.example`](.env.example) para la lista completa comentada
(Postgres, radio de búsqueda, tarifa, geocodificación, credenciales de
WhatsApp Business). Nunca subas un `.env` real con secretos: el
`.gitignore` ya lo excluye.

## Estado del WhatsApp Business

Todavía no hay credenciales de una cuenta de WhatsApp Business real. El
webhook (`backend/src/whatsapp/webhook.ts`) ya tiene la forma correcta para
Meta Cloud API (verificación + recepción de mensajes) y ejecuta el flujo
conversacional completo; el envío de mensajes salientes es un *stub* que
solo loguea (`backend/src/whatsapp/sender.ts`) hasta que haya credenciales
reales. Ver la sección 5 de `docs/ARCHITECTURE.md` para la comparación Meta
Cloud API vs. Twilio y la recomendación.
