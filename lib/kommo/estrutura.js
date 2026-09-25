'use strict';

/**
 * Estrutura dos funis no Kommo (Entrada e Comercial), derivada de
 * lib/sdr/regras.js. O nome das etapas no Kommo e o mesmo nome usado pelo
 * motor: e assim que kommo.destino.etapa vira um status_id.
 */

const { PIPELINES, ETAPAS_ENTRADA, ESTAGIOS } = require('../sdr/regras');

// Status de sistema que todo funil do Kommo ja tem.
const STATUS_GANHO = 142;
const STATUS_PERDIDO = 143;

// Etapas do motor que no Kommo sao os fechamentos nativos do funil.
const ETAPAS_DE_FECHAMENTO = {
  [ESTAGIOS.CONFIRMADA]: STATUS_GANHO,
  [ESTAGIOS.PERDIDO]: STATUS_PERDIDO
};

// Cores da paleta aceita pelo Kommo para etapas.
const COR_ENTRADA = '#e6e8ea';
const COR_COMERCIAL = '#d6eaff';

function chave(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function estruturaDesejada() {
  return [
    {
      nome: PIPELINES.ENTRADA,
      // Sem "leads de entrada" (unsorted): chat novo cai direto na Triagem,
      // onde o motor consegue move-lo.
      incomingLeads: false,
      cor: COR_ENTRADA,
      etapas: Object.values(ETAPAS_ENTRADA)
    },
    {
      nome: PIPELINES.COMERCIAL,
      incomingLeads: false,
      cor: COR_COMERCIAL,
      etapas: Object.values(ESTAGIOS).filter(etapa => !ETAPAS_DE_FECHAMENTO[etapa])
    }
  ];
}

function etapasDoPipeline(pipeline) {
  return (pipeline && pipeline._embedded && pipeline._embedded.statuses) || [];
}

/**
 * Compara o que existe no Kommo com o que o SDR precisa.
 * @returns {{ ok: boolean, pipelinesFaltando: object[], etapasFaltando: object[] }}
 */
function planejarEstrutura(pipelinesKommo) {
  const pipelinesFaltando = [];
  const etapasFaltando = [];

  estruturaDesejada().forEach(desejado => {
    const existente = pipelinesKommo.find(p => chave(p.name) === chave(desejado.nome));
    if (!existente) {
      pipelinesFaltando.push(desejado);
      return;
    }

    const nomes = etapasDoPipeline(existente).map(status => chave(status.name));
    desejado.etapas
      .filter(etapa => !nomes.includes(chave(etapa)))
      .forEach(etapa => etapasFaltando.push({ pipeline: desejado.nome, pipelineId: existente.id, etapa, cor: desejado.cor }));
  });

  return {
    ok: pipelinesFaltando.length === 0 && etapasFaltando.length === 0,
    pipelinesFaltando: pipelinesFaltando.map(p => ({ nome: p.nome, etapas: p.etapas })),
    etapasFaltando: etapasFaltando.map(e => ({ pipeline: e.pipeline, etapa: e.etapa })),
    _interno: { pipelinesFaltando, etapasFaltando }
  };
}

/**
 * Mapa nome -> id a partir dos funis do Kommo.
 */
function montarMapa(pipelinesKommo) {
  const pipelines = {};

  estruturaDesejada().forEach(desejado => {
    const existente = pipelinesKommo.find(p => chave(p.name) === chave(desejado.nome));
    if (!existente) {
      return;
    }

    const etapas = {};
    etapasDoPipeline(existente).forEach(status => {
      etapas[chave(status.name)] = status.id;
    });

    pipelines[desejado.nome] = { id: existente.id, etapas };
  });

  return {
    pipelines,

    nomePipeline(pipelineId) {
      const encontrado = Object.keys(pipelines).find(nome => pipelines[nome].id === Number(pipelineId));
      return encontrado || null;
    },

    nomeEtapa(pipelineId, statusId) {
      const nome = this.nomePipeline(pipelineId);
      if (!nome) {
        return null;
      }
      const etapas = pipelines[nome].etapas;
      const encontrada = Object.keys(etapas).find(k => etapas[k] === Number(statusId));
      return encontrada || null;
    },

    statusId(pipelineNome, etapa) {
      const pipeline = pipelines[pipelineNome];
      if (!pipeline || !etapa) {
        return null;
      }
      if (ETAPAS_DE_FECHAMENTO[etapa]) {
        return ETAPAS_DE_FECHAMENTO[etapa];
      }
      return pipeline.etapas[chave(etapa)] || null;
    }
  };
}

function corpoDeEtapas(etapas, cor, sortInicial = 10) {
  return etapas.map((nome, indice) => ({ name: nome, sort: sortInicial + indice * 10, color: cor }));
}

/**
 * Cria no Kommo o que faltar (funis e etapas). Sem `aplicar`, so planeja.
 */
async function sincronizarEstrutura(cliente, opcoes = {}) {
  const antes = await cliente.listarPipelines();
  const plano = planejarEstrutura(antes);
  const { _interno, ...resumo } = plano;

  if (!opcoes.aplicar || plano.ok) {
    return { aplicado: false, plano: resumo, mapa: montarMapa(antes).pipelines };
  }

  if (_interno.pipelinesFaltando.length > 0) {
    const maiorSort = antes.reduce((max, p) => Math.max(max, Number(p.sort) || 0), 0);
    await cliente.criarPipelines(_interno.pipelinesFaltando.map((p, indice) => ({
      name: p.nome,
      sort: maiorSort + (indice + 1) * 10,
      is_main: false,
      is_unsorted_on: p.incomingLeads,
      _embedded: { statuses: corpoDeEtapas(p.etapas, p.cor) }
    })));
  }

  const porPipeline = {};
  _interno.etapasFaltando.forEach(item => {
    porPipeline[item.pipelineId] = porPipeline[item.pipelineId] || { cor: item.cor, etapas: [] };
    porPipeline[item.pipelineId].etapas.push(item.etapa);
  });

  for (const pipelineId of Object.keys(porPipeline)) {
    const existente = antes.find(p => String(p.id) === String(pipelineId));
    const maiorSort = etapasDoPipeline(existente)
      .filter(status => status.id !== STATUS_GANHO && status.id !== STATUS_PERDIDO)
      .reduce((max, status) => Math.max(max, Number(status.sort) || 0), 0);
    await cliente.criarEtapas(pipelineId, corpoDeEtapas(porPipeline[pipelineId].etapas, porPipeline[pipelineId].cor, maiorSort + 10));
  }

  const depois = await cliente.listarPipelines();
  const { _interno: _ignorado, ...resumoFinal } = planejarEstrutura(depois);

  return { aplicado: true, plano: resumo, resultado: resumoFinal, mapa: montarMapa(depois).pipelines };
}

/**
 * Mapa com cache: evita listar funis a cada mensagem recebida.
 */
function criarResolvedorDeMapa(cliente, ttlMs = 10 * 60 * 1000) {
  let cache = null;
  let expiraEm = 0;

  return async function obterMapa(forcar = false) {
    const agora = Date.now();
    if (!forcar && cache && agora < expiraEm) {
      return cache;
    }
    cache = montarMapa(await cliente.listarPipelines());
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
