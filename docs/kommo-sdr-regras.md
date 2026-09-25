# SDR Agent U-RACE — Regras Operacionais (Kommo + Robô Chat)

Este documento define **como o Kommo separa o que é lead do que não é** (dois
funis: Entrada e Comercial), **quando um card desce para o Comercial** e **como
o robô chat atua como SDR**: a quem responde, como responde e quando aciona um
humano.

As regras estão implementadas em `lib/sdr/` e expostas pelo backend em
`POST /api/sdr/avaliar`. Alterar política de atendimento = alterar
`lib/sdr/regras.js` (parâmetros, palavras-chave, textos, SLAs).

---

## Princípio fundamental

> **Todas as mensagens continuam chegando normalmente por todos os canais.**
> A Entrada recebe tudo; o Comercial só recebe lead.

- O inbox do Kommo (WhatsApp, Instagram, Messenger, Telegram, site, e-mail)
  continua recebendo e exibindo **100% das mensagens**.
- Tudo pode cair no funil **Entrada** (e-mails, códigos, notificações, "oi",
  spam). Ninguém do comercial trabalha nele.
- Um card **só desce para o funil Comercial** quando a interação cumpre pelo
  menos uma regra de entrada (seção 1.2).
- Nenhuma interação abre um segundo card para um contato que já tem card aberto.

---

## Parte 0 — Os dois funis

Com uma pessoa só no atendimento, o que funcionava "na mão" com o time todo
mexendo no Kommo não escala. A regra passa a ser: **o comercial só abre o funil
Comercial**, e ele só tem lead.

```
 Todos os canais ──► Funil ENTRADA (recebe tudo)
                      ├─ Triagem (novo contato)
                      ├─ Aguardando contexto (robô perguntou)   ◄─ "oi", áudio solto
                      ├─ Conversa sem sinal comercial          ◄─ "obrigado", "onde fica"
                      ├─ Automáticos (e-mails, códigos, notificações)
                      ├─ Ruído (spam, fornecedor, interno)
                      └─ Não contatar (opt-out)
                             │
                             │  regra de entrada cumprida (seção 1.2)
                             ▼
                     Funil COMERCIAL (só lead)
                      Novo lead → Em qualificação (bot) → Qualificado - humano
                      → Reserva Etapa 1 → Briefing Etapa 2 → Confirmada | Perdido
```

**Regras de movimentação:**

1. Contato novo sem sinal comercial fica na Entrada, na etapa que o motor indica
   em `kommo.destino.etapa`.
2. Quando o mesmo contato manda uma mensagem com sinal comercial, o card da
   Entrada **desce** para o Comercial (`promover_card`). Não nasce outro card.
3. Evento do site (Pit ID, Driver Briefing, formulário) e chamada perdida descem
   direto, na etapa certa do funil de reserva.
4. Lead que já está no Comercial **nunca volta** para a Entrada. Opt-out dentro
   do Comercial fecha o card como **Perdido**.
5. E-mail de sistema, código de verificação, newsletter e notificação de
   plataforma vão para **Automáticos** e o robô não responde. Remetente
   `no-reply`/`notifications`/`mailer-daemon` conta como automático mesmo com
   texto que pareça comercial. "Unsubscribe" no rodapé de newsletter não é
   opt-out.
6. O Salesbot precisa enviar `card.pipeline` (`Entrada` ou `Comercial`). Sem
   isso, o motor trata o card como Comercial (lado seguro: não duplica).

**No Kommo da U-RACE, nada é criado: as regras usam os funis que já existem**
(`KOMMO_MAPA` em `lib/sdr/regras.js`). A Entrada é o funil principal **Urace**
e o Comercial é o funil **Comercial** montado pela equipe.

| Destino do motor | Funil / etapa no Kommo |
|---|---|
| Entrada · Triagem | Urace · First Contact |
| Entrada · Aguardando contexto | Urace · conversation in progress |
| Entrada · Sem sinal comercial | Urace · Cold Leads |
| Entrada · Automáticos | Urace · Cold Leads + tag `nao_e_lead` |
| Entrada · Ruído | Urace · Suppliers + tag `nao_e_lead` |
| Entrada · Não contatar | Urace · perdido (143) + tag `opt_out` |
| Comercial · Novo lead / Em qualificação | Comercial · ENTRADA |
| Comercial · Qualificado - humano | Comercial · ATENDIMENTO |
| Comercial · Reserva Etapa 1 (Pit ID) | Comercial · PROPOSTA |
| Comercial · Briefing Etapa 2 | Comercial · FECHAMENTO |
| Comercial · Reserva confirmada | Comercial · ganho (142) |
| Comercial · Perdido | Comercial · PERDIDO / NÃO QUALIFICADO |

QUALIFICADO e STAND BY ficam só para a equipe (o robô não coloca card lá).
As tags `nao_e_lead` e `opt_out` seguem a convenção que a equipe já usa.

**O que o executor não toca:** etapas do fluxo antigo no funil Urace (Hot Leads,
Closing the sale, Follow Up, etc.), cards em *Incoming leads* ainda não aceitos e
qualquer card dos outros funis (Contact list, Emails, Pós Venda, Operacional
Vendas, Chase). Card perdido no Urace só volta se for para descer ao Comercial.

**Pendência na conta:** o funil Comercial tem duas etapas chamadas
`FECHAMENTO` (ordens 70 e 80). O executor usa a primeira; renomear ou apagar a
segunda.

---

## Parte 1 — Regras de entrada no Kommo

### 1.1 Ações possíveis da triagem

| Ação | Significado |
|---|---|
| `ignorar` | Fica na Entrada (Ruído) e não recebe resposta automática. |
| `somente_conversa` | Fica na Entrada; **não desce** para o Comercial. |
| `criar_card` | Contato sem card nenhum: cria direto no Comercial. |
| `promover_card` | Card que estava na Entrada **desce** para o Comercial. |
| `anexar_card` | Registra no card já aberto no Comercial (nunca duplica). |
| `reabrir_card` | Card fechado recente volta ao Comercial. |

Em toda resposta, `kommo.destino = { pipeline, etapa, mover }` diz onde o card
tem que ficar. `mover = false` significa "não mexa no card".

### 1.2 O que **desce para o Comercial**

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

### 1.3 O que **fica na Entrada**

| # | Situação | Motivo (código) | Tratamento |
|---|---|---|---|
| 1 | Contato interno / número de teste da equipe | `CONTATO_INTERNO` | `ignorar` |
| 2 | Grupo ou lista de transmissão | `GRUPO_OU_TRANSMISSAO` | `ignorar` |
| 3 | E-mail automático, código de verificação, newsletter, notificação de plataforma | `MENSAGEM_AUTOMATICA` | Etapa Automáticos, sem resposta |
| 3b | Spam, fornecedor, agência, currículo, empréstimo | `SPAM_OU_OFERTA` | Conversa + tag `sdr:spam` |
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

1. Card **aberto no Comercial** para o contato → sempre `anexar_card`.
2. Card **na Entrada** + sinal comercial → `promover_card` (o mesmo card desce).
3. Card do Comercial **fechado há ≤ 30 dias** + novo sinal comercial →
   `reabrir_card` (tag `sdr:reaberto`).
4. Card do Comercial fechado há **> 30 dias** → card novo (novo ciclo de compra).

### 1.6 Etapas dos dois funis

**Funil Entrada** — ninguém do comercial trabalha aqui; revisão semanal rápida.

| Etapa | O que cai | Dono |
|---|---|---|
| Triagem (novo contato) | contato novo ainda não classificado | Robô |
| Aguardando contexto (robô perguntou) | "oi", áudio/foto sem texto | Robô |
| Conversa sem sinal comercial | "obrigado", pergunta operacional solta | Robô |
| Automáticos (e-mails, códigos, notificações) | e-mail de sistema, código, newsletter | — |
| Ruído (spam, fornecedor, interno) | spam, fornecedor, currículo, grupo, interno | — |
| Não contatar (opt-out) | pediu para não receber mensagens | — |

**Funil Comercial** — só lead.

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

**Ordem de qualificação (SDR)** — experiência decide o roteamento, origem decide
o produto, e só então vem o resto (modelo herdado do projeto Chase):

1. **Experiência**, classificação A/B/C/D
   (A nunca andou · B kart de aluguel · C já correu · D compete atualmente)
2. **Origem** — local de Orlando ou viajante
3. Serviço (Professional Coaching / Summer Camp / Trackside Support)
4. Data desejada
5. Período (manhã / tarde)
6. Quantidade de pilotos
7. Nome completo
8. E-mail de contato

O lead pode responder a letra ou descrever em prosa; o robô classifica sozinho
nos dois casos. **Nunca falar de valor antes da classificação registrada** — o
programa, e o preço, mudam com o nível do piloto.

**Lead que já conversou nunca recebe a abertura de novo.** Reapresentar o menu a
quem já respondeu é como o cliente aprende que ninguém escutou.

**Frases proibidas** (`NUNCA_DIZER`, verificadas no envio e nos testes): cada uma
custou um incidente real.

| Nunca dizer | Porque |
|---|---|
| "all-inclusive" / "tudo incluso" | driver pass e pit pass são pagos direto à pista |
| "come by" / "passe por aqui" / "apareça quando quiser" | todo serviço é por agendamento |
| "reserva confirmada" / "está reservado" antes do pagamento | reserva só vale com pagamento compensado |
| "vandalismo" | o depósito se explica de forma simples e neutra |
| "é só um test drive" | nunca diminuir o programa de entrada |
| "garanto sua vaga" | vaga, equipamento e resultado não são prometidos pelo robô |

Sem emoji e sem travessão nas mensagens ao lead (o travessão denuncia texto de IA);
o motor remove os dois antes de enviar.

**Cadência de follow-up** (decisão C11 do Chase): +2 h → +24 h → +3 dias → +7 dias,
depois fecha como `Perdido` por falta de resposta. Quando o que foi enviado é um
link de programa/calendário, a trilha é +10 min → +24 h → +3 dias → +7 dias.
Nunca duas trilhas no mesmo lead: resposta do lead ou escalonamento mata a trilha
na hora.

**Horário:** o robô responde 24/7. Fora da janela de atendimento humano, avisa que
uma pessoa responde no próximo horário útil e a tarefa do humano já nasce com
prazo a partir da abertura. O fuso é o de Orlando (`America/New_York`), com
horário de verão calculado, não offset fixo.

> ⚠️ **Os horários estão pendentes de confirmação.** A janela configurada
> (quarta a domingo, 9h–18h de Orlando) veio do arquivo do projeto Chase, e pela
> decisão D-2026-08-31 aquele material não vale como regra até ser reconfirmado.
> Há ainda um conflito conhecido: o horário de **operação da pista** confirmado
> por Italo em atendimento real foi **quarta a domingo, 8h–13h**. Confirme os dois
> (atendimento humano e operação) antes de publicar o robô — `descreverRegras()`
> devolve `confirmacaoPendente: true` enquanto isso não for feito.

### 2.4 Quando e como o robô aciona um humano

**Gatilhos de escalonamento:**

| Motivo | Prioridade | SLA da tarefa |
|---|---|---|
| `SINAL_CONVERSAO` — lead disse que quer avançar | Alta | 5 min úteis |
| `PILOTO_COMPETIDOR` — classificação D (compete hoje) | Alta | 5 min úteis |
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
2. Atribui ao **responsável único** (`responsavel_unico`): com uma pessoa no
   comercial não há rodízio. Só prioridade **alta** interrompe
   (`escalonamento.interromper = true`); média entra na fila de tarefas.
3. Cria **tarefa** com prazo conforme o SLA (fora do horário, contado da abertura).
4. Adiciona **nota estruturada** com o resumo: canal, contato, serviço, data,
   período, pilotos, experiência, Pit ID, score, intenções e última mensagem.
5. Aplica tags `sdr:handoff` e `handoff:<motivo>`.
6. Notifica o responsável e o grupo comercial.
7. **Silencia o robô** naquele card — a conversa passa a ser da pessoa.

**Lead que sinaliza conversão nunca espera atrás de pergunta de formulário.**
"Let's do it", "quando ele começa", "me manda o link" → escala na mesma resposta,
com o que falta declarado no briefing (`dadosFaltantes`). Piloto que compete
(classificação D) vai direto para o time, sem qualificação e sem pedir visita ao
site.

**Primeiro aviso não tem cooldown; o teto vale só para os re-alertas:** até 4
re-alertas, depois vira tarefa no Kommo. Lead escalado que manda mensagem
substantiva gera reaviso imediato.

**A notificação ao humano sai fora do caminho da resposta ao lead**
(`notificacaoAssincrona: true`). Avisar humanos de forma bloqueante consumia a
janela de ~58 s do Salesbot do Kommo e deixava o lead sem resposta.

**SLAs gerais:** primeira resposta do robô em até 30 s; notificação ao humano
disparada em até 10 s, fora do caminho da resposta; handoff registrado em até
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
    "pipeline": "Comercial",
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
  "versaoRegras": "2.0.0",
  "kommo": {
    "acao": "criar_card",
    "criarCard": true,
    "atualizaCard": true,
    "entraNoComercial": true,
    "destino": { "pipeline": "Comercial", "etapa": "Em qualificacao (bot)", "mover": true },
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
   - `kommo.destino.mover = true` → colocar o card em `destino.pipeline` /
     `destino.etapa` (é isso que faz o card **descer** da Entrada para o
     Comercial), com `kommo.campos` e `kommo.tags`;
   - `kommo.destino.mover = false` → não mexer no card;
   - `kommo.acao` diz o porquê (`criar_card`, `promover_card`, `anexar_card`,
     `reabrir_card`, `somente_conversa`, `ignorar`) e vai como nota/tag.
   - `robo.responder = true` → enviar `robo.mensagens` na ordem.
   - `robo.escalonamento != null` → mover estágio, atribuir responsável, criar a
     tarefa com `tarefa.prazoMinutos` e colar `resumo` como nota.
   - `robo.silenciarBot = true` → marcar o card para o bot não responder mais.
   - `robo.followUp.agendar = true` → agendar disparo em `emMinutos`;
     `acaoFinal = marcar_perdido_sem_resposta` → fechar como perdido.
> **HTTP 200/202 nunca prova entrega.** O Kommo devolve 202 e não renderiza nada
> no chat quando o modo de exibição do Salesbot está errado. Só confirmação
> visual no chat do lead + log contam como entrega; trate `sent=true` como
> "aceito para envio", não como "entregue".

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
| Cadência de follow-up | `lib/sdr/regras.js` | `FOLLOW_UP_MINUTOS`, `FOLLOW_UP_POS_LINK_MINUTOS` |
| Frases proibidas | `lib/sdr/regras.js` | `NUNCA_DIZER` |
| Classificação A/B/C/D | `lib/sdr/regras.js` | `CLASSIFICACAO_EXPERIENCIA` |
| Teto de re-alertas | `lib/sdr/regras.js` | `MAX_REALERTAS` |
| Janela de reabertura de card | `lib/sdr/regras.js` | `JANELA_REABERTURA_DIAS` |
| Etapas do funil Comercial | `lib/sdr/regras.js` | `ESTAGIOS` |
| Etapas do funil Entrada | `lib/sdr/regras.js` | `ETAPAS_ENTRADA` |
| O que conta como e-mail automático | `lib/sdr/regras.js` | `PALAVRAS.automatico`, `REMETENTES_AUTOMATICOS` |
| Quem recebe o handoff | `lib/sdr/regras.js` | `ATENDIMENTO` |

Testes: `npx jest tests/api/sdr.regras.test.js tests/api/sdr.route.test.js tests/api/kommo.integracao.test.js`.

### 3.6 Aplicar no Kommo (executor automático)

O backend move os cards sozinho pela API do Kommo, sem depender de regra
montada à mão no Salesbot. O Salesbot fica só com as **respostas** ao lead
(`/api/sdr/avaliar`); a **movimentação** é do executor (`lib/kommo/`).

| Rota | Faz |
|---|---|
| `POST /api/kommo/estrutura` | Confere o `KOMMO_MAPA` contra os funis da conta (etapas faltando ou repetidas); cria um funil só se ele não existir; opcionalmente registra o webhook. Exige `Authorization: Bearer <SDR_WEBHOOK_TOKEN>`. |
| `POST /api/kommo/webhook?token=<KOMMO_WEBHOOK_TOKEN>` | Recebe "mensagem recebida" do Kommo, avalia e aplica: move a etapa (desce da Entrada para o Comercial), tags, nota e, no handoff, tarefa para o responsável. Responde na hora e processa em segundo plano. |

Por mensagem do lead, o executor lê o card, avalia com as mesmas regras e:

- move para `kommo.destino`, traduzido pelo `KOMMO_MAPA` para a etapa real
  (Parte 0);
- adiciona tags sem apagar as existentes (`tags_to_add`);
- escreve nota **só** quando o card entra no Comercial ou vai para humano;
- no handoff cria tarefa com o prazo do SLA para `KOMMO_RESPONSAVEL_ID` e aplica
  `sdr:bot-silenciado` (o robô para de responder naquele card);
- ignora mensagem enviada pela equipe, mensagem repetida e lead de funil que não
  seja Entrada/Comercial (funis antigos ficam intactos).

**Modo observação (padrão):** sem `KOMMO_MODO=aplicar`, o executor recebe as
mensagens, decide e **só registra no log** o que faria (`Kommo SDR: {"modo":"observar",...}`),
sem escrever nada no Kommo. Rodar assim alguns dias com leads reais, conferir as
decisões e só então mudar para `aplicar`.

**Passo a passo para ligar:**

1. **Kommo → Configurações → Integrações → Criar integração** (privada) →
   *Chaves e escopos* → gerar **token de longa duração**.
2. **Render → Environment** do backend:
   - `KOMMO_SUBDOMINIO` — ex.: `urace` (de `urace.kommo.com`);
   - `KOMMO_TOKEN` — o token do passo 1;
   - `KOMMO_WEBHOOK_TOKEN` — segredo aleatório que vai na URL do webhook;
   - `SDR_WEBHOOK_TOKEN` — segredo administrativo (também protege `/api/sdr/avaliar`);
   - `KOMMO_RESPONSAVEL_ID` — id do usuário do Kommo que recebe os handoffs;
   - `KOMMO_MODO` — deixar vazio (observar) na primeira fase; `aplicar` depois.
3. Fazer o merge deste PR (deploy do backend).
4. Conferir o mapa contra a conta, sem alterar nada (na conta atual deve vir
   `ok: true` e só a pendência do `FECHAMENTO` duplicado):
   ```bash
   curl -X POST https://<backend>/api/kommo/estrutura \
     -H "Authorization: Bearer $SDR_WEBHOOK_TOKEN" -H "Content-Type: application/json" -d '{}'
   ```
5. Registrar o webhook (funil só é criado se não existir; etapa nunca é
   acrescentada em funil existente):
   ```bash
   curl -X POST https://<backend>/api/kommo/estrutura \
     -H "Authorization: Bearer $SDR_WEBHOOK_TOKEN" -H "Content-Type: application/json" \
     -d '{"aplicar": true, "webhookUrl": "https://<backend>/api/kommo/webhook?token=<KOMMO_WEBHOOK_TOKEN>"}'
   ```
   Alternativa local: `KOMMO_SUBDOMINIO=... KOMMO_TOKEN=... node scripts/kommo-setup.js --aplicar --webhook "<url>"`.
6. No Kommo, conferir que **cada canal** (WhatsApp, Instagram, Messenger,
   Telegram, chat do site, e-mail) cai no funil **Urace**. Em *Integrações → Web hooks*,
   conferir que o webhook aparece com o evento de **mensagem recebida**; se o
   registro pela API não tiver pegado, cadastrar manualmente a mesma URL.
7. Teste de fumaça: de um número de teste, mandar "oi" (Urace ·
   conversation in progress) e depois "quanto custa?" (desce para Comercial ·
   ENTRADA, com nota `promover_card`). Em modo observação, conferir no log. Os logs do Render mostram uma
   linha `Kommo SDR:` por mensagem.

---

## Parte 4 — O que veio do projeto Chase

O Chase foi o agente de vendas da U-RACE (Kommo, Instagram e WhatsApp),
encerrado em 27/08/2026. As regras abaixo vieram do registro daquele projeto e
estão implementadas aqui porque cada uma corrigiu um incidente real:

| Regra | Incidente que a originou |
|---|---|
| Toda decisão produz uma resposta; o lead nunca fica mudo | lead escalado ficou sem resposta por um `return` |
| HTTP 200/202 não prova entrega | Kommo devolvia 202 sem renderizar nada no chat |
| Não reapresentar o menu a lead retornante | lead que respondeu "A" recebeu o menu inteiro 3 dias depois |
| Nunca dizer "come by" (serviço é 100% agendado) | resposta convidou o lead a aparecer sem hora marcada |
| Notificação ao humano fora do caminho da resposta | aviso bloqueante estourava a janela de ~58 s do Salesbot |
| Teto de re-alertas com queda para tarefa no Kommo | alarme repetindo sem limite, e o oposto: lead escalado sem reaviso |
| Escalar em vez de deduzir; não inventar dado | invariante de segurança do projeto |
| Sinal de conversão escala na hora, sem formulário | lead pronto para fechar ficou preso atrás de pergunta de cadastro |
| Classificação antes de qualquer valor | leads pediam preço antes de haver programa definido |

### Fatos que ainda precisam ser confirmados

Pela decisão **D-2026-08-31**, o material arquivado do Chase **não vale como
regra** até ser reescrito com fonte confirmada. Estes pontos estão no código
como parâmetro, marcados, e não como verdade:

| Ponto | Valor provisório | Pendência |
|---|---|---|
| Horário de atendimento humano | quarta a domingo, 9h–18h (Orlando) | confirmar dias e faixa |
| Horário de operação da pista | quarta a domingo, 8h–13h | confirmado por Italo em atendimento real, mas conflita com a janela acima |
| Portfólio de serviços | Professional Coaching, Summer Camp, Trackside Support (do sistema de reservas) | o portfólio comercial do Chase era 1-Day Arrive and Drive, Training Camp, Academy e Racing Team; decidir qual vale no funil |
| Idade mínima | não implementado | o Chase recusava por código abaixo de 4 anos (Baby Kart 4–7, demais 7+) |
| Taxas da pista e depósito | não implementado | driver pass e pit pass são pagos direto à pista e nunca entram no valor |
| Política de cancelamento | não implementado | taxa fixa registrada no rate card do Chase, a reconfirmar |

Enquanto esses pontos não forem confirmados, o robô não afirma nenhum deles ao
lead: ele escala.

---

## Parte 5 — Funil mínimo em 7 dias

Objetivo da semana: um funil que funcione com **uma pessoa** no atendimento.
Não é o funil final; é o mínimo que para de jogar lead cru no pipeline.

| Dia | Entrega | Quem | Pronto quando |
|---|---|---|---|
| 1 | Validar o mapa de etapas (Parte 0) com a empresa e resolver o `FECHAMENTO` duplicado | Nós + empresa | mapa aprovado |
| 1 | Validar este documento: horário de atendimento, portfólio do funil (Parte 4) | Nós | pendências da Parte 4 respondidas |
| 2 | Ligar o executor em **modo observação** (seção 3.6): token, variáveis no Render, webhook | Nós | log mostra a decisão de cada mensagem real |
| 2 | Salesbot com passo `Webhook` → `/api/sdr/avaliar` só para as respostas do robô | Empresa + nós | robô responde "oi" com a pergunta de classificação |
| 3 | Respostas do robô: saudação, preço (classificação antes do valor), agenda com **link do calendário** | Nós | lead recebe o link e a pergunta seguinte |
| 3 | Handoff: tarefa + nota de resumo + notificação para o responsável único | Empresa | teste "quero falar com alguém" gera tarefa em ≤ 5 min |
| 4 | Site → Kommo: eventos `reserva_etapa1` / `reserva_etapa2` com Pit ID | Nós | reserva de teste aparece na etapa certa |
| 4 | Revisar 2 dias de log do modo observação e virar para `KOMMO_MODO=aplicar` | Nós | decisões conferidas; card de teste desce sozinho |
| 5 | Follow-up (2 h, 1 dia, 3 dias, 7 dias) e fechamento como Perdido sem resposta | Empresa | lead de teste sem resposta recebe o 1º follow-up |
| 6–7 | Rodar com leads reais; revisar a Entrada uma vez por dia procurando lead que ficou para trás e ajustar palavras-chave | Nós | nenhum lead real parado na Entrada |

**Divisão com a empresa que configura o Kommo:** a empresa monta funis,
Salesbot, tarefas e notificações; a **lógica** (o que desce, o que o robô
responde, quando chama humano) mora em `lib/sdr/regras.js` e neste documento,
para que todos tenham o domínio dos bots e qualquer ajuste seja uma mudança
revisável, não um clique perdido no Kommo.

**Métrica da semana:** quantos cards chegaram ao Comercial, quantos eram lead de
verdade, quantos leads ficaram presos na Entrada e tempo até a primeira resposta
humana nos handoffs de prioridade alta.
