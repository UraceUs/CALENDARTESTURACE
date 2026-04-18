# Calendar Project

Estrutura do projeto:

- `server.js`: backend HTTP + APIs
- `public/`: interface web
  - `public/Calendar.html`: cliente
  - `public/Admin.html`: painel admin
  - `public/admin/index.html`: atalho para `/admin/`
- `data/`: fallback local opcional (`STORAGE_MODE=local`)
  - `data/Reservation.json`
  - `data/Availability.json`

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
- `POST /api/reservas`
- `PUT /api/reservas/:id/move`
- `GET /api/disponibilidade`
- `POST /api/disponibilidade`
