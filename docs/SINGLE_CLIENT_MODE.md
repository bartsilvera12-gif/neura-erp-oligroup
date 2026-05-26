# Modo single_client — instancia dedicada Triple 7

Este repo (`neura-erp-triple7`) es un fork del ERP base `neura-erp` pin-eado al commit `54793e1`
(2026-05-25). Está diseñado para correr como **instancia dedicada monocliente** en Coolify +
Supabase self-hosted, sirviendo exclusivamente a Triple 7.

## Variables de instancia

| Variable | Valor | Propósito |
|---|---|---|
| `NEURA_INSTANCE_MODE` | `single_client` | Activa el modo monocliente. Cualquier otro valor o ausente → modo multi-tenant legado. |
| `NEURA_CLIENT_SCHEMA` | `triple7` | Schema operativo Postgres FIJO. En este modo no se consulta `zentra_erp.empresas` para resolverlo. |
| `NEURA_CLIENT_NAME` | `Triple 7` | Branding/UI. Informativo, no condiciona seguridad. |

## Diferencias frente a multi-tenant

| Aspecto | multi-tenant | single_client |
|---|---|---|
| Resolución de schema operativo | `empresas.data_schema` desde `zentra_erp` (con fallback a `zentra_erp`) | `process.env.NEURA_CLIENT_SCHEMA` (fail-fast si vacío) |
| `createServiceRoleClientForEmpresa(empresaId)` | resuelve dinámico | retorna client con `db.schema = NEURA_CLIENT_SCHEMA` ignorando `empresaId` para routing |
| Endpoint `POST /api/admin/crear-empresa` | crea empresa + schema | responde `403 SINGLE_CLIENT_MODE` |
| Módulos sin filas en `empresa_modulos` | fallback al catálogo completo (retrocompat) | `[]` (strict allowlist) |
| Usuario sin `usuario_modulos` y rol no-admin | fallback a todos los módulos de empresa (retrocompat) | `[]` (alta explícita requerida) |
| `zentra_erp` como schema operativo | aceptado para empresas legadas | **prohibido** — solo bootstrap |

## Implementación

- Helpers: `src/lib/instance/single-client.ts` (`server-only`).
- Resolución schema: `src/lib/supabase/empresa-data-schema.ts`.
- Bloqueo de creación: `src/app/api/admin/crear-empresa/route.ts`.
- Allowlist estricto de módulos: `src/lib/modulos/resolve-effective-modules.ts`.

## Reglas operativas

- No reactivar módulos por aliases legacy. Toda activación debe pasar por filas explícitas en
  `empresa_modulos`.
- No hardcodear módulos de Triple 7 en frontend. La fuente de verdad es la DB.
- No usar `zentra_erp` como schema de datos en runtime. Si el dump inicial trajo datos a
  `zentra_erp`, deben moverse o aliasarse al schema `triple7` antes del cutover.

## Fase actual

Fase 2 — preparación de código. Sin migración de datos, sin push, sin deploy, sin tocar
producción (Cloud, Meta, Vercel, Coolify).
