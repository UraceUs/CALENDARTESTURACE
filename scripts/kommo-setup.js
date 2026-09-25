#!/usr/bin/env node
'use strict';

/**
 * Cria/confere no Kommo os funis Entrada e Comercial com as etapas do SDR.
 *
 *   KOMMO_SUBDOMINIO=urace KOMMO_TOKEN=... node scripts/kommo-setup.js
 *       so mostra o que falta (nao altera nada)
 *   ... node scripts/kommo-setup.js --aplicar
 *       cria o que falta
 *   ... node scripts/kommo-setup.js --aplicar --webhook "https://<backend>/api/kommo/webhook?token=..."
 *       cria o que falta e registra o webhook de mensagens
 */

const kommo = require('../lib/kommo');

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const indiceWebhook = args.indexOf('--webhook');
  const webhookUrl = indiceWebhook >= 0 ? args[indiceWebhook + 1] : null;

  const integracao = kommo.criarIntegracaoDoAmbiente(process.env);
  if (!integracao) {
    console.error('Defina KOMMO_SUBDOMINIO e KOMMO_TOKEN.');
    process.exit(1);
  }

  const resultado = await integracao.sincronizarEstrutura({ aplicar });
  console.log(JSON.stringify(resultado, null, 2));

  if (!aplicar && !resultado.plano.ok) {
    console.log('\nNada foi alterado. Rode com --aplicar para criar o que falta.');
  }

  if (aplicar && webhookUrl) {
    console.log('Webhook:', JSON.stringify(await integracao.registrarWebhook(webhookUrl)));
  }
}

main().catch(error => {
  console.error(error.message, error.detalhes ? JSON.stringify(error.detalhes) : '');
  process.exit(1);
});
