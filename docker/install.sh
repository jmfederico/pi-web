#!/usr/bin/env sh
# shellcheck disable=SC2034
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

Progressive host setup:
  The installer supports native Linux Docker Engine and Docker Desktop for Mac.
  Unknown Docker hosts fail closed before services are recreated. Set
  PI_WEB_DOCKER_EXTRA_HOST_PATHS to a whitespace-separated list of additional
  existing absolute directories to bind-mount at the same path in the containers.

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

fetch_url() {
  # POSIX sh function variables are global, so keep these names distinct
  # from caller state such as write_asset's target path.
  fetch_url_source=$1
  fetch_url_output=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$fetch_url_source" -o "$fetch_url_output"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$fetch_url_output" "$fetch_url_source"
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
  pi_web_docker_compose "$@"
}

run_runtime_compose() {
  compose_cmd --project-name "$compose_project_name" --env-file .env -f compose.yml -f compose.override.yml "$@"
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

asset_ref=$(value_from_env_or_existing_or_default PI_WEB_DOCKER_REF main)
asset_base=${PI_WEB_DOCKER_ASSET_BASE:-https://raw.githubusercontent.com/jmfederico/pi-web/$asset_ref/docker}
use_local_asset_dir=1
if [ "${PI_WEB_DOCKER_REFRESH_ASSETS:-0}" = 1 ] || [ "${PI_WEB_DOCKER_REF+x}" = x ] || [ "${PI_WEB_DOCKER_ASSET_BASE+x}" = x ]; then
  use_local_asset_dir=0
fi

if [ "${PI_WEB_DOCKER_ASSET_DIR+x}" = x ]; then
  asset_dir=$(absolute_existing_dir "$PI_WEB_DOCKER_ASSET_DIR") || die "asset directory does not exist: $PI_WEB_DOCKER_ASSET_DIR"
  asset_base=
  log "Using Docker assets from $asset_dir"
elif [ "$use_local_asset_dir" = 1 ] && local_asset_dir=$(find_local_asset_dir 2>/dev/null) && [ "$local_asset_dir" != "$install_dir" ]; then
  asset_dir=$local_asset_dir
  asset_base=
  log "Using Docker assets from $asset_dir"
else
  asset_dir=
  log "Fetching Docker assets from $asset_base"
fi

profile_helper_temp=
cleanup_profile_helper() {
  [ -z "$profile_helper_temp" ] || rm -f "$profile_helper_temp"
}
trap cleanup_profile_helper EXIT

if [ -n "$asset_dir" ]; then
  profile_helper=$asset_dir/internal/host-profile.sh
  [ -f "$profile_helper" ] || die "missing Docker asset: $profile_helper"
else
  profile_helper_temp=${TMPDIR:-/tmp}/pi-web-host-profile.$$
  fetch_url "$asset_base/internal/host-profile.sh" "$profile_helper_temp"
  profile_helper=$profile_helper_temp
fi

# shellcheck source=internal/host-profile.sh
# shellcheck disable=SC1091
. "$profile_helper"

if ! pi_web_docker_host_detect_profile; then
  pi_web_docker_host_print_detection_failure
  die "refusing to install on an unsupported or unknown Docker host setup"
fi

write_asset Dockerfile 0644
write_asset compose.yml 0644
write_asset .dockerignore 0644
write_asset install.sh 0755
write_asset pi-web-docker 0755
write_asset internal/bin/hostexec 0755
write_asset internal/image/install-opensuse-base 0755
write_asset internal/host-profile.sh 0644

custom_image_hooks_dir=$install_dir/custom-image.d
mkdir -p "$custom_image_hooks_dir" || die "could not create custom image hooks directory: $custom_image_hooks_dir"
if [ ! -e "$custom_image_hooks_dir/.gitkeep" ]; then
  : >"$custom_image_hooks_dir/.gitkeep" || die "could not initialize custom image hooks directory: $custom_image_hooks_dir"
fi

pi_web_uid=$(value_from_env_or_default PI_WEB_UID "$(id -u)")
pi_web_gid=$(value_from_env_or_default PI_WEB_GID "$(id -g)")
docker_gid=$(value_from_env_or_default DOCKER_GID "$(pi_web_docker_host_detect_docker_gid)")
pi_web_host_profile=$PI_WEB_DETECTED_DOCKER_HOST_PROFILE
hostexec_mode=$PI_WEB_DETECTED_HOSTEXEC_MODE

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
compose_project_name=$(value_from_env_or_existing_or_default COMPOSE_PROJECT_NAME pi-web)
hostexec_image=$(value_from_env_or_existing_or_default HOSTEXEC_IMAGE alpine:3.22)
pi_web_max_upload_bytes=$(value_from_env_or_existing_or_default PI_WEB_MAX_UPLOAD_BYTES 67108864)
pi_web_extra_host_paths=$(value_from_env_or_existing_or_default PI_WEB_DOCKER_EXTRA_HOST_PATHS "")

require_non_empty PI_WEB_UID "$pi_web_uid"
require_non_empty PI_WEB_GID "$pi_web_gid"
require_non_empty DOCKER_GID "$docker_gid"
require_non_empty PI_WEB_DOCKER_HOST_PROFILE "$pi_web_host_profile"
require_non_empty HOSTEXEC_MODE "$hostexec_mode"
require_non_empty PI_WEB_DOCKER_DATA_DIR "$data_dir"
require_non_empty PI_WEB_DOCKER_INSTALL_DIR "$install_dir"
require_non_empty PI_WEB_DOCKER_REF "$asset_ref"
require_non_empty PI_WEB_BIND_ADDR "$pi_web_bind_addr"
require_non_empty PI_WEB_PORT "$pi_web_port"
require_non_empty PI_WEB_VERSION "$pi_web_version"
require_non_empty PI_VERSION "$pi_version"
require_non_empty PI_WEB_OPENSUSE_IMAGE "$pi_web_opensuse_image"
require_non_empty PI_WEB_NODEJS_MAJOR "$pi_web_nodejs_major"
require_non_empty PI_WEB_NODEJS_REPO "$pi_web_nodejs_repo"
require_non_empty PI_WEB_IMAGE "$pi_web_image"
require_non_empty COMPOSE_PROJECT_NAME "$compose_project_name"
require_non_empty HOSTEXEC_IMAGE "$hostexec_image"
require_non_empty PI_WEB_MAX_UPLOAD_BYTES "$pi_web_max_upload_bytes"

pi_web_extra_zypper_packages_env=$(dotenv_quote "$pi_web_extra_zypper_packages")
pi_web_extra_host_paths_env=$(dotenv_quote "$pi_web_extra_host_paths")
compose_override_file=$install_dir/compose.override.yml
if ! pi_web_docker_host_write_compose_override "$compose_override_file" "$pi_web_host_profile" "$pi_web_extra_host_paths" "$install_dir"; then
  die "could not write host-specific Compose override"
fi

umask 077
temp_env=$env_file.$$
cat >"$temp_env" <<EOF
# Generated by the PI WEB Docker installer.
# Re-run install.sh to refresh Docker assets and update the local image.
# Persistent data lives in PI_WEB_DOCKER_DATA_DIR and is not deleted by updates.

# Host identity used for the runtime containers and image user account.
PI_WEB_UID=$pi_web_uid
PI_WEB_GID=$pi_web_gid
DOCKER_GID=$docker_gid

# Detected Docker host profile and host capability toggles.
PI_WEB_DOCKER_HOST_PROFILE=$pi_web_host_profile
HOSTEXEC_MODE=$hostexec_mode
PI_WEB_DOCKER_EXTRA_HOST_PATHS=$pi_web_extra_host_paths_env

# Persistent data, Docker control root, and localhost-only default exposure.
PI_WEB_DOCKER_DATA_DIR=$data_dir
PI_WEB_DOCKER_INSTALL_DIR=$install_dir
PI_WEB_DOCKER_REF=$asset_ref
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

# Runtime image names, Compose project, and limits.
PI_WEB_IMAGE=$pi_web_image
COMPOSE_PROJECT_NAME=$compose_project_name
HOSTEXEC_IMAGE=$hostexec_image
PI_WEB_MAX_UPLOAD_BYTES=$pi_web_max_upload_bytes
EOF
mv "$temp_env" "$env_file"

log "Wrote Docker assets to $install_dir"
log "Wrote runtime environment to $env_file"
log "Wrote host Compose override to $compose_override_file"
log "Selected PI WEB Docker host profile: $pi_web_host_profile"
case "$pi_web_host_profile" in
  linux-native-docker)
    log "Enabled Linux host mounts and hostexec namespace bridge."
    ;;
  mac-docker-desktop)
    log "Enabled Docker Desktop for Mac project mounts. hostexec is disabled because containers cannot enter native macOS namespaces."
    ;;
esac
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
  CACHE_BUST=$cache_bust run_runtime_compose build --pull --no-cache
)

log "Recreating split PI WEB Docker services ..."
(
  cd "$install_dir"
  run_runtime_compose up -d --force-recreate --remove-orphans
)

log ""
log "PI WEB Docker runtime is ready: http://$pi_web_bind_addr:$pi_web_port"
log "Install directory: $install_dir"
log "To update later, run: $install_dir/pi-web-docker update"
(
  cd "$install_dir"
  run_runtime_compose ps
)
