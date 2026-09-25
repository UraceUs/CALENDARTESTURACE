'use strict';

/**
 * Rotas do SDR e do executor do Kommo. Montadas tanto pelo backend completo
 * (server.js) quanto pelo servico enxuto (sdr-server.js), que roda em
 * qualquer host Node 18+ sem Firebase nem e-mail.
 */

const sdr = require('./sdr');
const kommo = require('./kommo');
const { parseJsonBody, readRawBody, sendJson } = require('./http');

function autorizarWebhookSdr(req, env = process.env) {
  const esperado = env.SDR_WEBHOOK_TOKEN;
  if (!esperado) {
    return { ok: true };
  }

  const header = req.headers.authorization || '';
  const recebido = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (recebido && recebido === esperado) {
    return { ok: true };
  }

  return { ok: false };
}

// O Kommo nao envia cabecalho customizado no webhook: o segredo vai na URL.
function autorizarWebhookKommo(requestUrl, env = process.env) {
  const esperado = env.KOMMO_WEBHOOK_TOKEN;
  return Boolean(esperado) && requestUrl.searchParams.get('token') === esperado;
}

// Acao administrativa (cria funis no Kommo): exige SDR_WEBHOOK_TOKEN definido.
function autorizarAdminKommo(req, env = process.env) {
  return Boolean(env.SDR_WEBHOOK_TOKEN) && autorizarWebhookSdr(req, env).ok;
}

function erroKommo(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message, details: [] } });
}

/**
 * Trata as rotas /api/sdr/* e /api/kommo/*. Devolve true quando respondeu.
 *
 * @param {object} opcoes { kommo: integracao do Kommo ou null }
 */
async function tratarRotasSdr(req, res, requestUrl, opcoes = {}) {
  const kommoIntegracao = opcoes.kommo || null;

  if (req.method === 'GET' && requestUrl.pathname === '/api/sdr/regras') {
    sendJson(res, 200, { ok: true, regras: sdr.descreverRegras() });
    return true;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/sdr/avaliar') {
    if (!autorizarWebhookSdr(req).ok) {
      sendJson(res, 401, {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Token invalido para o webhook do SDR.',
          details: []
        }
      });
      return true;
    }

    let payload;
    try {
      payload = await parseJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: 'INVALID_JSON',
          message: 'Corpo da requisicao nao e um JSON valido.',
          details: []
        }
      });
      return true;
    }

    const erros = sdr.validarEvento(payload);
    if (erros.length > 0) {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Evento invalido para avaliacao do SDR.',
          details: erros
        }
      });
      return true;
    }

    try {
      const decisao = sdr.avaliarInteracao(payload);
      sendJson(res, 200, { ok: true, ...decisao });
    } catch (error) {
      console.error('Erro ao avaliar interacao do SDR:', error);
      sendJson(res, 500, {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Erro interno ao avaliar a interacao.',
          details: [error && error.message ? error.message : 'UNKNOWN']
        }
      });
    }
    return true;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/kommo/webhook') {
    if (!kommoIntegracao) {
      erroKommo(res, 503, 'KOMMO_NAO_CONFIGURADO', 'Defina KOMMO_SUBDOMINIO e KOMMO_TOKEN.');
      return true;
    }
    if (!autorizarWebhookKommo(requestUrl)) {
      erroKommo(res, 401, 'UNAUTHORIZED', 'Token invalido para o webhook do Kommo.');
      return true;
    }

    let corpo;
    try {
      corpo = kommo.parseCorpoWebhook(await readRawBody(req), req.headers['content-type'] || '');
    } catch (error) {
      erroKommo(res, 400, 'INVALID_BODY', 'Corpo do webhook invalido.');
      return true;
    }

    // O Kommo desativa webhooks que demoram: responde ja e processa depois.
    const recebidas = kommo.extrairMensagensRecebidas(corpo).length;
    sendJson(res, 200, { ok: true, recebidas });
    kommoIntegracao.receberWebhook(corpo).catch(error => {
      console.error('Kommo: erro no processamento do webhook:', error);
    });
    return true;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/kommo/estrutura') {
    if (!kommoIntegracao) {
      erroKommo(res, 503, 'KOMMO_NAO_CONFIGURADO', 'Defina KOMMO_SUBDOMINIO e KOMMO_TOKEN.');
      return true;
    }
    if (!autorizarAdminKommo(req)) {
      erroKommo(res, 401, 'UNAUTHORIZED', 'Exige Authorization: Bearer <SDR_WEBHOOK_TOKEN>.');
      return true;
    }

    let payload;
    try {
      payload = await parseJsonBody(req);
    } catch (error) {
      erroKommo(res, 400, 'INVALID_JSON', 'Corpo da requisicao nao e um JSON valido.');
      return true;
    }

    try {
      const estrutura = await kommoIntegracao.sincronizarEstrutura({ aplicar: payload.aplicar === true });
      let webhook = null;
      if (payload.aplicar === true && typeof payload.webhookUrl === 'string' && payload.webhookUrl.startsWith('https://')) {
        webhook = await kommoIntegracao.registrarWebhook(payload.webhookUrl);
      }
      sendJson(res, 200, { ok: true, ...estrutura, webhook });
    } catch (error) {
      console.error('Kommo: erro ao sincronizar estrutura:', error);
      sendJson(res, 502, {
        ok: false,
        error: {
          code: 'KOMMO_ERROR',
          message: error.message,
          details: error.detalhes ? [error.detalhes] : []
        }
      });
    }
    return true;
  }
  return false;
}

module.exports = {
  tratarRotasSdr,
  autorizarWebhookSdr
};
