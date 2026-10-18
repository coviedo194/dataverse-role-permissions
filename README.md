# Dataverse Role Permissions

Copilot canvas para consultar los privilegios de los roles de seguridad incluidos en una solución Dataverse.

## Requisitos

- GitHub Copilot CLI con soporte para extensiones canvas.
- Power Platform CLI (`pac`) con al menos un perfil autenticado.
- Azure CLI (`az`) con una sesión autenticada en el tenant del entorno y un usuario con acceso a Dataverse. Se recomienda la misma cuenta que en PAC.

La canvas consulta las soluciones mediante PAC y lee los roles y sus privilegios desde Dataverse Web API. Los tokens se obtienen localmente con `az`; no se guardan ni se incluyen en el repositorio.

## Instalar

En Copilot CLI, usa **Install extension from gist…** y pega la URL de esta carpeta:

`https://github.com/coviedo194/dataverse-role-permissions/tree/main/.github/extensions/role-permissions`

La extensión es pública, por lo que cualquier persona con acceso al repositorio puede ver e instalar el código. Cada usuario necesita sus propias herramientas y permisos PAC/Azure para consultar sus entornos.

### Disponible desde cualquier proyecto

Instala la extensión en el ámbito **user**, no **project**, para usarla desde cualquier repositorio. La entrada debe quedar en `$COPILOT_HOME/extensions/role-permissions/extension.mjs` (por defecto, `~/.copilot/extensions/role-permissions/extension.mjs`). No hace falta instalar dependencias: Copilot proporciona el SDK.

Después de instalarla o actualizarla, inicia una nueva sesión de Copilot. Si un repositorio contiene `.github/extensions/role-permissions/`, esa copia del proyecto tiene prioridad sobre la instalación de usuario.

## Uso

Abre la canvas **Permisos de roles** y selecciona:

1. **Perfil PAC:** determina el entorno y lista sus soluciones. Cambia el perfil PAC activo en la máquina local.
2. **Cuenta y tenant de Azure CLI:** determina la identidad que consulta los permisos. Solo muestra contextos ya autenticados mediante `az account list`, agrupados por usuario y tenant. No cambia la cuenta Azure predeterminada: obtiene el token con el contexto de suscripción seleccionado (también admite cuentas de tenant sin suscripción real).
3. **Solución:** muestra la matriz de privilegios por tabla y profundidad.

La canvas comprueba el acceso con `WhoAmI` antes de habilitar la consulta de permisos y lo vuelve a comprobar al cargarlos. Si los nombres de cuenta son diferentes muestra un aviso, sin bloquear identidades equivalentes o alias que sí tengan acceso. Al cambiar de cuenta Azure se descartan los permisos anteriores y se comprueba de nuevo el acceso.

Las sesiones PAC y Azure son independientes: seleccionar un perfil PAC no inicia sesión ni cambia la cuenta de Azure. Si es necesario, ejecuta en una terminal:

```sh
az login --tenant <tenant-del-entorno> --allow-no-subscriptions
```

Sustituye `<tenant-del-entorno>` por el tenant que contiene el entorno y elige la cuenta del perfil PAC. Después pulsa **Actualizar cuentas Azure** y selecciona la cuenta y el tenant adecuados; no es necesario reiniciar la canvas. Azure CLI puede reemplazar contextos al iniciar sesión con otro usuario, por lo que el selector solo puede mostrar los que el CLI conserva. **Comprobar acceso** permite revalidar la selección actual. La canvas no inicia sesiones interactivas automáticamente ni devuelve tokens al navegador.

## Diagnóstico

Si aparece **403 — The user is not a member of the organization**, revisa la cuenta y el tenant de Azure CLI, no solo el perfil PAC. Si son correctos, comprueba que el usuario está habilitado y tiene acceso en ese entorno Dataverse. Una comprobación de acceso correcta no garantiza privilegios suficientes para todas las consultas posteriores.

Si la canvas abre pero falla al cargar las soluciones, comprueba que la URL del entorno se conserva completa. La columna `ERP URL` es opcional en `pac auth list`; la extensión admite perfiles con y sin ella. Tras actualizar la extensión, recárgala o inicia una nueva sesión de Copilot para no seguir ejecutando la versión anterior.

Para ejecutar las pruebas locales sin conectar a Dataverse:

```sh
node --test .github/extensions/role-permissions/extension.test.mjs
node --check .github/extensions/role-permissions/extension.mjs
git diff --check
```
