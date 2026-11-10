# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:22-alpine AS build

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Defaults to offline.
# Override these at build time for Online Farm.
ARG VITE_API_URL=""
ARG VITE_GOOGLE_CLIENT_ID=""

RUN npm run build

# ---- Runtime stage ----
FROM caddy:2-alpine AS runtime

# Writable paths for any runtime UID/GID.
ENV HOME=/tmp \
    XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data

COPY --from=build /src/dist/ /srv/

# Copy external Caddy configuration.
COPY Caddyfile /etc/caddy/Caddyfile

# Format Caddyfile and make files readable
# by arbitrary users.
RUN caddy fmt --overwrite /etc/caddy/Caddyfile \
    && chmod -R a+rX /srv \
    && chmod a+r /etc/caddy/Caddyfile

# Default non-root identity.
# Can be overridden using --user UID:GID
USER 65532:65532

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

