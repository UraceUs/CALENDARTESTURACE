'use strict';

/**
 * Triagem de entrada no Kommo.
 *
 * Regra central: TODA mensagem continua chegando pelo canal de origem e fica
 * visivel no inbox. O que esta funcao decide e apenas se aquela interacao
 * vira (ou atualiza) um CARD no pipeline.
 */

const {
  ACOES,
  ESTAGIOS,
  MOTIVOS_ENTRADA,
  MOTIVOS_NAO_ENTRADA,
  LIMIAR_CARD,
  GATILHOS_DIRETOS,
  JANELA_REABERTURA_DIAS
} = require('./regras');

const MS_POR_DIA = 24 * 60 * 60 * 1000;

function diasDesde(valor, agora) {
  if (!valor) {
    return null;
  }

  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) {
    return null;
  }

  return (agora.getTime() - data.getTime()) / MS_POR_DIA;
}

function resultado(acao, motivo, descricao, extras = {}) {
  return {
    acao,
    criarCard: acao === ACOES.CRIAR_CARD,
    atualizaCard: acao === ACOES.CRIAR_CARD || acao === ACOES.ANEXAR_CARD || acao === ACOES.REABRIR_CARD,
    motivo,
    descricao,
    estagioSugerido: null,
    tags: [],
    campos: {},
    score: 0,
    intencoes: [],
    ...extras
  };
}

function montarCampos(evento, analise) {
  const qualificacao = evento.qualificacao || {};
  const sinais = analise.sinais || {};

  const campos = {
    canal: evento.canal,
    origem: evento.origem || evento.canal,
    servico_interesse: qualificacao.servico || sinais.servico || null,
    data_desejada: qualificacao.data || null,
    periodo: qualificacao.periodo || sinais.periodo || null,
    quantidade_pilotos: qualificacao.pilotos || sinais.quantidadePilotos || null,
    pit_id: (evento.reserva && evento.reserva.pitId) || sinais.pitId || null,
    email_contato: qualificacao.contato || sinais.email || (evento.contato && evento.contato.email) || null,
    score_sdr: analise.score,
    sdr_status: 'bot'
  };

  Object.keys(campos).forEach(chave => {
    if (campos[chave] === null || campos[chave] === undefined || campos[chave] === '') {
      delete campos[chave];
    }
  });

  return campos;
}

function qualificacaoSuficiente(evento) {
  const qualificacao = evento.qualificacao || {};
  const contato = evento.contato || {};

  const temServico = Boolean(qualificacao.servico);
  const temQuando = Boolean(qualificacao.data || qualificacao.periodo);
  const temContato = Boolean(qualificacao.contato || qualificacao.nome || contato.email || contato.telefone);

  return temServico && temQuando && temContato;
}

function estagioPorEvento(evento) {
  if (evento.tipo === 'reserva_etapa2') {
    return ESTAGIOS.CONFIRMADA;
  }
  if (evento.tipo === 'reserva_etapa1' || evento.tipo === 'reserva_etapa1_parada') {
    return ESTAGIOS.ETAPA1;
  }
  return null;
}

/**
 * @param {object} evento evento normalizado
 * @param {object} analise saida de classificarMensagem
 * @param {Date} agora referencia temporal (injetavel para testes)
 * @returns {object} decisao de entrada no Kommo
 */
function avaliarEntradaKommo(evento, analise, agora = new Date()) {
  const card = evento.card || {};
  const conversa = evento.conversa || {};
  const base = {
    score: analise.score,
    intencoes: analise.intencoes,
    campos: montarCampos(evento, analise)
  };

  // 1. Ruido estrutural: nunca vira card e nunca recebe resposta.
  if (evento.interno) {
    return resultado(ACOES.IGNORAR, 'CONTATO_INTERNO', MOTIVOS_NAO_ENTRADA.CONTATO_INTERNO, { ...base, campos: {} });
  }

  if (conversa.ehGrupo || conversa.ehTransmissao) {
    return resultado(ACOES.IGNORAR, 'GRUPO_OU_TRANSMISSAO', MOTIVOS_NAO_ENTRADA.GRUPO_OU_TRANSMISSAO, { ...base, campos: {} });
  }

  if (analise.spam) {
    return resultado(ACOES.SOMENTE_CONVERSA, 'SPAM_OU_OFERTA', MOTIVOS_NAO_ENTRADA.SPAM_OU_OFERTA, {
      ...base,
      campos: {},
      tags: ['sdr:spam']
    });
  }

  if (analise.optOut) {
    return resultado(ACOES.SOMENTE_CONVERSA, 'OPT_OUT', MOTIVOS_NAO_ENTRADA.OPT_OUT, {
      ...base,
      campos: {},
      tags: ['sdr:opt-out']
    });
  }

  // 2. Eventos do proprio funil de reserva sempre viram/atualizam card.
  const estagioEvento = estagioPorEvento(evento);
  if (estagioEvento) {
    const motivo = evento.tipo === 'reserva_etapa2'
      ? 'RESERVA_ETAPA2'
      : (evento.tipo === 'reserva_etapa1_parada' ? 'RESERVA_PARADA' : 'RESERVA_ETAPA1');

    return resultado(
      card.existe ? ACOES.ANEXAR_CARD : ACOES.CRIAR_CARD,
      motivo,
      MOTIVOS_ENTRADA[motivo],
      { ...base, estagioSugerido: estagioEvento, tags: ['sdr:reserva'] }
    );
  }

  if (evento.tipo === 'formulario') {
    return resultado(
      card.existe ? ACOES.ANEXAR_CARD : ACOES.CRIAR_CARD,
      'FORMULARIO_SITE',
      MOTIVOS_ENTRADA.FORMULARIO_SITE,
      { ...base, estagioSugerido: ESTAGIOS.NOVO, tags: ['sdr:formulario'] }
    );
  }

  if (evento.tipo === 'chamada_perdida') {
    return resultado(
      card.existe ? ACOES.ANEXAR_CARD : ACOES.CRIAR_CARD,
      'CHAMADA_PERDIDA',
      MOTIVOS_ENTRADA.CHAMADA_PERDIDA,
      { ...base, estagioSugerido: ESTAGIOS.NOVO, tags: ['sdr:chamada-perdida'] }
    );
  }

  // 3. Deduplicacao: contato com card aberto nunca gera card novo.
  if (card.existe && card.status === 'aberto') {
    return resultado(ACOES.ANEXAR_CARD, 'CARD_ABERTO_EXISTENTE', MOTIVOS_NAO_ENTRADA.CARD_ABERTO_EXISTENTE, {
      ...base,
      estagioSugerido: null,
      tags: []
    });
  }

  const temGatilhoDireto = analise.intencoes.some(intencao => GATILHOS_DIRETOS.includes(intencao));
  const temSinalComercial = temGatilhoDireto || analise.sensivel || Boolean(analise.sinais.pitId) || analise.score >= LIMIAR_CARD;

  // 4. Card fechado recente com novo sinal comercial: reabre em vez de duplicar.
  if (card.existe && card.status !== 'aberto') {
    if (!temSinalComercial) {
      return resultado(ACOES.SOMENTE_CONVERSA, 'SEM_SINAL_COMERCIAL', MOTIVOS_NAO_ENTRADA.SEM_SINAL_COMERCIAL, base);
    }

    const dias = diasDesde(card.fechadoEm || card.atualizadoEm, agora);
    if (dias !== null && dias <= JANELA_REABERTURA_DIAS) {
      return resultado(ACOES.REABRIR_CARD, 'INTENCAO_COMERCIAL', MOTIVOS_ENTRADA.INTENCAO_COMERCIAL, {
        ...base,
        estagioSugerido: ESTAGIOS.QUALIFICANDO,
        tags: ['sdr:reaberto']
      });
    }
  }

  // 5. Sem texto util: aguarda contexto (audio/sticker/imagem solta).
  if (!analise.temTextoUtil) {
    return resultado(ACOES.SOMENTE_CONVERSA, 'MIDIA_SEM_CONTEXTO', MOTIVOS_NAO_ENTRADA.MIDIA_SEM_CONTEXTO, { ...base, campos: {} });
  }

  // 6. Dados de qualificacao ja coletados sempre justificam um card.
  if (qualificacaoSuficiente(evento)) {
    return resultado(ACOES.CRIAR_CARD, 'DADOS_QUALIFICACAO', MOTIVOS_ENTRADA.DADOS_QUALIFICACAO, {
      ...base,
      estagioSugerido: ESTAGIOS.QUALIFICANDO,
      tags: ['sdr:qualificacao']
    });
  }

  // 7. Conversa social pura nao abre card.
  if (analise.saudacaoIsolada) {
    return resultado(ACOES.SOMENTE_CONVERSA, 'SAUDACAO_ISOLADA', MOTIVOS_NAO_ENTRADA.SAUDACAO_ISOLADA, base);
  }

  if (analise.encerramento) {
    return resultado(ACOES.SOMENTE_CONVERSA, 'AGRADECIMENTO_OU_ENCERRAMENTO', MOTIVOS_NAO_ENTRADA.AGRADECIMENTO_OU_ENCERRAMENTO, base);
  }

  // 8. Sinais que abrem card.
  if (analise.sensivel) {
    return resultado(ACOES.CRIAR_CARD, 'TEMA_SENSIVEL', MOTIVOS_ENTRADA.TEMA_SENSIVEL, {
      ...base,
      estagioSugerido: ESTAGIOS.HUMANO,
      tags: ['sdr:sensivel']
    });
  }

  if (analise.pedeHumano) {
    return resultado(ACOES.CRIAR_CARD, 'PEDIDO_HUMANO', MOTIVOS_ENTRADA.PEDIDO_HUMANO, {
      ...base,
      estagioSugerido: ESTAGIOS.HUMANO,
      tags: ['sdr:pedido-humano']
    });
  }

  if (analise.intencoes.includes('corporativo') || analise.grupoGrande) {
    return resultado(ACOES.CRIAR_CARD, 'DEMANDA_CORPORATIVA', MOTIVOS_ENTRADA.DEMANDA_CORPORATIVA, {
      ...base,
      estagioSugerido: ESTAGIOS.HUMANO,
      tags: ['sdr:corporativo']
    });
  }

  if (analise.sinais.pitId) {
    return resultado(ACOES.CRIAR_CARD, 'PIT_ID_INFORMADO', MOTIVOS_ENTRADA.PIT_ID_INFORMADO, {
      ...base,
      estagioSugerido: ESTAGIOS.ETAPA1,
      tags: ['sdr:pit-id']
    });
  }

  if (temGatilhoDireto) {
    return resultado(ACOES.CRIAR_CARD, 'INTENCAO_COMERCIAL', MOTIVOS_ENTRADA.INTENCAO_COMERCIAL, {
      ...base,
      estagioSugerido: ESTAGIOS.QUALIFICANDO,
      tags: ['sdr:intencao-comercial']
    });
  }

  if (analise.score >= LIMIAR_CARD) {
    return resultado(ACOES.CRIAR_CARD, 'SCORE_QUALIFICACAO', MOTIVOS_ENTRADA.SCORE_QUALIFICACAO, {
      ...base,
      estagioSugerido: ESTAGIOS.QUALIFICANDO,
      tags: ['sdr:score']
    });
  }

  // 9. Padrao: conversa segue no inbox, sem card.
  return resultado(ACOES.SOMENTE_CONVERSA, 'SEM_SINAL_COMERCIAL', MOTIVOS_NAO_ENTRADA.SEM_SINAL_COMERCIAL, base);
}

module.exports = {
  avaliarEntradaKommo
};
