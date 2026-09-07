# Changelog

Versionado semántico (`MAJOR.MINOR.PATCH`). La versión visible en la app (esquina
superior derecha de la topbar) es la de `package.json` — sirve para que un hub
pueda decir "estoy en la X" al reportar un problema. No confundir con
`__BUILD_VERSION__` (timestamp interno que solo detecta deploys nuevos).

Convención: `MAJOR` para cambios que rompen un flujo existente para el hub,
`MINOR` para features nuevos (como esta), `PATCH` para fixes.

## [1.1.0] — en desarrollo (rama `feat/ci-delivery-cargo`)

### Agregado

- Ingresar CI: pestañas nuevas **Delivery** y **Cargo** en Lima (competidores:
  Yango/InDrive/PedidosYa/Rappi para Delivery, Yango/InDrive para Cargo).
  Precio con descuento opcional, sin campo ETA. InDrive con contraofertas.
- Competidor **PedidosYa** en el catálogo.
- Versión de la app visible en la topbar.

Ver `docs/ci-delivery-cargo-plan.md` para el plan completo y las decisiones
de diseño.

## [1.0.0] — histórico (previo a este archivo)

Todo el trabajo anterior al 2026-09-07 no tiene entradas individuales acá —
consultar `git log` para el detalle. Hitos principales: dashboard con
materialized views, Ingresar CI (Normal/Corp/Aeropuerto/TukTuk), Rentabilidad,
Competitividad, sistema de accesos por rol, particionado de
`pricing_observations`, bonos de competidor con vigencia/historial.
