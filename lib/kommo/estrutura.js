'use strict';

/**
 * Liga os destinos do motor (lib/sdr) aos funis e etapas reais do Kommo,
 * pelo mapa KOMMO_MAPA de lib/sdr/regras.js.
 *
 * Regra de seguranca: o executor nunca acrescenta etapa em funil que ja
 * existe (os funis da equipe sao dela). So cria um funil inteiro quando ele
 * nao existe, e mesmo isso so com `aplicar`.
 */

const { PIPELINES, ETAPAS_ENTRADA, ESTAGIOS, KOMMO_MAPA } = require('../sdr/regras');

const STATUS_GANHO = 142;
const STATUS_PERDIDO = 143;
const TIPO_INCOMING_LEADS = 1;

const COR_PADRAO = '#e6e8ea';

function chave(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function etapasLogicas(pipelineLogico) {
  return pipelineLogico === PIPELINES.ENTRADA ? Object.values(ETAPAS_ENTRADA) : Object.values(ESTAGIOS);
}

/**
 * Para cada funil logico: nome real no Kommo e etapas reais (sem repetir,
 * na ordem do motor, sem os fechamentos nativos).
 */
function estruturaDesejada(mapa = KOMMO_MAPA) {
  return [PIPELINES.ENTRADA, PIPELINES.COMERCIAL].map(logico => {
    const etapas = [];
    etapasLogicas(logico).forEach(etapa => {
      const real = mapa.etapas[etapa];
      if (typeof real === 'string' && !etapas.some(e => chave(e) === chave(real))) {
        etapas.push(real);
      }
    });
    return { logico, nome: mapa.pipelines[logico], etapas };
  });
}

function etapasDoPipeline(pipeline) {
  return (pipeline && pipeline._embedded && pipeline._embedded.statuses) || [];
}

function acharPipeline(pipelinesKommo, nome) {
  return pipelinesKommo.find(p => chave(p.name) === chave(nome)) || null;
}

/**
 * Compara o mapa com o Kommo. `etapasFaltando` em funil existente e erro de
 * configuracao (corrigir o mapa ou o funil a mao), nunca criado sozinho.
 */
function planejarEstrutura(pipelinesKommo, mapa = KOMMO_MAPA) {
  const pipelinesFaltando = [];
  const etapasFaltando = [];
  const etapasDuplicadas = [];

  estruturaDesejada(mapa).forEach(desejado => {
    const existente = acharPipeline(pipelinesKommo, desejado.nome);
    if (!existente) {
      pipelinesFaltando.push({ nome: desejado.nome, etapas: desejado.etapas });
      return;
    }

    const nomes = etapasDoPipeline(existente).map(status => chave(status.name));
    desejado.etapas.forEach(etapa => {
      const ocorrencias = nomes.filter(nome => nome === chave(etapa)).length;
      if (ocorrencias === 0) {
        etapasFaltando.push({ pipeline: desejado.nome, etapa });
      } else if (ocorrencias > 1) {
        etapasDuplicadas.push({ pipeline: desejado.nome, etapa, ocorrencias });
      }
    });
  });

  return {
    ok: pipelinesFaltando.length === 0 && etapasFaltando.length === 0,
    pipelinesFaltando,
    etapasFaltando,
    // Etapa com nome repetido: o executor usa a primeira (menor ordem).
    etapasDuplicadas
  };
}

/**
 * Resolve ids <-> destinos logicos a partir dos funis do Kommo.
 */
function montarMapa(pipelinesKommo, mapa = KOMMO_MAPA) {
  const pipelines = {};

  estruturaDesejada(mapa).forEach(desejado => {
    const existente = acharPipeline(pipelinesKommo, desejado.nome);
    if (!existente) {
      return;
    }

    const etapas = {};
    const incoming = [];
    etapasDoPipeline(existente)
      .slice()
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
      .forEach(status => {
        if (Number(status.type) === TIPO_INCOMING_LEADS) {
          incoming.push(Number(status.id));
        }
        const k = chave(status.name);
        if (etapas[k] === undefined) {
          etapas[k] = Number(status.id);
        }
      });

    // Etapas deste funil que o motor pode mover (as do mapa), por id.
    const gerenciadas = desejado.etapas.map(nome => etapas[chave(nome)]).filter(Boolean);

    pipelines[desejado.logico] = {
      id: Number(existente.id),
      nome: existente.name,
      etapas,
      incoming,
      gerenciadas
    };
  });

  return {
    pipelines,

    /** Funil logico ('Entrada'/'Comercial') de um pipeline_id, ou null. */
    nomePipeline(pipelineId) {
      return Object.keys(pipelines).find(logico => pipelines[logico].id === Number(pipelineId)) || null;
    },

    nomeEtapa(pipelineId, statusId) {
      const logico = this.nomePipeline(pipelineId);
      if (!logico) {
        return null;
      }
      const etapas = pipelines[logico].etapas;
      return Object.keys(etapas).find(k => etapas[k] === Number(statusId)) || null;
    },

    /** status_id real para um destino do motor. */
    statusId(pipelineLogico, etapaLogica) {
      const pipeline = pipelines[pipelineLogico];
      const real = mapa.etapas[etapaLogica];
      if (!pipeline || real === undefined) {
        return null;
      }
      if (typeof real === 'number') {
        return real;
      }
      return pipeline.etapas[chave(real)] || null;
    },

    ehIncoming(pipelineId, statusId) {
      const logico = this.nomePipeline(pipelineId);
      return Boolean(logico) && pipelines[logico].incoming.includes(Number(statusId));
    },

    /** Etapa que o motor pode mexer (as do mapa); o resto e da equipe. */
    ehGerenciada(pipelineId, statusId) {
      const logico = this.nomePipeline(pipelineId);
      return Boolean(logico) && pipelines[logico].gerenciadas.includes(Number(statusId));
    },

    tagsExtras(motivo) {
      return (mapa.tagsPorMotivo && mapa.tagsPorMotivo[motivo]) || [];
    }
  };
}

function corpoDeEtapas(etapas) {
  return etapas.map((nome, indice) => ({ name: nome, sort: 20 + indice * 10, color: COR_PADRAO }));
}

/**
 * Confere o mapa contra o Kommo. Com `aplicar`, cria apenas funis que nao
 * existem. Etapa faltando em funil existente volta como pendencia.
 */
async function sincronizarEstrutura(cliente, opcoes = {}) {
  const mapa = opcoes.mapa || KOMMO_MAPA;
  const antes = await cliente.listarPipelines();
  const plano = planejarEstrutura(antes, mapa);

  if (!opcoes.aplicar || plano.pipelinesFaltando.length === 0) {
    return { aplicado: false, plano, mapa: montarMapa(antes, mapa).pipelines };
  }

  const maiorSort = antes.reduce((max, p) => Math.max(max, Number(p.sort) || 0), 0);
  await cliente.criarPipelines(plano.pipelinesFaltando.map((p, indice) => ({
    name: p.nome,
    sort: maiorSort + (indice + 1) * 10,
    is_main: false,
    is_unsorted_on: false,
    _embedded: { statuses: corpoDeEtapas(p.etapas) }
  })));

  const depois = await cliente.listarPipelines();
  return {
    aplicado: true,
    plano,
    resultado: planejarEstrutura(depois, mapa),
    mapa: montarMapa(depois, mapa).pipelines
  };
}

/**
 * Mapa com cache: evita listar funis a cada mensagem recebida.
 */
function criarResolvedorDeMapa(cliente, ttlMs = 10 * 60 * 1000, mapa = KOMMO_MAPA) {
  let cache = null;
  let expiraEm = 0;

  return async function obterMapa(forcar = false) {
    const agora = Date.now();
    if (!forcar && cache && agora < expiraEm) {
      return cache;
    }
    cache = montarMapa(await cliente.listarPipelines(), mapa);
    expiraEm = agora + ttlMs;
    return cache;
  };
}

module.exports = {
  STATUS_GANHO,
  STATUS_PERDIDO,
  estruturaDesejada,
  planejarEstrutura,
  montarMapa,
  sincronizarEstrutura,
  criarResolvedorDeMapa
};
