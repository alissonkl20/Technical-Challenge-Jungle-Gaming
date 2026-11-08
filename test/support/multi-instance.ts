import { expect } from "bun:test";
import { spawn } from "node:child_process";
import type { ProcessWagerInput } from "../../src/modules/transactions/types/index.js";

/**
 * Runs wager requests in independent OS processes (own ORM, pool and service
 * each) against one PostgreSQL schema. All instances start submitting at the
 * same instant, after their own boot, so requests from different processes
 * really overlap.
 */
export const INSTANCES = 3;

export interface InstanceResult {
  readonly status: string | null;
  readonly transactionId: string | null;
  readonly failureCode: string | null;
  readonly idempotentReplay: boolean;
  readonly error: string | null;
}

export interface InstanceRequest {
  readonly idempotencyKey: string;
  readonly wager: ProcessWagerInput;
}

function runInstance(
  schema: string,
  providerId: string,
  requests: readonly InstanceRequest[],
  startAt: number,
): Promise<{ pid: number; results: InstanceResult[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        new URL("./process-wager-batch.ts", import.meta.url).pathname,
        JSON.stringify({ providerId, startAt, requests }),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, POSTGRES_SCHEMA: schema },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`instance exited with ${code}: ${stderr}`));
        return;
      }
      const line = stdout
        .trim()
        .split("\n")
        .reverse()
        .find((candidate) => candidate.startsWith('{"pid"'));
      if (line === undefined) {
        reject(new Error(`instance printed no result: ${stdout}`));
        return;
      }
      resolve(JSON.parse(line));
    });
  });
}

/** Splits requests round-robin across the instances and runs them. */
export async function runAcrossInstances(
  schema: string,
  providerId: string,
  requests: readonly InstanceRequest[],
  instances = INSTANCES,
): Promise<(InstanceResult & { readonly request: InstanceRequest })[]> {
  const shards: InstanceRequest[][] = Array.from(
    { length: instances },
    () => [],
  );
  requests.forEach((request, index) => {
    shards[index % instances]?.push(request);
  });
  const startAt = Date.now() + 2_500;
  const outputs = await Promise.all(
    shards.map((shard) => runInstance(schema, providerId, shard, startAt)),
  );
  expect(new Set(outputs.map((output) => output.pid)).size).toBe(instances);
  return outputs.flatMap((output, shardIndex) =>
    output.results.map((result, index) => {
      const request = shards[shardIndex]?.[index];
      if (request === undefined) throw new Error("result without request");
      return { ...result, request };
    }),
  );
}
