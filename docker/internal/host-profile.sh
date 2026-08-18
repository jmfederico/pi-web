#!/usr/bin/env sh
# shellcheck disable=SC2034

pi_web_docker_host_yaml_quote() {
  value=$1
  escaped=$(printf '%s' "$value" | sed "s/'/''/g")
  printf "'%s'" "$escaped"
}

pi_web_docker_host_socket_path_from_endpoint() {
  endpoint=$1
  case "$endpoint" in
    unix://*) printf '%s\n' "${endpoint#unix://}" ;;
    *) return 1 ;;
  esac
}

pi_web_docker_host_mac_desktop_socket_path() {
  [ -n "${HOME:-}" ] || return 1
  printf '%s/.docker/run/docker.sock\n' "$HOME"
}

pi_web_docker_host_endpoint_is_linux_expected() {
  endpoint=$1
  [ "$endpoint" = unix:///var/run/docker.sock ]
}

pi_web_docker_host_endpoint_is_mac_expected() {
  endpoint=$1
  if ! socket_path=$(pi_web_docker_host_socket_path_from_endpoint "$endpoint" 2>/dev/null); then
    return 1
  fi

  case "$socket_path" in
    /var/run/docker.sock)
      return 0
      ;;
  esac

  if mac_socket_path=$(pi_web_docker_host_mac_desktop_socket_path 2>/dev/null); then
    [ "$socket_path" = "$mac_socket_path" ] && return 0
  fi

  return 1
}

pi_web_docker_host_socket_source_for_endpoint() {
  endpoint=$1
  pi_web_docker_host_socket_path_from_endpoint "$endpoint"
}

pi_web_docker_host_detect_docker_gid() {
  case "${PI_WEB_DETECTED_DOCKER_HOST_PROFILE:-}" in
    mac-docker-desktop)
      printf '0\n'
      return 0
      ;;
  esac

  socket_path=/var/run/docker.sock
  if [ -n "${PI_WEB_DETECTED_DOCKER_ENDPOINT:-}" ]; then
    if detected_socket_path=$(pi_web_docker_host_socket_path_from_endpoint "$PI_WEB_DETECTED_DOCKER_ENDPOINT" 2>/dev/null); then
      socket_path=$detected_socket_path
    fi
  fi

  if [ -S "$socket_path" ]; then
    if gid=$(stat -c '%g' "$socket_path" 2>/dev/null); then
      printf '%s\n' "$gid"
      return 0
    fi
    if gid=$(stat -f '%g' "$socket_path" 2>/dev/null); then
      printf '%s\n' "$gid"
      return 0
    fi
  fi

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

# True when running inside a PI WEB Docker container. The Compose environment
# sets this marker for the services, and detached helper containers pass it on.
pi_web_docker_host_in_container() {
  case "${PI_WEB_DOCKER_RUNTIME:-}" in
    ""|0|false|FALSE|False) return 1 ;;
    *) return 0 ;;
  esac
}

# Host facts are detected once on the host and then persisted. A container
# cannot observe the host it runs on: from inside a Linux container, a Docker
# Desktop for Mac host is indistinguishable from native Linux Docker. Reuse the
# persisted facts there instead of detecting them again, and detect only when
# running on the host itself.
pi_web_docker_host_resolve_profile() {
  pi_web_persisted_profile=${1:-}
  pi_web_persisted_hostexec=${2:-}
  pi_web_persisted_socket=${3:-}

  if pi_web_docker_host_in_container && [ -n "$pi_web_persisted_profile" ]; then
    PI_WEB_DETECTED_DOCKER_HOST_PROFILE=$pi_web_persisted_profile
    if [ -n "$pi_web_persisted_hostexec" ]; then
      PI_WEB_DETECTED_HOSTEXEC_MODE=$pi_web_persisted_hostexec
    else
      case "$pi_web_persisted_profile" in
        linux-native-docker) PI_WEB_DETECTED_HOSTEXEC_MODE=nsenter ;;
        *) PI_WEB_DETECTED_HOSTEXEC_MODE=disabled ;;
      esac
    fi
    PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE=${pi_web_persisted_socket:-/var/run/docker.sock}
    PI_WEB_DOCKER_HOST_PROFILE_REUSED=1
    return 0
  fi

  PI_WEB_DOCKER_HOST_PROFILE_REUSED=0
  pi_web_docker_host_detect_profile
}

pi_web_docker_host_detect_profile() {
  PI_WEB_DETECTED_HOST_OS=$(uname -s 2>/dev/null || printf 'unknown')
  PI_WEB_DETECTED_DOCKER_CONTEXT=
  PI_WEB_DETECTED_DOCKER_ENDPOINT=
  PI_WEB_DETECTED_DOCKER_HOST_ENV=${DOCKER_HOST:-}
  PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT=
  PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE=
  PI_WEB_DETECTED_DOCKER_OS=
  PI_WEB_DETECTED_DOCKER_HOST_PROFILE=
  PI_WEB_DETECTED_HOSTEXEC_MODE=disabled
  PI_WEB_DOCKER_HOST_PROFILE_ERROR=

  if ! command -v docker >/dev/null 2>&1; then
    PI_WEB_DOCKER_HOST_PROFILE_ERROR="docker CLI is required"
    return 1
  fi

  PI_WEB_DETECTED_DOCKER_CONTEXT=$(docker context show 2>/dev/null || printf 'unknown')
  if [ -n "$PI_WEB_DETECTED_DOCKER_CONTEXT" ] && [ "$PI_WEB_DETECTED_DOCKER_CONTEXT" != unknown ]; then
    PI_WEB_DETECTED_DOCKER_ENDPOINT=$(docker context inspect "$PI_WEB_DETECTED_DOCKER_CONTEXT" --format '{{if .Endpoints.docker}}{{.Endpoints.docker.Host}}{{end}}' 2>/dev/null || printf '')
  fi

  case "$PI_WEB_DETECTED_HOST_OS" in
    Linux)
      if [ -n "$PI_WEB_DETECTED_DOCKER_HOST_ENV" ] && ! pi_web_docker_host_endpoint_is_linux_expected "$PI_WEB_DETECTED_DOCKER_HOST_ENV"; then
        PI_WEB_DOCKER_HOST_PROFILE_ERROR="native Linux installs require DOCKER_HOST to be unset or exactly unix:///var/run/docker.sock, not $PI_WEB_DETECTED_DOCKER_HOST_ENV"
        return 1
      fi

      if [ -n "$PI_WEB_DETECTED_DOCKER_ENDPOINT" ] && ! pi_web_docker_host_endpoint_is_linux_expected "$PI_WEB_DETECTED_DOCKER_ENDPOINT"; then
        PI_WEB_DOCKER_HOST_PROFILE_ERROR="native Linux installs require the local /var/run/docker.sock Docker context, not $PI_WEB_DETECTED_DOCKER_ENDPOINT"
        return 1
      fi

      PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT=${PI_WEB_DETECTED_DOCKER_HOST_ENV:-$PI_WEB_DETECTED_DOCKER_ENDPOINT}
      PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE=/var/run/docker.sock
      if [ ! -S "$PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE" ]; then
        PI_WEB_DOCKER_HOST_PROFILE_ERROR="native Linux installs require a local Docker socket at /var/run/docker.sock"
        return 1
      fi
      ;;
    Darwin)
      if [ -n "$PI_WEB_DETECTED_DOCKER_ENDPOINT" ] && ! pi_web_docker_host_endpoint_is_mac_expected "$PI_WEB_DETECTED_DOCKER_ENDPOINT"; then
        PI_WEB_DOCKER_HOST_PROFILE_ERROR="macOS installs require a Docker Desktop local Unix socket context, not $PI_WEB_DETECTED_DOCKER_ENDPOINT"
        return 1
      fi

      if [ -n "$PI_WEB_DETECTED_DOCKER_HOST_ENV" ]; then
        if ! pi_web_docker_host_endpoint_is_mac_expected "$PI_WEB_DETECTED_DOCKER_HOST_ENV"; then
          PI_WEB_DOCKER_HOST_PROFILE_ERROR="macOS installs require DOCKER_HOST to be unset or a Docker Desktop local Unix socket, not $PI_WEB_DETECTED_DOCKER_HOST_ENV"
          return 1
        fi
        PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT=$PI_WEB_DETECTED_DOCKER_HOST_ENV
      else
        PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT=$PI_WEB_DETECTED_DOCKER_ENDPOINT
      fi

      if [ -n "$PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT" ]; then
        if ! pi_web_docker_host_endpoint_is_mac_expected "$PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT"; then
          PI_WEB_DOCKER_HOST_PROFILE_ERROR="macOS installs require a Docker Desktop local Unix socket, not ${PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT:-unknown}"
          return 1
        fi
        PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE=$(pi_web_docker_host_socket_source_for_endpoint "$PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT") || return 1
      elif mac_socket_path=$(pi_web_docker_host_mac_desktop_socket_path 2>/dev/null) && [ -S "$mac_socket_path" ]; then
        PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE=$mac_socket_path
      else
        PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE=/var/run/docker.sock
      fi

      if [ ! -S "$PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE" ]; then
        PI_WEB_DOCKER_HOST_PROFILE_ERROR="Docker Desktop socket is not accessible at $PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE"
        return 1
      fi
      ;;
    *)
      PI_WEB_DOCKER_HOST_PROFILE_ERROR="unsupported host OS: $PI_WEB_DETECTED_HOST_OS"
      return 1
      ;;
  esac

  if ! docker info >/dev/null 2>&1; then
    PI_WEB_DOCKER_HOST_PROFILE_ERROR="docker daemon is not reachable by this user"
    return 1
  fi
  PI_WEB_DETECTED_DOCKER_OS=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || printf '')

  case "$PI_WEB_DETECTED_HOST_OS" in
    Linux)
      case "$PI_WEB_DETECTED_DOCKER_CONTEXT:$PI_WEB_DETECTED_DOCKER_OS" in
        *desktop-linux*|*"Docker Desktop"*)
          PI_WEB_DOCKER_HOST_PROFILE_ERROR="Docker Desktop on Linux is not supported by this installer because it runs containers inside a VM instead of the native Linux host"
          return 1
          ;;
      esac

      PI_WEB_DETECTED_DOCKER_HOST_PROFILE=linux-native-docker
      PI_WEB_DETECTED_HOSTEXEC_MODE=nsenter
      ;;
    Darwin)
      case "$PI_WEB_DETECTED_DOCKER_CONTEXT:$PI_WEB_DETECTED_DOCKER_OS:$PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT" in
        *desktop-linux*|*"Docker Desktop"*|*"/.docker/run/docker.sock"*)
          PI_WEB_DETECTED_DOCKER_HOST_PROFILE=mac-docker-desktop
          PI_WEB_DETECTED_HOSTEXEC_MODE=disabled
          ;;
        *)
          PI_WEB_DOCKER_HOST_PROFILE_ERROR="macOS installs currently require Docker Desktop; detected context '$PI_WEB_DETECTED_DOCKER_CONTEXT' endpoint '${PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT:-unknown}'"
          return 1
          ;;
      esac
      ;;
  esac

  return 0
}

pi_web_docker_host_write_volume() {
  source_path=$1
  target_path=$2
  read_only=${3:-false}

  {
    printf '  - type: bind\n'
    printf '    source: %s\n' "$(pi_web_docker_host_yaml_quote "$source_path")"
    printf '    target: %s\n' "$(pi_web_docker_host_yaml_quote "$target_path")"
    if [ "$read_only" = true ]; then
      printf '    read_only: true\n'
    fi
  } >>"$PI_WEB_DOCKER_HOST_OVERRIDE_TEMP"
}

pi_web_docker_host_write_existing_volume() {
  source_path=$1
  target_path=$2
  read_only=${3:-false}

  if [ -e "$source_path" ]; then
    pi_web_docker_host_write_volume "$source_path" "$target_path" "$read_only"
  fi
}

pi_web_docker_host_write_extra_volumes() {
  extra_paths=$1

  for extra_path in $extra_paths; do
    case "$extra_path" in
      /*) ;;
      *)
        printf '%s\n' "PI_WEB_DOCKER_EXTRA_HOST_PATHS entries must be absolute paths: $extra_path" >&2
        return 1
        ;;
    esac

    if [ ! -e "$extra_path" ]; then
      printf '%s\n' "PI_WEB_DOCKER_EXTRA_HOST_PATHS entry does not exist: $extra_path" >&2
      return 1
    fi

    pi_web_docker_host_write_volume "$extra_path" "$extra_path" false
  done
}

# Create the user-owned container environment file once, without ever
# rewriting an existing one. Runtime and development mode share this file
# because they share the persistent /data mount.
pi_web_docker_write_container_env_template() {
  pi_web_container_env_target=$1
  [ ! -e "$pi_web_container_env_target" ] || return 0
  pi_web_container_env_dir=$(dirname "$pi_web_container_env_target")
  mkdir -p "$pi_web_container_env_dir" || return 1
  pi_web_container_env_temp=$pi_web_container_env_target.$$
  pi_web_container_env_umask=$(umask)
  umask 077
  cat >"$pi_web_container_env_temp" <<'EOF'
# PI WEB Docker container environment. Safe to edit.
#
# Every KEY=value line here is added to the environment of the PI WEB
# sessiond and web containers, in both runtime and development mode, and is
# inherited by agent sessions, terminals, and the processes they start.
#
# This file is created once and is never rewritten. It is not the same as the
# generated .env and .pi-web/docker-compose-dev.generated.env files: those only
# give values to Docker Compose itself and never reach the container process
# environment.
#
# Apply changes by recreating the containers:
#   pi-web-docker start                (development: pi-web-docker --dev start)
# The restart commands reuse the existing containers and do not re-read this
# file.
#
# The values PI WEB sets for a container stay authoritative, so HOME,
# XDG_CONFIG_HOME, PI_WEB_DATA_DIR, PI_WEB_SESSIOND_SOCKET, PI_CODING_AGENT_DIR,
# PI_WEB_MAX_UPLOAD_BYTES, HOSTEXEC_MODE, HOSTEXEC_IMAGE, the PI_WEB_DOCKER_*
# keys, and the web server's PI_WEB_HOST and PI_WEB_PORT keep their generated
# values. Change those through installer flags, .env, or
# .pi-web/docker-compose-dev.local.env instead.
#
# Use one KEY=value per line. Docker Compose dotenv rules apply, so $VAR and
# ${VAR} expand; write $$ for a literal dollar sign.
#
# Examples:
# HTTPS_PROXY=http://proxy.example.internal:3128
# NO_PROXY=localhost,127.0.0.1
# PI_WEB_OFFLINE=1
EOF
  umask "$pi_web_container_env_umask"
  mv "$pi_web_container_env_temp" "$pi_web_container_env_target" || return 1
}

pi_web_docker_host_write_compose_override() {
  target_file=$1
  host_profile=$2
  extra_paths=${3:-}
  control_path=${4:-}
  target_dir=$(dirname "$target_file")
  mkdir -p "$target_dir" || return 1
  PI_WEB_DOCKER_HOST_OVERRIDE_TEMP=$target_file.$$

  case "$host_profile" in
    linux-native-docker) hostexec_mode=nsenter ;;
    mac-docker-desktop) hostexec_mode=disabled ;;
    *)
      printf '%s\n' "unsupported PI WEB Docker host profile: $host_profile" >&2
      return 1
      ;;
  esac

  cat >"$PI_WEB_DOCKER_HOST_OVERRIDE_TEMP" <<EOF
# Generated by PI WEB Docker host profile detection. Do not edit by hand.
# Re-run the installer or docker/pi-web-docker --dev to refresh this file.

x-pi-web-host-volumes: &pi-web-host-volumes
EOF

  socket_source=${PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE:-/var/run/docker.sock}
  pi_web_docker_host_write_volume "$socket_source" /var/run/docker.sock false

  case "$host_profile" in
    linux-native-docker)
      pi_web_docker_host_write_existing_volume /home /home false
      pi_web_docker_host_write_existing_volume /srv /srv false
      pi_web_docker_host_write_existing_volume /opt /opt false
      pi_web_docker_host_write_volume / /host true
      ;;
    mac-docker-desktop)
      pi_web_docker_host_write_existing_volume /Users /Users false
      pi_web_docker_host_write_existing_volume /Volumes /Volumes false
      pi_web_docker_host_write_existing_volume /private /private false
      ;;
  esac

  if ! pi_web_docker_host_write_extra_volumes "$extra_paths"; then
    rm -f "$PI_WEB_DOCKER_HOST_OVERRIDE_TEMP"
    return 1
  fi

  if [ -n "$control_path" ]; then
    if [ ! -e "$control_path" ]; then
      printf '%s\n' "PI WEB Docker control path does not exist: $control_path" >&2
      rm -f "$PI_WEB_DOCKER_HOST_OVERRIDE_TEMP"
      return 1
    fi
    pi_web_docker_host_write_volume "$control_path" "$control_path" false
  fi

  cat >>"$PI_WEB_DOCKER_HOST_OVERRIDE_TEMP" <<EOF

services:
  sessiond:
    environment:
      HOSTEXEC_MODE: $hostexec_mode
    volumes: *pi-web-host-volumes

  web:
    environment:
      HOSTEXEC_MODE: $hostexec_mode
    volumes: *pi-web-host-volumes
EOF

  mv "$PI_WEB_DOCKER_HOST_OVERRIDE_TEMP" "$target_file"
}

pi_web_docker_host_print_detection_failure() {
  printf '%s\n' "PI WEB Docker setup could not determine a supported host profile." >&2
  printf '%s\n' "" >&2
  printf '%s\n' "Detected:" >&2
  printf '  host OS: %s\n' "${PI_WEB_DETECTED_HOST_OS:-unknown}" >&2
  printf '  docker context: %s\n' "${PI_WEB_DETECTED_DOCKER_CONTEXT:-unknown}" >&2
  printf '  docker endpoint: %s\n' "${PI_WEB_DETECTED_DOCKER_ENDPOINT:-unknown}" >&2
  printf '  DOCKER_HOST: %s\n' "${PI_WEB_DETECTED_DOCKER_HOST_ENV:-unset}" >&2
  printf '  effective endpoint: %s\n' "${PI_WEB_DETECTED_DOCKER_EFFECTIVE_ENDPOINT:-unknown}" >&2
  printf '  docker socket source: %s\n' "${PI_WEB_DETECTED_DOCKER_SOCKET_SOURCE:-unknown}" >&2
  printf '  docker OS: %s\n' "${PI_WEB_DETECTED_DOCKER_OS:-unknown}" >&2
  printf '%s\n' "" >&2
  printf '%s\n' "Supported profiles:" >&2
  printf '%s\n' "  - native Linux Docker Engine using /var/run/docker.sock" >&2
  printf '%s\n' "  - Docker Desktop for Mac" >&2
  if [ -n "${PI_WEB_DOCKER_HOST_PROFILE_ERROR:-}" ]; then
    printf '%s\n' "" >&2
    printf 'Reason: %s\n' "$PI_WEB_DOCKER_HOST_PROFILE_ERROR" >&2
  fi
}

pi_web_docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    printf '%s\n' "Docker Compose is required (docker compose plugin or docker-compose)" >&2
    return 1
  fi
}
