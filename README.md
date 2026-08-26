# WhatDomi

Plataforma de despacho de domiciliarios (repartidores en moto) para
restaurantes y tiendas online en Latinoamérica.

Un negocio solicita un domicilio (desde WhatsApp o desde una web), la
plataforma busca qué domiciliarios están **activos** y **cerca** del punto
de recogida, les notifica en tiempo real, y asigna el pedido al **primero
que lo acepte**.

Para el diseño técnico completo (diagrama, decisiones de stack, cómo se
resuelve la condición de carrera de la asignación, plan de integración con
WhatsApp) ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Estructura del repo

```
whatdomi/
├── backend/     API (Node.js + TypeScript + Express + Postgres/PostGIS)
├── frontend/    Formulario web mínimo para pedir un domicilio sin WhatsApp
├── docs/        Documentación de arquitectura
└── docker-compose.yml   Postgres + PostGIS para desarrollo local
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
cp .env.example .env    # ajusta valores si hace falta
npm install
npm run db:migrate      # crea las tablas, extensión PostGIS, triggers e índices
npm run dev             # http://localhost:3000
```

Correr las pruebas (lógica de asignación, incluida la condición de carrera):

```bash
npm test
```

### 3. Frontend

El frontend es HTML/CSS/JS plano, sin paso de build. Basta con servirlo con
cualquier servidor estático:

```bash
cd frontend
npx serve .              # o: python3 -m http.server 5173
```

Abre la URL que te indique (por defecto algo como `http://localhost:3000` de
`serve`, o `http://localhost:5173` con `http.server`) y usa el formulario
para registrar un negocio y pedir un domicilio. Si tu backend no corre en
`http://localhost:3000`, ajusta `window.WHATDOMI_API_URL` en
`frontend/index.html`.

### 4. Probar el flujo completo a mano

```bash
# 1. Registrar un negocio
curl -X POST http://localhost:3000/api/businesses \
  -H "Content-Type: application/json" \
  -d '{"name":"Restaurante La Esquina","phone":"+573000000001"}'

# 2. Registrar un domiciliario
curl -X POST http://localhost:3000/api/couriers \
  -H "Content-Type: application/json" \
  -d '{"name":"Carlos","phone":"+573000000002"}'

# 3. El domiciliario reporta su ubicación y se activa
curl -X POST http://localhost:3000/api/couriers/<courierId>/location \
  -H "Content-Type: application/json" -d '{"lat":4.6533,"lng":-74.0836}'
curl -X POST http://localhost:3000/api/couriers/<courierId>/active \
  -H "Content-Type: application/json" -d '{"isActive":true}'

# 4. El negocio crea el pedido
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

## API (resumen)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/businesses` | Registrar un negocio |
| POST | `/api/couriers` | Registrar un domiciliario |
| POST | `/api/couriers/:id/location` | Reportar ubicación en vivo |
| POST | `/api/couriers/:id/active` | Marcar activo/inactivo |
| POST | `/api/orders` | Crear una solicitud de domicilio (busca y notifica candidatos) |
| GET | `/api/orders/:id` | Consultar estado de un pedido |
| POST | `/api/orders/:id/accept` | Un domiciliario acepta el pedido (atómico) |
| POST | `/api/orders/:id/picked-up` | Marcar como recogido / en curso |
| POST | `/api/orders/:id/delivered` | Marcar como entregado |
| POST | `/api/orders/:id/cancel` | Cancelar el pedido |
| GET/POST | `/whatsapp/webhook` | Webhook de WhatsApp Business (stub, ver `docs/ARCHITECTURE.md`) |

Eventos de Socket.io emitidos por el backend: `order:offer` (a cada
domiciliario candidato), `order:won` (al ganador), `order:status` (a quien
siga la sala `order:<id>`), `order:offer-cancelled`.

## Variables de entorno

Ver [`.env.example`](.env.example) para la lista completa comentada
(Postgres, radio de búsqueda, credenciales de WhatsApp Business). Nunca
subas un `.env` real con secretos: el `.gitignore` ya lo excluye.

## Estado del WhatsApp Business

Todavía no hay credenciales de una cuenta de WhatsApp Business real. El
webhook (`backend/src/whatsapp/webhook.ts`) ya tiene la forma correcta para
Meta Cloud API (verificación + recepción de mensajes) y solo falta conectar
credenciales reales. Ver la sección 5 de `docs/ARCHITECTURE.md` para la
comparación Meta Cloud API vs. Twilio y la recomendación.
