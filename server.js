'use strict';

const http = require('http');
const { URL } = require('url');
const admin = require('firebase-admin');

const PORT = Number(process.env.PORT || 3000);
const RESERVAS_COLLECTION = 'reservas';
const ALLOWED_PERIODS = new Set(['manha', 'tarde']);
const ALLOWED_EXPERIENCE = new Set(['Sim', 'Nao']);
const DEFAULT_SERVICES = ['Professional Coaching', 'Summer Camp', 'Trackside Support'];

function normalizePitId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9-_]/g, '');
}

function toIsoStringIfPossible(value) {
  if (!value) {
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch (error) {
      return value;
    }
  }

  return value;
}

function normalizeReservaRecord(docId, data) {
  const raw = data || {};
  const canonicalPitId = normalizePitId(raw.pitId || raw.pitchId || docId);

  return {
    ...raw,
    id: canonicalPitId,
    pitId: canonicalPitId,
    createdAt: toIsoStringIfPossible(raw.createdAt),
    updatedAt: toIsoStringIfPossible(raw.updatedAt),
    stageOneCompletedAt: toIsoStringIfPossible(raw.stageOneCompletedAt),
    stageTwoCompletedAt: toIsoStringIfPossible(raw.stageTwoCompletedAt)
  };
}

function isNonEmptyString(value, min = 1, max = 255) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function inferStage(input) {
  if (input === 1 || input === '1' || input === 'etapa1' || input === 'stage1') {
    return 1;
  }
  if (input === 2 || input === '2' || input === 'etapa2' || input === 'stage2') {
    return 2;
  }
  return null;
}

function validateStageOne(payload) {
  const errors = [];
  const data = String(payload.data || '').trim();
  const periodo = String(payload.periodo || '').trim();
  const servico = String(payload.servico || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    errors.push('Campo "data" deve estar no formato YYYY-MM-DD.');
  }

  if (!ALLOWED_PERIODS.has(periodo)) {
    errors.push('Campo "periodo" deve ser "manha" ou "tarde".');
  }

  if (!isNonEmptyString(servico, 2, 120)) {
    errors.push('Campo "servico" e obrigatorio e deve ter entre 2 e 120 caracteres.');
  }

  return {
    ok: errors.length === 0,
    errors,
    data: {
      data,
      periodo,
      servico
    }
  };
}

function validateEmail(value) {
  if (!isNonEmptyString(value, 3, 254)) {
    return false;
  }
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(value).trim());
}

function validateStageTwo(payload) {
  const errors = [];

  const nomePiloto = String(payload.nomePiloto || payload.nome || '').trim();
  const responsavelPiloto = String(payload.responsavelPiloto || payload.nomeResponsavel || payload.responsavel || '').trim();
  const email = String(payload.email || '').trim();
  const telefone = String(payload.telefone || '').trim();
  const age = String(payload.age || '').trim();
  const height = String(payload.height || '').trim();
  const weight = String(payload.weight || '').trim();
  const waist = String(payload.waist || '').trim();
  const kartingExperience = String(payload.kartingExperience || '').trim();
  const experienceDescription = String(payload.experienceDescription || '').trim();

  if (!isNonEmptyString(nomePiloto, 2, 120)) {
    errors.push('Campo "nomePiloto" e obrigatorio.');
  }
  if (!isNonEmptyString(responsavelPiloto, 2, 120)) {
    errors.push('Campo "responsavelPiloto" e obrigatorio.');
  }
  if (!validateEmail(email)) {
    errors.push('Campo "email" invalido.');
  }
  if (!isNonEmptyString(telefone, 6, 32)) {
    errors.push('Campo "telefone" e obrigatorio.');
  }
  if (!isNonEmptyString(age, 1, 8)) {
    errors.push('Campo "age" e obrigatorio.');
  }
  if (!isNonEmptyString(height, 1, 32)) {
    errors.push('Campo "height" e obrigatorio.');
  }
  if (!isNonEmptyString(weight, 1, 32)) {
    errors.push('Campo "weight" e obrigatorio.');
  }
  if (!isNonEmptyString(waist, 1, 32)) {
    errors.push('Campo "waist" e obrigatorio.');
  }
  if (!ALLOWED_EXPERIENCE.has(kartingExperience)) {
    errors.push('Campo "kartingExperience" deve ser "Sim" ou "Nao".');
  }

  return {
    ok: errors.length === 0,
    errors,
    data: {
      nomePiloto,
      nome: nomePiloto,
      responsavelPiloto,
      email,
      telefone,
      age,
      height,
      weight,
      waist,
      kartingExperience,
      experienceDescription
    }
  };
}

function ensureFirestore() {
  if (admin.apps.length > 0) {
    return admin.firestore();
  }

  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountRaw) {
    const serviceAccount = JSON.parse(serviceAccountRaw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    return admin.firestore();
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
  return admin.firestore();
}

function createFirestoreReservaRepository() {
  const db = ensureFirestore();
  const collection = db.collection(RESERVAS_COLLECTION);

  async function getByPitId(pitId) {
    const canonicalRef = collection.doc(pitId);
    const canonicalSnap = await canonicalRef.get();
    if (canonicalSnap.exists) {
      return {
        exists: true,
        id: canonicalSnap.id,
        ref: canonicalRef,
        data: canonicalSnap.data() || {}
      };
    }

    const pitQuerySnap = await collection.where('pitId', '==', pitId).limit(1).get();
    if (!pitQuerySnap.empty) {
      const pitDoc = pitQuerySnap.docs[0];
      return {
        exists: true,
        id: pitDoc.id,
        ref: pitDoc.ref,
        data: pitDoc.data() || {}
      };
    }

    const pitchQuerySnap = await collection.where('pitchId', '==', pitId).limit(1).get();
    if (pitchQuerySnap.empty) {
      return {
        exists: false,
        id: pitId,
        ref: canonicalRef,
        data: null
      };
    }

    const legacyDoc = pitchQuerySnap.docs[0];
    return {
      exists: true,
      id: legacyDoc.id,
      ref: legacyDoc.ref,
      data: legacyDoc.data() || {}
    };
  }

  async function listReservas() {
    const snapshot = await collection.get();
    return snapshot.docs.map(doc => normalizeReservaRecord(doc.id, doc.data() || {}));
  }

  async function upsertStageOne(pitId, stageData) {
    const current = await getByPitId(pitId);
    const now = new Date().toISOString();

    const nextDoc = {
      ...(current.data || {}),
      pitId,
      data: stageData.data,
      periodo: stageData.periodo,
      servico: stageData.servico,
      bookingProgress: 50,
      bookingStageStatus: 'incompleta',
      stageOneCompletedAt: now,
      updatedAt: now,
      createdAt: current.exists && current.data && current.data.createdAt ? current.data.createdAt : now
    };

    if (current.exists && current.id !== pitId) {
      const canonicalRef = collection.doc(pitId);
      await canonicalRef.set(nextDoc, { merge: true });
      await current.ref.delete();
      const mergedSnap = await canonicalRef.get();
      return {
        id: mergedSnap.id,
        data: mergedSnap.data() || nextDoc
      };
    }

    await current.ref.set(nextDoc, { merge: true });
    const updated = await current.ref.get();
    return {
      id: updated.id,
      data: updated.data() || nextDoc
    };
  }

  async function updateStageTwo(pitId, stageData) {
    const current = await getByPitId(pitId);
    if (!current.exists) {
      return null;
    }

    const now = new Date().toISOString();
    const nextDoc = {
      ...(current.data || {}),
      pitId,
      ...stageData,
      bookingProgress: 100,
      bookingStageStatus: 'completa',
      stageTwoCompletedAt: now,
      updatedAt: now
    };

    if (current.id !== pitId) {
      const canonicalRef = collection.doc(pitId);
      await canonicalRef.set(nextDoc, { merge: true });
      await current.ref.delete();
      const mergedSnap = await canonicalRef.get();
      return {
        id: mergedSnap.id,
        data: mergedSnap.data() || nextDoc
      };
    }

    await current.ref.set(nextDoc, { merge: true });
    const updated = await current.ref.get();
    return {
      id: updated.id,
      data: updated.data() || nextDoc
    };
  }

  return {
    getByPitId,
    listReservas,
    upsertStageOne,
    updateStageTwo
  };
}

function createApp(options = {}) {
  const repo = options.repo || createFirestoreReservaRepository();

  return async function app(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const requestUrl = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && requestUrl.pathname === '/') {
      sendJson(res, 200, { ok: true, service: 'calendar-backend' });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(res, 200, { ok: true, status: 'healthy' });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/reservas') {
      try {
        const reservas = await repo.listReservas();
        sendJson(res, 200, Array.isArray(reservas) ? reservas : []);
      } catch (error) {
        console.error('Erro ao listar reservas:', error);
        sendJson(res, 500, {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Nao foi possivel consultar reservas no Firestore.',
            details: []
          }
        });
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/disponibilidade') {
      sendJson(res, 200, []);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/capacidade') {
      sendJson(res, 200, []);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/config/servicos') {
      sendJson(res, 200, {
        allServices: [...DEFAULT_SERVICES],
        enabledServices: [...DEFAULT_SERVICES],
        serviceIcons: {}
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/config/periodos') {
      sendJson(res, 200, {
        allPeriods: ['manha', 'tarde'],
        enabledPeriods: ['manha', 'tarde']
      });
      return;
    }

    const pitMatch = requestUrl.pathname.match(/^\/api\/reservas\/pit\/([A-Za-z0-9-_]+)$/);
    if (pitMatch && req.method === 'GET') {
      const pitId = normalizePitId(decodeURIComponent(pitMatch[1] || ''));
      if (!pitId) {
        sendJson(res, 400, {
          error: {
            code: 'INVALID_PIT_ID',
            message: 'Pit ID invalido.',
            details: []
          }
        });
        return;
      }

      try {
        const found = await repo.getByPitId(pitId);
        if (!found || !found.exists) {
          sendJson(res, 404, {
            error: {
              code: 'NOT_FOUND',
              message: 'Reserva nao encontrada para o pitId informado.',
              details: []
            }
          });
          return;
        }

        sendJson(res, 200, {
          reserva: normalizeReservaRecord(found.id, found.data || {})
        });
      } catch (error) {
        console.error('Erro ao buscar reserva por pitId:', error);
        sendJson(res, 500, {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Nao foi possivel consultar reserva por pitId.',
            details: []
          }
        });
      }
      return;
    }

    if (req.method === 'PATCH' && pitMatch) {
      const pitId = normalizePitId(decodeURIComponent(pitMatch[1] || ''));
      if (!pitId) {
        sendJson(res, 400, {
          error: {
            code: 'INVALID_PIT_ID',
            message: 'Pit ID invalido.',
            details: []
          }
        });
        return;
      }

      let body;
      try {
        body = await parseJsonBody(req);
      } catch (error) {
        sendJson(res, 400, {
          error: {
            code: 'INVALID_JSON',
            message: 'JSON invalido no corpo da requisicao.',
            details: []
          }
        });
        return;
      }

      const stage = inferStage(body.etapa || body.stage);
      if (!stage) {
        sendJson(res, 400, {
          error: {
            code: 'INVALID_STAGE',
            message: 'Informe etapa=1 (etapa1) ou etapa=2 (etapa2).',
            details: []
          }
        });
        return;
      }

      if (stage === 1) {
        const validation = validateStageOne(body);
        if (!validation.ok) {
          sendJson(res, 400, {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Dados invalidos para etapa 1.',
              details: validation.errors
            }
          });
          return;
        }

        try {
          const updated = await repo.upsertStageOne(pitId, validation.data);
          sendJson(res, 200, {
            reserva: normalizeReservaRecord(pitId, (updated && updated.data) || {}),
            meta: {
              stage: 1,
              key: 'pitId'
            }
          });
        } catch (error) {
          console.error('Erro ao salvar etapa 1:', error);
          sendJson(res, 500, {
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Nao foi possivel persistir a etapa 1 no Firestore.',
              details: []
            }
          });
        }
        return;
      }

      const validation = validateStageTwo(body);
      if (!validation.ok) {
        sendJson(res, 400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Dados invalidos para etapa 2.',
            details: validation.errors
          }
        });
        return;
      }

      try {
        const updated = await repo.updateStageTwo(pitId, validation.data);
        if (!updated) {
          sendJson(res, 404, {
            error: {
              code: 'NOT_FOUND',
              message: 'Reserva nao encontrada para o pitId informado.',
              details: []
            }
          });
          return;
        }

        sendJson(res, 200, {
          reserva: normalizeReservaRecord(pitId, (updated && updated.data) || {}),
          meta: {
            stage: 2,
            key: 'pitId'
          }
        });
      } catch (error) {
        console.error('Erro ao salvar etapa 2:', error);
        sendJson(res, 500, {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Nao foi possivel persistir a etapa 2 no Firestore.',
            details: []
          }
        });
      }
      return;
    }

    sendJson(res, 404, {
      error: {
        code: 'NOT_FOUND',
        message: 'Nao encontrado',
        details: []
      }
    });
  };
}

function startServer() {
  const app = createApp();
  const server = http.createServer((req, res) => {
    app(req, res).catch(error => {
      console.error('Erro nao tratado:', error);
      sendJson(res, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Erro interno.',
          details: []
        }
      });
    });
  });

  server.listen(PORT, () => {
    console.log(`Servidor iniciado na porta ${PORT}`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  createFirestoreReservaRepository,
  normalizePitId,
  validateStageOne,
  validateStageTwo,
  inferStage,
  startServer
};
