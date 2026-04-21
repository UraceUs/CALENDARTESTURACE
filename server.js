const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
const publicFile = path.join(__dirname, 'public', 'Calendar.html');
const adminFile = path.join(__dirname, 'public', 'Admin.html');
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'calendar-urace-db';
const FIREBASE_SERVICE_ACCOUNT_FILE =
  process.env.FIREBASE_SERVICE_ACCOUNT_FILE || path.join(__dirname, 'firebase-service-account.json');
const MAX_BODY_SIZE = 100 * 1024;
const DEFAULT_MAX_RESERVATIONS_PER_PERIOD = 4;
const SMTP_HOST = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
const SMTP_PORT = Number.parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE =
  String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true' || SMTP_PORT === 465;
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = (process.env.SMTP_FROM || SMTP_USER || 'no-reply@calendar.local').trim();
const SMTP_REPLY_TO = (process.env.SMTP_REPLY_TO || '').trim();
const SUPPORT_NOTIFICATION_EMAIL = (process.env.SUPPORT_NOTIFICATION_EMAIL || 'support@urace.us').trim();
const ASANA_PERSONAL_ACCESS_TOKEN = (process.env.ASANA_PERSONAL_ACCESS_TOKEN || '').trim();
const ASANA_PROJECT_GID = (process.env.ASANA_PROJECT_GID || '').trim();
const ASANA_SECTION_GID = (process.env.ASANA_SECTION_GID || '').trim();
const ASANA_TASK_TEMPLATE_NAME =
  (process.env.ASANA_TASK_TEMPLATE_NAME || 'Session Setup [DRIVER + SERVICE]').trim();
const ASANA_TASK_TEMPLATE_GID = (process.env.ASANA_TASK_TEMPLATE_GID || '').trim();
const DOCUSIGN_WEBHOOK_URL = (process.env.DOCUSIGN_WEBHOOK_URL || '').trim();
const DOCUSIGN_WEBHOOK_TOKEN = (process.env.DOCUSIGN_WEBHOOK_TOKEN || '').trim();

const ASANA_CHECKLIST_SUBTASKS = [
  'Enviado Security Deposit?',
  'Signed waiver?',
  'Pago Security Deposit/Driver pass?',
  'Comprar Driver Pass?',
  'Enviar Driver Pass para o cliente',
  'Service Order',
  'Feedback about the driver/session',
  'Payment has been completed (invoice)?'
];

const ALLOWED_SERVICES = new Set([
  'Professional Coaching',
  'Summer Camp',
  'Trackside Support'
]);

const ALLOWED_PERIODS = new Set(['manha', 'tarde']);

const firestoreState = {
  enabled: false,
  reason: ''
};

let emailTransporter = null;

function initFirestore() {
  try {
    if (!admin.apps.length) {
      const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (rawServiceAccount) {
        const serviceAccount = JSON.parse(rawServiceAccount);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: serviceAccount.project_id || FIREBASE_PROJECT_ID
        });
      } else if (fs.existsSync(FIREBASE_SERVICE_ACCOUNT_FILE)) {
        const serviceAccount = JSON.parse(fs.readFileSync(FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8'));
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: serviceAccount.project_id || FIREBASE_PROJECT_ID
        });
      } else {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
          projectId: FIREBASE_PROJECT_ID
        });
      }
    }

    firestoreState.enabled = true;
    console.log('Storage mode: Firestore');
  } catch (error) {
    firestoreState.enabled = false;
    firestoreState.reason = error.message;
    console.error('Falha ao inicializar Firestore:', error.message);
  }
}

initFirestore();

function asIsoDateTime(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }

  return null;
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, code, message, details = []) {
  sendJson(res, { error: { code, message, details } }, status);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo não encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bodySize = 0;

    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (!body.trim()) {
        reject(new Error('EMPTY_BODY'));
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('INVALID_JSON'));
      }
    });

    req.on('error', () => reject(new Error('REQUEST_STREAM_ERROR')));
  });
}

function getDb() {
  return admin.firestore();
}

function ensureStorageReady() {
  return firestoreState.enabled;
}

function isCredentialError(error) {
  const message = (error && error.message) || '';
  return (
    message.includes('Could not load the default credentials') ||
    message.includes('credential implementation provided to initializeApp') ||
    message.includes('Failed to determine service account') ||
    message.includes('invalid_grant')
  );
}

function credentialHelpMessage() {
  return (
    'Credenciais do Firestore ausentes/inválidas. Configure GOOGLE_APPLICATION_CREDENTIALS, ' +
    'FIREBASE_SERVICE_ACCOUNT_JSON ou o arquivo firebase-service-account.json na raiz do projeto.'
  );
}

function isEmailConfigured() {
  return (
    Boolean(SMTP_HOST) &&
    Number.isInteger(SMTP_PORT) &&
    SMTP_PORT > 0 &&
    Boolean(SMTP_USER) &&
    Boolean(SMTP_PASS) &&
    Boolean(SMTP_FROM)
  );
}

function getMissingEmailConfigFields() {
  const missing = [];

  if (!Boolean(SMTP_HOST)) {
    missing.push('SMTP_HOST');
  }

  if (!Number.isInteger(SMTP_PORT) || SMTP_PORT <= 0) {
    missing.push('SMTP_PORT');
  }

  if (!Boolean(SMTP_USER)) {
    missing.push('SMTP_USER');
  }

  if (!Boolean(SMTP_PASS)) {
    missing.push('SMTP_PASS');
  }

  if (!Boolean(SMTP_FROM)) {
    missing.push('SMTP_FROM');
  }

  return missing;
}

function getEmailTransporter() {
  if (!isEmailConfigured()) {
    return null;
  }

  if (emailTransporter) {
    return emailTransporter;
  }

  emailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  return emailTransporter;
}

function formatDateBr(dateString) {
  if (!isValidDateString(dateString)) {
    return dateString;
  }

  const [year, month, day] = dateString.split('-');
  return `${day}/${month}/${year}`;
}

function periodLabel(periodo) {
  if (periodo === 'manha') {
    return 'Manha';
  }
  if (periodo === 'tarde') {
    return 'Tarde';
  }
  return periodo;
}

function buildReservaSummaryLines(reserva) {
  const formattedDate = formatDateBr(reserva.data);
  const label = periodLabel(reserva.periodo);
  const experienceDescription = normalizeText(reserva.experienceDescription) || '-';
  const serviceDatesForMonth = normalizeText(reserva.serviceDatesForMonth) || `${formattedDate} | ${label}`;

  return [
    `Piloto: ${reserva.nomePiloto}`,
    `Responsavel: ${reserva.responsavelPiloto}`,
    `Servico: ${reserva.servico}`,
    `Service Dates for this Month: ${serviceDatesForMonth}`,
    `Data: ${formattedDate}`,
    `Periodo: ${label}`,
    `E-mail: ${reserva.email}`,
    `Telefone: ${reserva.telefone}`,
    `Age: ${normalizeText(reserva.age) || '-'}`,
    `Height: ${normalizeText(reserva.height) || '-'}`,
    `Weight: ${normalizeText(reserva.weight) || '-'}`,
    `Waist: ${normalizeText(reserva.waist) || '-'}`,
    `Karting Experience: ${normalizeText(reserva.kartingExperience) || '-'}`,
    `Experience Description: ${experienceDescription}`
  ];
}

async function postJson(url, body, options = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('FETCH_NOT_AVAILABLE');
  }

  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    method: options.method || 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const responseBody = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const errorText = typeof responseBody === 'string'
      ? responseBody
      : JSON.stringify(responseBody);
    throw new Error(`HTTP_${response.status}: ${errorText}`);
  }

  return responseBody;
}

function isAsanaConfigured() {
  return Boolean(ASANA_PERSONAL_ACCESS_TOKEN) && Boolean(ASANA_PROJECT_GID);
}

function buildAsanaServiceDates(reserva) {
  return `${formatDateBr(reserva.data)} | ${periodLabel(reserva.periodo)}`;
}

function asanaProfileValue(value) {
  const normalized = normalizeText(value);
  return normalized || '-';
}

function buildAsanaTaskDescription(reserva) {
  return [
    `Service Dates for this Month: ${asanaProfileValue(buildAsanaServiceDates(reserva))}`,
    `Age: ${asanaProfileValue(reserva.age)}`,
    `Height: ${asanaProfileValue(reserva.height)}`,
    `Weight: ${asanaProfileValue(reserva.weight)}`,
    `Waist: ${asanaProfileValue(reserva.waist)}`,
    `Responsible: ${asanaProfileValue(reserva.responsavelPiloto)}`,
    `Email: ${asanaProfileValue(reserva.email)}`,
    `Phone: ${asanaProfileValue(reserva.telefone)}`,
    `Karting Experience: ${asanaProfileValue(reserva.kartingExperience)}`,
    `Experience Description: ${asanaProfileValue(reserva.experienceDescription)}`
  ].join('\n');
}

async function asanaRequest(pathname, method = 'GET', payload, query = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('FETCH_NOT_AVAILABLE');
  }

  const url = new URL(`https://app.asana.com/api/1.0${pathname}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const headers = {
    Authorization: `Bearer ${ASANA_PERSONAL_ACCESS_TOKEN}`,
    Accept: 'application/json'
  };

  const options = {
    method,
    headers
  };

  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify({ data: payload });
  }

  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const errorText = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`HTTP_${response.status}: ${errorText}`);
  }

  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'data')) {
    return body.data;
  }

  return body;
}

async function findAsanaTemplateGid() {
  if (ASANA_TASK_TEMPLATE_GID) {
    return ASANA_TASK_TEMPLATE_GID;
  }

  try {
    const data = await asanaRequest(`/projects/${ASANA_PROJECT_GID}/task_templates`, 'GET');
    const templates = Array.isArray(data) ? data : [];
    const targetName = ASANA_TASK_TEMPLATE_NAME.toLowerCase();
    const matched = templates.find(item =>
      item && typeof item.name === 'string' && item.name.trim().toLowerCase() === targetName
    );
    return matched && matched.gid ? matched.gid : '';
  } catch (error) {
    console.error('Falha ao buscar template no Asana:', error.message);
    return '';
  }
}

async function updateAsanaTaskDetails(taskGid, taskName, taskNotes) {
  await asanaRequest(`/tasks/${taskGid}`, 'PUT', {
    name: taskName,
    notes: taskNotes
  });
}

async function addAsanaTaskToProject(taskGid) {
  const payload = { project: ASANA_PROJECT_GID };
  if (ASANA_SECTION_GID) {
    payload.section = ASANA_SECTION_GID;
  }
  await asanaRequest(`/tasks/${taskGid}/addProject`, 'POST', payload);
}

function extractAsanaTaskGidFromTemplateResponse(responseData) {
  if (!responseData || typeof responseData !== 'object') {
    return '';
  }

  if (responseData.gid) {
    return responseData.gid;
  }

  if (responseData.task && responseData.task.gid) {
    return responseData.task.gid;
  }

  if (responseData.new_task && responseData.new_task.gid) {
    return responseData.new_task.gid;
  }

  return '';
}

async function instantiateAsanaTaskFromTemplate(templateGid, taskName, taskNotes) {
  if (!templateGid) {
    return { created: false, reason: 'ASANA_TEMPLATE_NOT_FOUND' };
  }

  try {
    const instantiated = await asanaRequest(
      `/task_templates/${templateGid}/instantiateTask`,
      'POST',
      { name: taskName }
    );

    const taskGid = extractAsanaTaskGidFromTemplateResponse(instantiated);
    if (!taskGid) {
      return { created: false, reason: 'ASANA_TEMPLATE_INSTANTIATE_NO_TASK' };
    }

    await updateAsanaTaskDetails(taskGid, taskName, taskNotes);
    await addAsanaTaskToProject(taskGid);

    return {
      created: true,
      taskGid,
      usedTemplate: true,
      templateGid
    };
  } catch (error) {
    console.error('Falha ao instanciar template no Asana:', error.message);
    return {
      created: false,
      reason: 'ASANA_TEMPLATE_INSTANTIATE_FAILED',
      error: error.message,
      templateGid
    };
  }
}

async function createAsanaTaskForReserva(reserva) {
  if (!isAsanaConfigured()) {
    return { created: false, reason: 'ASANA_NOT_CONFIGURED' };
  }

  const formattedDate = formatDateBr(reserva.data);
  const periodo = periodLabel(reserva.periodo);
  const taskName = `${reserva.servico} | ${reserva.nomePiloto} | ${formattedDate} ${periodo}`;
  const taskNotes = buildAsanaTaskDescription(reserva);
  const templateGid = await findAsanaTemplateGid();

  const instantiated = await instantiateAsanaTaskFromTemplate(templateGid, taskName, taskNotes);
  if (instantiated.created) {
    return {
      ...instantiated,
      taskName,
      taskNotes
    };
  }

  return {
    created: false,
    reason: instantiated.reason || 'ASANA_TEMPLATE_REQUIRED',
    error: instantiated.error || null,
    templateName: ASANA_TASK_TEMPLATE_NAME,
    templateGid: templateGid || null
  };
}

async function addAsanaComment(taskGid, text) {
  if (!taskGid) {
    return { added: false, reason: 'TASK_MISSING' };
  }

  try {
    await asanaRequest(`/tasks/${taskGid}/stories`, 'POST', { text });
    return { added: true };
  } catch (error) {
    console.error('Falha ao adicionar comentario no Asana:', error.message);
    return { added: false, reason: 'ASANA_COMMENT_FAILED', error: error.message };
  }
}

async function createAsanaSubtask(taskGid, name) {
  if (!taskGid) {
    return { created: false, reason: 'TASK_MISSING' };
  }

  try {
    const response = await asanaRequest(`/tasks/${taskGid}/subtasks`, 'POST', { name });
    const subtask = response && response.data ? response.data : {};
    return {
      created: true,
      subtaskGid: subtask.gid || null
    };
  } catch (error) {
    console.error('Falha ao criar subtask no Asana:', error.message);
    return { created: false, reason: 'ASANA_SUBTASK_FAILED', error: error.message };
  }
}

async function listAsanaSubtasks(taskGid) {
  if (!taskGid) {
    return { listed: false, reason: 'TASK_MISSING', subtasks: [] };
  }

  try {
    const data = await asanaRequest(`/tasks/${taskGid}/subtasks`, 'GET', undefined, {
      opt_fields: 'gid,name,completed'
    });

    return {
      listed: true,
      subtasks: Array.isArray(data) ? data : []
    };
  } catch (error) {
    console.error('Falha ao listar subtarefas no Asana:', error.message);
    return {
      listed: false,
      reason: 'ASANA_SUBTASK_LIST_FAILED',
      error: error.message,
      subtasks: []
    };
  }
}

async function ensureAsanaChecklistSubtasks(taskGid) {
  const listed = await listAsanaSubtasks(taskGid);
  const existing = listed.subtasks || [];
  const byName = {};
  const failures = [];
  const created = [];

  existing.forEach(item => {
    if (!item || !item.name) {
      return;
    }
    byName[item.name.toLowerCase()] = {
      gid: item.gid || null,
      name: item.name,
      completed: Boolean(item.completed)
    };
  });

  for (const expectedName of ASANA_CHECKLIST_SUBTASKS) {
    const key = expectedName.toLowerCase();
    if (byName[key]) {
      continue;
    }

    const createdSubtask = await createAsanaSubtask(taskGid, expectedName);
    if (!createdSubtask.created || !createdSubtask.subtaskGid) {
      failures.push({ name: expectedName, result: createdSubtask });
      continue;
    }

    byName[key] = {
      gid: createdSubtask.subtaskGid,
      name: expectedName,
      completed: false
    };
    created.push(expectedName);
  }

  return {
    synced: failures.length === 0,
    listed,
    created,
    failures,
    subtasksByName: byName
  };
}

async function completeAsanaTask(taskGid) {
  if (!taskGid) {
    return { completed: false, reason: 'TASK_MISSING' };
  }

  try {
    await asanaRequest(`/tasks/${taskGid}`, 'PUT', { completed: true });
    return { completed: true };
  } catch (error) {
    console.error('Falha ao concluir item no Asana:', error.message);
    return { completed: false, reason: 'ASANA_COMPLETE_FAILED', error: error.message };
  }
}

function isDocusignConfigured() {
  return Boolean(DOCUSIGN_WEBHOOK_URL);
}

async function triggerDocusignForReserva(reserva, asanaTask) {
  if (!isDocusignConfigured()) {
    return { triggered: false, reason: 'DOCUSIGN_NOT_CONFIGURED' };
  }

  const payload = {
    source: 'calendar-reserva-site',
    reserva,
    asanaTask,
    sentAt: new Date().toISOString()
  };

  const headers = {};
  if (DOCUSIGN_WEBHOOK_TOKEN) {
    headers.Authorization = `Bearer ${DOCUSIGN_WEBHOOK_TOKEN}`;
  }

  try {
    const response = await postJson(DOCUSIGN_WEBHOOK_URL, payload, { headers });
    const envelopeId = response && typeof response === 'object' ? response.envelopeId || null : null;

    return {
      triggered: true,
      envelopeId,
      response
    };
  } catch (error) {
    console.error('Falha ao acionar envio DocuSign:', error.message);
    return {
      triggered: false,
      reason: 'DOCUSIGN_TRIGGER_FAILED',
      error: error.message
    };
  }
}

async function syncAsanaDocusignChecklist(asanaResult, docusignResult) {
  if (!asanaResult || !asanaResult.created || !asanaResult.taskGid) {
    return { synced: false, reason: 'ASANA_TASK_MISSING' };
  }

  const checklist = await ensureAsanaChecklistSubtasks(asanaResult.taskGid);
  const result = { synced: checklist.synced, checklist };

  if (docusignResult && docusignResult.triggered) {
    const signedWaiver = checklist.subtasksByName['signed waiver?'];
    if (signedWaiver && signedWaiver.gid) {
      result.subtaskCompletion = await completeAsanaTask(signedWaiver.gid);
    }

    const envelopeMessage = docusignResult.envelopeId
      ? `DocuSign enviado com sucesso. Envelope: ${docusignResult.envelopeId}`
      : 'DocuSign enviado com sucesso.';
    result.comment = await addAsanaComment(asanaResult.taskGid, envelopeMessage);
    return result;
  }

  result.comment = await addAsanaComment(
    asanaResult.taskGid,
    'DocuSign nao foi enviado automaticamente. Verificar integracao e enviar manualmente.'
  );
  return result;
}

async function runPostReservaAutomation(reservaToSave, emailConfirmation) {
  const asanaResult = await createAsanaTaskForReserva(reservaToSave);
  const docusignResult = await triggerDocusignForReserva(reservaToSave, asanaResult);
  const checklistResult = await syncAsanaDocusignChecklist(asanaResult, docusignResult);

  return {
    trigger: 'SITE_RESERVA_CREATED',
    emailConfirmation,
    asana: asanaResult,
    docusign: docusignResult,
    checklist: checklistResult
  };
}

function buildReservationEmailHtml(reserva) {
  const formattedDate = formatDateBr(reserva.data);
  const label = periodLabel(reserva.periodo);
  const experienceDescription = normalizeText(reserva.experienceDescription) || '-';
  const serviceDatesForMonth = normalizeText(reserva.serviceDatesForMonth) || `${formattedDate} | ${label}`;

  return (
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d1d1d;line-height:1.5;">' +
      '<h2 style="margin:0 0 12px 0;">Confirmacao de reserva</h2>' +
      '<p>Recebemos sua reserva com sucesso.</p>' +
      '<p><strong>Piloto:</strong> ' + reserva.nomePiloto + '</p>' +
      '<p><strong>Responsavel:</strong> ' + reserva.responsavelPiloto + '</p>' +
      '<p><strong>Servico:</strong> ' + reserva.servico + '</p>' +
      '<p><strong>Service Dates for this Month:</strong> ' + serviceDatesForMonth + '</p>' +
      '<p><strong>Data:</strong> ' + formattedDate + '</p>' +
      '<p><strong>Periodo:</strong> ' + label + '</p>' +
      '<p><strong>E-mail:</strong> ' + reserva.email + '</p>' +
      '<p><strong>Telefone:</strong> ' + reserva.telefone + '</p>' +
      '<p><strong>Age:</strong> ' + (normalizeText(reserva.age) || '-') + '</p>' +
      '<p><strong>Height:</strong> ' + (normalizeText(reserva.height) || '-') + '</p>' +
      '<p><strong>Weight:</strong> ' + (normalizeText(reserva.weight) || '-') + '</p>' +
      '<p><strong>Waist:</strong> ' + (normalizeText(reserva.waist) || '-') + '</p>' +
      '<p><strong>Karting Experience:</strong> ' + (normalizeText(reserva.kartingExperience) || '-') + '</p>' +
      '<p><strong>Experience Description:</strong> ' + experienceDescription + '</p>' +
      '<p>Se precisar alterar a reserva, entre em contato com o suporte do calendario.</p>' +
    '</div>'
  );
}

async function sendReservaConfirmationEmail(reserva) {
  if (!reserva || !reserva.email) {
    return { sent: false, reason: 'EMAIL_MISSING' };
  }

  const transporter = getEmailTransporter();
  if (!transporter) {
    const missingFields = getMissingEmailConfigFields();
    console.warn(`Envio de e-mail desativado: configure ${missingFields.join(', ')}.`);
    return { sent: false, reason: 'EMAIL_NOT_CONFIGURED' };
  }

  const formattedDate = formatDateBr(reserva.data);
  const label = periodLabel(reserva.periodo);
  const subject = `Confirmacao da reserva - ${reserva.servico}`;
  const text = [
    'Recebemos sua reserva com sucesso.',
    '',
    'Resumo completo da reserva:',
    ...buildReservaSummaryLines(reserva),
    '',
    `Data formatada: ${formattedDate}`,
    `Periodo formatado: ${label}`
  ].join('\n');

  const recipients = [];
  const uniqueRecipientKeys = new Set();

  [reserva.email, SMTP_USER].forEach(value => {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized || uniqueRecipientKeys.has(normalized)) {
      return;
    }
    uniqueRecipientKeys.add(normalized);
    recipients.push(normalized);
  });

  const message = {
    from: SMTP_FROM,
    to: recipients.join(', '),
    subject,
    text,
    html: buildReservationEmailHtml(reserva)
  };

  if (SMTP_REPLY_TO) {
    message.replyTo = SMTP_REPLY_TO;
  }

  try {
    const info = await transporter.sendMail(message);
    return {
      sent: true,
      messageId: info && info.messageId ? info.messageId : null
    };
  } catch (error) {
    console.error('Falha ao enviar e-mail de confirmacao:', error.message);
    return {
      sent: false,
      reason: 'EMAIL_SEND_FAILED',
      error: error.message
    };
  }
}

async function sendSupportReservationNotificationEmail(reserva) {
  if (!reserva) {
    return { sent: false, reason: 'RESERVA_MISSING' };
  }

  const transporter = getEmailTransporter();
  if (!transporter) {
    return { sent: false, reason: 'EMAIL_NOT_CONFIGURED' };
  }

  const supportEmail = normalizeText(SUPPORT_NOTIFICATION_EMAIL).toLowerCase();
  if (!supportEmail) {
    return { sent: false, reason: 'SUPPORT_EMAIL_MISSING' };
  }

  const driverName = normalizeText(reserva.nomePiloto) || 'Driver sem nome';
  const subject = `Nova Reserva - ${driverName}`;
  const summaryLines = buildReservaSummaryLines(reserva);
  const text = [
    'Nova reserva recebida no painel do cliente.',
    '',
    ...summaryLines
  ].join('\n');

  const htmlSummary = summaryLines
    .map(line => `<p style="margin:4px 0;">${line}</p>`)
    .join('');

  const message = {
    from: SMTP_FROM,
    to: supportEmail,
    subject,
    text,
    html:
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d1d1d;line-height:1.5;">' +
      '<h2 style="margin:0 0 12px 0;">Nova reserva recebida</h2>' +
      htmlSummary +
      '</div>'
  };

  if (SMTP_REPLY_TO) {
    message.replyTo = SMTP_REPLY_TO;
  }

  try {
    const info = await transporter.sendMail(message);
    return {
      sent: true,
      messageId: info && info.messageId ? info.messageId : null
    };
  } catch (error) {
    console.error('Falha ao enviar notificacao de nova reserva para suporte:', error.message);
    return {
      sent: false,
      reason: 'SUPPORT_NOTIFICATION_SEND_FAILED',
      error: error.message
    };
  }
}

async function readReservas() {
  const snapshot = await getDb().collection('reservas').get();
  const reservas = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    const nomePiloto = data.nomePiloto || data.nome || '';
    const responsavelPiloto = data.responsavelPiloto || data.nomeResponsavel || data.responsavel || '';

    reservas.push({
      id: doc.id,
      nome: nomePiloto,
      nomePiloto,
      responsavelPiloto,
      servico: data.servico || '',
      data: data.data || '',
      periodo: data.periodo || '',
      email: data.email || '',
      telefone: data.telefone || '',
      serviceDatesForMonth: data.serviceDatesForMonth || '',
      age: data.age || '',
      height: data.height || '',
      weight: data.weight || '',
      waist: data.waist || '',
      kartingExperience: data.kartingExperience || '',
      experienceDescription: data.experienceDescription || data.descrevaSuaExperiencia || '',
      createdAt: asIsoDateTime(data.createdAt) || asIsoDateTime(data.created_at),
      movedAt: asIsoDateTime(data.movedAt) || null
    });
  });

  reservas.sort((a, b) => {
    const dateCompare = String(a.data).localeCompare(String(b.data));
    if (dateCompare !== 0) {
      return dateCompare;
    }
    return String(a.periodo).localeCompare(String(b.periodo));
  });

  return reservas;
}

async function readDisponibilidade() {
  const snapshot = await getDb().collection('disponibilidade').get();
  const data = [];
  snapshot.forEach(doc => {
    const item = doc.data() || {};
    if (item.data && item.periodo) {
      data.push({ data: item.data, periodo: item.periodo });
    }
  });
  return data;
}

async function readCapacidades() {
  const snapshot = await getDb().collection('capacidade').get();
  const data = [];
  snapshot.forEach(doc => {
    const item = doc.data() || {};
    const vagas = Number(item.vagas);
    if (item.data && item.periodo && Number.isInteger(vagas) && vagas > 0) {
      data.push({ data: item.data, periodo: item.periodo, vagas });
    }
  });
  return data;
}

async function createReserva(reserva) {
  const ref = await getDb().collection('reservas').add({
    ...reserva,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  const snapshot = await ref.get();
  const data = snapshot.data() || {};

  return {
    id: snapshot.id,
    ...reserva,
    createdAt: asIsoDateTime(data.createdAt) || new Date().toISOString(),
    movedAt: null
  };
}

async function moveReservaById(id, data, periodo) {
  const ref = getDb().collection('reservas').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    return null;
  }

  await ref.update({
    data,
    periodo,
    movedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  const updatedSnapshot = await ref.get();
  const updated = updatedSnapshot.data() || {};

  return {
    id: updatedSnapshot.id,
    nome: updated.nomePiloto || updated.nome || '',
    nomePiloto: updated.nomePiloto || updated.nome || '',
    responsavelPiloto: updated.responsavelPiloto || updated.nomeResponsavel || updated.responsavel || '',
    servico: updated.servico || '',
    data: updated.data || data,
    periodo: updated.periodo || periodo,
    email: updated.email || '',
    telefone: updated.telefone || '',
    serviceDatesForMonth: updated.serviceDatesForMonth || '',
    age: updated.age || '',
    height: updated.height || '',
    weight: updated.weight || '',
    waist: updated.waist || '',
    kartingExperience: updated.kartingExperience || '',
    experienceDescription: updated.experienceDescription || updated.descrevaSuaExperiencia || '',
    createdAt: asIsoDateTime(updated.createdAt) || null,
    movedAt: asIsoDateTime(updated.movedAt) || new Date().toISOString()
  };
}

async function deleteReservaById(id) {
  const ref = getDb().collection('reservas').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    return false;
  }

  await ref.delete();
  return true;
}

async function setDisponibilidade(bloqueio) {
  const id = `${bloqueio.data}_${bloqueio.periodo}`;
  const ref = getDb().collection('disponibilidade').doc(id);

  if (bloqueio.bloqueado) {
    await ref.set({
      data: bloqueio.data,
      periodo: bloqueio.periodo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } else {
    await ref.delete();
  }

  return readDisponibilidade();
}

async function setCapacidade(data, periodo, vagas) {
  const id = `${data}_${periodo}`;
  await getDb().collection('capacidade').doc(id).set({
    data,
    periodo,
    vagas,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { data, periodo, vagas };
}

function isValidDateString(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
}

function isValidEmailAddress(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const email = value.trim().toLowerCase();
  if (!email || email.length > 254) {
    return false;
  }

  const basicRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!basicRegex.test(email)) {
    return false;
  }

  const [localPart, domain] = email.split('@');
  if (!localPart || !domain) {
    return false;
  }

  if (localPart.length > 64 || domain.length > 253) {
    return false;
  }

  if (email.includes('..') || localPart.startsWith('.') || localPart.endsWith('.')) {
    return false;
  }

  if (domain.startsWith('-') || domain.endsWith('-') || domain.startsWith('.') || domain.endsWith('.')) {
    return false;
  }

  if (!/^[a-z0-9.-]+$/.test(domain)) {
    return false;
  }

  const domainParts = domain.split('.').filter(Boolean);
  if (domainParts.length < 2) {
    return false;
  }

  const tld = domainParts[domainParts.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) {
    return false;
  }

  return true;
}

function validateReserva(payload) {
  const errors = [];
  const phoneRegex = /^[0-9()+\-\s]{8,20}$/;

  const nomePiloto = normalizeText(payload.nomePiloto || payload.nome);
  const responsavelPiloto = normalizeText(
    payload.responsavelPiloto || payload.nomeResponsavel || payload.responsavel
  );
  const servico = normalizeText(payload.servico);
  const data = normalizeText(payload.data);
  const periodo = normalizeText(payload.periodo);
  const email = normalizeText(payload.email).toLowerCase();
  const telefone = normalizeText(payload.telefone);
  const serviceDatesForMonth = normalizeText(payload.serviceDatesForMonth || payload.serviceDates);
  const age = normalizeText(payload.age);
  const height = normalizeText(payload.height);
  const weight = normalizeText(payload.weight);
  const waist = normalizeText(payload.waist);
  const kartingExperience = normalizeText(payload.kartingExperience);
  const experienceDescription = normalizeText(
    payload.experienceDescription || payload.descrevaSuaExperiencia
  );
  const ageNumber = Number.parseInt(age, 10);

  if (!nomePiloto || nomePiloto.length < 2 || nomePiloto.length > 120) {
    errors.push('Campo nomePiloto deve ter entre 2 e 120 caracteres.');
  }

  if (!responsavelPiloto || responsavelPiloto.length < 2 || responsavelPiloto.length > 120) {
    errors.push('Campo responsavelPiloto deve ter entre 2 e 120 caracteres.');
  }

  if (!ALLOWED_SERVICES.has(servico)) {
    errors.push('Campo servico invalido.');
  }

  if (!isValidDateString(data)) {
    errors.push('Campo data deve estar no formato YYYY-MM-DD e ser valido.');
  }

  if (!ALLOWED_PERIODS.has(periodo)) {
    errors.push('Campo periodo deve ser manha ou tarde.');
  }

  if (!isValidEmailAddress(email)) {
    errors.push('Campo email invalido.');
  }

  if (!phoneRegex.test(telefone)) {
    errors.push('Campo telefone invalido (8-20 caracteres).');
  }

  if (!Number.isInteger(ageNumber) || ageNumber < 1 || ageNumber > 120) {
    errors.push('Campo age deve ser inteiro entre 1 e 120.');
  }

  if (!height || height.length < 2 || height.length > 40) {
    errors.push('Campo height e obrigatorio (2-40 caracteres).');
  }

  if (!weight || weight.length < 2 || weight.length > 40) {
    errors.push('Campo weight e obrigatorio (2-40 caracteres).');
  }

  if (!waist || waist.length < 1 || waist.length > 40) {
    errors.push('Campo waist e obrigatorio (1-40 caracteres).');
  }

  if (!['Sim', 'Nao'].includes(kartingExperience)) {
    errors.push('Campo kartingExperience deve ser Sim ou Nao.');
  }

  if (kartingExperience === 'Sim' && (experienceDescription.length < 5 || experienceDescription.length > 500)) {
    errors.push('Campo experienceDescription deve ter entre 5 e 500 caracteres quando kartingExperience for Sim.');
  }

  return {
    errors,
    reserva: {
      nome: nomePiloto,
      nomePiloto,
      responsavelPiloto,
      servico,
      data,
      periodo,
      email,
      telefone,
      serviceDatesForMonth,
      age,
      height,
      weight,
      waist,
      kartingExperience,
      experienceDescription
    }
  };
}

function validateDisponibilidade(payload) {
  const date = normalizeText(payload.data);
  const period = normalizeText(payload.periodo);
  const blocked = payload.bloqueado;
  const errors = [];

  if (!isValidDateString(date)) {
    errors.push('Campo data deve estar no formato YYYY-MM-DD e ser valido.');
  }

  if (!(ALLOWED_PERIODS.has(period) || period === 'all')) {
    errors.push('Campo periodo deve ser manha, tarde ou all.');
  }

  if (typeof blocked !== 'boolean') {
    errors.push('Campo bloqueado deve ser booleano.');
  }

  return {
    errors,
    bloqueio: {
      data: date,
      periodo: period,
      bloqueado: blocked
    }
  };
}

function validateCapacidade(payload) {
  const date = normalizeText(payload.data);
  const period = normalizeText(payload.periodo);
  const quantity = normalizeInteger(payload.quantidade);
  const errors = [];

  if (!isValidDateString(date)) {
    errors.push('Campo data deve estar no formato YYYY-MM-DD e ser valido.');
  }

  if (!ALLOWED_PERIODS.has(period)) {
    errors.push('Campo periodo deve ser manha ou tarde.');
  }

  if (quantity === null || quantity < 1 || quantity > 20) {
    errors.push('Campo quantidade deve ser inteiro entre 1 e 20.');
  }

  return {
    errors,
    capacidade: {
      data: date,
      periodo: period,
      quantidade: quantity
    }
  };
}

function getCapacityForPeriod(capacidades, data, periodo) {
  const custom = capacidades.find(item => item && item.data === data && item.periodo === periodo);
  if (!custom) {
    return DEFAULT_MAX_RESERVATIONS_PER_PERIOD;
  }

  const vagas = Number(custom.vagas);
  if (!Number.isInteger(vagas) || vagas < 1) {
    return DEFAULT_MAX_RESERVATIONS_PER_PERIOD;
  }

  return vagas;
}

function countPeriodReservations(reservas, data, periodo) {
  return reservas.filter(
    reserva => reserva && reserva.data === data && reserva.periodo === periodo
  ).length;
}

function isBlocked(disponibilidade, data, periodo) {
  return disponibilidade.some(entry => {
    if (!entry || entry.data !== data) {
      return false;
    }
    return entry.periodo === 'all' || entry.periodo === periodo;
  });
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const moveMatch = url.pathname.match(/^\/api\/reservas\/([^/]+)\/move$/);
  const deleteMatch = url.pathname.match(/^\/api\/reservas\/([^/]+)$/);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/reservas') {
    if (req.method === 'GET') {
      if (!ensureStorageReady()) {
        sendError(
          res,
          500,
          'STORAGE_NOT_READY',
          `Firestore nao inicializado. ${firestoreState.reason || 'Verifique credenciais.'}`
        );
        return;
      }

      try {
        const data = await readReservas();
        sendJson(res, data);
      } catch (error) {
        if (isCredentialError(error)) {
          sendError(res, 500, 'STORAGE_NOT_READY', credentialHelpMessage());
          return;
        }
        sendError(res, 500, 'READ_ERROR', `Erro interno ao ler reservas. ${error.message}`);
      }
      return;
    }

    if (req.method === 'POST') {
      if (!ensureStorageReady()) {
        sendError(
          res,
          500,
          'STORAGE_NOT_READY',
          `Firestore nao inicializado. ${firestoreState.reason || 'Verifique credenciais.'}`
        );
        return;
      }

      try {
        if (!isEmailConfigured()) {
          const missingFields = getMissingEmailConfigFields();
          sendError(
            res,
            503,
            'EMAIL_SERVICE_NOT_CONFIGURED',
            `Servico de e-mail indisponivel. Configure: ${missingFields.join(', ')}.`
          );
          return;
        }

        const payload = await parseJsonBody(req);
        const { errors, reserva } = validateReserva(payload || {});
        if (errors.length > 0) {
          sendError(res, 400, 'VALIDATION_ERROR', 'Dados da reserva invalidos.', errors);
          return;
        }

        const [reservas, capacidades] = await Promise.all([readReservas(), readCapacidades()]);
        const disponibilidade = await readDisponibilidade();

        if (isBlocked(disponibilidade, reserva.data, reserva.periodo)) {
          sendError(
            res,
            409,
            'PERIOD_BLOCKED',
            'Este periodo foi bloqueado pelo administrador para esta data.'
          );
          return;
        }

        const periodCount = countPeriodReservations(reservas, reserva.data, reserva.periodo);
        const periodLimit = getCapacityForPeriod(capacidades, reserva.data, reserva.periodo);

        if (periodCount >= periodLimit) {
          sendError(
            res,
            409,
            'PERIOD_FULL',
            `Este periodo ja atingiu o limite de vagas para esta data (${periodLimit}).`
          );
          return;
        }

        const reservaToSave = await createReserva(reserva);
        const emailConfirmation = await sendReservaConfirmationEmail(reservaToSave);

        if (!emailConfirmation.sent) {
          try {
            await deleteReservaById(reservaToSave.id);
          } catch (rollbackError) {
            console.error('Falha ao desfazer reserva apos erro de e-mail:', rollbackError.message);
          }

          sendError(
            res,
            502,
            'EMAIL_SEND_FAILED',
            'Nao foi possivel enviar o e-mail de confirmacao. A reserva nao foi concluida.',
            [emailConfirmation.reason || 'UNKNOWN_EMAIL_ERROR']
          );
          return;
        }

        const supportNotification = await sendSupportReservationNotificationEmail(reservaToSave);
        if (!supportNotification.sent) {
          try {
            await deleteReservaById(reservaToSave.id);
          } catch (rollbackError) {
            console.error('Falha ao desfazer reserva apos erro de notificacao de suporte:', rollbackError.message);
          }

          sendError(
            res,
            502,
            'SUPPORT_NOTIFICATION_FAILED',
            'Nao foi possivel enviar a notificacao de nova reserva para o suporte. A reserva nao foi concluida.',
            [supportNotification.reason || 'UNKNOWN_SUPPORT_NOTIFICATION_ERROR']
          );
          return;
        }

        const automation = await runPostReservaAutomation(reservaToSave, emailConfirmation);
        sendJson(res, { reserva: reservaToSave, emailConfirmation, supportNotification, automation }, 201);
      } catch (error) {
        if (error.message === 'PAYLOAD_TOO_LARGE') {
          sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Corpo da requisicao muito grande.');
          return;
        }
        if (error.message === 'EMPTY_BODY') {
          sendError(res, 400, 'EMPTY_BODY', 'O corpo da requisicao nao pode estar vazio.');
          return;
        }
        if (error.message === 'INVALID_JSON') {
          sendError(res, 400, 'INVALID_JSON', 'JSON invalido no corpo da requisicao.');
          return;
        }
        if (isCredentialError(error)) {
          sendError(res, 500, 'STORAGE_NOT_READY', credentialHelpMessage());
          return;
        }
        sendError(res, 500, 'WRITE_ERROR', `Erro interno ao salvar reserva. ${error.message}`);
      }
      return;
    }

    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Metodo nao permitido para /api/reservas.');
    return;
  }

  if (moveMatch && req.method === 'PUT') {
    if (!ensureStorageReady()) {
      sendError(
        res,
        500,
        'STORAGE_NOT_READY',
        `Firestore nao inicializado. ${firestoreState.reason || 'Verifique credenciais.'}`
      );
      return;
    }

    const reservaId = decodeURIComponent(moveMatch[1]);

    try {
      const payload = await parseJsonBody(req);
      const data = normalizeText(payload.data);
      const periodo = normalizeText(payload.periodo);

      if (!isValidDateString(data) || !ALLOWED_PERIODS.has(periodo)) {
        sendError(
          res,
          400,
          'VALIDATION_ERROR',
          'Dados de movimentacao invalidos.',
          ['Campo data valido e campo periodo (manha/tarde) sao obrigatorios.']
        );
        return;
      }

      const [reservas, capacidades] = await Promise.all([readReservas(), readCapacidades()]);
      const targetReserva = reservas.find(item => item && item.id === reservaId);
      if (!targetReserva) {
        sendError(res, 404, 'NOT_FOUND', 'Reserva nao encontrada.');
        return;
      }

      const disponibilidade = await readDisponibilidade();
      if (isBlocked(disponibilidade, data, periodo)) {
        sendError(
          res,
          409,
          'PERIOD_BLOCKED',
          'Este periodo foi bloqueado pelo administrador para esta data.'
        );
        return;
      }

      const count = reservas.filter(item => {
        if (!item || item.id === targetReserva.id) {
          return false;
        }
        return item.data === data && item.periodo === periodo;
      }).length;

      const periodLimit = getCapacityForPeriod(capacidades, data, periodo);

      if (count >= periodLimit) {
        sendError(
          res,
          409,
          'PERIOD_FULL',
          `Este periodo ja atingiu o limite de vagas para esta data (${periodLimit}).`
        );
        return;
      }

      const updatedReserva = await moveReservaById(reservaId, data, periodo);
      if (!updatedReserva) {
        sendError(res, 404, 'NOT_FOUND', 'Reserva nao encontrada.');
        return;
      }

      sendJson(res, { reserva: updatedReserva }, 200);
    } catch (error) {
      if (error.message === 'PAYLOAD_TOO_LARGE') {
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Corpo da requisicao muito grande.');
        return;
      }
      if (error.message === 'EMPTY_BODY') {
        sendError(res, 400, 'EMPTY_BODY', 'O corpo da requisicao nao pode estar vazio.');
        return;
      }
      if (error.message === 'INVALID_JSON') {
        sendError(res, 400, 'INVALID_JSON', 'JSON invalido no corpo da requisicao.');
        return;
      }
      if (isCredentialError(error)) {
        sendError(res, 500, 'STORAGE_NOT_READY', credentialHelpMessage());
        return;
      }
      sendError(res, 500, 'WRITE_ERROR', `Erro interno ao salvar movimentacao da reserva. ${error.message}`);
    }

    return;
  }

  if (deleteMatch && req.method === 'DELETE') {
    if (!ensureStorageReady()) {
      sendError(
        res,
        500,
        'STORAGE_NOT_READY',
        `Firestore nao inicializado. ${firestoreState.reason || 'Verifique credenciais.'}`
      );
      return;
    }

    const reservaId = decodeURIComponent(deleteMatch[1]);

    try {
      const deleted = await deleteReservaById(reservaId);
      if (!deleted) {
        sendError(res, 404, 'NOT_FOUND', 'Reserva nao encontrada.');
        return;
      }

      sendJson(res, { deleted: true, id: reservaId }, 200);
    } catch (error) {
      if (isCredentialError(error)) {
        sendError(res, 500, 'STORAGE_NOT_READY', credentialHelpMessage());
        return;
      }

      sendError(res, 500, 'DELETE_ERROR', `Erro interno ao excluir reserva. ${error.message}`);
    }

    return;
  }

  if (url.pathname === '/api/disponibilidade') {
    if (req.method === 'GET') {
      if (!ensureStorageReady()) {
        sendError(
          res,
          500,
          'STORAGE_NOT_READY',
          `Firestore nao inicializado. ${firestoreState.reason || 'Verifique credenciais.'}`
        );
        return;
      }

      try {
        const data = await readDisponibilidade();
        sendJson(res, data);
      } catch (error) {
        if (isCredentialError(error)) {
          sendError(res, 500, 'STORAGE_NOT_READY', credentialHelpMessage());
          return;
        }
        sendError(res, 500, 'READ_AVAILABILITY_ERROR', `Erro interno ao ler disponibilidade. ${error.message}`);
      }
      return;
    }

    if (req.method === 'POST') {
      if (!ensureStorageReady()) {
        sendError(
          res,
          500,
          'STORAGE_NOT_READY',
          `Firestore nao inicializado. ${firestoreState.reason || 'Verifique credenciais.'}`
        );
        return;
      }

      try {
        const payload = await parseJsonBody(req);
        const { errors, bloqueio } = validateDisponibilidade(payload || {});
        if (errors.length > 0) {
          sendError(res, 400, 'VALIDATION_ERROR', 'Dados de disponibilidade invalidos.', errors);
          return;
        }

        const updated = await setDisponibilidade(bloqueio);

        sendJson(res, { disponibilidade: updated }, 200);
      } catch (error) {
        if (error.message === 'PAYLOAD_TOO_LARGE') {
          sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Corpo da requisicao muito grande.');
          return;
        }
        if (error.message === 'EMPTY_BODY') {
          sendError(res, 400, 'EMPTY_BODY', 'O corpo da requisicao nao pode estar vazio.');
          return;
        }
        if (error.message === 'INVALID_JSON') {
          sendError(res, 400, 'INVALID_JSON', 'JSON invalido no corpo da requisicao.');
          return;
        }
        if (isCredentialError(error)) {
          sendError(res, 500, 'STORAGE_NOT_READY', credentialHelpMessage());
          return;
        }

        sendError(res, 500, 'WRITE_AVAILABILITY_ERROR', `Erro interno ao salvar disponibilidade. ${error.message}`);
      }

      return;
    }

    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Metodo nao permitido para /api/disponibilidade.');
    return;
  }

  if (url.pathname === '/api/capacidade') {
    if (req.method === 'GET') {
      if (!ensureStorageReady()) {
        sendError(
          res,
          500,
          'STORAGE_NOT_READY',
          `Firestore nao inicializado. ${firestoreState.reason || 'Verifique credenciais.'}`
        );
        return;
      }

      try {
        const data = await readCapacidades();
        sendJson(res, data);
      } catch (error) {
        if (isCredentialError(error)) {
          sendError(res, 500, 'STORAGE_NOT_READY', credentialHelpMessage());
          return;
        }

        sendError(res, 500, 'READ_CAPACITY_ERROR', `Erro interno ao ler capacidade. ${error.message}`);
      }
      return;
    }

    if (req.method === 'POST') {
      if (!ensureStorageReady()) {
        sendError(
          res,
          500,
          'STORAGE_NOT_READY',
          `Firestore nao inicializado. ${firestoreState.reason || 'Verifique credenciais.'}`
        );
        return;
      }

      try {
        const payload = await parseJsonBody(req);
        const { errors, capacidade } = validateCapacidade(payload || {});
        if (errors.length > 0) {
          sendError(res, 400, 'VALIDATION_ERROR', 'Dados de capacidade invalidos.', errors);
          return;
        }

        const capacidades = await readCapacidades();
        const atual = getCapacityForPeriod(capacidades, capacidade.data, capacidade.periodo);
        const novaCapacidade = atual + capacidade.quantidade;

        await setCapacidade(capacidade.data, capacidade.periodo, novaCapacidade);
        const updated = await readCapacidades();

        sendJson(
          res,
          {
            capacidade: {
              data: capacidade.data,
              periodo: capacidade.periodo,
              vagas: novaCapacidade
            },
            capacidades: updated
          },
          200
        );
      } catch (error) {
        if (error.message === 'PAYLOAD_TOO_LARGE') {
          sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Corpo da requisicao muito grande.');
          return;
        }
        if (error.message === 'EMPTY_BODY') {
          sendError(res, 400, 'EMPTY_BODY', 'O corpo da requisicao nao pode estar vazio.');
          return;
        }
        if (error.message === 'INVALID_JSON') {
          sendError(res, 400, 'INVALID_JSON', 'JSON invalido no corpo da requisicao.');
          return;
        }
        if (isCredentialError(error)) {
          sendError(res, 500, 'STORAGE_NOT_READY', credentialHelpMessage());
          return;
        }

        sendError(res, 500, 'WRITE_CAPACITY_ERROR', `Erro interno ao salvar capacidade. ${error.message}`);
      }

      return;
    }

    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Metodo nao permitido para /api/capacidade.');
    return;
  }

  if (url.pathname === '/' || url.pathname === '/Calendar.html') {
    sendFile(res, publicFile, 'text/html; charset=utf-8');
    return;
  }

  if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/Admin.html') {
    sendFile(res, adminFile, 'text/html; charset=utf-8');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Não encontrado');
}

function createServer() {
  return http.createServer(requestHandler);
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

module.exports = {
  createServer,
  requestHandler
};
