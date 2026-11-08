import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SOURCE_ROOT = resolve(import.meta.dir, "../src");

interface SourceFile {
  /** Path relative to `src`, with forward slashes. */
  readonly path: string;
  /** Every module specifier the file imports or re-exports. */
  readonly imports: readonly string[];
}

function listSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const absolute = join(directory, name);
    if (statSync(absolute).isDirectory()) {
      found.push(...listSourceFiles(absolute));
      continue;
    }
    if (name.endsWith(".ts")) {
      found.push(absolute);
    }
  }
  return found;
}

/**
 * Reads module specifiers without a TypeScript parser. Specifiers appear only
 * in static `import`/`export ... from` and dynamic `import(...)`, all of which
 * carry a quoted string, so a regex over the source is sufficient and keeps
 * this test dependency-free.
 */
const SPECIFIER_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const sourceFiles: readonly SourceFile[] = listSourceFiles(SOURCE_ROOT).map(
  (absolute) => {
    const contents = readFileSync(absolute, "utf8");
    const imports: string[] = [];
    for (const match of contents.matchAll(SPECIFIER_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier !== undefined) {
        imports.push(specifier);
      }
    }
    return {
      path: relative(SOURCE_ROOT, absolute).split("\\").join("/"),
      imports,
    };
  },
);

function filesUnder(prefix: string): readonly SourceFile[] {
  return sourceFiles.filter((file) => file.path.startsWith(prefix));
}

/** Resolves a relative specifier to a path relative to `src`. */
function resolveSpecifier(file: SourceFile, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const absolute = resolve(SOURCE_ROOT, file.path, "..", specifier);
  return relative(SOURCE_ROOT, absolute).split("\\").join("/");
}

function violations(
  prefix: string,
  isForbidden: (specifier: string, resolved: string | null) => boolean,
): string[] {
  const found: string[] = [];
  for (const file of filesUnder(prefix)) {
    for (const specifier of file.imports) {
      if (isForbidden(specifier, resolveSpecifier(file, specifier))) {
        found.push(`${file.path} -> ${specifier}`);
      }
    }
  }
  return found;
}

const DOMAIN = "modules/finance/domain/";

describe("the test can see the source tree", () => {
  test("files and imports were actually collected", () => {
    // Without this, every rule below would pass vacuously on a bad glob.
    expect(sourceFiles.length).toBeGreaterThan(50);
    expect(filesUnder(DOMAIN).length).toBeGreaterThan(5);
    expect(
      sourceFiles.reduce((total, file) => total + file.imports.length, 0),
    ).toBeGreaterThan(100);
  });
});

describe("finance/domain depends on nothing", () => {
  const ALLOWED_EXTERNAL = new Set(["node:crypto"]);

  test("it imports no framework, ORM, transport or validation library", () => {
    expect(
      violations(
        DOMAIN,
        (specifier) =>
          !specifier.startsWith(".") && !ALLOWED_EXTERNAL.has(specifier),
      ),
    ).toEqual([]);
  });

  test("it imports nothing from outside itself", () => {
    expect(
      violations(
        DOMAIN,
        (specifier, resolved) =>
          specifier.startsWith(".") &&
          (resolved === null || !resolved.startsWith(DOMAIN)),
      ),
    ).toEqual([]);
  });

  test("it never names a persistence row type", () => {
    const offenders = filesUnder(DOMAIN).filter((file) =>
      /\b(?:WagerTransactionRow|WalletRow|FinancialOperationRow|InboxRow|OutboxRow|WalletLedgerRow|PersistenceSession)\b/.test(
        readFileSync(join(SOURCE_ROOT, file.path), "utf8"),
      ),
    );

    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});

describe("the HTTP interface holds no financial rule", () => {
  test("it never reaches into persistence", () => {
    // The read path goes through finance/application, which returns views, so
    // no controller or DTO names a column. This rule had a recorded baseline
    // of six files while the query services still lived here; the baseline is
    // gone because they moved.
    expect(
      violations(
        "modules/http-api/",
        (_specifier, resolved) => resolved?.includes("/persistence/") === true,
      ),
    ).toEqual([]);
  });

  test("it never names a persistence row type", () => {
    const offenders = filesUnder("modules/http-api/").filter((file) =>
      /\b(?:WagerTransactionRow|WalletRow|FinancialOperationRow|InboxRow|OutboxRow|WalletLedgerRow|PersistenceSession)\b/.test(
        readFileSync(join(SOURCE_ROOT, file.path), "utf8"),
      ),
    );

    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  test("no module outside persistence writes raw SQL", () => {
    const offenders = sourceFiles.filter(
      (file) =>
        !file.path.includes("/persistence/") &&
        !file.path.startsWith("migrations/") &&
        /\b(?:SELECT\s+.*\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(
          readFileSync(join(SOURCE_ROOT, file.path), "utf8"),
        ),
    );

    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});

describe("row types stay inside the finance module", () => {
  test("only persistence and its mappers name a column", () => {
    const allowed = [
      "modules/finance/persistence/",
      "modules/finance/application/",
      "modules/transactions/",
      "modules/wallets/",
      "modules/players/",
      "modules/providers/",
      "modules/auth/",
      "modules/events/",
      "modules/inbox/",
      "modules/outbox/",
    ];
    const offenders = sourceFiles.filter(
      (file) =>
        !allowed.some((prefix) => file.path.startsWith(prefix)) &&
        /\b(?:WagerTransactionRow|WalletRow|FinancialOperationRow|InboxRow|OutboxRow|WalletLedgerRow)\b/.test(
          readFileSync(join(SOURCE_ROOT, file.path), "utf8"),
        ),
    );

    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});

describe("the payload fingerprint has one implementation", () => {
  test("only the value object hashes a payload", () => {
    const offenders = sourceFiles.filter(
      (file) =>
        file.path !== `${DOMAIN}payload-fingerprint.ts` &&
        // These two hash something that is not a request payload, so they
        // are a different concern from request identity: the auth service
        // digests a secret for a constant-time comparison, and the command
        // consumer derives a FIFO deduplication ID from the exact message
        // bytes, which must not be canonicalized.
        file.path !== "modules/auth/provider-auth.service.ts" &&
        file.path !== "modules/events/sqs-wager-command-consumer.service.ts" &&
        /createHash\(\s*["']sha256["']\s*\)/.test(
          readFileSync(join(SOURCE_ROOT, file.path), "utf8"),
        ),
    );

    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});

describe("workers are thin", () => {
  test("a worker process contains no balance arithmetic or SQL", () => {
    const offenders = filesUnder("workers/").filter((file) =>
      /\b(?:balance_after|balance_before|SELECT\s)\b/.test(
        readFileSync(join(SOURCE_ROOT, file.path), "utf8"),
      ),
    );

    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});

describe("integration events are built by their typed class", () => {
  test("every outbox write goes through toOutboxRow", () => {
    // `event_type` and the payload must come from one typed instance. A
    // hand-written row can claim one event type and carry another's data, and
    // the publisher would send it. Counting per file is enough and does not
    // depend on parsing a call expression.
    const offenders = sourceFiles
      .map((file) => {
        const contents = readFileSync(join(SOURCE_ROOT, file.path), "utf8");
        return {
          path: file.path,
          writes: count(contents, /\boutbox\.create\(/g),
          typed: count(contents, /\.toOutboxRow\(\)/g),
        };
      })
      .filter((file) => file.writes !== file.typed);

    expect(offenders).toEqual([]);
  });

  test("only the envelope module declares an event type name", () => {
    const names = [
      "WagerTransactionProcessed",
      "WagerTransactionRejected",
      "WalletBalanceChanged",
      "WagerTransactionPendingReference",
    ];
    // Elsewhere the names may only appear as `EventType.X` or as an imported
    // class, never as a bare string: a typo in a string would publish an
    // event type the consumer rejects to the dead letter queue.
    const offenders = sourceFiles.filter((file) => {
      if (file.path === "modules/events/integration-event.ts") {
        return false;
      }
      const contents = readFileSync(join(SOURCE_ROOT, file.path), "utf8");
      return names.some((name) => contents.includes(`"${name}"`));
    });

    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});

function count(contents: string, pattern: RegExp): number {
  return [...contents.matchAll(pattern)].length;
}
