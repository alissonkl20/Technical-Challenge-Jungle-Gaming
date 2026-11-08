# 2. Decisões, trade-offs e avaliação

O que foi escolhido, o que foi recusado e por quê, e como o resultado se
compara aos critérios do desafio. A estrutura do sistema está em
[01-arquitetura.md](./01-arquitetura.md).

## 2.1 Decisões técnicas

| #   | Tema             | Decisão                                                                          | Alternativa recusada            | Motivo                                                                                                         |
| --- | ---------------- | -------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| D1  | Fonte da verdade | PostgreSQL decide tudo; SQS só transporta                                        | Confiar em FIFO/dedup do SQS    | O broker não conhece saldo; dedup tem janela limitada                                                          |
| D2  | Concorrência     | Lock pessimista por wallet + ordem de locks fixa                                 | Lock otimista com retry         | Em wallet "quente", retries em rajada e latência imprevisível; lock por wallet não bloqueia wallets diferentes |
| D3  | Idempotência     | Reserva por `INSERT … ON CONFLICT` com escopo por provider                       | Checar antes de inserir / cache | Só o banco arbitra corridas entre instâncias                                                                   |
| D4  | Invariantes      | CHECK, UNIQUE, FK composta e triggers no schema                                  | Só na aplicação                 | O enunciado exige; a aplicação é a primeira barreira, não a única                                              |
| D5  | Dinheiro         | `bigint` de centavos no domínio, `NUMERIC(20,2)` no banco, string no transporte  | `number` / lib decimal          | `number` é proibido; escala fixa dispensa biblioteca                                                           |
| D6  | ORM              | MikroORM para transação, migrations e pool; SQL explícito nos repositórios       | Entidades gerenciadas           | `FOR UPDATE`, `SKIP LOCKED` e `ON CONFLICT` precisam ser exatos e visíveis                                     |
| D7  | Caso de uso      | Um só, para HTTP, SQS, retomada e compensação                                    | Um por canal                    | Uma regra financeira, um lugar                                                                                 |
| D8  | Eventos          | Transactional Outbox com envelope final gravado no commit                        | Publicar na transação           | Evento antes do commit é proibido e perde dados em crash                                                       |
| D9  | Ledger           | Uma entrada por movimento, append-only, ligada ao saldo pelo ID da transação SQL | Partidas dobradas               | Opcional no enunciado; aumentaria o modelo sem ganho para o escopo                                             |
| D10 | Autenticação     | API key por provider, guard substituível                                         | IdP (Keycloak/Zitadel)          | Não pontua; o ponto de extensão para OIDC está isolado no guard                                                |
| D11 | API              | Só as rotas do enunciado (+ cadastro administrativo)                             | Manter rotas legadas            | Superfície menor e contrato único                                                                              |

## 2.2 Interpretações de regras de negócio

O enunciado permite interpretações adicionais desde que documentadas.

| #   | Regra                   | Interpretação adotada                                                                                                                                               | Por quê                                                                                |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| I1  | Resultados de uma BET   | Quando WIN, LOSS ou REFUND **referencia** uma BET, ela tem um único resultado ativo; **o primeiro válido registrado vence**, mesmo se chegar antes da BET (reserva) | Evita "aposta devolvida + prêmio" e torna o resultado determinístico sob concorrência  |
| I2  | WIN/LOSS sem referência | Aceitos (crédito avulso / resultado sem movimento)                                                                                                                  | O enunciado diz "pode referenciar"                                                     |
| I3  | Reversões               | Uma reversão processada por alvo, de qualquer tipo                                                                                                                  | Evita crédito duplicado (REFUND + ROLLBACK da mesma BET)                               |
| I4  | WIN revertido           | ROLLBACK de um WIN libera o resultado da BET para um resultado corrigido                                                                                            | Correções do provedor são legítimas                                                    |
| I5  | Identidade inválida     | Jogador/wallet inexistente ou moeda divergente → `REJECTED` (422), auditável, igual no HTTP e no SQS                                                                | O enunciado pede as mesmas validações de domínio nos dois canais                       |
| I6  | Compensação pós-COMMIT  | Implementada, **desligada por padrão**                                                                                                                              | Reverter aposta confirmada por falha de infraestrutura não é pedido; o operador decide |

## 2.3 Trade-offs e limitações aceitas

| Trade-off                  | Consequência                                                               | Mitigação                                                                         |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Lock pessimista por wallet | Uma wallet muito disputada é serializada (cerca de 120–130 req/s no teste) | Wallets distintas escalam em paralelo (cerca de 600 req/s); espera de lock medida |
| Entrega at-least-once      | Eventos podem ser publicados mais de uma vez                               | `eventId` estável; consumidores deduplicam no Inbox                               |
| Saldo nunca negativo       | ROLLBACK de prêmio já gasto é rejeitado (`REVERSAL_INSUFFICIENT_FUNDS`)    | Código distinto, auditável, para ação do operador                                 |
| Reserva antes da BET       | Valor e rodada só são conferidos quando a BET chega                        | Se inválido, é rejeitado e libera a vaga; o provedor reenvia com novo ID          |
| Triggers no banco          | Mais lógica em PL/pgSQL                                                    | Cada trigger é coberto por teste com SQL direto                                   |
| Métricas em memória        | Zeram ao reiniciar o processo                                              | Raspagem e agregação pelo Prometheus                                              |
| Prefixo `compensation:`    | Reservado para IDs internos                                                | Documentado                                                                       |

## 2.4 Avaliação frente ao enunciado

Evidências por critério de avaliação, a partir dos testes executados.

| Área (pontos)                | Evidência                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correção financeira (20)     | Money em centavos; Ledger imutável e ligado ao saldo no banco; reversões com valor exato; reconciliação que sinaliza sem corrigir; saldo = Ledger verificado em todos os testes |
| Concorrência (20)            | 100 → 2×80 (1 débito, saldo 20); 10 → 20×1 (10 débitos, saldo 0); cenários com 3 processos independentes; carga sem deadlocks                                                   |
| Idempotência (15)            | 50 envios idênticos em 3 processos → 1 movimento; payload divergente → 409; replay com saldo original; escopo por provider                                                      |
| Mensageria e falhas (15)     | Inbox com redelivery; ACK após commit; worker morto antes do ACK; publishers concorrentes; DLQ; retry com backoff; recuperação pós-COMMIT; SIGTERM                              |
| Modelagem e arquitetura (10) | Domínio encapsulado (construtor privado, `create`/`rehydrate`), fronteiras verificadas por teste, caso de uso único                                                             |
| Testes (10)                  | Unitários + integração com PostgreSQL e LocalStack reais; 3 processos; todas as ordens de chegada; falhas injetadas; testes de mutação                                          |
| Observabilidade (5)          | Logs JSON com os IDs exigidos; todas as métricas pedidas; health separados                                                                                                      |
| Documentação (5)             | README (setup e comandos), ARCHITECTURE.md e estes documentos                                                                                                                   |

**Falhas eliminatórias:** nenhuma identificada. Não há `number` para dinheiro,
saldo negativo por corrida, débito ou crédito duplicado, idempotência só em
memória, correção dependente de instância única, evento antes do commit,
ausência de Ledger auditável ou mocks no lugar de PostgreSQL e SQS.

**Pontos de atenção para a apresentação:** a autenticação sem IdP (D10), o
volume de triggers (D4) e as interpretações I1 e I3.
