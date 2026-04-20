# Workflow: Reserva -> Email -> Asana -> DocuSign

Este fluxo representa o que acontece hoje quando o usuario clica em `Enviar reserva`.

Arquivo Draw.io editavel: `docs/workflows/reservation-automation-workflow.drawio`.

## Visao Geral

```mermaid
flowchart TD
    A[Usuario envia reserva no site] --> B[Frontend valida campos obrigatorios]
    B -->|ok| C[POST /api/reservas]
    B -->|erro| B1[Exibe mensagem de validacao]

    C --> D[Backend valida payload]
    D -->|ok| E[Salva reserva]
    D -->|erro| D1[Retorna VALIDATION_ERROR]

    E --> F[Tenta enviar email de confirmacao SMTP]
    F -->|enviado| F1[emailConfirmation.sent=true]
    F -->|falhou/nao configurado| F2[emailConfirmation.sent=false]

    E --> G[Cria tarefa Asana via template Session Setup]
    G -->|ok| H[Preenche descricao com campos do driver]
    G -->|falha| G1[automation.asana.created=false]

    H --> I[Sincroniza subtarefas padrao]
    I --> J[Dispara webhook DocuSign]
    J -->|ok| K[Marca subtarefa Signed waiver? como concluida]
    J -->|falha| L[Comenta na tarefa para envio manual]

    F1 --> M[Retorna resposta API com status completo]
    F2 --> M
    K --> M
    L --> M
    G1 --> M

    M --> N[Frontend mostra feedback final ao usuario]
```

## Campos que alimentam a descricao do Asana

- Service Dates for this Month: data + periodo da reserva
- Age: age
- Height: height
- Weight: weight
- Waist: waist
- Responsible: responsavelPiloto
- Email: email
- Phone: telefone
- Karting Experience: kartingExperience (Sim/Nao)

## Subtarefas automatizadas

- Enviado Security Deposit?
- Signed waiver?
- Pago Security Deposit/Driver pass?
- Comprar Driver Pass?
- Enviar Driver Pass para o cliente
- Service Order
- Feedback about the driver/session
- Payment has been completed (invoice)?

## Resultado que voce deve observar na resposta da API

A chamada `POST /api/reservas` retorna:

- reserva
- emailConfirmation
- automation.asana
- automation.docusign
- automation.checklist

## Leitura rapida de status

- `emailConfirmation.sent=true`: email enviado
- `automation.asana.created=true`: tarefa criada no Asana
- `automation.docusign.triggered=true`: webhook DocuSign executado
- `automation.checklist.synced=true`: checklist de subtarefas sincronizado

## Onde isso esta no codigo

- Backend principal: `server.js`
- Frontend envio de reserva: `public/Calendar.html`
- Pipeline de feedback no cliente: `public/js/reservation/actions/submit-actions.js`
