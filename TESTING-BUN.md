# Instalación y prueba de PI WEB con Bun — sin Node.js

## 1. Construir el paquete localmente

```bash
# Desde el repo clonado (feature/native-bun-pty):
npm run build
```

Esto ejecuta el `prepack`: limpia `dist/`, genera los launchers (`dist/bin/*.sh`), compila TypeScript, plugins y la UI. El resultado es el directorio `dist/` con todo lo necesario.

## 2. Generar el tarball del paquete

```bash
npm pack
```

Esto crea `jmfederico-pi-web-<version>.tgz` en el directorio actual (npm renombra scoped packages: `@scope/pkg` → `scope-pkg.tgz`). El tarball incluye:
- `dist/` (binarios, launchers, plugins, cliente)
- `install.sh` (installer)
- `README.md`, `LICENSE`
- `docs/` (plugins.md, config.md, assets)
- Extensiones y `plugin-api.d.ts` / `server-plugin-api.d.ts`

**NO ejecutes `npm publish`** — el tarball se usa solo para prueba local.

## 3. Instalar con Bun (global, sin Node)

> **⚠️ Limitación de bun 1.4.x con paquetes scoped:**
> 
> `bun add -g @scope/pkg` falla con el error `"refusing to install dependency with unsafe name"`.
> Además, `npm pack` genera tarballs con `package/package.json` (estándar npm) que bun `add -g` no puede extraer.
> 
> Esto **no es un problema de PI WEB** — es una limitación de seguridad de bun con nombres de paquetes scoped (`@scope/name`) en instalaciones globales. El manual copy + symlinks es el método oficial para casos como este.

```bash
# 1. Extraer el tarball:
rm -rf /tmp/piweb-bun-install && mkdir -p /tmp/piweb-bun-install
tar -xzf jmfederico-pi-web-*.tgz -C /tmp/piweb-bun-install

# 2. Copiar al directorio global de bun:
mkdir -p ~/.bun/install/global/node_modules/@jmfederico/pi-web
cp -r /tmp/piweb-bun-install/package/* ~/.bun/install/global/node_modules/@jmfederico/pi-web/

# 3. Crear symlinks para los binarios:
ln -sf ~/.bun/install/global/node_modules/@jmfederico/pi-web/dist/bin/pi-web.sh ~/.bun/bin/pi-web
ln -sf ~/.bun/install/global/node_modules/@jmfederico/pi-web/dist/bin/pi-web-server.sh ~/.bun/bin/pi-web-server
ln -sf ~/.bun/install/global/node_modules/@jmfederico/pi-web/dist/bin/pi-web-sessiond.sh ~/.bun/bin/pi-web-sessiond
```

Esto coloca el paquete en `~/.bun/install/global/node_modules/@jmfederico/pi-web/` y crea symlinks en `~/.bun/bin/` (`pi-web`, `pi-web-server`, `pi-web-sessiond`). El launcher detecta automáticamente que la instalación es de bun (porque el path contiene `*/install/global/node_modules`).

> **Nota:** `bun pm ls -g` no mostrará `@jmfederico/pi-web` porque la instalación es manual (bun no la rastreó). Pero los binarios funcionan correctamente porque los symlinks están en `~/.bun/bin/`.

### Verificación de que está instalado sin Node

```bash
# 1. Que los comandos existen:
which pi-web
which pi-web-server
which pi-web-sessiond

# 2. Que el launcher identifica el runtime (debe ser "bun"):
pi-web --print-runtime
# → bun

# 3. Que la versión es correcta:
pi-web --version

# 4. Que el doctor reporta bun y terminales con PTY nativo:
pi-web doctor
# Debe mostrar:
#   runtime: bun
#   ✓ terminals: Bun native PTY (Bun.Terminal)
```

### Prueba funcional completa

```bash
# 5. Arrancar el server web y verificar que responde:
pi-web-server &
sleep 2
# Verificar puerto 3000:
curl -s http://localhost:3000 | head -5
# Debe devolver HTML del cliente.

# 6. Arrancar el sessiond y verificar que detecta la máquina/proyecto:
pi-web-sessiond &
sleep 2
# Verificar health endpoint:
curl -s http://localhost:3000/api/pi-web/version | python3 -m json.tool 2>/dev/null || curl -s http://localhost:3000/api/pi-web/version

# 7. Probar terminal (PTY nativo de bun):
# Un terminal creado por el sessiond debe usar Bun.Terminal sin node-pty.
# Esto se verifica en `pi-web doctor` con "✓ terminals: Bun native PTY".

# 8. Limpiar procesos de prueba:
kill %1 %2 2>/dev/null || true
```

### Prueba sin Node en PATH (entorno mínimo)

Para verificar que el paquete funciona **realmente sin Node**, prueba con Node fuera del PATH:

```bash
# Simula un entorno sin node (node no existe en PATH):
# El launcher debe encontrar bun en PATH y usarlo para todo.
env -i PATH="$HOME/.bun/bin:/usr/bin:/bin" HOME="$HOME" pi-web --print-runtime
# → bun (si bun está en PATH, funciona)
```

## 4. Nota: Limitación de bun con paquetes scoped

El error `"refusing to install dependency with unsafe name"` al hacer `bun add -g @scope/pkg` es una limitación de seguridad de bun 1.4.x. Bun rechaza los nombres scoped (`@...`) en instalaciones globales porque:

1. Los scoped packages son una función de npm, no de bun
2. bun usa una validación estricta de nombres para prevenir inyección de paquetes maliciosos
3. Esta validación no se relaja con flags ni variables de entorno

**Alternativas documentadas:**
- Manual copy + symlinks (el método usado arriba) — funciona, no es rastreable por bun
- `npm install -g <tarball>` — funciona con tarballs de npm, pero usa Node como runtime
- Esperar a que bun soporte scoped packages en global installs (no hay ETA oficial)

> **Nota:** `@jmfederico/pi-web` es un paquete scoped porque `@jmfederico` es el scope de la organización en npm. No se puede cambiar sin publicar un nuevo paquete con nombre diferente.

## 5. Desinstalar y volver a la versión estable (npm/Node)

### Paso 1: Desinstalar la versión de bun

```bash
# Limpiar manualmente el directorio de bun global:
rm -rf ~/.bun/install/global/node_modules/@jmfederico/pi-web

# Eliminar los symlinks:
rm -f ~/.bun/bin/pi-web ~/.bun/bin/pi-web-server ~/.bun/bin/pi-web-sessiond

# Si hay entradas en bun.lock, limpiarlas también:
# (bun remove puede fallar con "unsafe name" para paquetes scoped)
sed -i '/@jmfederico\/pi-web/d' bun.lock 2>/dev/null || true
```

### Paso 2: Instalar la versión estable desde npm

```bash
# Instalar la versión publicada (Node como runtime):
npm install -g @jmfederico/pi-web

# Si necesitas permitir scripts de node-pty (native binding para Node):
npm install -g @jmfederico/pi-web --allow-scripts=node-pty
```

### Paso 3: Verificar que la versión estable usa Node

```bash
pi-web --print-runtime
# → node (o el que tenga en PATH)

pi-web doctor
# Debe mostrar node como runtime y node-pty para terminales
```

---

## Notas sobre el launcher (`dist/bin/pi-web.sh`)

- **`PI_WEB_RUNTIME`** es una variable de entorno controlada por el usuario:
  - `auto` (default) — elige runtime según cómo se instaló (bun global → bun, npm global → node). Si no hay runtime usable, intenta el otro.
  - `bun` — **obliga** a usar Bun. Falla si no hay Bun con `Bun.Terminal`.
  - `node` — **obliga** a usar Node.js. Falla si no hay Node >= v22.19.0.

- El launcher **no tiene shebang de runtime**: es un script bash que resuelve el runtime en tiempo de ejecución. Así, tanto `npm` como `bun` generan symlinks al mismo archivo, y la decisión se toma al inicio.

- Para probar "bun puro sin node", el launcher usa la detección por árbol de instalación: si el paquete está en `*/install/global/node_modules` (layout de bun), intenta bun primero. Si bun no tiene `Bun.Terminal`, vuelve a node (con warning).

- `Bun.Terminal` es lo que hace posible PTY sin `node-pty`. Bun sin esta API no sirve para PI WEB — se vuelve a Node obligatoriamente.