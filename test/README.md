# Organização dos testes

Os testes de PostgreSQL foram separados por comportamento para permitir leitura
e execução isolada. Os nomes dos casos foram preservados.

| Arquivo                                             | Escopo                                            |
| --------------------------------------------------- | ------------------------------------------------- |
| `postgres-schema-migrations.integration.test.ts`    | Migrações e persistência inicial                  |
| `postgres-http-api.integration.test.ts`             | Contrato HTTP, validação e autenticação           |
| `postgres-http-idempotency.integration.test.ts`     | Idempotência HTTP e recuperação após restart      |
| `postgres-http-resilience.integration.test.ts`      | Commit financeiro e falhas transitórias HTTP      |
| `postgres-financial-processing.integration.test.ts` | Processamento financeiro, atomicidade e rejeições |
| `postgres-idempotency.integration.test.ts`          | Idempotência e deduplicação entre processos       |
| `postgres-pending-references.integration.test.ts`   | Referências pendentes, retries e expiração        |
| `postgres-wallet-concurrency.integration.test.ts`   | Contenção e apostas concorrentes na carteira      |
| `postgres-financial-properties.integration.test.ts` | Sequências geradas e propriedades financeiras     |
| `postgres-wallet-replay.integration.test.ts`        | Concorrência entre carteiras e replay de resposta |
| `postgres-reversals.integration.test.ts`            | Regras de `REFUND` e `ROLLBACK`                   |
| `postgres-provider-isolation.integration.test.ts`   | Autenticação e isolamento entre providers         |
| `postgres-database-invariants.integration.test.ts`  | Constraints e identidade das operações            |
| `postgres-ledger-invariants.integration.test.ts`    | Imutabilidade do Ledger e constraints de reversão |
| `postgres-inbox-outbox.integration.test.ts`         | Idempotência da Inbox e publicação da Outbox      |
| `postgres-sqs-command-worker.integration.test.ts`   | Workers de comandos SQS e recuperação             |
| `postgres-sqs-event-worker.integration.test.ts`     | Consumer de eventos SQS, retries e DLQ            |
| `postgres-reconciliation.integration.test.ts`       | Reconciliação de saldos e movimentos              |

`postgres-integration-context.ts` centraliza o ciclo de vida do PostgreSQL,
cria um schema isolado por arquivo e fornece fixtures compartilhadas.
`postgres-test-dependencies.ts` concentra os re-exports usados pelos testes.
Esses arquivos são suporte, não suítes de teste.

Para executar um assunto isoladamente, por exemplo:

```sh
RUN_POSTGRES_INTEGRATION=true bun test ./test/postgres-reversals.integration.test.ts
```

`bun run test:integration` executa todas as suítes PostgreSQL. Os testes
dependem de PostgreSQL disponível conforme a configuração local do projeto.
