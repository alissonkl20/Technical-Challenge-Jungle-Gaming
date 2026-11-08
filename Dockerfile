FROM oven/bun:1.4.4-alpine AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Sources, tests and dev dependencies, for `docker compose run --rm tests`.
FROM build AS test

CMD ["sh", "-c", "bun run test:unit && bun run test:integration"]

# The image the API and the workers run: compiled output only.
FROM oven/bun:1.4.4-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["bun", "run", "start:prod"]
