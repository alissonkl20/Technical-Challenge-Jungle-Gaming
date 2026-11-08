# 1. Arquitetura do projeto

Este documento descreve **como o sistema é organizado**: processos, módulos,
dados e fluxos. O **porquê** de cada escolha está em
[02-decisoes-tradeoffs-e-avaliacao.md](./02-decisoes-tradeoffs-e-avaliacao.md).

> A descrição fica no nível de módulos e responsabilidades, não de arquivos,
> para continuar válida enquanto a organização interna das pastas evolui.

## 1.1 Visão geral

Monólito modular em NestJS, com uma API HTTP e três workers independentes que
compartilham o mesmo código de domínio e o mesmo banco.

```
             ┌──────────────────────── PostgreSQL (fonte da verdade) ────────────────────────┐
             │ providers · players · wallets · financial_operations · wager_transactions     │
             │ wallet_ledger_entries · inbox · outbox · wager_recoveries                     │
             └───────────────▲──────────────────────▲───────────────────────▲─────────────────┘
                             │                      │                       │
 Provedor ── HTTP ──► API HTTP ──┐                  │                       │
                                 ├─► caso de uso financeiro (único) ◄───────┤
 Provedor ── SQS ──► sqs-event-worker ┘             │                       │
                    (comandos + Inbox)              │                       │
                                       outbox-worker ── publica ──► SQS (eventos)
                                       pending-reference-worker
                                       (referências pendentes + recuperação/compensação)
```

| Processo                     | Responsabilidade                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| **API HTTP**                 | Contrato dos provedores: wallets, transações, consultas, reconciliação, health, métricas             |
| **sqs-event-worker**         | Consome `wager-transactions.fifo` (comandos) e eventos financeiros, com Inbox, ACK após commit e DLQ |
| **outbox-worker**            | Publica eventos da Outbox no SQS com lease, retry com backoff e limite de tentativas                 |
| **pending-reference-worker** | Reprocessa transações em `PENDING_REFERENCE` e executa a compensação pós-COMMIT (quando habilitada)  |

Todos rodam como serviços separados no Docker Compose e podem ter várias
réplicas: nenhuma garantia depende de estado em memória.

## 1.2 Módulos

| Módulo                              | Papel                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `finance`                           | Núcleo. **Domínio** puro (sem NestJS nem ORM): `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `FinancialOperation`, `InboxMessage`, `OutboxMessage` e a política de referência. **Persistência**: repositórios PostgreSQL e o gerenciador de transação. **Aplicação**: consultas e a submissão pelo contrato HTTP |
| `transactions`                      | O caso de uso financeiro único (BET/WIN/LOSS/REFUND/ROLLBACK), resolução de identidade, regras de referência, retomada de pendências e compensação                                                                                                                                                                             |
| `http-api`                          | Adaptador HTTP: controllers, DTOs e mapeamento de respostas. Não acessa o banco diretamente                                                                                                                                                                                                                                    |
| `events`                            | Consumers SQS (comandos e eventos) e as classes de evento de integração                                                                                                                                                                                                                                                        |
| `inbox` / `outbox`                  | Deduplicação de entrada e publicação transacional de saída                                                                                                                                                                                                                                                                     |
| `auth`                              | Guards de API key do provider e da chave administrativa                                                                                                                                                                                                                                                                        |
| `providers` / `players` / `wallets` | Cadastro e abertura de identidades e wallets                                                                                                                                                                                                                                                                                   |
| `shared`                            | Observabilidade (logs JSON, métricas, correlação) e tratamento HTTP de erros                                                                                                                                                                                                                                                   |
| `config`                            | Validação das variáveis de ambiente no startup                                                                                                                                                                                                                                                                                 |
| `workers`                           | Pontos de entrada dos processos; só orquestram, sem regra nem SQL                                                                                                                                                                                                                                                              |

Fronteiras verificadas por teste automatizado: o domínio não importa
framework, a camada HTTP não importa persistência, os eventos só são criados
pelas suas classes e o hash de payload tem uma única implementação.

## 1.3 Modelo de dados

| Tabela                  | Conteúdo                                                                 | Garantias principais                                                                                        |
| ----------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `providers`             | Provedores de jogos                                                      | código único                                                                                                |
| `players`               | Jogador por provider                                                     | `UNIQUE (provider_id, external_player_id)`                                                                  |
| `wallets`               | Saldo materializado e versão                                             | `UNIQUE (player_id, currency)`, saldo ≥ 0, FK composta com o provider                                       |
| `financial_operations`  | Identidade de cada requisição e snapshot da resposta                     | `UNIQUE (provider_id, idempotency_key)` e `(provider_id, external_transaction_id)`; imutável após concluída |
| `wager_transactions`    | Fato financeiro (OPENING, BET, WIN, LOSS, REFUND, ROLLBACK) e seu estado | estados terminais imutáveis; referência por tipo; um resultado ativo por BET; uma reversão por alvo         |
| `wallet_ledger_entries` | Lançamentos                                                              | append-only; aritmética validada; sempre junto da mudança de saldo                                          |
| `inbox`                 | Mensagens consumidas                                                     | `UNIQUE (consumer_name, message_id)` + hash do payload                                                      |
| `outbox`                | Eventos a publicar                                                       | payload e identidade imutáveis, append-only; estado de entrega mutável                                      |
| `wager_recoveries`      | Recuperação e compensação pós-COMMIT                                     | um registro por transação; `COMPENSATED` só com o ROLLBACK confirmado                                       |

As migrations são versionadas e reversíveis (`bun run migration:up/down`). As
mais recentes só **adicionam** garantias; nenhuma reescreve as anteriores.

## 1.4 Fluxo de uma transação

```
1. Requisição (HTTP ou SQS) ── valida payload ── 400 se inválido
2. BEGIN
3. Reserva idempotência (INSERT … ON CONFLICT DO NOTHING)
      já existe? → replay do snapshot | conflito 409 | retomada se pendente
4. Locks: provider (share) → player (share) → wallet (FOR UPDATE) → transações
5. Resolve referência e aplica as regras
      ausente → PENDING_REFERENCE (202)
      inválida/sem saldo → REJECTED (422, failureCode)
6. Wallet.debit/credit → saldo + lançamento no Ledger
7. Grava transação, saldo, Ledger, [Inbox], Outbox e snapshot da resposta
8. COMMIT   (triggers adiados conferem saldo ⇔ Ledger)
9. Responde / ACK na fila
10. outbox-worker publica os eventos (at-least-once)
```

Falha antes do passo 8: tudo é desfeito e o reenvio é idempotente. Falha
depois: ver 1.6.

## 1.5 Eventos fora de ordem

- Resultado ou reversão que chega antes da referência fica em
  `PENDING_REFERENCE` e já reserva o resultado da BET.
- O `pending-reference-worker` retoma pelo **mesmo** caso de uso, com backoff
  exponencial e TTL (24 h). Esgotado o TTL: `REJECTED` com
  `REFERENCE_NOT_FOUND`, e o evento é publicado.
- Todas as ordens de chegada das cadeias definidas pelo contrato convergem
  para o mesmo saldo e o mesmo Ledger (testado por permutação).

## 1.6 Mensageria e recuperação

- **Entrada SQS**: Inbox + efeito + Outbox em um commit; ACK depois. Erro de
  negócio → registrado e ACK; transitório → nova visibilidade com backoff;
  permanente ou acima do limite → DLQ.
- **Saída**: Outbox com lease, fencing por worker, backoff exponencial,
  timeout por envio e limite de 6 tentativas; esgotado → `FAILED` (redrive
  manual).
- **Pós-COMMIT**: falha ao publicar os eventos de uma transação processada →
  `PENDING_RECOVERY` → `RECOVERED` ou, esgotada, `COMPENSATION_REQUIRED`.
  Com `COMPENSATION_ENABLED=true`, um ROLLBACK novo e idempotente neutraliza o
  efeito, gravado no mesmo commit que marca `COMPENSATED`.
- **Encerramento**: SIGTERM drena requisições e mensagens em andamento dentro
  de `SHUTDOWN_TIMEOUT_MS`.

## 1.7 Observabilidade

Logs JSON com `correlationId`, `causationId`, `messageId`, `transactionId`,
`walletId` e `providerId`; métricas Prometheus por processo; `/health/live` e
`/health/ready` separados; reconciliação que sinaliza divergência sem corrigir.
