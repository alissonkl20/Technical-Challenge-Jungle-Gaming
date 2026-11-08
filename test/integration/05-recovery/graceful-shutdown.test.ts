import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const processTest = enabled ? describe : describe.skip;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startProcess(
  entry: string,
  overrides: Record<string, string>,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; output: () => string }> {
  const chunks: string[] = [];
  const proc = Bun.spawn(["bun", entry], {
    cwd: `${import.meta.dir}/../../..`,
    env: { ...process.env, ...overrides },
    stdout: "pipe",
    stderr: "pipe",
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>);
  void drain(proc.stderr as ReadableStream<Uint8Array>);
  return { proc, output: () => chunks.join("") };
}

async function waitForOutput(
  output: () => string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(output())) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

processTest("real process shutdown on SIGTERM", () => {
  test("outbox worker stops promptly on SIGTERM and exits cleanly", async () => {
    const metricsPort = String(await freePort());
    const { proc, output } = await startProcess(
      "src/workers/outbox-worker.ts",
      {
        OUTBOX_METRICS_PORT: metricsPort,
        OUTBOX_POLL_INTERVAL_MS: "200",
      },
    );
    expect(await waitForOutput(output, /Started with worker ID/, 30_000)).toBe(
      true,
    );
    const sentAt = Date.now();
    proc.kill("SIGTERM");
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(Date.now() - sentAt).toBeLessThan(10_000);
  }, 60_000);

  test("SQS event worker aborts its long poll on SIGTERM instead of waiting it out", async () => {
    const metricsPort = String(await freePort());
    const { proc, output } = await startProcess(
      "src/workers/sqs-event-worker.ts",
      {
        SQS_EVENT_METRICS_PORT: metricsPort,
        SQS_EVENT_WAIT_TIME_SECONDS: "20",
        SQS_EVENT_POLL_INTERVAL_MS: "200",
      },
    );
    expect(await waitForOutput(output, /Started on host/, 30_000)).toBe(true);
    // Give the worker time to enter the 20 s long poll.
    await new Promise((r) => setTimeout(r, 1_500));
    const sentAt = Date.now();
    proc.kill("SIGTERM");
    const code = await proc.exited;
    const elapsed = Date.now() - sentAt;
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(10_000);
  }, 90_000);

  test("HTTP API drains and exits on SIGTERM within its deadline", async () => {
    const port = String(await freePort());
    const { proc, output } = await startProcess("src/main.ts", {
      PORT: port,
      SHUTDOWN_TIMEOUT_MS: "5000",
    });
    expect(
      await waitForOutput(
        output,
        /Nest application successfully started|Application is running/i,
        30_000,
      ),
    ).toBe(true);
    const response = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(response.status).toBe(200);
    const sentAt = Date.now();
    proc.kill("SIGTERM");
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(Date.now() - sentAt).toBeLessThan(8_000);
  }, 90_000);
});
