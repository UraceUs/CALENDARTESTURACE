'use strict';

/**
 * Servico enxuto do SDR: so as rotas do SDR e do executor do Kommo.
 *
 * Roda em qualquer host com Node 18+ e endereco HTTPS publico (o servidor do
 * Command Center, por exemplo), sem Firebase, e-mail nem dependencias npm:
 *
 *   node sdr-server.js
 *
 * Variaveis: SDR_PORT (padrao 3100), SDR_WEBHOOK_TOKEN, KOMMO_SUBDOMINIO,
 * KOMMO_TOKEN, KOMMO_WEBHOOK_TOKEN, KOMMO_RESPONSAVEL_ID, KOMMO_MODO.
 * Ver docs/kommo-sdr-regras.md, secao 3.6.
 */

const http = require('http');
const { URL } = require('url');
const kommo = require('./lib/kommo');
const { sendJson } = require('./lib/http');
const { tratarRotasSdr } = require('./lib/rotas-sdr');

function createSdrApp(options = {}) {
  const kommoIntegracao = options.kommo !== undefined ? options.kommo : kommo.criarIntegracaoDoAmbiente();

  return async function app(req, res) {
    const requestUrl = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/health')) {
      sendJson(res, 200, {
        ok: true,
        service: 'sdr-agent-urace',
        kommo: kommoIntegracao ? kommoIntegracao.modo || 'configurado' : 'nao_configurado'
      });
      return;
    }

    if (await tratarRotasSdr(req, res, requestUrl, { kommo: kommoIntegracao })) {
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Nao encontrado', details: [] } });
  };
}

function startSdrServer(porta = Number(process.env.SDR_PORT || 3100)) {
  const app = createSdrApp();
  const server = http.createServer((req, res) => {
    app(req, res).catch(error => {
      console.error('SDR: erro nao tratado:', error);
      sendJson(res, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Erro interno.', details: [] } });
    });
  });

  server.listen(porta, () => {
    console.log(`SDR Agent U-RACE ouvindo na porta ${porta}`);
  });

  return server;
}

if (require.main === module) {
  startSdrServer();
}

module.exports = {
  createSdrApp,
  startSdrServer
};
