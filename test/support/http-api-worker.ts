import "reflect-metadata";
import "dotenv/config";

import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module.js";

async function main(): Promise<void> {
  const port = process.env.PORT;
  if (port === undefined) {
    throw new Error("Missing HTTP API worker port");
  }
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(Number(port), "127.0.0.1");
  console.log("HTTP API worker ready");

  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      void app.close().then(resolve, reject);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
