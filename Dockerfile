# ---- build stage: compile native ssh2/cpufeatures bindings ----
FROM node:24-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

# ---- runtime stage ----
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js agent.js ./
COPY src ./src

RUN addgroup -S mega && adduser -S mega -G mega \
    && mkdir -p /data \
    && chown -R mega:mega /data /app
USER mega

ENV PORT=3000 \
    DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
