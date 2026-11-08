import type { LoggerService } from "@nestjs/common";
import { currentCausationId, currentCorrelationId } from "./request-context.js";

export type SafeLogFields = Readonly<{
  readonly messageId?: string | null;
  readonly transactionId?: string | null;
  readonly walletId?: string | null;
  readonly providerId?: string | null;
  readonly status?: string;
  readonly errorCode?: string;
  readonly attempts?: number;
}>;

type LogLevel = "log" | "error" | "warn" | "debug" | "verbose" | "fatal";

export class JsonLogger implements LoggerService {
  constructor(
    private readonly writeLine: (line: string) => void = (line) =>
      process.stdout.write(line),
  ) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("fatal", message, optionalParams);
  }

  emit(level: LogLevel, event: string, fields: SafeLogFields = {}): void {
    this.write(level, event, [], fields);
  }

  private write(
    level: LogLevel,
    message: unknown,
    optionalParams: readonly unknown[],
    fields: SafeLogFields = {},
  ): void {
    const contextValue = optionalParams.at(-1);
    const context =
      typeof contextValue === "string" &&
      /^[A-Za-z0-9._/-]{1,120}$/.test(contextValue)
        ? contextValue
        : undefined;
    const errorCode =
      fields.errorCode ??
      optionalParams.find(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "code" in value &&
          typeof value.code === "string",
      );
    const output = {
      timestamp: new Date().toISOString(),
      level: level === "log" ? "info" : level,
      context: context ?? null,
      event: typeof message === "string" ? message : "application.log",
      // No random fallback: a generated ID per line would make the line
      // untraceable. A log outside a flow carries null instead.
      correlationId: currentCorrelationId(),
      causationId: currentCausationId(),
      messageId: fields.messageId ?? null,
      transactionId: fields.transactionId ?? null,
      walletId: fields.walletId ?? null,
      providerId: fields.providerId ?? null,
      ...(fields.status === undefined ? {} : { status: fields.status }),
      ...(fields.attempts === undefined ? {} : { attempts: fields.attempts }),
      ...(typeof errorCode === "string" ? { errorCode } : {}),
    };
    this.writeLine(`${JSON.stringify(output)}\n`);
  }
}
