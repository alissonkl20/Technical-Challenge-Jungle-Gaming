# 2. Decisões, trade-offs e avaliação

O que foi escolhido, o que foi recusado e por quê, e como o resultado se
compara aos critérios do desafio. A estrutura do sistema está em
[01-arquitetura.md](./01-arquitetura.md).

## 2.1 Estilo arquitetural: por que monólito modular

**Decisão:** monólito modular em NestJS, com um único código-fonte e um único
banco PostgreSQL, implantado como **processos separados** (API HTTP e três
workers). Foram avaliadas três opções: **monólito modular**, **microsserviços**
e **arquitetura em camadas**. As demais (serverless, event sourcing completo,
micro-kernel, pipeline etc.) não se encaixam neste tipo de aplicação: elas não
oferecem a transação ACID única entre saldo, Ledger, idempotência e Outbox que
o domínio financeiro exige, ou trazem um formato pensado para outro problema.

### 2.1.1 Contexto que pesou na escolha

- Toda operação financeira precisa alterar **saldo, Ledger, operação
  idempotente e Outbox na mesma transação**. Qualquer fronteira de rede no meio
  disso transforma uma transação local em uma transação distribuída.
- O domínio é **coeso**: wallet, transação de aposta e Ledger mudam juntos e
  pelas mesmas regras. Não há subdomínios que evoluam em ritmos diferentes.
- O time e o escopo são pequenos; o custo operacional precisa ser proporcional.

### 2.1.2 Monólito modular (escolhido)

| Pontos fortes                                                                                                                                         | Pontos fracos                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Integridade dos dados sob controle**: uma transação ACID cobre saldo, Ledger, idempotência e Outbox; constraints e triggers protegem tudo no banco   | **Ponto único de falha no banco**: se o PostgreSQL cai, o sistema inteiro para (API e todos os workers)                                              |
| **Menos abstração de comunicação**: módulos conversam por chamada de função tipada, sem rede, serialização, retry ou contrato versionado entre eles    | **Escala horizontal limitada pelo banco**: réplicas de API e workers escalam, mas todas disputam o mesmo PostgreSQL e o mesmo lock por wallet         |
| **Arquitetura consistente e confiável**: um caso de uso financeiro único (D7) para HTTP, SQS, retomada e compensação — uma regra, um lugar             | **Cuidado dobrado com volumetria**: crescimento de tabelas (Ledger, Outbox, Inbox), pool de conexões e tempo de lock afetam todos os fluxos ao mesmo tempo |
| **Organização centralizada e bem estruturada**: módulos com responsabilidade clara e fronteiras verificadas por teste automatizado                    | **Arquitetura mais engessada**: mudanças de stack, de banco ou de modelo de dados atingem o sistema inteiro; não dá para trocar só um pedaço          |
| **Fácil manutenibilidade**: refatoração com o compilador ajudando; uma mudança de ponta a ponta é um único PR, um único deploy                         | **Integrações externas fora do padrão** pesam mais: um provedor com protocolo ou semântica diferente precisa ser encaixado no mesmo modelo e processo |
| **Fácil observabilidade**: um formato de log, um conjunto de métricas e IDs de correlação únicos; o rastreio não depende de tracing distribuído        | **Implantação acoplada**: uma correção em um módulo exige publicar a imagem inteira, ainda que só um processo precise reiniciar                      |
| **Boa escalabilidade para o escopo**: wallets diferentes processam em paralelo (cerca de 600 req/s no teste) e cada processo pode ter várias réplicas  | **Sistema polarizado em um núcleo**: um bug no domínio compartilhado afeta todos os canais de uma vez                                                |

**Mitigações adotadas:** nenhuma garantia depende de memória (qualquer
processo pode ter réplicas); os workers são processos separados, então uma
fila travada não derruba a API; health checks separados para liveness e
readiness; métricas de espera de lock e de fila; e as fronteiras de módulo
permitem extrair um serviço no futuro sem reescrever o domínio.

### 2.1.3 Por que não microsserviços

| Pontos fortes                                                                                       | Pontos fracos (motivo da recusa)                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Alta escalabilidade**: cada serviço escala sozinho, conforme a sua carga                          | **Complexidade muito maior**: service discovery, gateway, contratos versionados, tracing distribuído e uma pipeline por serviço                                       |
| **Serviços independentes**: cada um tem o seu funcionamento, banco e ciclo de vida                   | **Transação distribuída no caminho crítico**: saldo e Ledger em serviços diferentes exigiriam saga e compensação para algo que hoje é um `COMMIT`                       |
| **Isolamento de falhas**: se um microsserviço cai, o restante continua de pé                         | **Abstração e colisão na comunicação entre dados**: consistência eventual entre serviços, mensagens fora de ordem e dados duplicados em mais de um lugar                 |
| **Autonomia total**: alterar um serviço isolado sem afetar os outros                                 | **Maior probabilidade de erros recorrentes**: timeouts, retries e falhas parciais na rede viram parte de toda operação financeira                                      |
| **Deploy e correções em produção** mais rápidos e com raio de impacto menor                          | **Controle difícil e conhecimento dedicado**: cada serviço precisa de dono, monitoramento e operação próprios — custo desproporcional ao tamanho do domínio e do time |
| **Mais liberdade de configuração**: stack, banco e parâmetros escolhidos por serviço                 | **Sem ganho real aqui**: o domínio é coeso; dividir wallet, transação e Ledger cortaria exatamente onde a regra precisa de atomicidade                                  |

**Conclusão:** os ganhos dos microsserviços aparecem quando há subdomínios
independentes, times separados e cargas muito diferentes entre partes do
sistema. Nenhuma dessas condições existe neste escopo, e o custo seria pago
justamente na garantia mais importante: a consistência financeira.

### 2.1.4 Por que não arquitetura em camadas (pura)

Era uma escolha muito boa e divide quase o mesmo conceito do monólito: um
deploy, um banco, transação local. A diferença está na forma de organizar o
código — por **camada técnica** (controller → service → repository) em vez de
por **módulo de negócio**. Envolve o clássico dilema da engenharia de
software: ganha-se em organização, manutenibilidade e isolamento, mas paga-se
em desempenho, complexidade de código e flexibilidade.

| Pontos fortes                                                                                                              | Pontos fracos                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Separação de conceitos**: cada camada tem uma responsabilidade única (interface, negócio, persistência)                  | **Degradação de desempenho**: os dados atravessam várias camadas intermediárias, gerando sobrecarga (overhead) de chamadas                          |
| **Facilidade de manutenção**: trocar uma camada (ex.: o banco) raramente quebra as outras, desde que os contratos se mantenham | **Código redundante (boilerplate)**: surgem as "camadas fantasma", em que uma leitura simples só repassa dados de uma camada para outra sem lógica real |
| **Testabilidade isolada**: é simples criar testes unitários mockando as camadas inferiores                                 | **Rigidez no desenvolvimento**: uma funcionalidade de ponta a ponta exige tocar arquivos em praticamente todas as camadas do sistema                |
| **Reutilização de código**: camadas inferiores fornecem serviços globais às superiores                                     | **Acoplamento oculto**: desenvolvedores tendem a burlar as regras, criando dependências circulares ou pulando camadas para acelerar entregas         |

**Conclusão:** o monólito modular aproveita o melhor das camadas **dentro** de
cada módulo — o `finance` tem domínio, persistência e aplicação separados, e o
domínio não importa framework nem ORM — sem impor camadas globais ao sistema
inteiro. O agrupamento por negócio mantém juntos os arquivos que mudam juntos,
e as fronteiras são verificadas por teste, o que combate o acoplamento oculto.

### 2.1.5 Workers: a parte distribuída do monólito

O sistema é um monólito **no código e nos dados**, mas é **distribuído na
execução**. A API e os três workers (`sqs-event-worker`, `outbox-worker`,
`pending-reference-worker`) são processos independentes, criados a partir da
mesma imagem e do mesmo código de domínio.

| O que se ganha                                                                                           | O que se paga                                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Escala por tipo de carga: mais réplicas de consumidor SQS sem escalar a API, e vice-versa                | Concorrência entre processos: exige lock por wallet, `SKIP LOCKED`, lease na Outbox e idempotência no banco      |
| Isolamento de falhas parcial: um worker parado ou lento não derruba a API                                | Entrega at-least-once: mensagens e eventos podem chegar mais de uma vez (tratado por Inbox e `eventId` estável) |
| Ciclo de vida próprio: cada processo tem desligamento gracioso (SIGTERM) e health check                  | Mais processos para operar e monitorar no Docker Compose                                                         |
| Sem rede entre módulos: todos chamam o mesmo caso de uso em processo e coordenam só pelo PostgreSQL       | Continuam dependentes do mesmo banco: isolamento de falha de infraestrutura não existe                           |

Na prática, esse arranjo entrega parte da escalabilidade e do isolamento dos
microsserviços onde eles importam (canais de entrada e publicação de eventos),
sem abrir mão da transação única no núcleo financeiro.

### 2.1.6 Resumo comparativo

| Critério                         | Monólito modular | Microsserviços        | Camadas pura      |
| -------------------------------- | ---------------- | --------------------- | ----------------- |
| Consistência financeira (ACID)   | Alta, nativa     | Baixa, exige saga     | Alta, nativa      |
| Escalabilidade horizontal        | Média (por processo, limitada pelo banco) | Alta     | Média             |
| Isolamento de falhas             | Parcial (workers) | Alto                 | Baixo             |
| Complexidade operacional         | Baixa            | Alta                  | Baixa             |
| Manutenibilidade                 | Alta             | Média (por serviço)   | Média (boilerplate) |
| Observabilidade                  | Simples          | Exige tracing distribuído | Simples       |
| Adequação ao domínio e ao time   | **Alta**         | Baixa                 | Média             |

## 2.2 Decisões técnicas

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
| D10 | Autenticação     | API key por provider, guard substituível                                         | IdP (Keycloak/Zitadel)          | Ênfase nas garantias financeiras primeiro; ponto de extensão `ProviderIdentityPort`, desenho com Keycloak em ARCHITECTURE.md §8                                                |
| D11 | API              | Só as rotas do enunciado (+ cadastro administrativo)                             | Manter rotas legadas            | Superfície menor e contrato único                                                                              |

## 2.3 Interpretações de regras de negócio

O enunciado permite interpretações adicionais desde que documentadas.

| #   | Regra                   | Interpretação adotada                                                                                                                                               | Por quê                                                                                |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| I1  | Resultados de uma BET   | Quando WIN, LOSS ou REFUND **referencia** uma BET, ela tem um único resultado ativo; **o primeiro válido registrado vence**, mesmo se chegar antes da BET (reserva) | Evita "aposta devolvida + prêmio" e torna o resultado determinístico sob concorrência  |
| I2  | WIN/LOSS sem referência | Aceitos (crédito avulso / resultado sem movimento)                                                                                                                  | O enunciado diz "pode referenciar"                                                     |
| I3  | Reversões               | Uma reversão processada por alvo, de qualquer tipo                                                                                                                  | Evita crédito duplicado (REFUND + ROLLBACK da mesma BET)                               |
| I4  | WIN revertido           | ROLLBACK de um WIN libera o resultado da BET para um resultado corrigido                                                                                            | Correções do provedor são legítimas                                                    |
| I5  | Identidade inválida     | Jogador/wallet inexistente ou moeda divergente → `REJECTED` (422), auditável, igual no HTTP e no SQS                                                                | O enunciado pede as mesmas validações de domínio nos dois canais                       |
| I6  | Compensação pós-COMMIT  | Implementada, **desligada por padrão**                                                                                                                              | Reverter aposta confirmada por falha de infraestrutura não é pedido; o operador decide |

## 2.4 Trade-offs e limitações aceitas

| Trade-off                  | Consequência                                                               | Mitigação                                                                         |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Lock pessimista por wallet | Uma wallet muito disputada é serializada (cerca de 120–130 req/s no teste) | Wallets distintas escalam em paralelo (cerca de 600 req/s); espera de lock medida |
| Entrega at-least-once      | Eventos podem ser publicados mais de uma vez                               | `eventId` estável; consumidores deduplicam no Inbox                               |
| Saldo nunca negativo       | ROLLBACK de prêmio já gasto é rejeitado (`REVERSAL_INSUFFICIENT_FUNDS`)    | Código distinto, auditável, para ação do operador                                 |
| Reserva antes da BET       | Valor e rodada só são conferidos quando a BET chega                        | Se inválido, é rejeitado e libera a vaga; o provedor reenvia com novo ID          |
| Triggers no banco          | Mais lógica em PL/pgSQL                                                    | Cada trigger é coberto por teste com SQL direto                                   |
| Métricas em memória        | Zeram ao reiniciar o processo                                              | Raspagem e agregação pelo Prometheus                                              |
| Prefixo `compensation:`    | Reservado para IDs internos                                                | Documentado                                                                       |

## 2.5 Avaliação frente ao enunciado

Evidências por critério de avaliação, a partir dos testes executados.

| Área (pontos)                | Evidência                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correção financeira (20)     | Money em centavos; Ledger imutável e ligado ao saldo no banco; reversões com valor exato; reconciliação que sinaliza sem corrigir; saldo = Ledger verificado em todos os testes |
| Concorrência (20)            | 100 → 2×80 (1 débito, saldo 20); 10 → 20×1 (10 débitos, saldo 0); cenários com 3 processos independentes; carga sem deadlocks                                                   |
| Idempotência (15)            | 50 envios idênticos em 3 processos → 1 movimento; payload divergente → 409; replay com saldo original; escopo por provider                                                      |
| Mensageria e falhas (15)     | Inbox com redelivery; ACK após commit; worker morto antes do ACK; publishers concorrentes; DLQ; retry com backoff; recuperação pós-COMMIT; SIGTERM                              |
| Modelagem e arquitetura (10) | Domínio encapsulado (construtor privado, `create`/`rehydrate`), transições de Inbox e Outbox nas próprias classes, fronteiras verificadas por teste, caso de uso único, porta `ProviderIdentityPort`                                                             |
| Testes (10)                  | Unitários + integração com PostgreSQL e LocalStack reais; 3 processos; todas as ordens de chegada; falhas injetadas; testes de mutação                                          |
| Observabilidade (5)          | Logs JSON com os IDs exigidos; todas as métricas pedidas; health separados                                                                                                      |
| Documentação (5)             | README (setup e comandos), ARCHITECTURE.md e estes documentos                                                                                                                   |

**Falhas eliminatórias:** nenhuma identificada. Não há `number` para dinheiro,
saldo negativo por corrida, débito ou crédito duplicado, idempotência só em
memória, correção dependente de instância única, evento antes do commit,
ausência de Ledger auditável ou mocks no lugar de PostgreSQL e SQS.

**Pontos abertos para discussão:** o desenho de autenticação com IdP (D10,
[ARCHITECTURE.md §8](../ARCHITECTURE.md#8-autenticação)), o volume de lógica em
triggers (D4) e as interpretações I1 e I3.
