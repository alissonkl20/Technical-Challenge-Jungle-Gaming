# Jungle Gaming — serviço financeiro de apostas

Processa BET, WIN, LOSS, REFUND e ROLLBACK de múltiplos provedores. Permanece
correto com mensagens duplicadas, fora de ordem, simultâneas e com várias
instâncias.

Stack: Bun 1.x, TypeScript 7 (strict), NestJS 11, PostgreSQL 17, MikroORM 7,
SQS via LocalStack e Docker Compose.
Decisões, garantias e trade-offs: **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Subir o ambiente

Requisito: Docker com Compose v2 (`docker compose version`). Bun, Node e
PostgreSQL não precisam estar instalados na máquina.

```sh
docker compose up --build
```

O Compose sobe PostgreSQL e LocalStack, espera as filas SQS serem criadas,
aplica as migrations (serviço `migrate`, que termina sozinho) e só então inicia
a API em `http://localhost:3000` e os três workers.

Testes, também em container, contra o mesmo PostgreSQL e LocalStack (cada suíte
usa um schema isolado, sem tocar nos dados da aplicação):

```sh
docker compose run --rm tests                     # unitários + integração
docker compose run --rm tests bun run test:load   # teste de carga
```

**Credenciais de demonstração** (só para avaliação local, definidas no
`docker-compose.yml`): provider `provider-a` com chave
`provider-a-local-key-0123456789abcdef`, e chave administrativa
`local-admin-key-0123456789abcdef0123`. Roteiro rápido:

```sh
B=http://localhost:3000
P='-H X-Provider-Code:provider-a -H X-Provider-Key:provider-a-local-key-0123456789abcdef -H Content-Type:application/json'
curl -X POST $B/providers -H 'X-Admin-Key: local-admin-key-0123456789abcdef0123' \
  -H 'Content-Type: application/json' -d '{"code":"provider-a","name":"Provider A"}'
curl -X POST $B/providers/provider-a/players $P -d '{"externalPlayerId":"player-1"}'
curl -X POST $B/wallets $P -d '{"playerId":"<id do player>","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

**Problemas comuns**

- `port is already allocated`: outra coisa já usa a porta no host (por
  exemplo, um PostgreSQL local na 5432). Troque a porta publicada:
  `POSTGRES_PORT=5433 LOCALSTACK_PORT=4567 PORT=3001 docker compose up --build`.
- Para recomeçar do zero (**apaga os dados locais**):
  `docker compose down -v && docker compose up --build`.

Sem Docker para a aplicação (desenvolvimento local):

```sh
bun install
cp .env.example .env
docker compose up -d postgres localstack
bun run migration:up
bun run start:dev
```

| Processo                            | Comando                                      | Métricas        |
| ----------------------------------- | -------------------------------------------- | --------------- |
| API HTTP                            | `bun run start:dev`                          | `:3000/metrics` |
| Publisher da Outbox                 | `bun run start:outbox-worker:dev`            | `:9464/metrics` |
| Consumer SQS (comandos e eventos)   | `bun run start:sqs-event-worker:dev`         | `:9465/metrics` |
| Referências pendentes e compensação | `bun run start:pending-reference-worker:dev` | `:9466/metrics` |

Em produção: `bun run build` e depois os scripts sem `:dev`.

## Comandos

| Comando                                                                                                | O que faz                                                                   |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `bun run build`                                                                                        | Compila e verifica tipos (strict)                                           |
| `bun run lint`                                                                                         | Biome                                                                       |
| `bun run test:unit`                                                                                    | Domínio, regras, DTOs e arquitetura (sem serviços externos)                 |
| `bun run test:integration`                                                                             | Toda a suíte com PostgreSQL e LocalStack reais (schema e filas temporários) |
| `bun run test:load`                                                                                    | Carga (100/1.000 jogadores, wallet "quente", multi-provider)                |
| `bun run test:all`                                                                                     | Unitários + integração + carga                                              |
| `bun run test:concurrency`, `test:idempotency`, `test:bet-results`, `test:recovery`, `test:messaging`… | Recortes temáticos da suíte de integração                                   |
| `bun run migration:up` / `migration:down` / `migration:list`                                           | Migrations versionadas e reversíveis                                        |
| `bun run outbox:redrive [limite]`                                                                      | Devolve eventos `FAILED` da Outbox para publicação                          |

## API HTTP

Autenticação: headers `X-Provider-Code` e `X-Provider-Key` em todas as rotas,
exceto health e `/metrics` (decisão e desenho com IdP em
[ARCHITECTURE.md §8](./ARCHITECTURE.md#8-autenticação)). `providerId` no corpo ou na rota só confirma o escopo (UUID ou
código do provider autenticado); qualquer outro valor → 403.

| Rota                                                                      | Função                                                                                         |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /wallets`                                                           | Abre wallet. Saldo inicial > 0 gera `OPENING` + CREDIT no Ledger no mesmo commit; `version: 1` |
| `GET /wallets/:walletId`                                                  | Saldo e versão                                                                                 |
| `GET /wallets/:walletId/ledger?cursor=&limit=50`                          | Ledger com cursor opaco e estável                                                              |
| `POST /wallets/:walletId/reconciliation`                                  | Saldo armazenado × reconstruído pelo Ledger                                                    |
| `POST /wagering/transactions`                                             | Submete uma operação (header `Idempotency-Key` obrigatório)                                    |
| `GET /wagering/transactions/:transactionId`                               | Transação pelo ID interno                                                                      |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Pelo ID do provedor; inclui rejeições anteriores à criação da transação                        |
| `GET /health/live`, `GET /health/ready`                                   | Liveness e readiness (PostgreSQL + SQS), sem autenticação                                      |

```sh
curl -X POST http://localhost:3000/wagering/transactions \
  -H "content-type: application/json" \
  -H "x-provider-code: provider-a" -H "x-provider-key: $PROVIDER_KEY" \
  -H "idempotency-key: provider-a:transaction-123" \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
# {"transactionId":"…","externalTransactionId":"transaction-123","status":"PROCESSED",
#  "balance":{"amount":"975.00","currency":"BRL"},"failureCode":null,"idempotentReplay":false}
```

`referenceExternalTransactionId` é obrigatório em REFUND e ROLLBACK, opcional
em WIN e LOSS e proibido em BET.

| Situação                                                     | HTTP      |
| ------------------------------------------------------------ | --------- |
| Processada                                                   | 200       |
| Aceita, aguardando a referência (`PENDING_REFERENCE`)        | 202       |
| Payload inválido / `Idempotency-Key` ausente                 | 400       |
| Sem credencial / escopo de outro provider                    | 401 / 403 |
| Recurso inexistente (ou de outro provider)                   | 404       |
| Mesma chave com payload diferente; wallet duplicada          | 409       |
| Rejeição de regra de negócio (persistida, com `failureCode`) | 422       |
| Falha transitória de infraestrutura                          | 503       |

A taxonomia de `failureCode` e o algoritmo do `payloadHash` estão em
[ARCHITECTURE.md](./ARCHITECTURE.md#4-regras-de-negócio).

**Rotas administrativas** (fora do contrato do provedor, necessárias para
cadastrar identidades): `POST /providers` e `PATCH /providers/:id/status` (header
`X-Admin-Key` = `PROVIDER_ADMIN_API_KEY`); `POST /providers/:id/players`,
`GET /providers/:id/players/:externalPlayerId` e
`PATCH /providers/:id/players/:playerId/status`.

## SQS

Fila de comandos `wager-transactions.fifo` (DLQ `wager-transactions-dlq.fifo`),
com a mensagem do enunciado:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "…",
    "walletId": "…",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

O consumer usa o mesmo caso de uso do HTTP, deduplica pelo Inbox
`(consumerName, messageId)` e faz ACK só após o commit. Eventos publicados:
`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`
e `WagerTransactionPendingReference`.

## Configuração

Todas as variáveis estão em `.env.example`; as inválidas interrompem o startup.
As mais relevantes:

| Variável                                            | Padrão           | Função                                                     |
| --------------------------------------------------- | ---------------- | ---------------------------------------------------------- |
| `PROVIDER_API_KEYS`                                 | —                | JSON `{"codigo": "segredo ≥ 32 caracteres"}`               |
| `PROVIDER_ADMIN_API_KEY`                            | —                | Chave das rotas administrativas (vazia = fechadas)         |
| `DATABASE_TRANSACTION_MAX_RETRIES`                  | `3`              | Retries de deadlock/serialização                           |
| `PENDING_REFERENCE_TTL_HOURS` / `_INITIAL_DELAY_MS` | `24` / `5000`    | TTL e backoff das referências pendentes                    |
| `OUTBOX_MAX_ATTEMPTS`                               | `6`              | Tentativas de publicação antes de `FAILED`                 |
| `OUTBOX_RETRY_BASE_DELAY_MS` / `_MAX_DELAY_MS`      | `1000` / `60000` | Backoff da Outbox                                          |
| `OUTBOX_PUBLISH_TIMEOUT_MS`                         | `10000`          | Timeout de cada envio ao SQS                               |
| `SQS_EVENT_MAX_RECEIVE_COUNT`                       | `5`              | Recebimentos antes da DLQ                                  |
| `COMPENSATION_ENABLED`                              | `false`          | Compensação automática pós-COMMIT (ver ARCHITECTURE.md §6) |
| `SHUTDOWN_TIMEOUT_MS`                               | `10000`          | Prazo do encerramento gracioso                             |

## Testes

A suíte de integração usa PostgreSQL 17 e LocalStack **reais**, com schema e
filas temporários, sem mocks de persistência ou fila. Toda verificação
financeira termina com `saldo da wallet == saldo reconstruído pelo Ledger`.

| Exigência do enunciado (seção 13)                                                         | Onde                                                                                                            |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Money, Wallet, regras BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, payload divergente | `finance-domain.test.ts`, `wager-rules.test.ts`                                                                 |
| Migrations (up/down) e constraints                                                        | `postgres-schema-migrations`, `postgres-database-invariants`, `postgres-ledger-invariants`                      |
| Atomicidade wallet/Ledger/Inbox/Outbox; Inbox e redelivery; retry e DLQ                   | `postgres-inbox-outbox`, `postgres-sqs-command-worker`                                                          |
| Publishers concorrentes; recuperação após reinício                                        | `postgres-inbox-outbox`, `process-*`, `postgres-http-idempotency`                                               |
| Mesma aposta 50× em paralelo; 100 → 2×80; wallets em paralelo                             | `postgres-idempotency`, `postgres-wallet-concurrency`, carga                                                    |
| ≥ 3 processos independentes                                                               | `postgres-multi-instance-contract` (cenários A–D), `postgres-bet-result-slot`, `postgres-recovery-compensation` |
| Worker morto após o commit e antes do ACK                                                 | `postgres-sqs-command-worker`                                                                                   |
| REFUND/ROLLBACK antes da referência; todas as ordens de chegada                           | `postgres-pending-references`, `postgres-out-of-order-matrix`                                                   |
| Falha antes/depois do COMMIT e compensação                                                | `postgres-http-resilience`, `postgres-recovery-compensation`                                                    |

### Teste de carga

- **Ambiente:** máquina local com 12 CPUs e 15 GB de RAM, PostgreSQL 17 em
  Docker, Bun 1.4, um processo de aplicação com pool de 10 conexões.
- **Metodologia:** requisições concorrentes pelo caso de uso real contra
  PostgreSQL real. Ao final, cada cenário reconcilia saldo, Ledger, versões e
  Outbox. Linha `LOAD_REPORT` por cenário.
- **Resultado** (duas execuções recentes):

| Cenário                                                     | Requisições | Concorrência | Throughput    | p50 / p95 / p99 (ms)        | Erros | Deadlocks |
| ----------------------------------------------------------- | ----------- | ------------ | ------------- | --------------------------- | ----- | --------- |
| A — uma wallet "quente"                                     | 400         | 50           | 117–134 req/s | 340–419 / 472–502 / 536–563 | 0     | 0         |
| B — 1.000 wallets distintas                                 | 1.000       | 100          | 615–637 req/s | 158–163 / 170–175 / 173–178 | 0     | 0         |
| C — 4 providers, operações mistas + publishers concorrentes | 950         | 60           | 547–556 req/s | 104–106 / 123–126 / 131–132 | 0     | 0         |
| 1.000 jogadores, 4 providers                                | 1.000       | —            | 615 req/s     | p95 1.533 / p99 1.592       | 0     | 0         |

Na wallet "quente", a vazão fica limitada pelo lock por wallet: as
requisições são serializadas por desenho, e a espera de lock aparece na métrica
`financial_lock_wait_milliseconds`. No cenário C, a Outbox terminou sem
pendências (`outboxNotPublished: 0`). Os números dependem da máquina; o que
o teste afirma é ausência de erros, deadlocks e divergências.

## Documentação

- [`docs/01-arquitetura.md`](./docs/01-arquitetura.md): processos, módulos, tabelas e garantias, fluxo de uma transação, mensageria e recuperação.
- [`docs/02-decisoes-tradeoffs-e-avaliacao.md`](./docs/02-decisoes-tradeoffs-e-avaliacao.md): decisões técnicas, interpretações de regras, trade-offs e evidências por critério.
- [`docs/03-funcionamento-do-sistema.md`](./docs/03-funcionamento-do-sistema.md): o que acontece em cada situação (respostas, gravações e eventos).
- [`docs/Mapa do Serviço de Apostas.html`](./docs/Mapa%20do%20Servi%C3%A7o%20de%20Apostas.html): mapa visual com diagramas da configuração, das tabelas e do ciclo de ponta a ponta, simulador de cenários em JSON e guia de integração. Baixe e abra no navegador (precisa de internet para os diagramas).
