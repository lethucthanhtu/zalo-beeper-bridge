# Zalo ⇄ Beeper bridge + bbctl proxy in one image (works with Docker and Podman).
# Both processes share the container's loopback: the appservice binds 127.0.0.1:29350
# and bbctl proxy forwards Beeper's websocket traffic to it (registration url stays
# http://localhost:29350).

FROM docker.io/library/node:24-bookworm-slim AS deps
WORKDIR /app
# Toolchain only as a fallback in case better-sqlite3 has no prebuilt binary
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM docker.io/library/node:24-bookworm-slim
ARG BBCTL_VERSION=v0.15.0
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/* \
 && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && base="https://github.com/beeper/bridge-manager/releases/download/${BBCTL_VERSION}" \
 && curl -fsSL -o /usr/local/bin/bbctl "${base}/bbctl-linux-${arch}" \
 && curl -fsSL -o /tmp/sha256sums.txt "${base}/sha256sums.txt" \
 && (cd /usr/local/bin && grep " bbctl-linux-${arch}\$" /tmp/sha256sums.txt | sed "s/bbctl-linux-${arch}/bbctl/" | sha256sum -c -) \
 && chmod +x /usr/local/bin/bbctl \
 && rm /tmp/sha256sums.txt

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY assets ./assets
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data /config && chown node:node /data

# /config: config.yaml + registration.yaml (+ optional bbctl-config.json), read-only
# /data:   bridge.db, encrypted Zalo session, bbctl login — keep it on a named volume
ENV NODE_ENV=production \
    HOME=/data \
    BBCTL_CONFIG=/data/bbctl/config.json
VOLUME ["/data"]
USER node
WORKDIR /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('net').connect(29350,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["run"]
