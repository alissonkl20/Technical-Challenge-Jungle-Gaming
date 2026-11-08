/**
 * Catálogo das exigências da seção 13 do enunciado ("Testes obrigatórios").
 *
 * Cada item aponta para os arquivos (e, quando o arquivo cobre mais de um
 * assunto, para o filtro de nome dos testes) que provam aquela exigência.
 * `bun run test:spec <id>` executa só aquele item; `bun run test:spec list`
 * mostra todos. Ver test/README.md.
 */

export type SpecGroup =
  | "unidade"
  | "integracao"
  | "concorrencia"
  | "invariante"
  | "carga";

export interface SpecRun {
  /** Arquivos ou pastas, relativos à raiz do projeto. */
  paths: string[];
  /** Regex aplicada ao nome completo do teste (`bun test -t`). */
  pattern?: string;
}

export interface Spec {
  id: string;
  group: SpecGroup;
  /** Texto da exigência, como está no enunciado. */
  requirement: string;
  runs: SpecRun[];
}

const unit = "test/unit";
const integration = "test/integration";
const concurrency = "test/concurrency";

const twoPublishers: SpecRun[] = [
  {
    paths: [`${integration}/03-inbox-outbox/inbox-outbox.test.ts`],
    pattern: "two independent Outbox publishers",
  },
  {
    paths: [`${integration}/03-inbox-outbox/outbox-publication.test.ts`],
    pattern: "two publishers",
  },
];

export const specs: Spec[] = [
  // ── Unidade ───────────────────────────────────────────────────────────
  {
    id: "unidade:money",
    group: "unidade",
    requirement:
      "operações e validações de Money (escala, arredondamento, entradas inválidas)",
    runs: [{ paths: [`${unit}/money.test.ts`] }],
  },
  {
    id: "unidade:wallet",
    group: "unidade",
    requirement: "invariantes da Wallet",
    runs: [{ paths: [`${unit}/wallet.test.ts`] }],
  },
  {
    id: "unidade:regras",
    group: "unidade",
    requirement: "regras de BET, WIN, LOSS, REFUND, ROLLBACK",
    runs: [{ paths: [`${unit}/wager-rules.test.ts`] }],
  },
  {
    id: "unidade:conflito-moeda",
    group: "unidade",
    requirement: "conflito de moeda",
    runs: [
      {
        paths: [
          `${unit}/money.test.ts`,
          `${unit}/wallet.test.ts`,
          `${unit}/wager-rules.test.ts`,
        ],
        pattern: "currenc",
      },
    ],
  },
  {
    id: "unidade:idempotencia-payload",
    group: "unidade",
    requirement: "idempotency key com payload divergente",
    runs: [
      {
        paths: [`${unit}/wager-transaction.test.ts`],
        pattern: "idempotency conflict|identical idempotent",
      },
      {
        paths: [`${unit}/request-identity.test.ts`],
        pattern: "different payload|payload conflict",
      },
    ],
  },

  // ── Integração ────────────────────────────────────────────────────────
  {
    id: "integracao:migrations",
    group: "integracao",
    requirement: "migrations e constraints",
    runs: [{ paths: [`${integration}/01-migrations-constraints`] }],
  },
  {
    id: "integracao:atomicidade",
    group: "integracao",
    requirement: "atomicidade entre wallet, ledger, inbox e outbox",
    runs: [
      { paths: [`${integration}/02-atomicity`] },
      {
        paths: [`${integration}/03-inbox-outbox/inbox-outbox.test.ts`],
        pattern:
          "atomically|rolls back|before its PostgreSQL transaction commits",
      },
    ],
  },
  {
    id: "integracao:inbox-redelivery",
    group: "integracao",
    requirement: "inbox e redelivery",
    runs: [
      {
        paths: [`${integration}/03-inbox-outbox/inbox-outbox.test.ts`],
        pattern: "Inbox",
      },
      {
        paths: [`${integration}/04-retry-dlq/sqs-command-worker.test.ts`],
        pattern: "deduplicates duplicate|redelivers",
      },
    ],
  },
  {
    id: "integracao:publishers-concorrentes",
    group: "integracao",
    requirement: "publishers concorrentes sobre a mesma outbox",
    runs: twoPublishers,
  },
  {
    id: "integracao:retry-dlq",
    group: "integracao",
    requirement: "retry e DLQ",
    runs: [
      { paths: [`${integration}/04-retry-dlq`] },
      { paths: [`${integration}/03-inbox-outbox/outbox-publication.test.ts`] },
    ],
  },
  {
    id: "integracao:recuperacao",
    group: "integracao",
    requirement: "recuperação após reinicialização",
    runs: [{ paths: [`${integration}/05-recovery`] }],
  },

  // ── Concorrência ──────────────────────────────────────────────────────
  {
    id: "concorrencia:aposta-50x",
    group: "concorrencia",
    requirement:
      "a mesma aposta enviada 50 vezes em paralelo → um único débito",
    runs: [
      {
        paths: [`${concurrency}/idempotency.test.ts`],
        pattern: "50 parallel",
      },
      {
        paths: [`${concurrency}/multi-instance.test.ts`],
        pattern: "50 identical",
      },
    ],
  },
  {
    id: "concorrencia:mesma-wallet",
    group: "concorrencia",
    requirement:
      "operações concorrentes disputando o saldo da mesma wallet (seção 8)",
    runs: [
      { paths: [`${concurrency}/same-wallet-contention.test.ts`] },
      {
        paths: [`${concurrency}/multi-instance.test.ts`],
        pattern: "A: balance|B: balance",
      },
    ],
  },
  {
    id: "concorrencia:wallets-distintas",
    group: "concorrencia",
    requirement: "wallets distintas processadas em paralelo",
    runs: [
      {
        paths: [`${concurrency}/distinct-wallets-replay.test.ts`],
        pattern: "different wallets|separate PostgreSQL connections",
      },
    ],
  },
  {
    id: "concorrencia:3-processos",
    group: "concorrencia",
    requirement: "≥ 3 processos/instâncias simultâneos",
    runs: [
      { paths: [`${concurrency}/multi-instance.test.ts`] },
      {
        paths: [`${concurrency}/idempotency.test.ts`],
        pattern: "three independent",
      },
      {
        paths: [`${concurrency}/bet-result-race.test.ts`],
        pattern: "3 processes|three processes",
      },
      {
        paths: [`${integration}/05-recovery/recovery-compensation.test.ts`],
        pattern: "three recovery workers",
      },
    ],
  },
  {
    id: "concorrencia:worker-morto-antes-ack",
    group: "concorrencia",
    requirement: "worker morto depois do commit e antes do ack",
    runs: [
      {
        paths: [`${integration}/04-retry-dlq/sqs-command-worker.test.ts`],
        pattern: "worker death before ACK|exits between Inbox commit and ACK",
      },
      {
        paths: [`${integration}/03-inbox-outbox/outbox-publication.test.ts`],
        pattern: "crash after publish",
      },
      {
        paths: [`${integration}/03-inbox-outbox/inbox-outbox.test.ts`],
        pattern: "worker crash following SQS publish",
      },
    ],
  },
  {
    id: "concorrencia:dois-publishers",
    group: "concorrencia",
    requirement: "dois publishers sobre a mesma outbox",
    runs: twoPublishers,
  },
  {
    id: "concorrencia:reversao-antes-referencia",
    group: "concorrencia",
    requirement: "ROLLBACK ou REFUND entregue antes da referência",
    runs: [
      { paths: [`${concurrency}/out-of-order-delivery.test.ts`] },
      {
        paths: [`${integration}/06-business-rules/pending-references.test.ts`],
        pattern: "ROLLBACK that arrived before",
      },
      {
        paths: [`${concurrency}/bet-result-race.test.ts`],
        pattern: "results before the BET",
      },
    ],
  },
  {
    id: "concorrencia:reinicio",
    group: "concorrencia",
    requirement: "reinício do serviço com comprovação da consistência final",
    runs: [
      {
        paths: [`${integration}/05-recovery/http-idempotency-restart.test.ts`],
        pattern: "restart",
      },
      {
        paths: [`${integration}/05-recovery/pending-expiry.test.ts`],
        pattern: "restart",
      },
      {
        paths: [`${integration}/05-recovery/inflight-shutdown.test.ts`],
        pattern: "restart",
      },
      { paths: [`${integration}/05-recovery/outbox-inflight-restart.test.ts`] },
    ],
  },

  // ── Invariante final ──────────────────────────────────────────────────
  {
    id: "invariante:ledger",
    group: "invariante",
    requirement: "wallet.balance == saldo reconstruído pelo ledger",
    runs: [
      { paths: [`${integration}/02-atomicity/reconciliation.test.ts`] },
      { paths: [`${integration}/02-atomicity/financial-properties.test.ts`] },
    ],
  },

  // ── Carga (extra, fora da seção 13) ───────────────────────────────────
  {
    id: "carga",
    group: "carga",
    requirement: "carga: 100/1.000 jogadores, wallet quente, multi-provider",
    runs: [{ paths: ["test/load"] }],
  },
];
