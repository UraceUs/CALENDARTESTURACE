# Kommo + Robô Chat como SDR — Regras Operacionais

Este documento define **o que entra no Kommo** (vira card) e **como o robô chat
atua como SDR**: a quem responde, como responde e quando aciona um humano.

As regras estão implementadas em `lib/sdr/` e expostas pelo backend em
`POST /api/sdr/avaliar`. Alterar política de atendimento = alterar
`lib/sdr/regras.js` (parâmetros, palavras-chave, textos, SLAs).

---

## Princípio fundamental

> **Todas as mensagens continuam chegando normalmente por todos os canais.**
> O card é um evento comercial, não um registro de conversa.

- O inbox do Kommo (WhatsApp, Instagram, Messenger, Telegram, site, e-mail)
  continua recebendo e exibindo **100% das mensagens**.
- O **card só nasce** quando a interação cumpre pelo menos uma regra de entrada.
- Nenhuma interação abre um segundo card para um contato que já tem card aberto.

---

## Parte 1 — Regras de entrada no Kommo

### 1.1 Ações possíveis da triagem

| Ação | Significado |
|---|---|
| `ignorar` | Não vira card e não recebe resposta automática (ruído estrutural). |
| `somente_conversa` | Mensagem fica no inbox, **sem card**. |
| `criar_card` | Abre card novo no pipeline. |
| `anexar_card` | Registra no card já existente (nunca duplica). |
| `reabrir_card` | Card fechado recente volta ao pipeline. |

### 1.2 O que **CRIA** card

| # | Gatilho | Motivo (código) | Estágio inicial |
|---|---|---|---|
| 1 | Reserva Etapa 1 concluída no site (Pit ID gerado) | `RESERVA_ETAPA1` | Reserva Etapa 1 (Pit ID gerado) |
| 2 | Driver Briefing Etapa 2 concluído | `RESERVA_ETAPA2` | Reserva confirmada |
| 3 | Reserva parada na Etapa 1 além de 24 h | `RESERVA_PARADA` | Reserva Etapa 1 (Pit ID gerado) |
| 4 | Formulário do site preenchido | `FORMULARIO_SITE` | Novo lead (SDR) |
| 5 | Chamada perdida de número desconhecido | `CHAMADA_PERDIDA` | Novo lead (SDR) |
| 6 | Pergunta de **preço**, **disponibilidade/agenda** ou **como contratar** | `INTENCAO_COMERCIAL` | Em qualificação (bot) |
| 7 | Pedido explícito de falar com uma pessoa | `PEDIDO_HUMANO` | Qualificado - humano |
| 8 | Demanda corporativa / evento / grupo acima de 4 pilotos | `DEMANDA_CORPORATIVA` | Qualificado - humano |
| 9 | Tema sensível (jurídico, saúde, cobrança, imprensa) | `TEMA_SENSIVEL` | Qualificado - humano |
| 10 | Lead informou um Pit ID existente | `PIT_ID_INFORMADO` | Reserva Etapa 1 (Pit ID gerado) |
| 11 | Lead já forneceu serviço + data/período + contato | `DADOS_QUALIFICACAO` | Em qualificação (bot) |
| 12 | Soma de sinais fracos ≥ 40 pontos | `SCORE_QUALIFICACAO` | Em qualificação (bot) |

### 1.3 O que **NÃO** cria card

| # | Situação | Motivo (código) | Tratamento |
|---|---|---|---|
| 1 | Contato interno / número de teste da equipe | `CONTATO_INTERNO` | `ignorar` |
| 2 | Grupo ou lista de transmissão | `GRUPO_OU_TRANSMISSAO` | `ignorar` |
| 3 | Spam, fornecedor, agência, currículo, empréstimo | `SPAM_OU_OFERTA` | Conversa + tag `sdr:spam` |
| 4 | Pedido de opt-out ("não quero mais receber") | `OPT_OUT` | Conversa + tag `sdr:opt-out` |
| 5 | Saudação isolada ("oi", "bom dia") sem intenção | `SAUDACAO_ISOLADA` | Conversa; bot pergunta o que a pessoa precisa |
| 6 | Agradecimento, "ok", "valeu", encerramento | `AGRADECIMENTO_OU_ENCERRAMENTO` | Conversa, sem resposta |
| 7 | Áudio/imagem/sticker sem texto útil | `MIDIA_SEM_CONTEXTO` | Conversa; bot pede texto |
| 8 | Pergunta operacional genérica (endereço, horário) | `SEM_SINAL_COMERCIAL` | Conversa |
| 9 | Contato **já possui card aberto** | `CARD_ABERTO_EXISTENTE` | `anexar_card` (sem duplicar) |

### 1.4 Pontuação (sinais fracos)

Nenhum sinal fraco sozinho abre card. O card nasce quando a soma atinge **40**.

| Sinal | Pontos | Gatilho direto? |
|---|---|---|
| Preço | 40 | ✅ |
| Agenda / disponibilidade | 40 | ✅ |
| Contratação explícita | 40 | ✅ |
| Pedido de humano | 40 | ✅ |
| Corporativo | 30 | ✅ |
| Pit ID informado | 30 | — |
| Serviço citado pelo nome | 20 | — |
| Pergunta informativa | 20 | — |
| Data mencionada | 15 | — |
| Quantidade de pilotos | 15 | — |
| E-mail ou telefone informado | 15 | — |

Exemplos:
- `"Onde fica a pista?"` → 20 pontos → **sem card**.
- `"Queria uma aula dia 12/10 para 2 pilotos"` → 20 + 15 + 15 = 50 → **card**.
- `"Quanto custa?"` → gatilho direto → **card**.

### 1.5 Deduplicação e reabertura

1. Card **aberto** para o contato → sempre `anexar_card`.
2. Card **fechado há ≤ 30 dias** + novo sinal comercial → `reabrir_card`
   (tag `sdr:reaberto`).
3. Card fechado há **> 30 dias** → card novo (novo ciclo de compra).

### 1.6 Pipeline sugerido

| Ordem | Estágio | Dono |
|---|---|---|
| 1 | Novo lead (SDR) | Robô |
| 2 | Em qualificação (bot) | Robô |
| 3 | Qualificado - humano | Vendas |
| 4 | Reserva Etapa 1 (Pit ID gerado) | Vendas |
| 5 | Briefing Etapa 2 pendente | Vendas |
| 6 | Reserva confirmada | Operação |
| 7 | Perdido (com motivo) | — |

### 1.7 Campos personalizados do card

`canal`, `origem`, `servico_interesse`, `data_desejada`, `periodo`,
`quantidade_pilotos`, `pit_id`, `email_contato`, `score_sdr`, `sdr_status`.

O motor devolve esses campos preenchidos em `kommo.campos`.

---

## Parte 2 — Regras do robô chat (SDR)

### 2.1 Quando o robô **responde**

- Canal com robô: WhatsApp, Instagram, Messenger, Telegram, chat do site.
- Conversa individual (nunca grupo/transmissão).
- Card **sem responsável humano** e com bot não silenciado.
- Assunto comercial: serviços, disponibilidade, como funciona, faixa de valores,
  apoio com Pit ID e Etapa 2.

### 2.2 Quando o robô **NÃO responde**

| Situação | Código | Comportamento |
|---|---|---|
| Humano já assumiu a conversa | `HUMANO_NO_ATENDIMENTO` | Silêncio (só notifica se o tema for sensível ou o lead reclamar) |
| Bot silenciado manualmente no card | `BOT_SILENCIADO` | Silêncio até liberação manual |
| Grupo / lista de transmissão | `GRUPO_OU_TRANSMISSAO` | Silêncio |
| Contato interno / teste | `CONTATO_INTERNO` | Silêncio |
| Spam / fornecedor / currículo | `SPAM_OU_OFERTA` | Silêncio |
| Agradecimento ou encerramento | `AGRADECIMENTO_OU_ENCERRAMENTO` | Silêncio |
| Canal sem robô (telefone, e-mail) | `CANAL_SEM_ROBO` | Silêncio + tarefa humana |
| Etapa 2 concluída (e-mail automático já sai) | `FLUXO_AUTOMATICO` | Silêncio |
| Opt-out | `OPT_OUT` | Uma confirmação e silêncio definitivo |

### 2.3 Como o robô responde

- **Idioma do lead** (pt-BR padrão; inglês quando o lead escreve em inglês).
- **Máximo 2 mensagens por turno**, até **350 caracteres** cada, no máximo 1 emoji.
- **Uma pergunta por vez**, na ordem de qualificação.
- **Nunca inventa**: preço fechado, disponibilidade, promessa de data ou condição
  de pagamento. Quando não sabe, encaminha ou escala.
- Sempre empurra para o funil oficial: Etapa 1 no `Calendar.html` (gera o Pit ID)
  → Etapa 2 no `DriverBriefing.html`.

**Ordem de qualificação (SDR):**

1. Serviço (Professional Coaching / Summer Camp / Trackside Support)
2. Data desejada
3. Período (manhã / tarde)
4. Quantidade de pilotos
5. Experiência prévia
6. Nome completo
7. E-mail de contato

**Cadência de follow-up:** +30 min → +24 h → +72 h. Sem resposta após a terceira
tentativa, o card vai para `Perdido` com motivo "sem resposta".

**Horário:** o robô responde 24/7. Fora de seg–sáb, 9h–19h (America/Sao_Paulo),
avisa que uma pessoa responde no próximo horário útil e a tarefa do humano já
nasce com prazo a partir da abertura.

### 2.4 Quando e como o robô aciona um humano

**Gatilhos de escalonamento:**

| Motivo | Prioridade | SLA da tarefa |
|---|---|---|
| `LEAD_QUALIFICADO` — qualificação completa | Alta | 5 min úteis |
| `PEDIDO_HUMANO` — lead pediu uma pessoa | Alta | 5 min úteis |
| `TEMA_SENSIVEL` — jurídico, saúde, cobrança, imprensa | Alta | 5 min úteis |
| `LEAD_INSATISFEITO` — lead irritado ou cobrando retorno | Alta | 5 min úteis |
| `FALHA_TECNICA` — Pit ID inexistente, erro de sistema | Alta | 5 min úteis |
| `NEGOCIACAO` — desconto ou condição especial | Média | 15 min úteis |
| `CORPORATIVO` — empresa, evento, grupo > 4 pilotos | Média | 15 min úteis |
| `SEM_ENTENDIMENTO` — 2 tentativas sem entender | Média | 15 min úteis |
| `RESERVA_PARADA` — Etapa 1 parada há mais de 24 h | Média | 15 min úteis |

**Como notifica (ações no Kommo):**

1. Move o card para **Qualificado - humano** (ou mantém o estágio do funil).
2. Atribui responsável por rodízio comercial.
3. Cria **tarefa** com prazo conforme o SLA (fora do horário, contado da abertura).
4. Adiciona **nota estruturada** com o resumo: canal, contato, serviço, data,
   período, pilotos, experiência, Pit ID, score, intenções e última mensagem.
5. Aplica tags `sdr:handoff` e `handoff:<motivo>`.
6. Notifica o responsável e o grupo comercial.
7. **Silencia o robô** naquele card — a conversa passa a ser da pessoa.

**SLAs gerais:** primeira resposta do robô em até 30 s; handoff registrado em até
5 min; retomada de reserva parada em 24 h.

---

## Parte 3 — Integração técnica

### 3.1 Endpoints

| Método | Rota | Uso |
|---|---|---|
| `POST` | `/api/sdr/avaliar` | Recebe a interação e devolve a decisão (card + robô). |
| `GET` | `/api/sdr/regras` | Devolve a parametrização ativa (auditoria/painel). |

Proteção opcional: defina `SDR_WEBHOOK_TOKEN` no ambiente e envie
`Authorization: Bearer <token>`. Sem a variável, o endpoint fica aberto.

### 3.2 Payload de entrada

```json
{
  "canal": "whatsapp",
  "tipo": "mensagem",
  "texto": "Quanto custa o Professional Coaching dia 12/10?",
  "midia": null,
  "origem": "instagram-bio",
  "interno": false,
  "contato": { "id": "55...", "nome": "Ana", "telefone": "+5511...", "email": null },
  "conversa": {
    "id": "c-1",
    "ehGrupo": false,
    "ehTransmissao": false,
    "mensagensDoLead": 3,
    "tentativasSemEntendimento": 0,
    "tentativasFollowUp": 0
  },
  "card": {
    "existe": true,
    "id": "4412",
    "estagio": "Em qualificação (bot)",
    "status": "aberto",
    "responsavelHumano": null,
    "botSilenciado": false,
    "atualizadoEm": "2026-09-20T12:00:00Z",
    "fechadoEm": null
  },
  "reserva": { "pitId": null, "etapa": null, "encontrada": null },
  "qualificacao": {
    "servico": null, "data": null, "periodo": null,
    "pilotos": null, "experiencia": null, "nome": null, "contato": null
  }
}
```

`tipo` aceita: `mensagem`, `reserva_etapa1`, `reserva_etapa2`,
`reserva_etapa1_parada`, `chamada_perdida`, `formulario`.

### 3.3 Resposta

```json
{
  "ok": true,
  "versaoRegras": "1.0.0",
  "kommo": {
    "acao": "criar_card",
    "criarCard": true,
    "atualizaCard": true,
    "motivo": "INTENCAO_COMERCIAL",
    "descricao": "Sinal comercial explicito (preco, agenda, contratacao).",
    "estagioSugerido": "Em qualificacao (bot)",
    "tags": ["sdr:intencao-comercial"],
    "campos": { "canal": "whatsapp", "servico_interesse": "Professional Coaching", "score_sdr": 75 },
    "score": 75
  },
  "robo": {
    "responder": true,
    "motivo": "PRECO",
    "mensagens": ["...", "..."],
    "proximaPergunta": "Para qual data voce quer reservar?",
    "dadosFaltantes": ["data", "periodo", "pilotos", "experiencia", "nome", "contato"],
    "escalonamento": null,
    "followUp": { "agendar": true, "tentativa": 1, "emMinutos": 30, "maxTentativas": 3 },
    "silenciarBot": false,
    "foraDoHorarioComercial": false
  }
}
```

### 3.4 Como ligar no Kommo

1. **Salesbot** (um por canal) com o primeiro passo `Webhook` →
   `POST https://<backend>/api/sdr/avaliar`, enviando o payload da seção 3.2 com
   os dados já conhecidos do contato e do card.
2. Condicionais sobre a resposta:
   - `kommo.acao = criar_card` → criar card no pipeline com `kommo.estagioSugerido`,
     `kommo.campos` e `kommo.tags`;
   - `anexar_card` / `reabrir_card` → atualizar o card existente;
   - `somente_conversa` / `ignorar` → não tocar no pipeline.
   - `robo.responder = true` → enviar `robo.mensagens` na ordem.
   - `robo.escalonamento != null` → mover estágio, atribuir responsável, criar a
     tarefa com `tarefa.prazoMinutos` e colar `resumo` como nota.
   - `robo.silenciarBot = true` → marcar o card para o bot não responder mais.
   - `robo.followUp.agendar = true` → agendar disparo em `emMinutos`;
     `acaoFinal = marcar_perdido_sem_resposta` → fechar como perdido.
3. **Site → Kommo:** ao concluir a Etapa 1 e a Etapa 2, enviar os eventos
   `reserva_etapa1` e `reserva_etapa2` para o mesmo endpoint, com o `pitId`.
4. **Reservas paradas:** rotina diária envia `reserva_etapa1_parada` para as
   reservas com `etapa = 1` há mais de 24 h.

### 3.5 Onde mudar cada regra

| Quero mudar | Arquivo | Parâmetro |
|---|---|---|
| Limiar de criação de card | `lib/sdr/regras.js` | `LIMIAR_CARD`, `PESOS` |
| Palavras-chave de intenção/spam | `lib/sdr/regras.js` | `PALAVRAS` |
| Textos do robô | `lib/sdr/regras.js` | `MENSAGENS` |
| Perguntas de qualificação | `lib/sdr/regras.js` | `CAMPOS_QUALIFICACAO` |
| Horário comercial e SLAs | `lib/sdr/regras.js` | `HORARIO_COMERCIAL`, `SLA` |
| Cadência de follow-up | `lib/sdr/regras.js` | `FOLLOW_UP_MINUTOS` |
| Janela de reabertura de card | `lib/sdr/regras.js` | `JANELA_REABERTURA_DIAS` |
| Estágios do pipeline | `lib/sdr/regras.js` | `ESTAGIOS` |

Testes: `npx jest tests/api/sdr.regras.test.js tests/api/sdr.route.test.js`.
