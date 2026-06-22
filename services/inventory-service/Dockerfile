FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

FROM node:20-alpine AS production
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nodeuser -u 1001
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package*.json ./
COPY src/ ./src/
COPY --from=shared . /shared/
ENV NODE_PATH=/app/node_modules
USER nodeuser
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3004/health || exit 1
CMD ["node", "src/index.js"]
