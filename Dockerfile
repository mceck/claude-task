# The backend image: serves the API, the WebSocket and the built frontend.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile
COPY shared shared
COPY backend backend
COPY frontend frontend
RUN pnpm build \
 && pnpm --filter @claude-task/backend deploy --prod --legacy /out \
 && cp -r backend/dist backend/drizzle /out/ \
 && cp -r frontend/dist /out/public

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/main.js"]
