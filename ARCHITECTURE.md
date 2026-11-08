# Arquitetura e decisões

Serviço financeiro de apostas: monólito modular NestJS com workers separados.
**O PostgreSQL é a fonte da verdade financeira.** O SQS é apenas transporte
at-least-once e nunca garante consistência.

## Stack

Segue a stack obrigatória do enunciado. As versões são fixadas para que o
ambiente seja o mesmo em qualquer máquina.

| Item                                   | Escolha                              | Versão                    | Onde é fixada                                        |
| -------------------------------------- | ------------------------------------ | ------------------------- | ---------------------------------------------------- |
| Runtime, package manager e test runner | Bun                                  | 1.4.4                     | `packageManager`, `bun.lock`, imagem do `Dockerfile` |
| Linguagem                              | TypeScript, `strict: true`           | 7.0.2                     | `package.json`, `tsconfig.json`                      |
| Framework                              | NestJS                               | 11.2.8                    | `package.json`                                       |
| Banco                                  | PostgreSQL                           | 17.11                     | imagem do `docker-compose.yml`                       |
| ORM e migrations                       | MikroORM (preferencial no enunciado) | 7.2.7                     | `package.json`                                       |
| Mensageria                             | AWS SQS via LocalStack               | LocalStack 3.8.1          | imagem do `docker-compose.yml`                       |
| Orquestração local                     | Docker Compose v2                    | —                         | `docker-compose.yml`                                 |
| Lint e formatação                      | Biome                                | 2.x (travado no lockfile) | `package.json`, `bun.lock`                           |

As migrations são versionadas e reversíveis: cada uma tem `up()` e `down()`,
e um teste de integração reverte todas. As imagens têm build para amd64 e
arm64.

## 1. Decisões principais e trade-offs

| Decisão               | Escolha                                                                                                                                                    | Alternativa recusada e motivo                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concorrência          | Lock pessimista por wallet (`SELECT … FOR UPDATE`), ordem de locks fixa                                                                                    | Lock otimista com retry: sob wallet "quente" gera rajadas de retry e latência imprevisível. Lock global: proibido e desnecessário.                                                                                                                                                                                                                       |
| Idempotência          | `INSERT … ON CONFLICT DO NOTHING` em `financial_operations`, com `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` | Cache em memória ou `SELECT` antes de `INSERT`: incorretos com várias instâncias.                                                                                                                                                                                                                                                                        |
| Invariantes           | No schema: CHECKs, UNIQUEs, FKs compostas e triggers (Ledger imutável, saldo = Ledger, uma reversão por alvo, um resultado por BET)                        | Só na aplicação: o enunciado exige o banco como garantia, e o código é a primeira barreira, não a única.                                                                                                                                                                                                                                                 |
| Dinheiro              | `Money` imutável em `bigint` de centavos; `NUMERIC(20,2)` no banco; transporte como string decimal                                                         | `number`/`float`: proibido. Biblioteca decimal: desnecessária para escala fixa de 2.                                                                                                                                                                                                                                                                     |
| ORM                   | MikroORM 7: `EntityManager.transactional()`, migrations versionadas e reversíveis, pool. Repositórios usam SQL explícito                                   | Entidades com Unit of Work e Identity Map: no flush, o ORM decide ordem e forma das instruções, mas aqui a ordem de locks, `FOR UPDATE`, `SKIP LOCKED`, `ON CONFLICT` e `pg_current_xact_id()` precisam ser visíveis e exatos no SQL financeiro. O ORM continua dono da transação (`em.transactional`, com retry em deadlock), do pool e das migrations. |
| Eventos               | Transactional Outbox com payload final gravado no mesmo commit; publisher com lease e fencing                                                              | Publicar dentro da transação: proibido e perde eventos em crash.                                                                                                                                                                                                                                                                                         |
| Mensageria de entrada | Inbox por `(consumer_name, message_id)` na mesma transação do efeito; ACK só após o commit                                                                 | Confiar no FIFO/dedup do SQS: é otimização, não garantia.                                                                                                                                                                                                                                                                                                |
| Autenticação          | API key por provider (`X-Provider-Code`/`X-Provider-Key`, comparação em tempo constante). Sem tabela de usuários                                           | IdP (Keycloak/Zitadel): próxima etapa, depois das garantias financeiras. O ponto de troca é a porta `ProviderIdentityPort` (token `PROVIDER_IDENTITY`), que passaria a ser implementada por um adaptador OIDC. Desenho completo na seção 8.                                                                                                                                                                    |

**Interpretações adicionais** (permitidas pela seção 7 do enunciado):

1. **Um resultado por BET.** Quando WIN, LOSS ou REFUND **referencia** uma BET, a BET tem um único resultado ativo e o primeiro resultado válido registrado vence (`REFERENCE_ALREADY_SETTLED` para os demais). Um resultado que chega antes da BET já reserva a vaga. WIN e LOSS **sem** referência continuam aceitos, como o enunciado permite ("pode referenciar"), e não disputam BET nenhuma.
2. **Uma reversão por alvo.** Um alvo aceita uma única reversão processada de qualquer tipo, o que é mais restrito que "uma por tipo". Uma BET reembolsada não pode também sofrer ROLLBACK, o que evita crédito duplicado.
3. **Rejeições de identidade são de negócio.** Jogador inexistente, wallet de outro jogador e moeda divergente são `REJECTED` (422), persistidos e repetíveis, tanto no HTTP quanto no SQS.

**Limitações conhecidas**

- Entrega de eventos at-least-once, não exactly-once. Consumidores deduplicam por `eventId`.
- Reversões que debitam (ROLLBACK de WIN/REFUND) dependem do saldo do momento. Se o prêmio já foi gasto, são rejeitadas com `REVERSAL_INSUFFICIENT_FUNDS`, como o contrato exige. Por isso a convergência independente de ordem não é garantida para esses débitos.
- Um resultado reservado antes da BET só pode ter valor e rodada validados quando a BET chega. Se for inválido, é rejeitado e libera a vaga, mas resultados recusados antes não voltam: o provedor reenvia com novo ID.
- As métricas ficam em memória por processo (Prometheus deve agregar as réplicas).
- O prefixo de ID externo `compensation:` é reservado para compensações internas.

## 2. Módulos e processos

```
http-api ─┐                       ┌─ outbox-worker      (publica Outbox → SQS)
          ├─► finance (domínio,  ─┼─ sqs-event-worker   (comandos e eventos SQS → Inbox)
SQS ──────┘    casos de uso,      └─ pending-reference-worker
               persistência)         (referências pendentes e compensação)
```

- `finance/domain`: `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `FinancialOperation`, `InboxMessage`, `OutboxMessage`, política de referência. Construtores privados com `create`/`rehydrate`, sem NestJS nem ORM. `InboxMessage` (`receive` → `markProcessed`, uma única vez) e `OutboxMessage` (`enqueue` → claim → `markPublished` ou `scheduleRetry` → `PENDING`/`FAILED`, com `isDue`) decidem as próprias transições; o repositório só as persiste. O claim da Outbox continua sendo um único `UPDATE … FOR UPDATE SKIP LOCKED`, porque só o banco arbitra publishers concorrentes, e é ele que conta a tentativa (um publisher que morre no envio também consome orçamento).
- `transactions`: o **único** caso de uso financeiro (`WagerTransactionsService`), usado por HTTP, SQS, worker de referências e compensação.
- `http-api`: só adapta HTTP ↔ caso de uso; não importa persistência (verificado em `test/unit/architecture.test.ts`).
- Cada módulo separa `dto/` (entrada/saída HTTP e mapeadores de resposta), `types/` (interfaces por assunto) e `errors/` (erros do módulo), com `index.ts` na fronteira de cada pasta. Erros de domínio ficam em `finance/domain/errors.ts`.
- `src/config/settings.ts` é o único ponto de leitura da configuração em runtime, com objetos tipados por área (outbox, SQS, referências pendentes, compensação). A validação continua em `env.validation*.ts`.
- `src/shared`: `errors/` (filtro único erro → status HTTP e utilitários de cadeia de erro), `validation/`, `retry/` (backoff exponencial), `aws/` (cliente SQS e cache de URLs de fila), `http/` e `observability/`.

## 3. Transação financeira

Uma requisição é **um** commit PostgreSQL:

1. Reserva da identidade (`financial_operations`, `ON CONFLICT DO NOTHING`). Quem perde a corrida lê a operação gravada: replay, conflito ou retomada.
2. Locks: provider (`FOR SHARE`) → player (`FOR SHARE`) → **wallet (`FOR UPDATE`)** → linhas de transação. Todo caminho segue essa ordem, então não há ciclos. Deadlocks residuais (`40P01`/`40001`) repetem a transação inteira, até `DATABASE_TRANSACTION_MAX_RETRIES`.
3. Regras de referência e de resultado sob o lock da wallet.
4. `Wallet.debit/credit` devolve saldo e lançamento juntos. Grava transação, saldo (`version + 1`), Ledger, Inbox (se SQS), Outbox e snapshot da resposta.

**Garantias no banco**

| Garantia                                                              | Mecanismo                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Saldo ≥ 0, valores > 0, moeda ISO                                     | `CHECK`                                                                                                                                                                                                                                    |
| Uma wallet por jogador + moeda; wallet de um único jogador e provider | `UNIQUE (player_id, currency)`, FKs compostas `(provider_id, player_id, wallet_id)`                                                                                                                                                        |
| Identidade e idempotência por provider                                | `UNIQUE` em `financial_operations` e `wager_transactions (provider_id, external_transaction_id)`                                                                                                                                           |
| Ledger append-only                                                    | trigger contra `UPDATE`/`DELETE`/`TRUNCATE`                                                                                                                                                                                                |
| Saldo ⇔ Ledger                                                        | triggers adiados: toda mudança de saldo tem lançamento na mesma transação SQL (`pg_current_xact_id()`), e vice-versa; uma wallet criada com saldo exige o CREDIT de `OPENING` de zero até esse saldo; aritmética `before ± amount = after` |
| Uma reversão por alvo; REFUND só de BET; valor igual                  | índice único parcial + trigger                                                                                                                                                                                                             |
| Um resultado ativo por BET                                            | trigger `validate_bet_result_slot` (trava a wallet)                                                                                                                                                                                        |
| Referência obrigatória para REFUND/ROLLBACK; proibida em BET          | `CHECK`                                                                                                                                                                                                                                    |
| Estados terminais imutáveis                                           | trigger em `wager_transactions` e em operações concluídas                                                                                                                                                                                  |
| Outbox: payload e identidade imutáveis, append-only                   | trigger                                                                                                                                                                                                                                    |

**Estados de `WagerTransaction`**

```
PENDING ──► PROCESSED | REJECTED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED (incl. REFERENCE_NOT_FOUND no TTL) | FAILED
PROCESSED, REJECTED, FAILED: terminais (imutáveis no banco)
```

`FAILED` (`INTERNAL_INCONSISTENCY`) só ocorre quando o contexto gravado de uma pendência é inconsistente e nenhuma nova tentativa pode resolvê-lo.

## 4. Regras de negócio

| Operação | Saldo                                            | Ledger      | Referência                                   |
| -------- | ------------------------------------------------ | ----------- | -------------------------------------------- |
| BET      | débito; rejeita sem saldo (`INSUFFICIENT_FUNDS`) | 1 DEBIT     | proibida                                     |
| WIN      | crédito                                          | 1 CREDIT    | opcional (BET da mesma rodada)               |
| LOSS     | nenhum                                           | nenhum      | opcional (BET)                               |
| REFUND   | crédito igual à BET                              | 1 CREDIT    | obrigatória (BET `PROCESSED`)                |
| ROLLBACK | inverso da referência                            | 1 invertido | obrigatória (BET, WIN ou REFUND `PROCESSED`) |

- A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ter o mesmo provider, jogador, wallet, moeda e rodada.
- Referência ausente → `PENDING_REFERENCE` (202). O worker reprocessa com backoff exponencial (`PENDING_REFERENCE_INITIAL_DELAY_MS`, dobrando, teto de 1 h). TTL de `PENDING_REFERENCE_TTL_HOURS` (24 h), dimensionado para atrasos operacionais de provedores sem reter pendências indefinidamente. Esgotado o TTL: `REJECTED` + `REFERENCE_NOT_FOUND` + evento.
- Replay devolve o snapshot original, inclusive o saldo observado naquele momento.

**`failureCode`** (estável; indica ao provedor se reenvia, corrige ou desiste):

| Código                                                                                | Significado                                               |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `INSUFFICIENT_FUNDS`                                                                  | BET sem saldo                                             |
| `REVERSAL_INSUFFICIENT_FUNDS`                                                         | reversão deixaria saldo negativo (requer operador)        |
| `CURRENCY_MISMATCH`, `BALANCE_LIMIT_EXCEEDED`                                         | moeda diferente da wallet; estouro de `NUMERIC(20,2)`     |
| `REFERENCE_NOT_FOUND`                                                                 | referência não chegou dentro do TTL                       |
| `REFERENCE_NOT_PROCESSED`, `REFERENCE_KIND_NOT_ELIGIBLE`                              | alvo não processado ou de tipo inválido                   |
| `REFERENCE_CONTEXT_MISMATCH`, `REFERENCE_ROUND_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH` | outro jogador/wallet/moeda, outra rodada, valor parcial   |
| `REFERENCE_ALREADY_REVERSED`, `REFERENCE_CHAIN_INVALID`                               | alvo já revertido; ROLLBACK de REFUND com cadeia inválida |
| `REFERENCE_ALREADY_SETTLED`                                                           | a BET já tem um resultado ativo                           |
| `PLAYER_NOT_FOUND`, `WALLET_NOT_FOUND`, `PLAYER_INACTIVE`, `PROVIDER_INACTIVE`        | identidade inexistente ou inativa no provider             |
| `INTERNAL_INCONSISTENCY`                                                              | `FAILED` (operador)                                       |

## 5. Idempotência

- O header `Idempotency-Key` é obrigatório (padrão recomendado `{providerId}:{externalTransactionId}`), com escopo por provider.
- `payloadHash` = SHA-256 do JSON canônico (chaves ordenadas) dos campos de negócio: `externalPlayerId`, `externalTransactionId`, `kind`, `amount`, `currency`, `externalReferenceTransactionId`, `roundId`, `gameId`. Valores normalizados (amount com 2 casas, ausente = `null`); header e metadados de transporte não entram. Uma única implementação (`PayloadFingerprint`), verificada em teste de arquitetura.
- `walletId` não entra no hash, porque é derivado de jogador + moeda. Um replay com outro `walletId` é recusado como conflito.
- Mesma chave + mesmo payload → snapshot, `idempotentReplay: true`. Payload diferente → 409. Mesmo ID externo com outra chave e mesmo payload → replay.
- HTTP e SQS usam a mesma reserva. O SQS ainda deduplica a mensagem no Inbox.

## 6. Mensageria, falhas e recuperação

**Entrada SQS** (`wager-transactions.fifo`): Inbox + caso de uso + Outbox em um commit, e ACK depois. Erro de negócio → registrado e ACK. Transitório → nova visibilidade com backoff exponencial (base `SQS_EVENT_RETRY_VISIBILITY_SECONDS`, dobra por recebimento, teto de 15 min). Permanente (JSON inválido, provider desconhecido, conflito) ou `SQS_EVENT_MAX_RECEIVE_COUNT` atingido → DLQ antes do ACK. Em SIGTERM, o long poll é abortado e as mensagens já recebidas são concluídas.

**Saída (Outbox)**: o envelope (`eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version`, `data` com `MoneyProps`) é criado por uma classe concreta por evento e gravado no commit financeiro. Publishers concorrentes usam `FOR UPDATE SKIP LOCKED` + lease. O ACK de publicação só vale para quem ainda detém o lease (fencing). Lease expirado é retomado por outra instância. Republicação é segura (mesmo `eventId`). Backoff exponencial, timeout por envio (`OUTBOX_PUBLISH_TIMEOUT_MS`) e limite `OUTBOX_MAX_ATTEMPTS` (6). Ao esgotar: `FAILED`, nunca apagado, com `bun run outbox:redrive`.

**Falha antes do COMMIT**: o PostgreSQL desfaz tudo e o reenvio é idempotente.
**Falha depois do COMMIT**: a única etapa pendente possível é publicar eventos (ACK e resposta HTTP se recuperam por reentrega idempotente). Quando a publicação de `WagerTransactionProcessed`/`WalletBalanceChanged` falha, `wager_recoveries` registra `PENDING_RECOVERY` → `RECOVERED` ou, ao esgotar, `COMPENSATION_REQUIRED` (na mesma transação que registra a tentativa).

**Compensação** (desligada por padrão, `COMPENSATION_ENABLED=false`, porque o enunciado não pede reverter apostas confirmadas por falha de infraestrutura): quando ligada, o worker cria um ROLLBACK **novo** do wager pelo mesmo caso de uso, com chave fixa `compensation:<id>`, e marca `COMPENSATED` no **mesmo commit**. Um trigger recusa `COMPENSATED` sem o ROLLBACK processado. Desfechos: `COMPENSATED`, `COMPENSATION_NOT_REQUIRED` (LOSS ou já revertido), `COMPENSATION_REJECTED` (ex.: prêmio gasto), `COMPENSATION_FAILED` (limite). Linhas terminais são imutáveis. Com a compensação ligada, ajuste o backoff da Outbox: com base de 1 s, 6 tentativas se esgotam em cerca de 30 s de indisponibilidade do SQS.

## 7. Observabilidade

- Logs JSON de uma linha com `correlationId` (header `X-Correlation-Id` ou gerado, propagado para eventos e retomadas), `causationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Sem payloads, valores, chaves ou stacks.
- `GET /metrics` (Prometheus): transações por status, duplicatas (replay/conflito), retries por componente, DLQ, conflitos e espera de lock, idade do evento mais antigo na Outbox (lag), eventos `FAILED`, pendências abertas e histograma de latência.
- `GET /health/live` (processo) e `GET /health/ready` (PostgreSQL e SQS), sem autenticação.
- Reconciliação (`POST /wallets/:id/reconciliation`): compara saldo armazenado e saldo do Ledger. Divergência é logada, contada em métrica e sinalizada, nunca corrigida.

## 8. Autenticação

### 8.1 Decisão

**A ênfase foi dada à robustez da arquitetura financeira, e o Identity Provider ficou como próxima etapa.** Os riscos que podem causar prejuízo real neste domínio são débito ou crédito duplicado, saldo negativo por corrida entre instâncias, idempotência que falha entre processos, evento publicado sem commit e saldo divergente do Ledger. Por isso essas garantias foram tratadas primeiro e com profundidade: aplicadas no schema do banco, isoladas em um único caso de uso e provadas por testes com PostgreSQL e SQS reais, várias instâncias e falhas injetadas.

Para a autenticação, a escolha foi um mecanismo simples e correto, com a troca por IdP preparada no código. Assim a arquitetura fica consistente e concisa, sem uma peça de infraestrutura a mais competindo com as garantias financeiras. O que existe garante que cada provedor só enxergue os próprios dados:

- **API key por provider**: headers `X-Provider-Code` e `X-Provider-Key`, conferidos em tempo constante (`timingSafeEqual` sobre SHA-256) contra `PROVIDER_API_KEYS`. As chaves são configuradas pelo operador e nenhuma rota as devolve.
- **Chave administrativa** (`X-Admin-Key` = `PROVIDER_ADMIN_API_KEY`, mínimo de 32 caracteres) só para cadastrar providers e mudar o status deles.
- **Sem tabela de usuários e sem hash de senha.** Não há autenticação artesanal de pessoas: as chaves identificam sistemas (provedores), não usuários.

### 8.2 O que a autenticação cobre e o que não cobre

| Entrada | Tratamento |
| --- | --- |
| Rotas do provedor (`/wallets`, `/wagering/...`, `/providers/:id/players`) | Exigem identidade. Sem credencial: **401** `PROVIDER_AUTHENTICATION_REQUIRED`/`FAILED`. Provider inativo: **403** `PROVIDER_INACTIVE`. Recurso de outro provider: **403** `PROVIDER_SCOPE_MISMATCH` ou **404** (wallet/transação de outro provider não é revelada) |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | Abertos, como pede o enunciado. Em produção ficariam na rede interna |
| Fila `wager-transactions.fifo` | Canal interno confiável: não há credencial na mensagem. **A identidade contida nela passa pelas mesmas validações de domínio do HTTP**: provider inexistente vai para a DLQ (erro permanente); provider inativo, jogador ou wallet inexistente, de outro provider ou com moeda divergente viram `REJECTED` auditável. As FKs compostas `(provider_id, player_id, wallet_id)` impedem no banco que uma mensagem mova a wallet de outro provider |

### 8.3 Ponto de extensão no código

A troca de mecanismo é isolada numa porta:

```ts
// src/modules/auth/types/auth.types.ts
export interface ProviderIdentityPort {
  identify(headers: RequestHeaders): Promise<AuthenticatedProvider>;
}
```

- `PROVIDER_IDENTITY` (`src/modules/auth/auth.tokens.ts`) é o token de injeção. O `AuthModule` hoje o liga ao adaptador de API key (`ProviderAuthService`).
- O `ProviderApiKeyGuard` só chama `identify()` e depois confere o escopo do provider na rota. Ele não sabe qual é o mecanismo de credencial.
- Controllers, caso de uso, workers e banco recebem só `AuthenticatedProvider { id, code }` e não mudam com a troca.

### 8.4 Desenho com um IdP (Keycloak)

O que seria feito para integrar o Keycloak (o Zitadel segue o mesmo desenho):

1. **Compose**: serviço `keycloak` com um realm `betting` importado de um JSON versionado no repositório.
2. **Um client confidencial por provedor** (`client_id = provider-a`), com o fluxo **client credentials** (máquina para máquina: não há usuário nem tela de login). Um *mapper* põe o claim `provider_code` no token e um *audience mapper* põe `aud = betting-api`.
3. **O provedor obtém o token** em `POST /realms/betting/protocol/openid-connect/token` e envia `Authorization: Bearer <JWT>` em vez dos headers de API key.
4. **Um novo adaptador `OidcProviderIdentity`** implementa `ProviderIdentityPort`:
   - valida a assinatura pelo JWKS do issuer (biblioteca `jose`, chaves em cache e renovadas pelo `kid`, só `RS256`);
   - confere `iss`, `aud`, `exp` e `nbf`, com tolerância de relógio pequena;
   - resolve o provider pelo claim `provider_code` (`ProvidersService.findByCode`) e exige status `ACTIVE`, como hoje.
5. **Troca do binding** no `AuthModule`: `{ provide: PROVIDER_IDENTITY, useClass: OidcProviderIdentity }`, com as variáveis `OIDC_ISSUER_URL` e `OIDC_AUDIENCE` validadas no startup.
6. **Rotas administrativas**: a `X-Admin-Key` daria lugar a um *realm role* `provider-admin`, conferido no token.
7. **Testes**: os testes de isolamento atuais passariam a emitir tokens de um Keycloak real no Compose, e haveria casos novos para token expirado, `aud` errado e assinatura inválida.

**Por que o IdP não fica no caminho crítico:** o token é validado localmente com o JWKS em cache, sem chamada ao Keycloak por requisição. Se o IdP cair, só a emissão de novos tokens para, e os tokens válidos (vida curta, cerca de 5 minutos) continuam sendo aceitos.

### 8.5 Camada adicional proposta: sessão assinada com chave rotativa

O IdP responde "quem é o provedor". Esta camada, que seria implementada depois dele, responde "esta requisição veio mesmo de quem tem a sessão e não foi alterada no caminho". Ela não foi implementada neste desafio.

**Princípio:** o segredo é dividido em uma parte fixa, que nunca sai do servidor, e uma parte variável, que muda com o tempo. O cliente nunca tem o segredo completo.

| Peça | Onde fica | Papel |
| --- | --- | --- |
| Chave mestra | Só no servidor (variável de ambiente ou KMS), nunca transmitida | Parte fixa. Dela derivam todas as chaves de sessão |
| Época (`epoch`) | Registro da sessão no PostgreSQL | Parte variável. Muda a cada rotação |
| Chave de assinatura da época | Cliente | `HKDF-SHA256(chave mestra, sessionId ‖ epoch)`. Entregue ao cliente na abertura e a cada rotação; a anterior deixa de valer |
| Identificador da sessão | Cliente: cookie `HttpOnly`, `Secure`, `SameSite=Strict`, assinado com HMAC (ou header `Authorization: Session <id>` para chamadas entre servidores) | Diz qual sessão e qual época usar |

**Cada requisição é assinada**, inclusive o body:

```
X-Timestamp: 2026-11-08T15:00:00Z
X-Nonce:     6f1c…(aleatório, uso único)
X-Signature: HMAC-SHA256(chave da época,
               método ‖ caminho ‖ X-Timestamp ‖ X-Nonce ‖ SHA-256(body))
```

O guard recalcula a chave da época a partir da chave mestra e confere, nesta ordem:

1. A sessão existe, está ativa e está dentro dos prazos.
2. O timestamp está a no máximo 60 s do relógio do servidor.
3. O nonce é inédito. Ele é gravado no PostgreSQL com TTL, e não em memória, pelo mesmo motivo da idempotência: precisa valer entre instâncias.
4. A assinatura confere, comparada em tempo constante.

Qualquer alteração em header assinado, rota ou body invalida a assinatura. Reenviar uma requisição capturada falha no nonce.

**Ciclo de vida da sessão:**

| Prazo | Valor | Efeito |
| --- | --- | --- |
| Avaliação | a cada 6 h | O servidor revisa o uso: mudança de origem, nonce repetido, taxa de assinaturas inválidas. Se houver risco, troca a época (nova chave) ou revoga a sessão |
| Validade | 24 h | Sem renovação nesse prazo, a sessão expira |
| Máximo absoluto | 7 dias | Depois disso é preciso autenticar de novo no IdP, mesmo com uso contínuo |

**O que isso protege:** adulteração do body e dos headers assinados, reuso de requisição capturada (replay), sessão forjada (sem a chave mestra não há como derivar uma chave válida) e sessão esquecida aberta (prazos e revogação no servidor).

**Limites:**

- Se o computador do cliente for invadido durante a sessão, o atacante pode assinar requisições com a chave da época atual até a próxima rotação ou revogação. A rotação reduz essa janela a no máximo 6 h, mas não a elimina. Para prender a chave ao dispositivo, ela teria de ser não exportável (chave WebCrypto `extractable: false` ou TPM), como no padrão DPoP (RFC 9449).
- Os provedores são servidores, não navegadores. Para eles o identificador vai em header. O cookie só se aplica a um painel web.
- Cada requisição grava um nonce, o que soma latência. É uma escrita pequena, mas está no caminho crítico.
- Só primitivas padronizadas (HMAC-SHA256, HKDF, comparação em tempo constante). Nenhum algoritmo criptográfico próprio.

**Encaixe no código:** seria mais um adaptador de `ProviderIdentityPort`. A assinatura cobre o body, então a porta passaria a receber `{ método, caminho, headers, rawBody }` em vez de só os headers. O body cru precisa ser preservado antes do parse JSON.

### 8.6 Limitações aceitas

| Limitação | Consequência | Com o IdP |
| --- | --- | --- |
| Chave estática por provider | Rotação exige trocar `PROVIDER_API_KEYS` e reiniciar | Tokens de vida curta e rotação de segredo no IdP |
| Sem expiração nem escopos | Uma chave vazada vale até ser trocada | `exp` e escopos por client |
| Chave administrativa única | Sem rastreio de qual operador agiu | Role por usuário do IdP, com auditoria |
| Health e métricas abertos | Expostos se a rede não os proteger | Continuam abertos, atrás da rede interna |
