'use strict';

/**
 * Liga os destinos do motor (lib/sdr) aos funis e etapas reais do Kommo,
 * pelo mapa KOMMO_MAPA de lib/sdr/regras.js.
 *
 * Entrada e Comercial podem ser funis diferentes ou o mesmo funil (etapas de
 * triagem + etapas de venda). Quando dividem o funil, a zona do card sai da
 * etapa em que ele esta.
 *
 * Regra de seguranca: o executor nunca acrescenta etapa em funil que ja
 * existe. So cria um funil inteiro quando ele nao existe, e so com `aplicar`.
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

/** Etapas reais (texto, sem repetir) que um funil logico usa. */
function etapasReaisDe(logico, mapa) {
  const etapas = [];
  etapasLogicas(logico).forEach(etapa => {
    const real = mapa.etapas[etapa];
    if (typeof real === 'string' && !etapas.some(e => chave(e) === chave(real))) {
      etapas.push(real);
    }
  });
  return etapas;
}

/**
 * Funis reais que o mapa precisa, cada um com suas etapas na ordem de
 * criacao (ordemEtapas do mapa quando houver).
 */
function estruturaDesejada(mapa = KOMMO_MAPA) {
  const porNome = [];

  [PIPELINES.ENTRADA, PIPELINES.COMERCIAL].forEach(logico => {
    const nome = mapa.pipelines[logico];
    let funil = porNome.find(f => chave(f.nome) === chave(nome));
    if (!funil) {
      funil = { nome, logicos: [], etapas: [] };
      porNome.push(funil);
    }
    funil.logicos.push(logico);
    etapasReaisDe(logico, mapa).forEach(etapa => {
      if (!funil.etapas.some(e => chave(e) === chave(etapa))) {
        funil.etapas.push(etapa);
      }
    });
  });

  if (Array.isArray(mapa.ordemEtapas)) {
    const posicao = etapa => {
      const indice = mapa.ordemEtapas.findIndex(e => chave(e) === chave(etapa));
      return indice === -1 ? Number.MAX_SAFE_INTEGER : indice;
    };
    porNome.forEach(funil => funil.etapas.sort((a, b) => posicao(a) - posicao(b)));
  }

  return porNome;
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

  [PIPELINES.ENTRADA, PIPELINES.COMERCIAL].forEach(logico => {
    const existente = acharPipeline(pipelinesKommo, mapa.pipelines[logico]);
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

    pipelines[logico] = {
      id: Number(existente.id),
      nome: existente.name,
      etapas,
      incoming,
      // Etapas deste funil logico que o motor pode mover (as do mapa), por id.
      gerenciadas: etapasReaisDe(logico, mapa).map(nome => etapas[chave(nome)]).filter(Boolean)
    };
  });

  const logicosDoId = pipelineId => Object.keys(pipelines).filter(l => pipelines[l].id === Number(pipelineId));

  return {
    pipelines,

    /**
     * Onde um card esta: zona logica ('Entrada'/'Comercial'), se esta em
     * Incoming leads, fechado ou numa etapa que o motor gerencia.
     * logico = null quando o funil nao e do SDR.
     */
    localizar(pipelineId, statusId) {
      const logicos = logicosDoId(pipelineId);
      const status = Number(statusId);
      const fechado = status === STATUS_GANHO || status === STATUS_PERDIDO;
      if (logicos.length === 0) {
        return { doSdr: false, logico: null, incoming: false, fechado, gerenciada: false };
      }

      const incoming = pipelines[logicos[0]].incoming.includes(status);
      const dono = logicos.find(l => pipelines[l].gerenciadas.includes(status));
      let logico = dono || null;
      if (!logico) {
        // Funil unico: fechado conta como Comercial (reabre/recebe anexo).
        // Funis separados: o funil ja diz a zona.
        logico = logicos.length === 1 ? logicos[0] : (fechado || incoming ? PIPELINES.COMERCIAL : null);
      }

      return { doSdr: true, logico, incoming, fechado, gerenciada: Boolean(dono) };
    },

    nomeEtapa(pipelineId, statusId) {
      const [logico] = logicosDoId(pipelineId);
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
    // Sem "Incoming leads": conversa nova cai direto na primeira etapa
    // (Triagem), onde o executor consegue move-la.
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
