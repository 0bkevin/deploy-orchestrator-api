# Deploy Orchestrator API

API REST mínima en TypeScript para coordinar despliegues de servicios mediante una máquina de estados explícita.

## Requisitos

- Node.js 22+
- npm 10+

## Instalar, ejecutar y probar

```bash
npm install
npm run dev
# en otra terminal
npm test
npm run typecheck
```

La API escucha en `http://localhost:3000` por defecto. Puede cambiarse con `PORT=8080 npm start`.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/deployments` | Crea un deployment `queued`; recibe `{ "service", "version" }`. Acepta `Idempotency-Key`. |
| POST | `/deployments/:id/transitions` | Transiciona con `{ "to": "running" | "succeeded" | "failed" | "rolled_back" }`. |
| GET | `/deployments?service=&status=&limit=&offset=` | Lista de más nuevo a más viejo, con filtros combinables y paginación. |
| GET | `/services/:name/current` | Devuelve el último deployment exitoso no revertido. |
| GET | `/health` | Devuelve estado, uptime e in-flight deployments. |

Ejemplo:

```bash
curl -i -X POST http://localhost:3000/deployments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: deploy-orders-1' \
  -d '{"service":"orders","version":"1.0.0"}'
```

## Decisiones de diseño

El dominio se modela con un tipo cerrado de estados y una tabla explícita de transiciones permitidas. Esto hace que una transición ilegal sea un conflicto (`409`) y evita reglas implícitas dispersas en las rutas HTTP. El almacenamiento es un `Map` en memoria, adecuado para el límite del ejercicio. La comprobación de un deployment en curso y su inserción ocurren en el mismo método síncrono, sin puntos `await`, por lo que no pueden intercalarse dos handlers en un único proceso de Node.js. La transición también lee, valida y escribe de forma síncrona, impidiendo que dos solicitudes apliquen transiciones contra el mismo estado anterior. La idempotencia se implementa con un índice `Idempotency-Key → deploymentId`, revisado antes de evaluar la regla de un deployment activo. El trade-off deliberado es no usar una base de datos: se pierde persistencia y coordinación entre múltiples réplicas, pero se conserva un diseño pequeño y demostrable en 45 minutos.

## Producción en Ubuntu

Desplegaría el servicio como una imagen o proceso versionado detrás de Caddy o Nginx para TLS y reverse proxy. Usaría Coolify o `systemd` para mantener el proceso vivo, reiniciarlo ante fallos y manejar variables de entorno. GitHub Actions validaría typecheck y pruebas y, tras aprobación, desplegaría el artefacto al servidor. Para despliegues sin caída usaría health checks y una estrategia blue/green o rolling deployment con el proxy apuntando solo a instancias sanas. El rollback consistiría en volver a la imagen o release previo, manteniendo migraciones compatibles hacia atrás. En producción reemplazaría el almacenamiento en memoria por PostgreSQL o SQLite según el nivel de replicación, con una restricción única/transacción para el invariant de in-flight. Finalmente incorporaría logs estructurados, métricas de latencia/conflictos y alertas mediante Grafana/Prometheus o un servicio equivalente.

## Alcance

No incluye frontend, autenticación, Docker ni una base de datos, tal como permite el ejercicio. Los tests cubren la máquina de estados, el único deployment activo, la deduplicación por idempotencia y el caso de rollback.
