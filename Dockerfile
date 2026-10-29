# syntax=docker/dockerfile:1
FROM node:24-bookworm AS build
WORKDIR /app/product
COPY product/package*.json ./
RUN --mount=type=secret,id=proxy_ca if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; npm ci --strict-ssl=true --no-audit --no-fund
COPY product/ ./
RUN npm run build
FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app/product ./product
COPY --chown=node:node tools/agent-coordination/src/workspace.js ./tools/agent-coordination/src/workspace.js
# workspace credential screening imports these modules from its package boundary.
RUN ln -s /app/product/node_modules /app/tools/agent-coordination/node_modules
USER node
WORKDIR /app/product
ENV HOST=0.0.0.0 ALLOW_CONTAINER_BIND=true PORT=4310
EXPOSE 4310
CMD ["node","src/server.js"]
