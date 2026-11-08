# Testes

A organização segue a seção 13 do enunciado: **unidade**, **integração** e
**concorrência** ficam em pastas separadas, e cada exigência pode ser executada
sozinha com `bun run test:spec <id>`.

Integração e concorrência usam PostgreSQL e LocalStack **reais** (schema e filas
temporários por arquivo), sem mocks de persistência ou fila. Toda verificação
financeira termina com `wallet.balance == saldo reconstruído pelo Ledger`.

## Estrutura

```
test/
├── unit/                          # sem serviços externos
│   ├── money.test.ts              # Money: escala, arredondamento, entradas inválidas
│   ├── wallet.test.ts             # invariantes da Wallet (+ Provider/Player)
│   ├── wager-rules.test.ts        # regras BET, WIN, LOSS, REFUND, ROLLBACK
│   ├── wager-transaction.test.ts  # idempotency key com payload divergente
│   ├── request-identity.test.ts   # fingerprint, replay, Inbox/Outbox no domínio
│   ├── integration-event.test.ts  # envelope dos eventos
│   ├── observability.test.ts      # logs JSON, métricas, liveness/readiness
│   ├── app-config.test.ts         # validação de variáveis de ambiente
│   ├── http-dto.test.ts           # DTOs do contrato HTTP
│   └── architecture.test.ts       # regras de dependência entre camadas
├── integration/
│   ├── 01-migrations-constraints/ # migrations up/down, constraints, imutabilidade
│   ├── 02-atomicity/              # wallet + ledger + outbox na mesma transação, reconciliação
│   ├── 03-inbox-outbox/           # Inbox, publicação da Outbox, correlação
│   ├── 04-retry-dlq/              # workers SQS, retry com backoff, DLQ, FAILED
│   ├── 05-recovery/               # reinício, shutdown, compensação, expiração
│   ├── 06-business-rules/         # WIN/REFUND/ROLLBACK contra o estado da BET
│   └── 07-api/                    # contrato HTTP, isolamento entre providers
├── concurrency/                   # paralelismo real e processos independentes
│   ├── idempotency.test.ts        # mesma aposta 50× em paralelo, 3 processos
│   ├── same-wallet-contention.test.ts
│   ├── distinct-wallets-replay.test.ts
│   ├── multi-instance.test.ts     # cenários A–D com ≥ 3 processos
│   ├── bet-result-race.test.ts
│   ├── out-of-order-delivery.test.ts
│   ├── lock-ordering.test.ts
│   └── lock-wait-metric.test.ts
├── load/                          # carga (só com RUN_FINANCIAL_LOAD=true)
├── support/                       # contexto PostgreSQL, fixtures e processos filhos
├── spec-catalog.ts                # exigência da seção 13 → arquivos/testes
└── run-spec.ts                    # executor de `bun run test:spec`
```

## Como executar

Por pasta:

```sh
bun run test:unit
bun run test:integration
bun run test:concurrency
bun run test:load
bun run test:all
```

Uma exigência específica:

```sh
bun run test:spec list                          # lista as exigências
bun run test:spec concorrencia:aposta-50x       # só "mesma aposta 50× em paralelo"
bun run test:spec integracao:retry-dlq unidade:money
bun run test:spec concorrencia                  # o grupo inteiro
```

Pelo Docker (a imagem copia os testes, então use `--build` depois de alterá-los):

```sh
docker compose run --rm --build tests bun run test:spec concorrencia:aposta-50x
```

## Exigências da seção 13

| Id (`test:spec`)                         | Exigência                                              | Onde                                                                                                |
| ---------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `unidade:money`                          | Money: escala, arredondamento, entradas inválidas      | `unit/money.test.ts`                                                                                |
| `unidade:wallet`                         | Invariantes da Wallet                                  | `unit/wallet.test.ts`                                                                               |
| `unidade:regras`                         | Regras de BET, WIN, LOSS, REFUND, ROLLBACK             | `unit/wager-rules.test.ts`                                                                          |
| `unidade:conflito-moeda`                 | Conflito de moeda                                      | `unit/money`, `unit/wallet`, `unit/wager-rules`                                                     |
| `unidade:idempotencia-payload`           | Idempotency key com payload divergente                 | `unit/wager-transaction`, `unit/request-identity`                                                   |
| `integracao:migrations`                  | Migrations e constraints                               | `integration/01-migrations-constraints/`                                                            |
| `integracao:atomicidade`                 | Atomicidade entre wallet, ledger, inbox e outbox       | `integration/02-atomicity/`, `03-inbox-outbox/inbox-outbox`                                         |
| `integracao:inbox-redelivery`            | Inbox e redelivery                                     | `03-inbox-outbox/inbox-outbox`, `04-retry-dlq/sqs-command-worker`                                   |
| `integracao:publishers-concorrentes`     | Publishers concorrentes sobre a mesma outbox           | `03-inbox-outbox/inbox-outbox`, `03-inbox-outbox/outbox-publication`                                |
| `integracao:retry-dlq`                   | Retry e DLQ                                            | `integration/04-retry-dlq/`, `03-inbox-outbox/outbox-publication`                                   |
| `integracao:recuperacao`                 | Recuperação após reinicialização                       | `integration/05-recovery/`                                                                          |
| `concorrencia:aposta-50x`                | Mesma aposta 50× em paralelo → um único débito         | `concurrency/idempotency`, `concurrency/multi-instance` (C)                                         |
| `concorrencia:mesma-wallet`              | Operações disputando o saldo da mesma wallet (seção 8) | `concurrency/same-wallet-contention`, `concurrency/multi-instance` (A, B)                           |
| `concorrencia:wallets-distintas`         | Wallets distintas em paralelo                          | `concurrency/distinct-wallets-replay`                                                               |
| `concorrencia:3-processos`               | ≥ 3 processos/instâncias simultâneos                   | `concurrency/multi-instance`, `idempotency`, `bet-result-race`, `05-recovery/recovery-compensation` |
| `concorrencia:worker-morto-antes-ack`    | Worker morto depois do commit e antes do ack           | `04-retry-dlq/sqs-command-worker`, `03-inbox-outbox/*`                                              |
| `concorrencia:dois-publishers`           | Dois publishers sobre a mesma outbox                   | `03-inbox-outbox/inbox-outbox`, `03-inbox-outbox/outbox-publication`                                |
| `concorrencia:reversao-antes-referencia` | ROLLBACK ou REFUND antes da referência                 | `concurrency/out-of-order-delivery`, `bet-result-race`, `06-business-rules/pending-references`      |
| `concorrencia:reinicio`                  | Reinício do serviço com consistência final comprovada  | `integration/05-recovery/*`                                                                         |
| `invariante:ledger`                      | `wallet.balance == saldo reconstruído pelo ledger`     | `02-atomicity/reconciliation`, `02-atomicity/financial-properties` (e todos os demais)              |

O mapeamento exato (arquivos e filtros de nome) está em `spec-catalog.ts`.

## Suporte

`support/postgres-integration-context.ts` centraliza o ciclo de vida do
PostgreSQL, cria um schema isolado por arquivo e fornece fixtures.
`support/postgres-test-dependencies.ts` concentra os re-exports usados pelos
testes. Os demais arquivos de `support/` são processos filhos usados nos testes
com múltiplas instâncias. Nenhum deles é suíte de teste.
