'use strict';

/**
 * Cliente minimo da API v4 do Kommo.
 *
 * So cobre o que o SDR precisa para aplicar as regras: funis e etapas, ler e
 * mover lead, tags, nota e tarefa. Autenticacao por token de longa duracao
 * (integracao privada do Kommo).
 */

function normalizarSubdominio(valor) {
  return String(valor || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\.kommo\.com.*$/, '')
    .replace(/\/.*$/, '');
}

function criarErroKommo(status, caminho, detalhes) {
  const erro = new Error(`KOMMO_HTTP_${status} ${caminho}`);
  erro.code = 'KOMMO_HTTP_ERROR';
  erro.status = status;
  erro.detalhes = detalhes;
  return erro;
}

function criarClienteKommo(opcoes = {}) {
  const subdominio = normalizarSubdominio(opcoes.subdominio);
  const token = String(opcoes.token || '').trim();
  const fetchImpl = opcoes.fetchImpl || globalThis.fetch;
  const base = opcoes.baseUrl || `https://${subdominio}.kommo.com/api/v4`;

  if (!opcoes.baseUrl && !subdominio) {
    throw new Error('KOMMO_SUBDOMINIO ausente.');
  }
  if (!token) {
    throw new Error('KOMMO_TOKEN ausente.');
  }

  async function chamar(metodo, caminho, corpo) {
    const resposta = await fetchImpl(`${base}${caminho}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo)
    });

    const texto = resposta.status === 204 ? '' : await resposta.text();
    let dados = null;
    if (texto) {
      try {
        dados = JSON.parse(texto);
      } catch (error) {
        dados = texto;
      }
    }

    if (!resposta.ok) {
      throw criarErroKommo(resposta.status, caminho, dados);
    }

    return dados;
  }

  return {
    async listarPipelines() {
      const dados = await chamar('GET', '/leads/pipelines');
      return (dados && dados._embedded && dados._embedded.pipelines) || [];
    },

    criarPipelines(pipelines) {
      return chamar('POST', '/leads/pipelines', pipelines);
    },

    criarEtapas(pipelineId, etapas) {
      return chamar('POST', `/leads/pipelines/${pipelineId}/statuses`, etapas);
    },

    obterLead(leadId) {
      return chamar('GET', `/leads/${leadId}`);
    },

    atualizarLead(leadId, dados) {
      return chamar('PATCH', `/leads/${leadId}`, dados);
    },

    adicionarNota(leadId, texto) {
      return chamar('POST', `/leads/${leadId}/notes`, [{ note_type: 'common', params: { text: texto } }]);
    },

    criarTarefa(tarefa) {
      return chamar('POST', '/tasks', [tarefa]);
    },

    async listarWebhooks() {
      const dados = await chamar('GET', '/webhooks');
      return (dados && dados._embedded && dados._embedded.webhooks) || [];
    },

    registrarWebhook(destino, eventos) {
      return chamar('POST', '/webhooks', { destination: destino, settings: eventos });
    }
  };
}

/**
 * Cliente a partir das variaveis de ambiente. Devolve null quando a
 * integracao nao esta configurada (o resto do backend segue funcionando).
 */
function criarClienteKommoDoAmbiente(env = process.env, fetchImpl) {
  if (!env.KOMMO_TOKEN || !(env.KOMMO_SUBDOMINIO || env.KOMMO_BASE_URL)) {
    return null;
  }

  return criarClienteKommo({
    subdominio: env.KOMMO_SUBDOMINIO,
    baseUrl: env.KOMMO_BASE_URL,
    token: env.KOMMO_TOKEN,
    fetchImpl
  });
}

module.exports = {
  criarClienteKommo,
  criarClienteKommoDoAmbiente,
  normalizarSubdominio
};
