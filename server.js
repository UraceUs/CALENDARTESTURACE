'use strict';

const http = require('http');
const { URL } = require('url');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');

const PORT = Number(process.env.PORT || 3000);
const RESERVAS_COLLECTION = 'reservas';
const ALLOWED_PERIODS = new Set(['manha', 'tarde']);
const ALLOWED_EXPERIENCE = new Set(['Sim', 'Nao']);
const DEFAULT_SERVICES = ['Professional Coaching', 'Summer Camp', 'Trackside Support'];

function formatDateBr(value) {
  const dateMatch = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    return value || '-';
  }
  return `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`;
}

function buildSmtpSettingsFromEnv(env = process.env) {
  const host = String(env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number(env.SMTP_PORT || 587);
  const secure = String(env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const family = Number(env.SMTP_FAMILY || 4);
  const connectionTimeout = Number(env.SMTP_CONNECTION_TIMEOUT_MS || 20000);
  const greetingTimeout = Number(env.SMTP_GREETING_TIMEOUT_MS || 20000);
  const socketTimeout = Number(env.SMTP_SOCKET_TIMEOUT_MS || 30000);
  const user = String(env.SMTP_USER || '').trim();
  const pass = String(env.SMTP_PASS || '').trim();
  const gmailClientId = String(env.GMAIL_CLIENT_ID || '').trim();
  const gmailClientSecret = String(env.GMAIL_CLIENT_SECRET || '').trim();
  const gmailRefreshToken = String(env.GMAIL_REFRESH_TOKEN || '').trim();
  const gmailFrom = String(env.GMAIL_FROM || '').trim();
  const hasPasswordAuth = Boolean(user && pass);
  const hasOAuthAuth = Boolean(gmailClientId && gmailClientSecret && gmailRefreshToken && gmailFrom);
  const effectiveUser = hasOAuthAuth ? gmailFrom : user;
  const from = String(env.SMTP_FROM || effectiveUser).trim();
  const replyTo = String(env.SMTP_REPLY_TO || '').trim();

  const configured = Boolean((hasOAuthAuth || hasPasswordAuth) && from && host && Number.isFinite(port));

  const auth = hasOAuthAuth
    ? {
        type: 'OAuth2',
        user: gmailFrom,
        clientId: gmailClientId,
        clientSecret: gmailClientSecret,
        refreshToken: gmailRefreshToken
      }
    : {
        user,
        pass
      };

  return {
    configured,
    hasPasswordAuth,
    hasOAuthAuth,
    authMode: hasOAuthAuth ? 'gmail-oauth2' : (hasPasswordAuth ? 'password' : 'none'),
    from,
    replyTo,
    transport: {
      host,
      port,
      secure,
      family,
      connectionTimeout,
      greetingTimeout,
      socketTimeout,
      auth
    }
  };
}

function createEmailService(options = {}) {
  const env = options.env || process.env;
  const transporterFactory = options.transporterFactory || nodemailer.createTransport;
  const smtpSettings = buildSmtpSettingsFromEnv(env);
  let transporter = null;
  let transporterVerifyAttempted = false;
  let transporterVerifyError = null;
  let oauthClient = null;

  function getMissingSmtpFields() {
    const missing = [];
    if (!smtpSettings.transport.host) {
      missing.push('SMTP_HOST');
    }
    if (!Number.isFinite(smtpSettings.transport.port)) {
      missing.push('SMTP_PORT');
    }
    if (!smtpSettings.from) {
      missing.push('SMTP_FROM|GMAIL_FROM');
    }

    if (!smtpSettings.hasPasswordAuth && !smtpSettings.hasOAuthAuth) {
      const smtpUser = String(env.SMTP_USER || '').trim();
      const smtpPass = String(env.SMTP_PASS || '').trim();
      const gmailClientId = String(env.GMAIL_CLIENT_ID || '').trim();
      const gmailClientSecret = String(env.GMAIL_CLIENT_SECRET || '').trim();
      const gmailRefreshToken = String(env.GMAIL_REFRESH_TOKEN || '').trim();
      const gmailFrom = String(env.GMAIL_FROM || '').trim();

      if (smtpUser || smtpPass) {
        if (!smtpUser) {
          missing.push('SMTP_USER');
        }
        if (!smtpPass) {
          missing.push('SMTP_PASS');
        }
      }

      if (gmailClientId || gmailClientSecret || gmailRefreshToken || gmailFrom) {
        if (!gmailClientId) {
          missing.push('GMAIL_CLIENT_ID');
        }
        if (!gmailClientSecret) {
          missing.push('GMAIL_CLIENT_SECRET');
        }
        if (!gmailRefreshToken) {
          missing.push('GMAIL_REFRESH_TOKEN');
        }
        if (!gmailFrom) {
          missing.push('GMAIL_FROM');
        }
      }

      if (missing.length === 0) {
        missing.push('GMAIL_CLIENT_ID+GMAIL_CLIENT_SECRET+GMAIL_REFRESH_TOKEN+GMAIL_FROM');
      }
    }

    return missing;
  }

  function getSmtpStatusSnapshot() {
    return {
      host: smtpSettings.transport.host,
      port: smtpSettings.transport.port,
      family: smtpSettings.transport.family,
      connectionTimeout: smtpSettings.transport.connectionTimeout,
      greetingTimeout: smtpSettings.transport.greetingTimeout,
      socketTimeout: smtpSettings.transport.socketTimeout,
      authMode: smtpSettings.authMode,
      user: smtpSettings.transport.auth && smtpSettings.transport.auth.user ? smtpSettings.transport.auth.user : 'MISSING',
      pass: smtpSettings.hasPasswordAuth ? 'OK' : 'N/A',
      oauthClientId: smtpSettings.hasOAuthAuth ? 'OK' : (String(env.GMAIL_CLIENT_ID || '').trim() ? 'PARTIAL' : 'MISSING'),
      oauthClientSecret: smtpSettings.hasOAuthAuth ? 'OK' : (String(env.GMAIL_CLIENT_SECRET || '').trim() ? 'PARTIAL' : 'MISSING'),
      oauthRefreshToken: smtpSettings.hasOAuthAuth ? 'OK' : (String(env.GMAIL_REFRESH_TOKEN || '').trim() ? 'PARTIAL' : 'MISSING'),
      configured: smtpSettings.configured,
      missingFields: getMissingSmtpFields()
    };
  }

  function getEmailRuntimeDiagnostics() {
    return {
      smtp: getSmtpStatusSnapshot(),
      envStatus: {
        GMAIL_CLIENT_ID: String(env.GMAIL_CLIENT_ID || '').trim() ? 'OK' : 'MISSING',
        GMAIL_CLIENT_SECRET: String(env.GMAIL_CLIENT_SECRET || '').trim() ? 'OK' : 'MISSING',
        GMAIL_REFRESH_TOKEN: String(env.GMAIL_REFRESH_TOKEN || '').trim() ? 'OK' : 'MISSING',
        GMAIL_FROM: String(env.GMAIL_FROM || '').trim() ? 'OK' : 'MISSING',
        SUPPORT_NOTIFICATION_EMAIL: String(env.SUPPORT_NOTIFICATION_EMAIL || '').trim() ? 'OK' : 'MISSING'
      }
    };
  }

  function getOAuthClient() {
    if (!oauthClient) {
      oauthClient = new google.auth.OAuth2(
        smtpSettings.transport.auth.clientId,
        smtpSettings.transport.auth.clientSecret,
        'https://developers.google.com/oauthplayground'
      );
      oauthClient.setCredentials({
        refresh_token: smtpSettings.transport.auth.refreshToken
      });
    }
    return oauthClient;
  }

  async function resolveOAuthAccessToken() {
    try {
      const client = getOAuthClient();
      const accessTokenResult = await client.getAccessToken();
      const accessToken = typeof accessTokenResult === 'string'
        ? accessTokenResult
        : (accessTokenResult && accessTokenResult.token ? accessTokenResult.token : '');

      if (!accessToken) {
        throw new Error('EMPTY_OAUTH_ACCESS_TOKEN');
      }

      console.log('DEBUG SMTP: OAuth access token gerado com sucesso.');
      return accessToken;
    } catch (error) {
      console.error('DEBUG SMTP: falha ao gerar OAuth access token:', error);
      throw error;
    }
  }

  async function createTransporterWithDiagnostics() {
    let transportConfig = smtpSettings.transport;
    if (smtpSettings.authMode === 'gmail-oauth2') {
      const accessToken = await resolveOAuthAccessToken();
      transportConfig = {
        ...smtpSettings.transport,
        auth: {
          ...smtpSettings.transport.auth,
          accessToken
        }
      };
    }

    const nextTransporter = transporterFactory(transportConfig);
    console.log('DEBUG SMTP: transporter inicializado:', {
      host: smtpSettings.transport.host,
      port: smtpSettings.transport.port,
      family: smtpSettings.transport.family,
      user: smtpSettings.transport.auth.user || 'MISSING',
      authMode: smtpSettings.authMode
    });
    return nextTransporter;
  }

  function logSmtpConfig() {
    console.log('SMTP CONFIG:', getSmtpStatusSnapshot());

    if (/@gmail\.com$/i.test(smtpSettings.transport.auth.user || '')) {
      console.log('DEBUG SMTP: detectado Gmail. Use App Password (senha de app), nao a senha normal da conta.');
    }
  }

  async function getTransporter() {
    if (smtpSettings.authMode === 'gmail-oauth2') {
      logSmtpConfig();
      const oauthTransporter = await createTransporterWithDiagnostics();
      const verifyStartedAt = Date.now();
      console.log('DEBUG SMTP: iniciando transporter.verify() (oauth2)...');
      try {
        await oauthTransporter.verify();
        console.log('DEBUG SMTP: transporter.verify() OK', {
          durationMs: Date.now() - verifyStartedAt
        });
      } catch (error) {
        console.error('DEBUG SMTP: transporter.verify() falhou:', {
          durationMs: Date.now() - verifyStartedAt,
          code: error && error.code ? error.code : 'UNKNOWN',
          message: error && error.message ? error.message : 'UNKNOWN'
        });
        // Keep attempting sendMail because some providers can fail verify but still accept send.
      }
      return oauthTransporter;
    }

    if (!transporter) {
      logSmtpConfig();
      transporter = await createTransporterWithDiagnostics();
    }

    if (!transporterVerifyAttempted) {
      transporterVerifyAttempted = true;
      const verifyStartedAt = Date.now();
      console.log('DEBUG SMTP: iniciando transporter.verify() (password)...');
      try {
        await transporter.verify();
        console.log('DEBUG SMTP: transporter.verify() OK', {
          durationMs: Date.now() - verifyStartedAt
        });
      } catch (error) {
        transporterVerifyError = error;
        console.error('DEBUG SMTP: transporter.verify() falhou:', {
          durationMs: Date.now() - verifyStartedAt,
          code: error && error.code ? error.code : 'UNKNOWN',
          message: error && error.message ? error.message : 'UNKNOWN'
        });
      }
    }

    return transporter;
  }

  async function sendMailWithDiagnostics(mailOptions) {
    const to = mailOptions && mailOptions.to ? mailOptions.to : '';
    console.log('DEBUG: tentativa de envio iniciada:', {
      to,
      subject: mailOptions && mailOptions.subject ? mailOptions.subject : ''
    });

    const shouldRetry = (error) => {
      const code = String((error && error.code) || '').toUpperCase();
      const message = String((error && error.message) || '').toLowerCase();
      return [
        code === 'ETIMEDOUT',
        code === 'ESOCKET',
        code === 'ECONNECTION',
        code === 'EAI_AGAIN',
        message.includes('timeout'),
        message.includes('connection')
      ].some(Boolean);
    };

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const smtpTransporter = await getTransporter();
        if (transporterVerifyError) {
          console.log('DEBUG SMTP: envio continuara apesar de verify falhar; erro do verify:', transporterVerifyError.message || 'UNKNOWN_VERIFY_ERROR');
        }

        const info = await smtpTransporter.sendMail(mailOptions);
        console.log('DEBUG: email enviado:', {
          attempt,
          response: info && info.response ? info.response : 'SEM_RESPONSE'
        });
        return {
          ok: true,
          info
        };
      } catch (err) {
        lastError = err;
        console.error('DEBUG: erro ao enviar email:', {
          attempt,
          code: err && err.code ? err.code : 'UNKNOWN',
          message: err && err.message ? err.message : 'UNKNOWN'
        });

        if (attempt === 1 && shouldRetry(err)) {
          console.log('DEBUG SMTP: erro transitório detectado, tentando envio novamente...');
          continue;
        }
        break;
      }
    }

    return {
      ok: false,
      error: lastError || new Error('UNKNOWN_SEND_ERROR')
    };
  }

  function buildStageTwoMail(reserva) {
    const pitId = normalizePitId(reserva.pitId || reserva.id || '');
    const dataLabel = formatDateBr(reserva.data || '');
    const periodoLabel = reserva.periodo === 'manha' ? 'Manha' : reserva.periodo === 'tarde' ? 'Tarde' : (reserva.periodo || '-');
    const servicoLabel = reserva.servico || '-';
    const piloto = reserva.nomePiloto || reserva.nome || '-';
    const responsavel = reserva.responsavelPiloto || reserva.nomeResponsavel || reserva.responsavel || '-';

    const text = [
      'Sua reserva foi confirmada com sucesso.',
      '',
      `Pit ID: ${pitId || '-'}`,
      `Piloto: ${piloto}`,
      `Responsavel: ${responsavel}`,
      `Data: ${dataLabel}`,
      `Periodo: ${periodoLabel}`,
      `Servico: ${servicoLabel}`,
      '',
      'Nos vemos na pista.'
    ].join('\n');

    return {
      from: smtpSettings.from,
      to: reserva.email,
      subject: `Confirmacao de reserva - ${pitId || 'U-RACE'}`,
      text,
      ...(smtpSettings.replyTo ? { replyTo: smtpSettings.replyTo } : {})
    };
  }

  function buildSupportMail(reserva) {
    const supportTo = String(env.SUPPORT_NOTIFICATION_EMAIL || env.TEST_EMAIL_TO || env.SMTP_USER || '').trim();
    const pitId = normalizePitId(reserva.pitId || reserva.id || '');
    const dataLabel = formatDateBr(reserva.data || '');
    const periodoLabel = reserva.periodo === 'manha' ? 'Manha' : reserva.periodo === 'tarde' ? 'Tarde' : (reserva.periodo || '-');
    const servicoLabel = reserva.servico || '-';
    const piloto = reserva.nomePiloto || reserva.nome || '-';

    const text = [
      'Reenvio de confirmacao de reserva.',
      '',
      `Pit ID: ${pitId || '-'}`,
      `Piloto: ${piloto}`,
      `Data: ${dataLabel}`,
      `Periodo: ${periodoLabel}`,
      `Servico: ${servicoLabel}`,
      `Email cliente: ${reserva.email || '-'}`
    ].join('\n');

    return {
      from: smtpSettings.from,
      to: supportTo,
      subject: `Reenvio confirmacao - ${pitId || 'U-RACE'}`,
      text,
      ...(smtpSettings.replyTo ? { replyTo: smtpSettings.replyTo } : {})
    };
  }

  return {
    getDiagnostics() {
      return getEmailRuntimeDiagnostics();
    },

    async sendStageTwoConfirmation(reserva) {
      if (!smtpSettings.configured) {
        logSmtpConfig();
        return {
          sent: false,
          reason: 'SMTP_NOT_CONFIGURED',
          details: {
            missingFields: getMissingSmtpFields(),
            smtp: getSmtpStatusSnapshot()
          }
        };
      }

      if (!reserva || !validateEmail(reserva.email)) {
        return { sent: false, reason: 'INVALID_EMAIL' };
      }

      const mailOptions = buildStageTwoMail(reserva);
      const sendResult = await sendMailWithDiagnostics(mailOptions);
      if (sendResult.ok) {
        return {
          sent: true,
          to: reserva.email,
          sentAt: new Date().toISOString()
        };
      }

      return {
        sent: false,
        reason: 'SEND_FAILED',
        error: sendResult.error && sendResult.error.message ? sendResult.error.message : 'UNKNOWN_SEND_ERROR'
      };
    },

    async sendTestEmail() {
      if (!smtpSettings.configured) {
        logSmtpConfig();
        return {
          sent: false,
          reason: 'SMTP_NOT_CONFIGURED',
          details: {
            missingFields: getMissingSmtpFields(),
            smtp: getSmtpStatusSnapshot()
          }
        };
      }

      const to = String(env.TEST_EMAIL_TO || env.SUPPORT_NOTIFICATION_EMAIL || env.GMAIL_FROM || env.SMTP_USER || '').trim();
      if (!validateEmail(to)) {
        return { sent: false, reason: 'TEST_EMAIL_TO_INVALID' };
      }

      const mailOptions = {
        from: smtpSettings.from,
        to,
        subject: 'TESTE SMTP',
        text: 'Se chegou, o SMTP esta funcionando',
        ...(smtpSettings.replyTo ? { replyTo: smtpSettings.replyTo } : {})
      };

      const sendResult = await sendMailWithDiagnostics(mailOptions);
      if (sendResult.ok) {
        return {
          sent: true,
          to,
          sentAt: new Date().toISOString(),
          response: sendResult.info && sendResult.info.response ? sendResult.info.response : null
        };
      }

      return {
        sent: false,
        reason: 'SEND_FAILED',
        error: sendResult.error && sendResult.error.message ? sendResult.error.message : 'UNKNOWN_SEND_ERROR'
      };
    },

    async sendSupportNotification(reserva) {
      if (!smtpSettings.configured) {
        logSmtpConfig();
        return {
          sent: false,
          reason: 'SMTP_NOT_CONFIGURED',
          details: {
            missingFields: getMissingSmtpFields(),
            smtp: getSmtpStatusSnapshot()
          }
        };
      }

      const mailOptions = buildSupportMail(reserva || {});
      if (!validateEmail(mailOptions.to)) {
        return { sent: false, reason: 'SUPPORT_EMAIL_NOT_CONFIGURED' };
      }

      const sendResult = await sendMailWithDiagnostics(mailOptions);
      if (sendResult.ok) {
        return {
          sent: true,
          to: mailOptions.to,
          sentAt: new Date().toISOString(),
          response: sendResult.info && sendResult.info.response ? sendResult.info.response : null
        };
      }

      return {
        sent: false,
        reason: 'SEND_FAILED',
        error: sendResult.error && sendResult.error.message ? sendResult.error.message : 'UNKNOWN_SEND_ERROR'
      };
    }
  };
}

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
    stageTwoCompletedAt: toIsoStringIfPossible(raw.stageTwoCompletedAt),
    stageTwoEmailSentAt: toIsoStringIfPossible(raw.stageTwoEmailSentAt)
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

  async function markStageTwoEmailSent(pitId, details = {}) {
    const current = await getByPitId(pitId);
    if (!current.exists) {
      return null;
    }

    const now = String(details.sentAt || new Date().toISOString());
    await current.ref.set({
      pitId,
      stageTwoEmailSentAt: now,
      stageTwoEmailRecipient: String(details.recipient || '').trim(),
      updatedAt: now
    }, { merge: true });

    const updated = await current.ref.get();
    return {
      id: updated.id,
      data: updated.data() || {}
    };
  }

  return {
    getByPitId,
    listReservas,
    upsertStageOne,
    updateStageTwo,
    markStageTwoEmailSent
  };
}

function createApp(options = {}) {
  const repo = options.repo || createFirestoreReservaRepository();
  const emailService = options.emailService || createEmailService();

  return async function app(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');

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

    if (req.method === 'GET' && requestUrl.pathname === '/api/test-email') {
      try {
        const runtimeDiagnostics = typeof emailService.getDiagnostics === 'function'
          ? emailService.getDiagnostics()
          : null;
        const result = await emailService.sendTestEmail();
        if (!result || !result.sent) {
          sendJson(res, 500, {
            ok: false,
            error: {
              code: result && result.reason ? result.reason : 'TEST_EMAIL_FAILED',
              message: 'Falha ao enviar e-mail de teste SMTP.',
              details: [
                ...(result && result.error ? [result.error] : []),
                ...(result && result.details && Array.isArray(result.details.missingFields)
                  ? result.details.missingFields.map(item => `MISSING:${item}`)
                  : [])
              ]
            },
            diagnostics: result && result.details ? result.details : null,
            runtimeDiagnostics
          });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          message: 'E-mail de teste enviado com sucesso.',
          emailConfirmation: {
            sent: true,
            to: result.to,
            sentAt: result.sentAt,
            response: result.response || null
          },
          runtimeDiagnostics
        });
      } catch (error) {
        console.error('Erro no endpoint /api/test-email:', error);
        sendJson(res, 500, {
          ok: false,
          error: {
            code: 'TEST_EMAIL_INTERNAL_ERROR',
            message: 'Erro interno ao executar teste de e-mail SMTP.',
            details: [error && error.message ? error.message : 'UNKNOWN']
          }
        });
      }
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

    const resendMatch = requestUrl.pathname.match(/^\/api\/reservas\/([^/]+)\/resend-confirmation$/);
    if (req.method === 'POST' && resendMatch) {
      const reservaId = decodeURIComponent(resendMatch[1] || '');
      const pitId = normalizePitId(reservaId);
      console.log('DEBUG: rota resend-confirmation acionada com parametro:', {
        rawParam: resendMatch[1] || '',
        decodedParam: reservaId,
        normalizedPitId: pitId
      });
      if (!pitId) {
        sendJson(res, 400, {
          error: {
            code: 'INVALID_PIT_ID',
            message: 'Pit ID invalido para reenvio.',
            details: []
          }
        });
        return;
      }

      try {
        const found = await repo.getByPitId(pitId);
        if (!found || !found.exists) {
          console.log('DEBUG: resend-confirmation nao encontrou reserva para pitId:', pitId);
          sendJson(res, 404, {
            error: {
              code: 'NOT_FOUND',
              message: 'Nao encontrado',
              details: []
            }
          });
          return;
        }

        const reserva = normalizeReservaRecord(found.id, found.data || {});
        console.log('DEBUG: resend-confirmation encontrou reserva:', {
          pitId,
          reservaId: reserva.id,
          email: reserva.email || null
        });
        const emailConfirmation = await emailService.sendStageTwoConfirmation(reserva);
        const supportNotification = await emailService.sendSupportNotification(reserva);

        console.log('DEBUG: resend-confirmation resultado de envio:', {
          pitId,
          emailConfirmation,
          supportNotification
        });

        sendJson(res, 200, {
          ok: Boolean(emailConfirmation && emailConfirmation.sent) && Boolean(supportNotification && supportNotification.sent),
          reserva,
          emailConfirmation: emailConfirmation || { sent: false, reason: 'UNAVAILABLE' },
          supportNotification: supportNotification || { sent: false, reason: 'UNAVAILABLE' }
        });
      } catch (error) {
        console.error('Erro ao reenviar confirmacao:', error);
        sendJson(res, 500, {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Falha ao reenviar confirmacao por e-mail.',
            details: [error && error.message ? error.message : 'UNKNOWN']
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

        const reserva = normalizeReservaRecord(pitId, (updated && updated.data) || {});
        let emailConfirmation;

        if (reserva.stageTwoEmailSentAt) {
          console.log('DEBUG: envio de email ignorado para pitId pois stageTwoEmailSentAt ja existe:', {
            pitId,
            stageTwoEmailSentAt: reserva.stageTwoEmailSentAt
          });
          emailConfirmation = {
            sent: false,
            skipped: true,
            reason: 'ALREADY_SENT',
            sentAt: reserva.stageTwoEmailSentAt,
            to: reserva.email || validation.data.email
          };
        } else {
          console.log('DEBUG: etapa 2 concluida, iniciando fluxo de envio de email:', {
            pitId,
            to: reserva.email || validation.data.email
          });
          emailConfirmation = await emailService.sendStageTwoConfirmation(reserva);
          console.log('DEBUG: etapa 2 resultado do envio de email:', {
            pitId,
            emailConfirmation
          });

          if (emailConfirmation && emailConfirmation.sent) {
            const sentAt = String(emailConfirmation.sentAt || new Date().toISOString());
            reserva.stageTwoEmailSentAt = sentAt;

            if (typeof repo.markStageTwoEmailSent === 'function') {
              try {
                await repo.markStageTwoEmailSent(pitId, {
                  sentAt,
                  recipient: reserva.email || emailConfirmation.to || ''
                });
              } catch (markError) {
                console.error('Falha ao marcar envio de e-mail da etapa 2:', markError);
              }
            }
          }
        }

        sendJson(res, 200, {
          reserva,
          emailConfirmation: emailConfirmation || { sent: false, reason: 'UNAVAILABLE' },
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
  createEmailService,
  createFirestoreReservaRepository,
  normalizePitId,
  validateStageOne,
  validateStageTwo,
  inferStage,
  startServer
};
