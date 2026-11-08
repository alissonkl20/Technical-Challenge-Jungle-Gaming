# 3. Funcionamento do sistema

Este documento mostra **o que acontece em cada situação** que o provedor ou a
operação pode encontrar: a resposta, o que fica gravado e quais eventos saem. A
estrutura está em [01-arquitetura.md](./01-arquitetura.md) e o porquê das
escolhas em [02-decisoes-tradeoffs-e-avaliacao.md](./02-decisoes-tradeoffs-e-avaliacao.md).

Os exemplos partem de uma wallet com `100.00 BRL`.

## 3.1 Operações normais

| Situação                              | Resposta                      | Saldo e Ledger                                | Eventos publicados                                  |
| ------------------------------------- | ----------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Abrir wallet com `initialBalance` > 0 | 201                           | transação `OPENING` + 1 CREDIT; `version: 1`  | `WagerTransactionProcessed`, `WalletBalanceChanged` |
| BET de `25.00`                        | 200 `PROCESSED`, saldo 75.00  | 1 DEBIT; `version` + 1                        | `WagerTransactionProcessed`, `WalletBalanceChanged` |
| WIN de `40.00` da mesma rodada        | 200 `PROCESSED`, saldo 115.00 | 1 CREDIT; `version` + 1                       | `WagerTransactionProcessed`, `WalletBalanceChanged` |
| LOSS da BET                           | 200 `PROCESSED`               | nada muda; `version` igual                    | só `WagerTransactionProcessed`                      |
| REFUND da BET (mesmo valor)           | 200 `PROCESSED`               | 1 CREDIT do valor da BET                      | `WagerTransactionProcessed`, `WalletBalanceChanged` |
| ROLLBACK de uma BET, WIN ou REFUND    | 200 `PROCESSED`               | 1 lançamento na direção inversa da referência | `WagerTransactionProcessed`, `WalletBalanceChanged` |

Toda resposta de transação traz `transactionId`, `status`, `balance`,
`failureCode` e `idempotentReplay`.

## 3.2 Rejeições de negócio

Uma rejeição é um resultado definitivo: fica gravada como `REJECTED`, com um
`failureCode`, e responde **422**. Não move saldo nem gera lançamento, mas
publica `WagerTransactionRejected`. Reenviar a mesma requisição devolve a
mesma rejeição.

| Situação                                             | `failureCode`                                                 | O que o provedor deve fazer                           |
| ---------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| BET maior que o saldo                                | `INSUFFICIENT_FUNDS`                                          | desistir ou enviar outro valor                        |
| ROLLBACK de um WIN cujo prêmio já foi gasto          | `REVERSAL_INSUFFICIENT_FUNDS`                                 | acionar operação (caso diferente de aposta sem saldo) |
| REFUND/ROLLBACK de valor diferente da referência     | `REFERENCE_AMOUNT_MISMATCH`                                   | corrigir o payload com novo ID                        |
| Referência de outro jogador, wallet, moeda ou rodada | `REFERENCE_CONTEXT_MISMATCH` / `REFERENCE_ROUND_MISMATCH`     | corrigir o payload                                    |
| Referência já revertida                              | `REFERENCE_ALREADY_REVERSED`                                  | nada: o efeito já foi desfeito                        |
| Segundo resultado para a mesma BET                   | `REFERENCE_ALREADY_SETTLED`                                   | nada: a BET já foi liquidada                          |
| Jogador ou wallet inexistente, moeda divergente      | `PLAYER_NOT_FOUND` / `WALLET_NOT_FOUND` / `CURRENCY_MISMATCH` | corrigir a identidade                                 |

A lista completa de códigos está em [ARCHITECTURE.md](../ARCHITECTURE.md#4-regras-de-negócio).

Diferente de uma rejeição, um **payload inválido** (valor `"1e3"`, mais de
duas casas, `kind: "OPENING"`, campo desconhecido) responde **400** e não grava
nada, porque nunca poderia ser processado.

## 3.3 Repetições e conflitos

| Situação                                                      | Resultado                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Mesma `Idempotency-Key` e mesmo payload                       | Mesmo status e corpo da primeira vez, inclusive o saldo daquele momento, com `idempotentReplay: true`. Nada é gravado de novo |
| Mesma chave, payload diferente                                | **409**. A operação original não muda                                                                                         |
| Mesmo `externalTransactionId` com outra chave e mesmo payload | Tratado como replay                                                                                                           |
| A mesma BET enviada 50 vezes em paralelo                      | Um único débito; as outras 49 respostas são replays                                                                           |
| Wallet duplicada para o mesmo jogador e moeda                 | **409**                                                                                                                       |

O `payloadHash` cobre só os campos de negócio. Header, metadados de transporte
e campos de rastreio não entram, então um reenvio com outro `X-Correlation-Id`
continua sendo replay.

## 3.4 Concorrência na mesma wallet

Saldo de 100.00 e duas BETs de 80.00 chegando ao mesmo tempo, de instâncias
diferentes:

1. As duas reservam suas chaves de idempotência (são operações distintas).
2. A primeira obtém o lock da wallet (`FOR UPDATE`); a segunda espera.
3. A primeira debita, grava e faz commit: saldo 20.00.
4. A segunda obtém o lock, lê 20.00 e é rejeitada com `INSUFFICIENT_FUNDS`.

Resultado: uma `PROCESSED`, uma `REJECTED`, saldo 20.00, um único DEBIT no
Ledger. Wallets diferentes não disputam lock entre si e são processadas em
paralelo.

## 3.5 Operação que chega antes da referência

Exemplo: um ROLLBACK chega antes da BET que ele reverte.

1. O ROLLBACK responde **202** com status `PENDING_REFERENCE` e publica
   `WagerTransactionPendingReference`. Nada é debitado ou creditado.
2. O `pending-reference-worker` tenta de novo com backoff exponencial: começa
   em 5 s e dobra a cada tentativa, até no máximo 1 h.
3. Quando a BET chega, ela é processada normalmente. Na próxima tentativa, o
   ROLLBACK encontra a referência e é aplicado pelo mesmo caso de uso.
4. Se a BET não chegar em 24 h (`PENDING_REFERENCE_TTL_HOURS`), o ROLLBACK vira
   `REJECTED` com `REFERENCE_NOT_FOUND` e o evento de rejeição é publicado.

Para saber o estado, o provedor consulta
`GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
Reenviar a mesma requisição também funciona: enquanto pendente, ela é retomada;
depois de concluída, devolve o resultado final.

## 3.6 Entrada pela fila SQS

Uma mensagem `WagerTransactionRequested` na fila `wager-transactions.fifo`
segue o mesmo caso de uso do HTTP, com uma etapa a mais:

| O que acontece                               | Tratamento                                                   |
| -------------------------------------------- | ------------------------------------------------------------ |
| Processada ou rejeitada por regra de negócio | Inbox, efeito e Outbox gravados em um commit; depois o ACK   |
| Mesma mensagem entregue de novo              | O Inbox reconhece o `messageId`; nada é reaplicado; ACK      |
| Mesmo `messageId` com outro conteúdo         | Vai para a DLQ                                               |
| JSON inválido ou provider desconhecido       | Vai para a DLQ (erro permanente)                             |
| PostgreSQL indisponível                      | Sem ACK; volta com visibilidade crescente (5 s, 10 s, 20 s…) |
| Limite de recebimentos atingido              | Vai para a DLQ                                               |

## 3.7 Falhas no meio do caminho

| Momento da falha                                         | O que acontece                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Processo morre antes do commit                           | O PostgreSQL desfaz tudo. O reenvio processa do zero                                                                     |
| Processo morre depois do commit e antes da resposta HTTP | O reenvio com a mesma chave devolve o resultado gravado                                                                  |
| Worker SQS morre depois do commit e antes do ACK         | A mensagem volta; o Inbox a reconhece e só faz o ACK                                                                     |
| PostgreSQL cai durante uma requisição                    | **503**; o provedor reenvia com a mesma chave                                                                            |
| SQS fora do ar na hora de publicar                       | Os eventos esperam na Outbox e são publicados quando o SQS volta                                                         |
| Publisher morre com eventos reservados                   | O lease expira e outro publisher assume; o evento sai com o mesmo `eventId`                                              |
| Publicação falha 6 vezes                                 | O evento fica `FAILED` (nunca apagado) e pode ser republicado com `bun run outbox:redrive`                               |
| Deploy ou SIGTERM                                        | Requisições e mensagens em andamento terminam dentro de `SHUTDOWN_TIMEOUT_MS`; o que não terminar é desfeito e reenviado |

Um evento pode ser publicado mais de uma vez, mas sempre com o mesmo
`eventId`, que o consumidor usa para descartar a duplicata.

## 3.8 Conferência e diagnóstico

- **Reconciliação**: `POST /wallets/:walletId/reconciliation` responde 200 com
  o saldo armazenado, o saldo recalculado pelo Ledger e a diferença. Uma
  divergência é registrada em log e métrica e marcada com `consistent: false`;
  nunca é corrigida automaticamente.
- **Rastreio**: envie `X-Correlation-Id` (ou receba um gerado). O mesmo ID
  aparece nos logs JSON, nos eventos publicados e nas retomadas do worker.
- **Métricas**: `GET /metrics` na API e uma porta por worker, com transações
  por status, duplicatas, retries, DLQ, conflitos e espera de lock, lag da
  Outbox e latência.
- **Saúde**: `/health/live` indica se o processo responde; `/health/ready`
  confere PostgreSQL e SQS.
