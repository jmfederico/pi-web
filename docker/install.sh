#!/usr/bin/env sh
set -eu

log() {
  printf '%s\n' "$*" >&2
}

die() {
  log "pi-web Docker installer: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: docker/install.sh [options]

Install or update the local-build PI WEB Docker runtime. The installer refreshes
Docker assets in the install directory, writes host-specific .env values,
rebuilds the image without using cache, and recreates the split sessiond/web
services without deleting persistent data.

Options:
  --install-dir DIR       Install directory (default: $XDG_DATA_HOME/pi-web-docker
                          or ~/.local/share/pi-web-docker)
  --data-dir DIR          Persistent data directory (default: INSTALL_DIR/data)
  --bind-address ADDR     Host bind address (default: 127.0.0.1)
  --port PORT             Host port (default: 8504)
  --pi-web-version VER    npm @jmfederico/pi-web version pin (default: latest)
  --pi-version VER        npm @earendil-works/pi-coding-agent version pin
                          (default: latest)
  --opensuse-image IMAGE  openSUSE base image (default: opensuse/tumbleweed)
  --nodejs-major MAJOR    Node.js major version package to install (default: 22)
  --nodejs-repo REPO      Node.js zypper repository URL, auto, or disabled
                          (default: auto)
  --extra-zypper-packages LIST
                          extra openSUSE packages to install during image build
  --asset-dir DIR         Copy Docker assets from a local docker/ directory
  --asset-ref REF         Fetch Docker assets from a Git ref (default: main)
  --skip-compose          Write assets/.env but skip build and service recreate
  -h, --help              Show this help

Environment variables with the same names used in .env may also be set before
running the installer, for example:

  PI_WEB_VERSION=1.202606.4 PI_VERSION=0.79.1 docker/install.sh
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ "$#" -ge 2 ] || die "--install-dir requires a value"
      PI_WEB_DOCKER_HOME=$2
      shift 2
      ;;
    --data-dir)
      [ "$#" -ge 2 ] || die "--data-dir requires a value"
      PI_WEB_DOCKER_DATA_DIR=$2
      shift 2
      ;;
    --bind-address)
      [ "$#" -ge 2 ] || die "--bind-address requires a value"
      PI_WEB_BIND_ADDR=$2
      shift 2
      ;;
    --port)
      [ "$#" -ge 2 ] || die "--port requires a value"
      PI_WEB_PORT=$2
      shift 2
      ;;
    --pi-web-version)
      [ "$#" -ge 2 ] || die "--pi-web-version requires a value"
      PI_WEB_VERSION=$2
      shift 2
      ;;
    --pi-version)
      [ "$#" -ge 2 ] || die "--pi-version requires a value"
      PI_VERSION=$2
      shift 2
      ;;
    --opensuse-image)
      [ "$#" -ge 2 ] || die "--opensuse-image requires a value"
      PI_WEB_OPENSUSE_IMAGE=$2
      shift 2
      ;;
    --nodejs-major)
      [ "$#" -ge 2 ] || die "--nodejs-major requires a value"
      PI_WEB_NODEJS_MAJOR=$2
      shift 2
      ;;
    --nodejs-repo)
      [ "$#" -ge 2 ] || die "--nodejs-repo requires a value"
      PI_WEB_NODEJS_REPO=$2
      shift 2
      ;;
    --extra-zypper-packages)
      [ "$#" -ge 2 ] || die "--extra-zypper-packages requires a value"
      PI_WEB_EXTRA_ZYPPER_PACKAGES=$2
      shift 2
      ;;
    --asset-dir)
      [ "$#" -ge 2 ] || die "--asset-dir requires a value"
      PI_WEB_DOCKER_ASSET_DIR=$2
      shift 2
      ;;
    --asset-ref)
      [ "$#" -ge 2 ] || die "--asset-ref requires a value"
      PI_WEB_DOCKER_REF=$2
      shift 2
      ;;
    --skip-compose)
      PI_WEB_DOCKER_SKIP_COMPOSE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

absolute_dir() {
  dir=$1
  mkdir -p "$dir" || return 1
  (cd "$dir" && pwd -P)
}

absolute_existing_dir() {
  dir=$1
  (cd "$dir" && pwd -P)
}

path_from_base() {
  base=$1
  path=$2
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *) printf '%s/%s\n' "$base" "$path" ;;
  esac
}

strip_wrapping_quotes() {
  value=$1
  case "$value" in
    \"*\")
      case "$value" in
        *\") value=${value#\"}; value=${value%\"} ;;
      esac
      ;;
    \'*\')
      case "$value" in
        *\') value=${value#\'}; value=${value%\'} ;;
      esac
      ;;
  esac
  printf '%s\n' "$value"
}

existing_env_value() {
  key=$1
  [ -f "$env_file" ] || return 1
  raw=$(awk -v key="$key" '
    function trim(value) {
      sub(/^[ \t]+/, "", value)
      sub(/[ \t\r]+$/, "", value)
      return value
    }
    /^[ \t]*(#|$)/ { next }
    {
      line = $0
      sub(/^[ \t]*export[ \t]+/, "", line)
      name = line
      sub(/=.*/, "", name)
      name = trim(name)
      if (name == key) {
        sub(/^[^=]*=/, "", line)
        print trim(line)
        found = 1
        exit
      }
    }
    END { if (!found) exit 1 }
  ' "$env_file") || return 1
  strip_wrapping_quotes "$raw"
}

value_from_env_or_default() {
  key=$1
  default_value=$2
  eval "is_set=\${$key+x}"
  if [ "${is_set:-}" = x ]; then
    eval "printf '%s\n' \"\${$key}\""
  else
    printf '%s\n' "$default_value"
  fi
}

value_from_env_or_existing_or_default() {
  key=$1
  default_value=$2
  eval "is_set=\${$key+x}"
  if [ "${is_set:-}" = x ]; then
    eval "printf '%s\n' \"\${$key}\""
  elif existing=$(existing_env_value "$key"); then
    printf '%s\n' "$existing"
  else
    printf '%s\n' "$default_value"
  fi
}

require_non_empty() {
  name=$1
  value=$2
  [ -n "$value" ] || die "$name must not be empty"
}

dotenv_quote() {
  value=$1
  [ -n "$value" ] || return 0
  printf '"%s"' "$(printf '%s' "$value" | sed 's/[\\"]/\\&/g')"
}

detect_docker_gid() {
  if [ -S /var/run/docker.sock ]; then
    if gid=$(stat -c '%g' /var/run/docker.sock 2>/dev/null); then
      printf '%s\n' "$gid"
      return 0
    fi
    if gid=$(stat -f '%g' /var/run/docker.sock 2>/dev/null); then
      printf '%s\n' "$gid"
      return 0
    fi
  fi

  if command -v getent >/dev/null 2>&1; then
    if gid=$(getent group docker | awk -F: 'NR == 1 { print $3 }'); then
      if [ -n "$gid" ]; then
        printf '%s\n' "$gid"
        return 0
      fi
    fi
  fi

  printf '0\n'
}

fetch_url() {
  url=$1
  target=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$target"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$target" "$url"
  else
    die "curl or wget is required to fetch Docker assets"
  fi
}

find_local_asset_dir() {
  if [ -f "${0:-}" ]; then
    candidate_dir=$(dirname "$0")
    if candidate_dir=$(absolute_existing_dir "$candidate_dir" 2>/dev/null); then
      if [ -f "$candidate_dir/Dockerfile" ] && [ -f "$candidate_dir/compose.yml" ]; then
        printf '%s\n' "$candidate_dir"
        return 0
      fi
    fi
  fi

  return 1
}

write_asset() {
  rel_path=$1
  mode=$2
  target=$install_dir/$rel_path
  temp_target=$target.$$
  mkdir -p "$(dirname "$target")"

  if [ -n "$asset_dir" ]; then
    [ -f "$asset_dir/$rel_path" ] || die "missing Docker asset: $asset_dir/$rel_path"
    cp "$asset_dir/$rel_path" "$temp_target"
  else
    fetch_url "$asset_base/$rel_path" "$temp_target"
  fi

  chmod "$mode" "$temp_target"
  mv "$temp_target" "$target"
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    die "Docker Compose is required (docker compose plugin or docker-compose)"
  fi
}

if [ -n "${XDG_DATA_HOME:-}" ]; then
  default_data_home=$XDG_DATA_HOME
elif [ -n "${HOME:-}" ]; then
  default_data_home=$HOME/.local/share
else
  default_data_home=
fi

default_install_dir=
if [ -n "$default_data_home" ]; then
  default_install_dir=$default_data_home/pi-web-docker
fi
install_dir_input=${PI_WEB_DOCKER_HOME:-$default_install_dir}
[ -n "$install_dir_input" ] || die "HOME, XDG_DATA_HOME, or PI_WEB_DOCKER_HOME must be set"
install_dir=$(absolute_dir "$install_dir_input") || die "could not create install directory"
env_file=$install_dir/.env

if [ "${PI_WEB_DOCKER_ASSET_DIR+x}" = x ]; then
  asset_dir=$(absolute_existing_dir "$PI_WEB_DOCKER_ASSET_DIR") || die "asset directory does not exist: $PI_WEB_DOCKER_ASSET_DIR"
  asset_base=
  log "Using Docker assets from $asset_dir"
elif asset_dir=$(find_local_asset_dir 2>/dev/null); then
  asset_base=
  log "Using Docker assets from $asset_dir"
else
  asset_ref=${PI_WEB_DOCKER_REF:-main}
  asset_base=${PI_WEB_DOCKER_ASSET_BASE:-https://raw.githubusercontent.com/jmfederico/pi-web/$asset_ref/docker}
  asset_dir=
  log "Fetching Docker assets from $asset_base"
fi

write_asset Dockerfile 0644
write_asset compose.yml 0644
write_asset .dockerignore 0644
write_asset install.sh 0755
write_asset bin/hostexec 0755
write_asset bin/install-opensuse-base 0755

custom_image_hooks_dir=$install_dir/custom-image.d
mkdir -p "$custom_image_hooks_dir" || die "could not create custom image hooks directory: $custom_image_hooks_dir"
if [ ! -e "$custom_image_hooks_dir/.gitkeep" ]; then
  : >"$custom_image_hooks_dir/.gitkeep" || die "could not initialize custom image hooks directory: $custom_image_hooks_dir"
fi

pi_web_uid=$(value_from_env_or_default PI_WEB_UID "$(id -u)")
pi_web_gid=$(value_from_env_or_default PI_WEB_GID "$(id -g)")
docker_gid=$(value_from_env_or_default DOCKER_GID "$(detect_docker_gid)")

raw_data_dir=$(value_from_env_or_existing_or_default PI_WEB_DOCKER_DATA_DIR "$install_dir/data")
data_dir=$(absolute_dir "$(path_from_base "$install_dir" "$raw_data_dir")") || die "could not create data directory"

pi_web_bind_addr=$(value_from_env_or_existing_or_default PI_WEB_BIND_ADDR 127.0.0.1)
pi_web_port=$(value_from_env_or_existing_or_default PI_WEB_PORT 8504)
pi_web_version=$(value_from_env_or_existing_or_default PI_WEB_VERSION latest)
pi_version=$(value_from_env_or_existing_or_default PI_VERSION latest)
pi_web_opensuse_image=$(value_from_env_or_existing_or_default PI_WEB_OPENSUSE_IMAGE opensuse/tumbleweed)
pi_web_nodejs_major=$(value_from_env_or_existing_or_default PI_WEB_NODEJS_MAJOR 22)
pi_web_nodejs_repo=$(value_from_env_or_existing_or_default PI_WEB_NODEJS_REPO auto)
pi_web_extra_zypper_packages=$(value_from_env_or_existing_or_default PI_WEB_EXTRA_ZYPPER_PACKAGES "")
pi_web_image=$(value_from_env_or_existing_or_default PI_WEB_IMAGE pi-web:local)
hostexec_image=$(value_from_env_or_existing_or_default HOSTEXEC_IMAGE alpine:3.22)
pi_web_max_upload_bytes=$(value_from_env_or_existing_or_default PI_WEB_MAX_UPLOAD_BYTES 67108864)

require_non_empty PI_WEB_UID "$pi_web_uid"
require_non_empty PI_WEB_GID "$pi_web_gid"
require_non_empty DOCKER_GID "$docker_gid"
require_non_empty PI_WEB_DOCKER_DATA_DIR "$data_dir"
require_non_empty PI_WEB_BIND_ADDR "$pi_web_bind_addr"
require_non_empty PI_WEB_PORT "$pi_web_port"
require_non_empty PI_WEB_VERSION "$pi_web_version"
require_non_empty PI_VERSION "$pi_version"
require_non_empty PI_WEB_OPENSUSE_IMAGE "$pi_web_opensuse_image"
require_non_empty PI_WEB_NODEJS_MAJOR "$pi_web_nodejs_major"
require_non_empty PI_WEB_NODEJS_REPO "$pi_web_nodejs_repo"
require_non_empty PI_WEB_IMAGE "$pi_web_image"
require_non_empty HOSTEXEC_IMAGE "$hostexec_image"
require_non_empty PI_WEB_MAX_UPLOAD_BYTES "$pi_web_max_upload_bytes"

pi_web_extra_zypper_packages_env=$(dotenv_quote "$pi_web_extra_zypper_packages")

umask 077
temp_env=$env_file.$$
cat >"$temp_env" <<EOF
# Generated by the PI WEB Docker installer.
# Re-run install.sh to refresh Docker assets and update the local image.
# Persistent data lives in PI_WEB_DOCKER_DATA_DIR and is not deleted by updates.

# Host identity used for the runtime containers.
PI_WEB_UID=$pi_web_uid
PI_WEB_GID=$pi_web_gid
DOCKER_GID=$docker_gid

# Persistent data and localhost-only default exposure.
PI_WEB_DOCKER_DATA_DIR=$data_dir
PI_WEB_BIND_ADDR=$pi_web_bind_addr
PI_WEB_PORT=$pi_web_port

# npm version pins. Use latest for quick updates, or set concrete versions.
PI_WEB_VERSION=$pi_web_version
PI_VERSION=$pi_version

# openSUSE/Node.js image build inputs.
PI_WEB_OPENSUSE_IMAGE=$pi_web_opensuse_image
PI_WEB_NODEJS_MAJOR=$pi_web_nodejs_major
PI_WEB_NODEJS_REPO=$pi_web_nodejs_repo
PI_WEB_EXTRA_ZYPPER_PACKAGES=$pi_web_extra_zypper_packages_env

# Runtime image names and limits.
PI_WEB_IMAGE=$pi_web_image
HOSTEXEC_IMAGE=$hostexec_image
PI_WEB_MAX_UPLOAD_BYTES=$pi_web_max_upload_bytes
EOF
mv "$temp_env" "$env_file"

log "Wrote Docker assets to $install_dir"
log "Wrote runtime environment to $env_file"
log "Persistent PI WEB Docker data: $data_dir"
log "Custom image hooks: $custom_image_hooks_dir"

if [ "${PI_WEB_DOCKER_SKIP_COMPOSE:-0}" = 1 ]; then
  log "Skipping Docker build/recreate because PI_WEB_DOCKER_SKIP_COMPOSE=1"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  die "docker CLI is required"
fi

if ! docker info >/dev/null 2>&1; then
  die "docker daemon is not reachable by this user"
fi

cache_bust=${CACHE_BUST:-install-$(date -u +%Y%m%dT%H%M%SZ)}

log ""
log "WARNING: updating recreates the PI WEB Docker session daemon."
log "Active Pi agent runtimes inside this Docker install can stop; update while sessions are idle."
log "Persistent data under $data_dir is kept. The installer does not run 'docker compose down -v'."
log ""
log "Building $pi_web_image with --pull --no-cache (CACHE_BUST=$cache_bust) ..."
(
  cd "$install_dir"
  CACHE_BUST=$cache_bust compose_cmd -f compose.yml build --pull --no-cache
)

log "Recreating split PI WEB Docker services ..."
(
  cd "$install_dir"
  compose_cmd -f compose.yml up -d --force-recreate --remove-orphans
)

log ""
log "PI WEB Docker runtime is ready: http://$pi_web_bind_addr:$pi_web_port"
log "Install directory: $install_dir"
log "To update later, re-run this installer."
(
  cd "$install_dir"
  compose_cmd -f compose.yml ps
)
