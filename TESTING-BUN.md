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

> **Nota sobre versiones de bun:**
> 
> `bun add -g <tarball>` funcionaba en versiones estable de bun 1.2.x / 1.3.x, pero en **bun 1.4.3-canary** (d316760e8) hay un bug donde el lockfile se corrompe con referencias a tarballs inexistentes (`testpkg-1.0.0.tgz`) tras la extracción. Esto afecta a cualquier paquete scoped (`@scope/pkg`).
> 
> Si usas una versión estable de bun, `bun add -g` debería funcionar. Si no, el método manual funciona siempre:

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

### ¿Funciona `bun add -g <tarball>`?

En tu entorno: **sí** (ya lo verificaste con `jmfederico-pi-web-1.202608.2.tgz`). Si funciona en tu bun, el flujo más simple es:

```bash
npm run build && npm pack --pack-destination /tmp/piw
bun add -g /tmp/piw/jmfederico-pi-web-1.202609.0.tgz
```

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

## 4. Nota: Comportamiento de bun con `bun add -g <tarball>`

El comportamiento de `bun add -g` con tarballs de paquetes scoped varía según la versión de bun:

- **bun 1.2.x / 1.3.x (estable)**: `bun add -g <tarball>` funciona correctamente (lo que usaste la otra vez)
- **bun 1.4.3-canary (d316760e8)**: Bug conocido — el lockfile se corrompe con referencias a tarballs inexistentes (`testpkg-1.0.0.tgz`) tras la extracción

El error `"refusing to install dependency with unsafe name"` **no ocurre aquí** — en bun estable funciona. Si falla en tu entorno, puede ser una versión diferente o un lockfile corrupto.

**Método infalible (funciona siempre, sin depender de la versión de bun):**
- Manual copy + symlinks (sección 3) — funciona, no es rastreable por `bun pm ls -g`

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