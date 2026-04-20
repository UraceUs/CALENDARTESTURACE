# Calendar Project

Sistema de agendamento com duas interfaces:

- Cliente: consulta agenda e realiza reservas.
- Usuário administrador: gerencia disponibilidade e reservas.

## Estrutura do projeto

- `server.js`: backend HTTP + APIs
- `public/`: interface web
  - `public/Calendar.html`: cliente
  - `public/Admin.html`: painel admin
  - `public/admin/index.html`: atalho para `/admin/`
- `tests/`: testes automatizados (API e E2E)
- `docs/`: fluxos e documentacao operacional

## Funcionalidades por perfil

### Cliente (`/`)

- Visualizar calendário com dias disponíveis e já reservados.
- Selecionar data e período disponível para criar uma reserva.
- Enviar dados do agendamento para confirmação no backend.
- Receber feedback visual de sucesso/erro ao reservar.

Fluxo principal do cliente:

1. Abre a página inicial (`/`).
2. Escolhe a data no calendário.
3. Escolhe o período (ex.: manhã, tarde ou noite, conforme disponibilidade).
4. Confirma a reserva.
5. O sistema grava a reserva e atualiza a visualização.

### Usuário administrador (`/admin/`)

- Visualizar todas as reservas cadastradas.
- Definir ou atualizar disponibilidade por data/período.
- Mover reservas entre datas/horários quando necessário.
- Acompanhar o estado geral da agenda para evitar conflitos.

Fluxo principal do administrador:

1. Abre o painel admin (`/admin/`).
2. Consulta reservas existentes.
3. Ajusta disponibilidade (abrindo/fechando períodos).
4. Se necessário, move reservas para outro horário.
5. Confirma alterações para persistir no backend.

## Storage no backend

O backend usa **Firestore de forma obrigatoria**.

Para autenticar no Firestore, configure uma das opções abaixo:

1. Arquivo de service account na raiz do projeto:
  - `firebase-service-account.json`
  - Exemplo de estrutura: `firebase-service-account.example.json`
2. Variável `FIREBASE_SERVICE_ACCOUNT_JSON` com o JSON completo da service account.
3. Variável `GOOGLE_APPLICATION_CREDENTIALS` apontando para o arquivo JSON da service account.

Opcional:

- `FIREBASE_PROJECT_ID` (default: `calendar-urace-db`)

Importante:

- O modo local foi desativado.
- Sem credenciais Firestore validas, a API nao inicia o armazenamento.

## Confirmação de reserva por e-mail

Ao criar uma reserva (`POST /api/reservas`), o backend tenta enviar um e-mail de confirmação para o mesmo e-mail informado no formulário.

Regra atual: a reserva so e concluida com sucesso quando o e-mail de confirmacao e enviado.
Se o envio falhar, a API retorna erro e a reserva nao e persistida.

Configure as variáveis SMTP no ambiente do servidor:

- `SMTP_HOST` (ex.: `smtp.gmail.com`)
- `SMTP_PORT` (ex.: `587`)
- `SMTP_SECURE` (`true` para SSL direto, geralmente porta 465; `false` para STARTTLS)
- `SMTP_USER` (usuário SMTP)
- `SMTP_PASS` (senha/app password SMTP)
- `SMTP_FROM` (remetente exibido; se ausente, usa `SMTP_USER`)
- `SMTP_REPLY_TO` (opcional)

Se SMTP nao estiver configurado, a API recusara novas reservas ate a configuracao ser corrigida.

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

## Como rodar

1. Instalar dependências:
  - `npm.cmd install`
2. Subir o servidor:
  - `node server.js`
3. Abrir no navegador:
  - Cliente: `http://localhost:3000/`
  - Admin: `http://localhost:3000/admin/`

## Publicacao no GitHub Pages

Quando o frontend roda no GitHub Pages (`*.github.io`), ele nao consegue acessar automaticamente `localhost:3000` do seu computador.

Nessa situacao, conecte um backend publicado via `apiBase`.

Para usar uma API backend publicada (Render, Railway, VPS etc.), abra a URL com o parametro `apiBase`:

- Cliente: `https://SEU_USUARIO.github.io/SEU_REPO/Calendar.html?apiBase=https://seu-backend.com`
- Admin: `https://SEU_USUARIO.github.io/SEU_REPO/Admin.html?apiBase=https://seu-backend.com`

O valor de `apiBase` valido fica salvo no navegador e sera reutilizado nas proximas visitas.
Sem backend conectado, cliente e admin exibem erro e nao persistem dados.

### Configuracao permanente de API no frontend

Para evitar usar `?apiBase=` em toda URL:

1. Publique o backend (ex.: Render).
2. Edite `public/runtime-config.js`:
  - `window.CALENDAR_API_BASE = 'https://SEU_BACKEND_PUBLICO';`
3. Publique novamente o frontend no GitHub Pages.

Com isso, `Calendar.html` e `Admin.html` passam a usar automaticamente a API publicada.

### Deploy de backend com Render

O repositório inclui `render.yaml` para criar o serviço backend Node.js.

1. No Render, crie um serviço usando Blueprint apontando para este repositório.
2. Preencha os secrets obrigatórios (`FIREBASE_SERVICE_ACCOUNT_JSON`, SMTP e demais integrações).
3. Após deploy, copie a URL pública do backend e configure em `public/runtime-config.js`.

## APIs

- `GET /api/reservas`
  - Lista todas as reservas atuais.
  - Usado por cliente e admin para renderizar o calendário.
- `POST /api/reservas`
  - Cria uma nova reserva.
  - Usado principalmente pela interface do cliente.
- `PUT /api/reservas/:id/move`
  - Move uma reserva existente para outra data/período.
  - Usado no painel administrador.
- `GET /api/disponibilidade`
  - Retorna os períodos disponíveis por data.
  - Usado para controlar o que o cliente pode selecionar.
- `POST /api/disponibilidade`
  - Cria ou atualiza disponibilidade.
  - Usado no painel administrador.

## Observações importantes

- Os dados ficam persistidos no Firestore.
- O modo local em arquivo/`localStorage` nao e mais utilizado.

## Workflow visual do processo

- Veja o fluxo completo em `docs/workflows/reservation-automation-workflow.md`.
