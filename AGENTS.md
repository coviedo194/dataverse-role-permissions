# Instrucciones para agentes

## Propósito

Este repositorio contiene una extensión de GitHub Copilot con una canvas para consultar los privilegios de los roles de seguridad de soluciones Dataverse.

## Estructura

- `.github/extensions/role-permissions/extension.mjs`: punto de entrada de la canvas y servidor HTTP local.
- `README.md`: requisitos, instalación y uso.

## Reglas de trabajo

- Mantén los cambios dentro de esta extensión y su documentación; este repositorio es independiente de GoOfi.
- No incluyas credenciales, tokens ni datos exportados de entornos Dataverse. La autenticación se realiza localmente con PAC y Azure CLI.
- Conserva el servidor ligado a `127.0.0.1`; no expongas la API local en interfaces de red.
- No añadas dependencias si la funcionalidad puede resolverse con Node.js y el SDK disponible en Copilot CLI.
- Ejecuta `node --check .github/extensions/role-permissions/extension.mjs` y `git diff --check` después de cambios.
- No hagas commit ni push salvo que el usuario lo solicite explícitamente.
