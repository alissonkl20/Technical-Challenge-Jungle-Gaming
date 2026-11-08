import "dotenv/config";

import { defineConfig } from "@mikro-orm/postgresql";

export default defineConfig({
  dbName: process.env.POSTGRES_DB ?? "betting_db",
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? "5432"),
  user: process.env.POSTGRES_USER ?? "betting_user",
  password: process.env.POSTGRES_PASSWORD ?? "betting_password",
  schema: process.env.POSTGRES_SCHEMA ?? "public",
  entities: ["./dist/src/**/*.entity.js"],
  entitiesTs: ["./src/**/*.entity.ts"],
  migrations: {
    path: "./dist/src/migrations",
    pathTs: "./src/migrations",
    schema: process.env.POSTGRES_SCHEMA ?? "public",
    transactional: true,
    allOrNothing: true,
  },
  // Connections per process. The driver default is 10, which caps the number of
  // operations one process can run at once; the load measurements depend on it.
  pool: {
    max: Number(process.env.POSTGRES_POOL_MAX ?? "10"),
  },
  discovery: {
    warnWhenNoEntities: false,
  },
});
