const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const publicFile = path.join(__dirname, 'public', 'Calendar.html');
const adminFile = path.join(__dirname, 'public', 'Admin.html');
const reservaFile = path.join(__dirname, 'data', 'Reservation.json');
const disponibilidadeFile = path.join(__dirname, 'data', 'Availability.json');
const capacidadeFile = path.join(__dirname, 'data', 'Capacity.json');
const STORAGE_MODE = (process.env.STORAGE_MODE || 'firestore').toLowerCase();
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'calendar-urace-db';
const FIREBASE_SERVICE_ACCOUNT_FILE =
  process.env.FIREBASE_SERVICE_ACCOUNT_FILE || path.join(__dirname, 'firebase-service-account.json');
const MAX_BODY_SIZE = 100 * 1024;
const DEFAULT_MAX_RESERVATIONS_PER_PERIOD = 4;

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

function initFirestore() {
  if (STORAGE_MODE !== 'firestore') {
    firestoreState.reason = 'STORAGE_MODE=local';
    return;
  }

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

async function readLocalArray(filePath) {
  try {
    const data = await fs.promises.readFile(filePath, 'utf8');
    if (!data) {
      return [];
    }
    const json = JSON.parse(data);
    return Array.isArray(json) ? json : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeLocalArray(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getDb() {
  return admin.firestore();
}

function ensureStorageReady() {
  return STORAGE_MODE === 'local' || firestoreState.enabled;
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

async function readReservas() {
  if (STORAGE_MODE === 'local') {
    return readLocalArray(reservaFile);
  }

  const snapshot = await getDb().collection('reservas').get();
  const reservas = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    reservas.push({
      id: doc.id,
      nome: data.nome || '',
      servico: data.servico || '',
      data: data.data || '',
      periodo: data.periodo || '',
      email: data.email || '',
      telefone: data.telefone || '',
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
  if (STORAGE_MODE === 'local') {
    return readLocalArray(disponibilidadeFile);
  }

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
  if (STORAGE_MODE === 'local') {
    const capacidades = await readLocalArray(capacidadeFile);
    return capacidades.filter(item => {
      if (!item) {
        return false;
      }

      if (!isValidDateString(item.data) || !ALLOWED_PERIODS.has(item.periodo)) {
        return false;
      }

      const vagas = Number(item.vagas);
      return Number.isInteger(vagas) && vagas > 0;
    }).map(item => ({
      data: item.data,
      periodo: item.periodo,
      vagas: Number(item.vagas)
    }));
  }

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
  if (STORAGE_MODE === 'local') {
    const reservas = await readLocalArray(reservaFile);
    const reservaToSave = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...reserva,
      createdAt: new Date().toISOString()
    };
    reservas.push(reservaToSave);
    await writeLocalArray(reservaFile, reservas);
    return reservaToSave;
  }

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
  if (STORAGE_MODE === 'local') {
    const reservas = await readLocalArray(reservaFile);
    const targetIndex = reservas.findIndex(item => item && item.id === id);
    if (targetIndex === -1) {
      return null;
    }
    const updated = {
      ...reservas[targetIndex],
      data,
      periodo,
      movedAt: new Date().toISOString()
    };
    reservas[targetIndex] = updated;
    await writeLocalArray(reservaFile, reservas);
    return updated;
  }

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
    nome: updated.nome || '',
    servico: updated.servico || '',
    data: updated.data || data,
    periodo: updated.periodo || periodo,
    email: updated.email || '',
    telefone: updated.telefone || '',
    createdAt: asIsoDateTime(updated.createdAt) || null,
    movedAt: asIsoDateTime(updated.movedAt) || new Date().toISOString()
  };
}

async function deleteReservaById(id) {
  if (STORAGE_MODE === 'local') {
    const reservas = await readLocalArray(reservaFile);
    const targetIndex = reservas.findIndex(item => item && item.id === id);
    if (targetIndex === -1) {
      return false;
    }
    reservas.splice(targetIndex, 1);
    await writeLocalArray(reservaFile, reservas);
    return true;
  }

  const ref = getDb().collection('reservas').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    return false;
  }

  await ref.delete();
  return true;
}

async function setDisponibilidade(bloqueio) {
  if (STORAGE_MODE === 'local') {
    const disponibilidade = await readLocalArray(disponibilidadeFile);
    return toggleDisponibilidade(disponibilidade, bloqueio);
  }

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
  if (STORAGE_MODE === 'local') {
    const capacidades = await readLocalArray(capacidadeFile);
    const targetIndex = capacidades.findIndex(
      item => item && item.data === data && item.periodo === periodo
    );

    if (targetIndex === -1) {
      capacidades.push({ data, periodo, vagas });
    } else {
      capacidades[targetIndex] = { data, periodo, vagas };
    }

    await writeLocalArray(capacidadeFile, capacidades);
    return { data, periodo, vagas };
  }

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

function validateReserva(payload) {
  const errors = [];
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phoneRegex = /^[0-9()+\-\s]{8,20}$/;

  const nome = normalizeText(payload.nome);
  const servico = normalizeText(payload.servico);
  const data = normalizeText(payload.data);
  const periodo = normalizeText(payload.periodo);
  const email = normalizeText(payload.email).toLowerCase();
  const telefone = normalizeText(payload.telefone);

  if (!nome || nome.length < 2 || nome.length > 120) {
    errors.push('Campo nome deve ter entre 2 e 120 caracteres.');
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

  if (!emailRegex.test(email)) {
    errors.push('Campo email invalido.');
  }

  if (!phoneRegex.test(telefone)) {
    errors.push('Campo telefone invalido (8-20 caracteres).');
  }

  return {
    errors,
    reserva: {
      nome,
      servico,
      data,
      periodo,
      email,
      telefone
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

function toggleDisponibilidade(disponibilidade, bloqueio) {
  const targetIndex = disponibilidade.findIndex(
    item => item && item.data === bloqueio.data && item.periodo === bloqueio.periodo
  );

  if (bloqueio.bloqueado) {
    if (targetIndex === -1) {
      disponibilidade.push({ data: bloqueio.data, periodo: bloqueio.periodo });
    }
  } else if (targetIndex !== -1) {
    disponibilidade.splice(targetIndex, 1);
  }

  return disponibilidade;
}

const server = http.createServer(async (req, res) => {
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
        sendJson(res, { reserva: reservaToSave }, 201);
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
        if (STORAGE_MODE === 'local') {
          await writeLocalArray(disponibilidadeFile, updated);
        }

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
});

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
