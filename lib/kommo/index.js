'use strict';

const cliente = require('./cliente');
const estrutura = require('./estrutura');
const webhook = require('./webhook');

// Evento de webhook do Kommo para "mensagem recebida".
const EVENTOS_WEBHOOK = ['add_message'];

/**
 * Integracao a partir do ambiente, ou null quando o Kommo nao esta
 * configurado (KOMMO_SUBDOMINIO + KOMMO_TOKEN).
 */
function criarIntegracaoDoAmbiente(env = process.env, fetchImpl) {
  const clienteKommo = cliente.criarClienteKommoDoAmbiente(env, fetchImpl);
  if (!clienteKommo) {
    return null;
  }

  const integracao = webhook.criarIntegracaoKommo({
    cliente: clienteKommo,
    obterMapa: estrutura.criarResolvedorDeMapa(clienteKommo),
    responsavelId: env.KOMMO_RESPONSAVEL_ID || null
  });

  return {
    cliente: clienteKommo,
    ...integracao,
    sincronizarEstrutura: opcoes => estrutura.sincronizarEstrutura(clienteKommo, opcoes),
    async registrarWebhook(destino) {
      const existentes = await clienteKommo.listarWebhooks();
      if (existentes.some(w => w.destination === destino && !w.disabled)) {
        return { registrado: false, motivo: 'JA_EXISTE' };
      }
      await clienteKommo.registrarWebhook(destino, EVENTOS_WEBHOOK);
      return { registrado: true };
    }
  };
}

module.exports = {
  ...cliente,
  ...estrutura,
  ...webhook,
  EVENTOS_WEBHOOK,
  criarIntegracaoDoAmbiente
};
