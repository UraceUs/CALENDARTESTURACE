# Calendar — U-RACE Booking System

Sistema de agendamento para karting profissional (U-RACE) com fluxo em duas etapas, painel administrativo e integrações com Firestore, e-mail, Asana e DocuSign.

## URLs de produção

| Interface | URL |
|---|---|
| Calendário (Etapa 1) | `https://uraceus.github.io/CALENDARTESTURACE/Calendar.html` |
| Driver Briefing (Etapa 2) | `https://uraceus.github.io/CALENDARTESTURACE/DriverBriefing.html` |
| Painel Admin | `https://uraceus.github.io/CALENDARTESTURACE/Admin.html` |
| Backend API | `https://calendar-backend-w6wm.onrender.com` |

---

## Estrutura do projeto

```
server.js                          # Backend Node.js (HTTP puro, sem framework)
public/
  Calendar.html                    # Etapa 1 — seleção de data/período/serviço + geração de Pit ID
  DriverBriefing.html              # Etapa 2 — preenchimento de dados do piloto
  Admin.html                       # Painel administrativo
  admin/index.html                 # Atalho para /admin/
  runtime-config.js                # Configura window.CALENDAR_API_BASE (API pública)
  js/
    reservation/actions/
      submit-actions.js            # Lógica de submissão do formulário (Etapa 1)
  img/                             # Imagens e ícones
tests/
  api/                             # Testes de API (Jest)
  e2e/                             # Testes E2E (Playwright)
```

---

## Fluxo completo de reserva

### Etapa 1 — Calendário (`Calendar.html`)

1. O cliente abre o calendário e visualiza os dias do mês atual.
2. Seleciona um **serviço**: Professional Coaching, Summer Camp ou Trackside Support.
3. Seleciona a **data** disponível no calendário.
4. Seleciona o **período** disponível (Manhã / Tarde).
5. Um **Pit ID** é gerado automaticamente (ex.: `PIT-S40K-RTK3VQ`).
   - O cliente pode clicar no botão de cópia ao lado do campo para copiar o Pit ID para a área de transferência.
   - O Pit ID fica vinculado à data, período e serviço ao concluir a reserva.
   - **Este código deve ser guardado** — é necessário para concluir a Etapa 2.
6. Ao clicar em **Reservar**, o sistema salva a reserva no Firestore com `etapa = 1`.

### Etapa 2 — Driver Briefing (`DriverBriefing.html`)

1. O piloto acessa a página do Driver Briefing.
2. Informa o **Pit ID** recebido na Etapa 1.
3. O sistema busca a reserva no backend via `GET /api/reservas/pit/:pitId`.
4. O piloto preenche os dados pessoais (nome, idade, altura, peso, cintura, contato, experiência etc.).
5. Ao confirmar, o backend atualiza a reserva para `etapa = 2` via `PATCH /api/reservas/pit/:pitId`.
6. Um **e-mail de confirmação** é enviado automaticamente para o e-mail informado.
7. Se o envio de e-mail falhar, o sistema indica o motivo mas **a reserva é salva normalmente**.

### Painel Admin (`Admin.html`)

- Visualiza todas as reservas cadastradas em uma tabela.
- Mostra etapa atual de cada reserva (1 ou 2).
- Botão **Reenviar Confirmação** por reserva: dispara novamente o e-mail de confirmação da Etapa 2.
- Exibe o motivo de erro caso o reenvio falhe.

---

## Sistema de Pit ID

O Pit ID é o identificador canônico de cada reserva no Firestore.

- **Formato:** `PIT-XXXX-XXXXXX` (letras maiúsculas + números, separados por hífen)
- **Gerado em:** `Calendar.html` no momento da seleção
- **Armazenado como:** chave do documento Firestore
- **Uso em Etapa 2:** o piloto informa o Pit ID para recuperar e completar sua reserva
- **Copiável:** botão de cópia ao lado do campo exibe ícone de check por 1,8 s após copiar

---

## Funcionalidades por perfil

### Cliente — Etapa 1 (`Calendar.html`)

- Calendário mensal com navegação por mês (Jan–Dez).
- Dias bloqueados (sem disponibilidade) exibidos em cinza.
- Seleção de serviço com ícones e cards visuais.
- Campo Pit ID com geração automática e botão de copiar.
- Feedback visual em tempo real (período lotado, serviço indisponível, erro de API etc.).

### Cliente — Etapa 2 (`DriverBriefing.html`)

- Busca de reserva por Pit ID.
- Preenchimento de dados do piloto.
- Confirmação com envio automático de e-mail.
- Exibe motivo detalhado caso o e-mail falhe.

### Usuário administrador (`Admin.html`)

- Tabela de todas as reservas com dados completos.
- Indicador de etapa por reserva.
- Reenvio de e-mail de confirmação por reserva individual.
- Feedback de erro no reenvio com timeout controlado (sem loading infinito).

---

## Storage no backend

O backend usa **Firestore** como único modo de armazenamento.

Para autenticar no Firestore, configure uma das opções abaixo:

1. Arquivo de service account na raiz: `firebase-service-account.json`
2. Variável de ambiente `FIREBASE_SERVICE_ACCOUNT_JSON` com o JSON completo da service account.
3. Variável `GOOGLE_APPLICATION_CREDENTIALS` apontando para o caminho do arquivo JSON.

Variável opcional:

- `FIREBASE_PROJECT_ID` (default: `calendar-urace-db`)

> Sem credenciais Firestore válidas, o backend recusa todas as requisições de dados.

---

## Confirmação de reserva por e-mail

O e-mail de confirmação é enviado na **Etapa 2** (após preenchimento do Driver Briefing).

**Comportamento atual:**
- Se o e-mail for enviado com sucesso: a reserva é atualizada para `etapa = 2` e o e-mail é confirmado na resposta.
- Se o e-mail falhar: a reserva **ainda é salva** como `etapa = 2`, mas a resposta indica `emailConfirmation.sent = false` com o motivo do erro.

### Variáveis de e-mail (Render / produção)

O backend suporta dois modos de autenticação, com a seguinte ordem de prioridade:

**Modo 1 — App Password (recomendado):**

| Variável | Obrigatório | Descrição |
|---|---|---|
| `SMTP_USER` | ✅ | Endereço de e-mail (ex.: `support@urace.us`) |
| `SMTP_PASS` | ✅ | App Password gerado no Google |
| `SMTP_HOST` | — | Default: `smtp.gmail.com` |
| `SMTP_PORT` | — | Default: `587` |
| `SMTP_SECURE` | — | `false` (587) ou `true` (465) |
| `EMAIL_AUTH_MODE` | — | `password` (forçar) ou automático |

**Modo 2 — OAuth2 (fallback):**

| Variável | Obrigatório | Descrição |
|---|---|---|
| `GMAIL_CLIENT_ID` | ✅ | Client ID do projeto Google Cloud |
| `GMAIL_CLIENT_SECRET` | ✅ | Client Secret |
| `GMAIL_REFRESH_TOKEN` | ✅ | Refresh token OAuth2 |
| `GMAIL_FROM` | ✅ | Endereço de envio |
| `SUPPORT_NOTIFICATION_EMAIL` | — | E-mail para notificações internas |

**Lógica de seleção:**
- Se `SMTP_USER` + `SMTP_PASS` estiverem definidos → usa App Password.
- Caso contrário → tenta OAuth2 com as variáveis `GMAIL_*`.

**Resiliência SMTP:**
- IPv4 forçado (`family: 4`, `dns.resolve4`).
- Fallback automático de porta: `587 → 465`.
- Fallback automático de host: `smtp.gmail.com → smtp-relay.gmail.com`.
- Retry em erros transientes.

> **Nota:** Em ambientes com egress SMTP bloqueado (ex.: Render free tier), o envio pode falhar com `Connection timeout`. Nesse caso, considere usar SendGrid ou Resend (envio via HTTPS).

---

## Automação: Asana + DocuSign após reserva

Ao clicar em `Enviar reserva`, após salvar no backend, o sistema executa este fluxo:

1. Criar tarefa no Asana (projeto U-RACE).
2. Acionar webhook para envio de DocuSign ao cliente.
3. Garantir as subtarefas operacionais padrão no Asana.
4. Marcar `Signed waiver?` como concluída quando o DocuSign for disparado com sucesso.

### Variáveis para Asana

- `ASANA_PERSONAL_ACCESS_TOKEN` (token pessoal da API Asana)
- `ASANA_PROJECT_GID` (GID do projeto U-RACE)
- `ASANA_SECTION_GID` (opcional, seção onde a tarefa será criada)
- `ASANA_TASK_TEMPLATE_NAME` (default: `Session Setup [DRIVER + SERVICE]`)
- `ASANA_TASK_TEMPLATE_GID` (opcional; se informado, força esse template direto)

O backend tenta instanciar a tarefa via template `Session Setup [DRIVER + SERVICE]`.

Descrição preenchida automaticamente na tarefa:

- `Service Dates for this Month:`
- `Age:`
- `Height:`
- `Weight:`
- `Waist:`
- `Responsible:`
- `Email:`
- `Phone:`
- `Karting Experience:`

Subtarefas automatizadas no Asana:

- `Enviado Security Deposit?`
- `Signed waiver?`
- `Pago Security Deposit/Driver pass?`
- `Comprar Driver Pass?`
- `Enviar Driver Pass para o cliente`
- `Service Order`
- `Feedback about the driver/session`
- `Payment has been completed (invoice)?`

### Variáveis para DocuSign (via webhook)

- `DOCUSIGN_WEBHOOK_URL` (endpoint que recebe os dados da reserva e dispara o DocuSign)
- `DOCUSIGN_WEBHOOK_TOKEN` (opcional, enviado como Bearer token no header Authorization)

Payload enviado ao webhook DocuSign:

```json
{
  "source": "calendar-reserva-site",
  "reserva": {
    "id": "...",
    "nomePiloto": "...",
    "responsavelPiloto": "...",
    "servico": "...",
    "data": "YYYY-MM-DD",
    "periodo": "manha|tarde",
    "email": "...",
    "telefone": "..."
  },
  "asanaTask": {
    "created": true,
    "taskGid": "..."
  },
  "sentAt": "ISO_DATE"
}
```

Se Asana/DocuSign não estiver configurado, a reserva continua sendo salva normalmente e o backend retorna o status de automação no JSON da resposta.

Campos opcionais aceitos no `POST /api/reservas` para preencher a descrição do Asana:

- `serviceDatesForMonth`
- `age`
- `height`
- `weight`
- `waist`
- `kartingExperience`

---

## Deploy

### Frontend — GitHub Pages

O frontend é servido automaticamente pela branch `main` a partir da pasta `public/`.

- Push na `main` → GitHub Actions faz deploy automático.
- A API base é configurada em `public/runtime-config.js`:
  ```js
  window.CALENDAR_API_BASE = 'https://calendar-backend-w6wm.onrender.com';
  ```
- Sem necessidade de `?apiBase=` na URL quando `runtime-config.js` estiver configurado.

### Backend — Render

O repositório inclui `render.yaml` para deploy via Blueprint no Render.

1. No Render, crie um serviço Node.js apontando para este repositório.
2. Configure as variáveis de ambiente obrigatórias (ver seção abaixo).
3. Após o deploy, a URL pública é `https://calendar-backend-w6wm.onrender.com`.

#### Variáveis de ambiente obrigatórias no Render

| Variável | Descrição |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | JSON completo da service account do Firestore |
| `SMTP_USER` | E-mail de envio (App Password mode) |
| `SMTP_PASS` | App Password do Google |
| `GMAIL_CLIENT_ID` | Client ID OAuth2 (fallback) |
| `GMAIL_CLIENT_SECRET` | Client Secret OAuth2 (fallback) |
| `GMAIL_REFRESH_TOKEN` | Refresh Token OAuth2 (fallback) |
| `GMAIL_FROM` | Endereço de envio OAuth2 |
| `SUPPORT_NOTIFICATION_EMAIL` | E-mail para notificações internas |

---

## APIs

### Saúde e diagnóstico

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/health` | Health check do servidor |
| `GET` | `/api/test-email` | Testa envio de e-mail e retorna diagnóstico SMTP detalhado |

### Reservas

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/reservas` | Lista todas as reservas (usado pelo calendário e admin) |
| `GET` | `/api/reservas/pit/:pitId` | Busca uma reserva pelo Pit ID (usado na Etapa 2) |
| `PATCH` | `/api/reservas/pit/:pitId` | Atualiza uma reserva pelo Pit ID — aceita `etapa=1` ou `etapa=2` |
| `POST` | `/api/reservas/:id/resend-confirmation` | Reenvia o e-mail de confirmação da Etapa 2 (usado pelo admin) |

### Disponibilidade e configuração

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/disponibilidade` | Retorna períodos disponíveis por data |
| `GET` | `/api/capacidade` | Retorna a capacidade configurada por período |
| `GET` | `/api/config/servicos` | Retorna serviços habilitados |
| `GET` | `/api/config/periodos` | Retorna períodos habilitados |

---

## Testes

```bash
npm test
```

- `tests/api/` — Testes de integração com Jest (rotas, Firestore mockado, e-mail mockado)
- `tests/e2e/` — Testes E2E com Playwright
- Cobertura atual: 10/10 testes de API passando

---

## Observações importantes

- Todos os dados ficam persistidos no Firestore (sem modo local).
- O Pit ID é a chave canônica do documento no Firestore.
- O reenvio de e-mail pelo admin usa `POST /api/reservas/:id/resend-confirmation` onde `:id` é o Pit ID.
- Timeouts de requisição no frontend evitam loading infinito em caso de lentidão do backend (Render free tier pode ter cold start de ~30 s).

## Workflow visual do processo

- Veja o fluxo completo em `docs/workflows/reservation-automation-workflow.md`.