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
- `data/`: fallback local opcional (`STORAGE_MODE=local`)
  - `data/Reservation.json`
  - `data/Availability.json`

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

O backend usa **Firestore por padrão** (`STORAGE_MODE=firestore`).

Para autenticar no Firestore, configure uma das opções abaixo:

1. Arquivo de service account na raiz do projeto:
  - `firebase-service-account.json`
  - Exemplo de estrutura: `firebase-service-account.example.json`
2. Variável `FIREBASE_SERVICE_ACCOUNT_JSON` com o JSON completo da service account.
3. Variável `GOOGLE_APPLICATION_CREDENTIALS` apontando para o arquivo JSON da service account.

Opcional:

- `FIREBASE_PROJECT_ID` (default: `calendar-urace-db`)
- `STORAGE_MODE=local` para forçar persistência em arquivo JSON local.

## Como rodar

1. Instalar dependências:
  - `npm.cmd install`
2. Subir o servidor:
  - `node server.js`
3. Abrir no navegador:
  - Cliente: `http://localhost:3000/`
  - Admin: `http://localhost:3000/admin/`

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

- Se `STORAGE_MODE=firestore`, os dados ficam persistidos no Firestore.
- Se `STORAGE_MODE=local`, os dados ficam nos arquivos JSON dentro de `data/`.
- Em produção, prefira Firestore para maior confiabilidade e consistência.
