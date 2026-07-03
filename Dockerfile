FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
ENV NODE_ENV=production FINORA_HOST=0.0.0.0 FINORA_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
VOLUME ["/data"]
EXPOSE 3011
CMD ["node", "dist/cli.js", "serve"]
