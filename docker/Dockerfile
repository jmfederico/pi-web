# syntax=docker/dockerfile:1.7

ARG UBUNTU_IMAGE=ubuntu:26.04
ARG NODE_IMAGE=node:22.22.2-bookworm-slim
ARG DOCKER_CLI_VERSION=29-cli

FROM docker:${DOCKER_CLI_VERSION} AS docker-cli
FROM ${NODE_IMAGE} AS node-runtime
FROM ${UBUNTU_IMAGE} AS base

ARG UBUNTU_IMAGE
ARG NODE_IMAGE
ARG DOCKER_CLI_VERSION
ARG MISE_VERSION=2026.10.17
ARG GIT_VERSION=""
ARG PI_WEB_EXTRA_APT_PACKAGES=""
ARG PI_WEB_UID=1000
ARG PI_WEB_GID=1000

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
  NPM_CONFIG_PREFIX=/usr/local \
  LANG=C.UTF-8 \
  SHELL=/bin/bash \
  TERM=xterm-256color

# The official Node runtime is image-owned and never hidden by user mounts.
COPY --from=node-runtime /usr/local/ /usr/local/lib/pi-web-node/
RUN ln -s /usr/local/lib/pi-web-node/bin/node /usr/local/bin/node \
  && ln -s /usr/local/lib/pi-web-node/bin/npm /usr/local/bin/npm \
  && ln -s /usr/local/lib/pi-web-node/bin/npx /usr/local/bin/npx
COPY --chmod=0755 internal/image/install-ubuntu-base /usr/local/sbin/install-pi-web-ubuntu-base
RUN install-pi-web-ubuntu-base
# Match the repository's pinned Playwright implementation, not arbitrary latest.
# Only libraries are baked in; browser binaries are explicitly installed by users.
RUN npm exec --yes --package=playwright@1.64.1 -- playwright install-deps \
  && npm cache clean --force \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

FROM base AS package

ARG PI_WEB_VERSION=latest
ARG CACHE_BUST=local

RUN set -eux; \
  echo "PI WEB Docker build cache bust: ${CACHE_BUST}"; \
  npm install -g --omit=dev --no-audit --no-fund @earendil-works/pi-coding-agent "@jmfederico/pi-web@${PI_WEB_VERSION}" --allow-scripts=node-pty; \
  command -v pi; \
  npm cache clean --force

FROM base AS runtime

# Empty lets npm derive its prefix from the selected Node installation, so
# mise-managed Node can own persistent global packages instead of /usr/local.
ENV NPM_CONFIG_PREFIX="" \
  HOME=/data/home \
  XDG_CONFIG_HOME=/data/config \
  MISE_CONFIG_DIR=/data/config/mise \
  MISE_DATA_DIR=/data/home/.local/share/mise \
  MISE_SHARED_INSTALL_DIRS=/usr/local/share/pi-web/mise/installs \
  MISE_CACHE_DIR=/data/home/.cache/mise \
  MISE_STATE_DIR=/data/home/.local/state/mise \
  MISE_AUTO_INSTALL=false \
  MISE_NOT_FOUND_SYSTEM_FALLBACK=false \
  MISE_PARANOID=true \
  MISE_YES=false \
  PI_WEB_HOST=0.0.0.0 \
  PI_WEB_PORT=8504 \
  PI_WEB_DATA_DIR=/data/pi-web \
  PI_WEB_SESSIOND_SOCKET=/data/pi-web/sessiond.sock \
  PI_CODING_AGENT_DIR=/data/pi-agent \
  HOSTEXEC_IMAGE=alpine:3.22
ENV PATH=/workspace/node_modules/.bin:/data/home/.local/share/mise/shims:/usr/local/share/pi-web/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

COPY --from=package /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=package /usr/local/bin /usr/local/bin
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
COPY --chmod=0755 internal/bin/hostexec internal/bin/pi-web-service internal/bin/pi-web-image-doctor /usr/local/bin/
COPY --chmod=0755 internal/bin/pi-web-reconcile-mise /usr/local/bin/
COPY --chmod=0755 pi-web-docker /usr/local/bin/pi-web-docker
COPY --chmod=0755 internal/image/write-manifest /usr/local/sbin/pi-web-write-image-manifest

COPY custom-image.d/ /tmp/pi-web-custom-image.d/
RUN set -eux; \
  shopt -s nullglob; \
  for script in /tmp/pi-web-custom-image.d/*.sh; do \
    echo "Running PI WEB custom image hook: ${script}"; \
    bash "${script}"; \
  done; \
  rm -rf /tmp/pi-web-custom-image.d; \
  apt-get clean; \
  rm -rf /var/lib/apt/lists/*; \
  pi-web-write-image-manifest

WORKDIR /workspace
USER pi-web

EXPOSE 8504

ENTRYPOINT ["tini", "--"]
CMD ["pi-web-service", "/usr/local/bin/pi-web-server"]
