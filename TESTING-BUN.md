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

### Flujo recomendado (un solo paso)

```bash
BUN_PI_TMP_DIR=$(mktemp -d) bun run build && bunx npm pack --pack-destination "$BUN_PI_TMP_DIR" && bun add -g "$BUN_PI_TMP_DIR"/jmfederico-pi-web-*.tgz
```

Esto:
1. Crea un directorio temporal único
2. Construye el proyecto con `bun run build`
3. Genera el tarball de npm (`jmfederico-pi-web-<version>.tgz`)
4. Instala globalmente con `bun add -g` desde el tarball
5. Limpia automáticamente el directorio temporal al salir (`$BUN_PI_TMP_DIR` se pierde pero no queda basura)

**Nota:** `bun add -g <tarball>` funciona correctamente en bun estable 1.2.x / 1.3.x / 1.4.x (lo que usaste la otra vez con `jmfederico-pi-web-1.202608.2.tgz`). El bug de lockfile (`testpkg-1.0.0.tgz`) solo afecta a bun 1.4.3-canary (d316760e8) que tenemos en este entorno de desarrollo.

### Verificación post-instalación

### Verificación post-instalación

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

`bun add -g <tarball>` funciona correctamente en bun estable 1.2.x / 1.3.x / 1.4.x (lo que usaste la otra vez con `jmfederico-pi-web-1.202608.2.tgz`). 

El bug de lockfile (`testpkg-1.0.0.tgz`) solo afecta a bun 1.4.3-canary (d316760e8) que tenemos en este entorno de desarrollo, no a versiones estables.

> **Nota:** `@jmfederico/pi-web` es un paquete scoped (`@scope/pkg`). En bun estable, `bun add -g` maneja scoped packages correctamente. En versiones canary puede fallar por el bug de lockfile descrito.

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