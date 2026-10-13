# Dataverse Role Permissions

Copilot canvas para consultar los privilegios de los roles de seguridad incluidos en una solución Dataverse.

## Requisitos

- GitHub Copilot CLI con soporte para extensiones canvas.
- Power Platform CLI (`pac`) con al menos un perfil autenticado.
- Azure CLI (`az`) autenticada con la misma cuenta que el perfil PAC seleccionado.

La canvas consulta las soluciones mediante PAC y lee los roles y sus privilegios desde Dataverse Web API. Los tokens se obtienen localmente con `az`; no se guardan ni se incluyen en el repositorio.

## Instalar

En Copilot CLI, usa **Install extension from gist…** y pega la URL de esta carpeta:

`https://github.com/coviedo194/dataverse-role-permissions/tree/main/.github/extensions/role-permissions`

La extensión es pública, por lo que cualquier persona con acceso al repositorio puede ver e instalar el código. Cada usuario necesita sus propias herramientas y permisos PAC/Azure para consultar sus entornos.

## Uso

Abre la canvas **Permisos de roles**, elige un perfil PAC y una solución. La matriz muestra los privilegios por tabla y su profundidad. La selección de un perfil actualiza el perfil PAC activo en la máquina local.
