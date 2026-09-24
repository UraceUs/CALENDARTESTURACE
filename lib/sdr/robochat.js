'use strict';

/**
 * Robo chat (SDR).
 *
 * Decide se o robo responde, o que responde, e quando/como aciona um humano.
 * Funcao pura: recebe o estado que o Kommo ja conhece e devolve a decisao.
 */

const { normalizarTexto } = require('./classificador');
const {
  ACOES,
  ESTAGIOS,
  CANAIS_COM_ROBO,
  MENSAGENS,
  MOTIVOS_NAO_RESPOSTA,
  MOTIVOS_ESCALONAMENTO,
  CAMPOS_QUALIFICACAO,
  ESTILO_RESPOSTA,
  FOLLOW_UP_MINUTOS,
  MAX_TENTATIVAS_SEM_ENTENDIMENTO,
  HORARIO_COMERCIAL,
  NUNCA_DIZER,
  MAX_REALERTAS,
  JANELA_SALESBOT_SEGUNDOS,
  SLA
} = require('./regras');

// ---------------------------------------------------------------------------
// Horario comercial
// ---------------------------------------------------------------------------

const DIAS_SEMANA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Usa o fuso real (com horario de verao) em vez de offset fixo: a operacao
// fica em Orlando, onde o offset muda duas vezes por ano.
function horarioLocal(agora) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: HORARIO_COMERCIAL.fuso,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(agora).reduce((acc, parte) => {
    acc[parte.type] = parte.value;
    return acc;
  }, {});

  return {
    diaSemana: DIAS_SEMANA[partes.weekday],
    hora: Number(partes.hour) % 24,
    minuto: Number(partes.minute)
  };
}

function dentroDoHorarioComercial(agora) {
  const local = horarioLocal(agora);
  return HORARIO_COMERCIAL.diasSemana.includes(local.diaSemana)
    && local.hora >= HORARIO_COMERCIAL.inicioHora
    && local.hora < HORARIO_COMERCIAL.fimHora;
}

function minutosAteAbertura(agora) {
  if (dentroDoHorarioComercial(agora)) {
    return 0;
  }

  const local = horarioLocal(agora);
  let minutos = 0;
  let dia = local.diaSemana;
  let hora = local.hora;
  const minutoAtual = local.minuto;

  // Mesmo dia util, antes da abertura.
  if (HORARIO_COMERCIAL.diasSemana.includes(dia) && hora < HORARIO_COMERCIAL.inicioHora) {
    return (HORARIO_COMERCIAL.inicioHora - hora) * 60 - minutoAtual;
  }

  // Vai para a abertura do proximo dia util.
  minutos = (24 - hora) * 60 - minutoAtual;
  hora = 0;
  dia = (dia + 1) % 7;

  for (let i = 0; i < 7; i += 1) {
    if (HORARIO_COMERCIAL.diasSemana.includes(dia)) {
      return minutos + HORARIO_COMERCIAL.inicioHora * 60;
    }
    minutos += 24 * 60;
    dia = (dia + 1) % 7;
  }

  return minutos;
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

const REGEX_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

/**
 * Verifica se um texto contem alguma frase proibida.
 * @returns {object|null} a entrada de NUNCA_DIZER encontrada, ou null
 */
function frasseProibida(texto) {
  const normalizado = normalizarTexto(texto);
  return NUNCA_DIZER.find(item => normalizado.includes(normalizarTexto(item.termo))) || null;
}

function aplicarEstilo(texto) {
  let saida = texto;

  if (ESTILO_RESPOSTA.travessaoProibido) {
    saida = saida.replace(/\s*[\u2013\u2014]\s*/g, ', ');
  }

  if (ESTILO_RESPOSTA.maxEmojisPorMensagem === 0) {
    saida = saida.replace(REGEX_EMOJI, '').replace(/\s{2,}/g, ' ').trim();
  }

  if (saida.length > ESTILO_RESPOSTA.maxCaracteresPorMensagem) {
    saida = `${saida.slice(0, ESTILO_RESPOSTA.maxCaracteresPorMensagem - 3).trimEnd()}...`;
  }

  return saida;
}

function prepararMensagens(lista) {
  return lista
    .filter(item => typeof item === 'string' && item.trim().length > 0)
    .slice(0, ESTILO_RESPOSTA.maxMensagensPorTurno)
    .map(aplicarEstilo)
    // Ultima barreira: mensagem com frase proibida nao sai. Cada frase dessa
    // lista custou um incidente real no projeto Chase.
    .filter(item => frasseProibida(item) === null);
}

function dadosConhecidos(evento, analise) {
  const qualificacao = evento.qualificacao || {};
  const sinais = analise.sinais || {};
  const contato = evento.contato || {};

  return {
    servico: qualificacao.servico || sinais.servico || null,
    data: qualificacao.data || (sinais.dataMencionada ? 'informada na conversa' : null),
    periodo: qualificacao.periodo || sinais.periodo || null,
    pilotos: qualificacao.pilotos || sinais.quantidadePilotos || null,
    experiencia: qualificacao.experiencia || sinais.classificacaoExperiencia || null,
    origem: qualificacao.origem || sinais.origem || null,
    nome: qualificacao.nome || contato.nome || null,
    contato: qualificacao.contato || sinais.email || contato.email || null
  };
}

function camposFaltantes(dados) {
  return CAMPOS_QUALIFICACAO
    .filter(item => !dados[item.campo])
    .map(item => item.campo);
}

function proximaPerguntaPara(dados) {
  const pendente = CAMPOS_QUALIFICACAO.find(item => !dados[item.campo]);
  return pendente ? pendente.pergunta : null;
}

function montarResumo(evento, analise, dados) {
  const contato = evento.contato || {};

  return {
    canal: evento.canal,
    contato: {
      nome: dados.nome || contato.nome || null,
      telefone: contato.telefone || null,
      email: dados.contato || contato.email || null
    },
    servico: dados.servico,
    data: dados.data,
    periodo: dados.periodo,
    pilotos: dados.pilotos,
    experiencia: dados.experiencia,
    pitId: (evento.reserva && evento.reserva.pitId) || analise.sinais.pitId || null,
    classificacaoExperiencia: dados.experiencia,
    origem: dados.origem,
    score: analise.score,
    intencoes: analise.intencoes,
    dadosFaltantes: camposFaltantes(dados),
    ultimaMensagem: analise.texto || null
  };
}

function montarEscalonamento(motivo, opcoes) {
  const {
    prioridade = 'media',
    estagio = ESTAGIOS.HUMANO,
    resumo = null,
    tags = [],
    agora = new Date()
  } = opcoes || {};

  const prioritaria = prioridade === 'alta';
  const slaMinutos = prioritaria ? SLA.tarefaHumanoPrioritariaMinutos : SLA.tarefaHumanoMinutos;
  const esperaAbertura = minutosAteAbertura(agora);

  return {
    escalar: true,
    motivo,
    descricao: MOTIVOS_ESCALONAMENTO[motivo] || motivo,
    prioridade,
    estagio,
    responsavel: 'rodizio_comercial',
    slaMinutos,
    dentroDoHorarioComercial: esperaAbertura === 0,
    tarefa: {
      titulo: `SDR: ${MOTIVOS_ESCALONAMENTO[motivo] || motivo}`,
      prazoMinutos: esperaAbertura + slaMinutos
    },
    notificar: ['responsavel_do_card', 'grupo_comercial'],
    // A notificacao sai fora do caminho da resposta ao lead: no Chase, avisar
    // humanos de forma bloqueante consumia a janela de ~58s do Salesbot.
    notificacaoAssincrona: true,
    janelaSalesbotSegundos: JANELA_SALESBOT_SEGUNDOS,
    // Primeiro aviso nunca tem cooldown; o teto vale so para os re-alertas.
    maxRealertas: MAX_REALERTAS,
    aposMaxRealertas: 'criar_tarefa_no_kommo',
    tags: ['sdr:handoff', `handoff:${motivo.toLowerCase()}`, ...tags],
    resumo
  };
}

function decisao(extras) {
  return {
    responder: false,
    motivo: null,
    descricao: null,
    mensagens: [],
    proximaPergunta: null,
    dadosFaltantes: [],
    escalonamento: null,
    followUp: null,
    silenciarBot: false,
    foraDoHorarioComercial: false,
    ...extras
  };
}

function followUpPara(evento) {
  const conversa = evento.conversa || {};
  const tentativa = Number(conversa.tentativasFollowUp || 0);

  if (tentativa >= FOLLOW_UP_MINUTOS.length) {
    return {
      agendar: false,
      tentativa,
      maxTentativas: FOLLOW_UP_MINUTOS.length,
      emMinutos: null,
      acaoFinal: 'marcar_perdido_sem_resposta'
    };
  }

  return {
    agendar: true,
    tentativa: tentativa + 1,
    maxTentativas: FOLLOW_UP_MINUTOS.length,
    emMinutos: FOLLOW_UP_MINUTOS[tentativa],
    acaoFinal: null
  };
}

// ---------------------------------------------------------------------------
// Decisao principal
// ---------------------------------------------------------------------------

/**
 * @param {object} evento evento normalizado
 * @param {object} analise saida de classificarMensagem
 * @param {object} triagem saida de avaliarEntradaKommo
 * @param {Date} agora referencia temporal (injetavel para testes)
 */
function decidirRespostaBot(evento, analise, triagem, agora = new Date()) {
  const card = evento.card || {};
  const dados = dadosConhecidos(evento, analise);
  const resumo = montarResumo(evento, analise, dados);
  const fora = !dentroDoHorarioComercial(agora);
  const avisoHorario = fora ? MENSAGENS.foraDoHorario : null;

  const naoResponder = (motivo, extras = {}) => decisao({
    responder: false,
    motivo,
    descricao: MOTIVOS_NAO_RESPOSTA[motivo] || motivo,
    foraDoHorarioComercial: fora,
    ...extras
  });

  const responder = (mensagens, extras = {}) => decisao({
    responder: true,
    mensagens: prepararMensagens(mensagens),
    foraDoHorarioComercial: fora,
    dadosFaltantes: camposFaltantes(dados),
    ...extras
  });

  // 1. Ruido estrutural.
  if (triagem.acao === ACOES.IGNORAR) {
    return naoResponder(triagem.motivo === 'CONTATO_INTERNO' ? 'CONTATO_INTERNO' : 'GRUPO_OU_TRANSMISSAO');
  }

  if (analise.spam) {
    return naoResponder('SPAM_OU_OFERTA');
  }

  // 2. Opt-out: uma unica confirmacao e silencio definitivo.
  if (analise.optOut) {
    return responder([MENSAGENS.optOut], {
      motivo: 'OPT_OUT',
      descricao: MOTIVOS_NAO_RESPOSTA.OPT_OUT,
      silenciarBot: true
    });
  }

  // 3. Humano no comando: o robo cala a boca.
  if (card.botSilenciado) {
    return naoResponder('BOT_SILENCIADO', { silenciarBot: true });
  }

  if (card.responsavelHumano) {
    const urgente = analise.sensivel || analise.insatisfacao;
    return naoResponder('HUMANO_NO_ATENDIMENTO', {
      silenciarBot: true,
      escalonamento: urgente
        ? montarEscalonamento(analise.sensivel ? 'TEMA_SENSIVEL' : 'LEAD_INSATISFEITO', {
          prioridade: 'alta',
          estagio: card.estagio || ESTAGIOS.HUMANO,
          resumo,
          agora
        })
        : null
    });
  }

  // 4. Canal sem robo: nunca responde automaticamente, mas nao deixa parado.
  if (!CANAIS_COM_ROBO.includes(evento.canal)) {
    return naoResponder('CANAL_SEM_ROBO', {
      escalonamento: triagem.atualizaCard
        ? montarEscalonamento('PEDIDO_HUMANO', { prioridade: 'media', resumo, agora })
        : null
    });
  }

  // 5. Temas que saem do robo imediatamente.
  if (analise.sensivel) {
    return responder([MENSAGENS.sensivel, avisoHorario], {
      motivo: 'TEMA_SENSIVEL',
      silenciarBot: true,
      escalonamento: montarEscalonamento('TEMA_SENSIVEL', { prioridade: 'alta', resumo, agora })
    });
  }

  if (analise.pedeHumano) {
    return responder([MENSAGENS.pedidoHumano, avisoHorario], {
      motivo: 'PEDIDO_HUMANO',
      silenciarBot: true,
      escalonamento: montarEscalonamento('PEDIDO_HUMANO', { prioridade: 'alta', resumo, agora })
    });
  }

  if (analise.insatisfacao) {
    return responder([MENSAGENS.pedidoHumano, avisoHorario], {
      motivo: 'LEAD_INSATISFEITO',
      silenciarBot: true,
      escalonamento: montarEscalonamento('LEAD_INSATISFEITO', { prioridade: 'alta', resumo, agora })
    });
  }

  // Lead que sinaliza avanco nao espera atras de pergunta de formulario
  // (licao do Chase, cenario 19): escala na mesma resposta, com o que falta
  // declarado no briefing.
  if (analise.sinalDeConversao) {
    return responder([MENSAGENS.conversao, avisoHorario], {
      motivo: 'SINAL_CONVERSAO',
      silenciarBot: true,
      escalonamento: montarEscalonamento('SINAL_CONVERSAO', { prioridade: 'alta', resumo, agora })
    });
  }

  // Classificacao D (compete atualmente) vai direto para o time, sem
  // qualificacao e sem pedir visita ao site.
  if (analise.compete) {
    return responder([MENSAGENS.compete, avisoHorario], {
      motivo: 'PILOTO_COMPETIDOR',
      silenciarBot: true,
      escalonamento: montarEscalonamento('PILOTO_COMPETIDOR', { prioridade: 'alta', resumo, agora })
    });
  }

  if (analise.desconto) {
    return responder([MENSAGENS.negociacao, avisoHorario], {
      motivo: 'NEGOCIACAO',
      silenciarBot: true,
      escalonamento: montarEscalonamento('NEGOCIACAO', { prioridade: 'media', resumo, agora })
    });
  }

  if (analise.intencoes.includes('corporativo') || analise.grupoGrande) {
    return responder([MENSAGENS.corporativo, avisoHorario], {
      motivo: 'CORPORATIVO',
      silenciarBot: true,
      escalonamento: montarEscalonamento('CORPORATIVO', { prioridade: 'media', resumo, agora })
    });
  }

  // 6. Eventos do funil de reserva.
  if (evento.tipo === 'reserva_etapa2') {
    return naoResponder('FLUXO_AUTOMATICO');
  }

  if (evento.tipo === 'reserva_etapa1') {
    return responder([MENSAGENS.briefingPendente], {
      motivo: 'RESERVA_ETAPA1',
      followUp: followUpPara(evento)
    });
  }

  if (evento.tipo === 'reserva_etapa1_parada') {
    return responder([MENSAGENS.recuperacaoEtapa1], {
      motivo: 'RESERVA_PARADA',
      followUp: followUpPara(evento),
      escalonamento: montarEscalonamento('RESERVA_PARADA', {
        prioridade: 'media',
        estagio: ESTAGIOS.ETAPA1,
        resumo,
        agora
      })
    });
  }

  if (evento.tipo === 'chamada_perdida' || evento.tipo === 'formulario') {
    const jaConversou = Number((evento.conversa || {}).mensagensDoLead || 0) > 1;
    return responder(jaConversou ? [proximaPerguntaPara(dados)] : [MENSAGENS.abertura, proximaPerguntaPara(dados)], {
      motivo: 'PRIMEIRO_CONTATO',
      proximaPergunta: proximaPerguntaPara(dados),
      followUp: followUpPara(evento)
    });
  }

  // 7. Encerramento e midia sem contexto.
  if (analise.encerramento) {
    return naoResponder('AGRADECIMENTO_OU_ENCERRAMENTO');
  }

  if (!analise.temTextoUtil) {
    const tentativas = Number((evento.conversa || {}).tentativasSemEntendimento || 0);
    if (tentativas >= MAX_TENTATIVAS_SEM_ENTENDIMENTO) {
      return responder([MENSAGENS.pedidoHumano], {
        motivo: 'SEM_ENTENDIMENTO',
        silenciarBot: true,
        escalonamento: montarEscalonamento('SEM_ENTENDIMENTO', { prioridade: 'media', resumo, agora })
      });
    }

    return responder([MENSAGENS.pedirTexto], { motivo: 'MIDIA_SEM_CONTEXTO' });
  }

  // 8. Suporte a reserva existente via Pit ID.
  if (analise.sinais.pitId) {
    const reserva = evento.reserva || {};
    if (reserva.encontrada === false) {
      return responder([MENSAGENS.pitIdNaoEncontrado], {
        motivo: 'FALHA_TECNICA',
        silenciarBot: true,
        escalonamento: montarEscalonamento('FALHA_TECNICA', { prioridade: 'alta', resumo, agora })
      });
    }

    return responder([MENSAGENS.briefingPendente], {
      motivo: 'SUPORTE_RESERVA',
      followUp: followUpPara(evento)
    });
  }

  // 9. Qualificacao completa: handoff para vendas.
  const faltantes = camposFaltantes(dados);
  if (faltantes.length === 0) {
    return responder([MENSAGENS.handoff, avisoHorario], {
      motivo: 'LEAD_QUALIFICADO',
      silenciarBot: true,
      escalonamento: montarEscalonamento('LEAD_QUALIFICADO', { prioridade: 'alta', resumo, agora })
    });
  }

  // 10. Conversa de qualificacao normal.
  const pergunta = proximaPerguntaPara(dados);

  if (analise.intencoes.includes('preco')) {
    // Nunca falar de valor antes de classificar a experiencia: o programa (e
    // o preco) mudam com o nivel do piloto.
    if (!dados.experiencia) {
      return responder([MENSAGENS.precoAntesDaClassificacao, pergunta], {
        motivo: 'PRECO_ANTES_DA_CLASSIFICACAO',
        proximaPergunta: pergunta,
        followUp: followUpPara(evento)
      });
    }

    return responder([MENSAGENS.preco, pergunta], {
      motivo: 'PRECO',
      proximaPergunta: pergunta,
      followUp: followUpPara(evento)
    });
  }

  if (analise.intencoes.includes('agenda') || analise.intencoes.includes('contratacao')) {
    return responder([MENSAGENS.agenda, pergunta], {
      motivo: 'AGENDA',
      proximaPergunta: pergunta,
      followUp: followUpPara(evento)
    });
  }

  if (analise.intencoes.includes('informacao') || analise.intencoes.includes('servico')) {
    return responder([MENSAGENS.informacao, pergunta], {
      motivo: 'INFORMACAO',
      proximaPergunta: pergunta,
      followUp: followUpPara(evento)
    });
  }

  if (analise.saudacaoIsolada) {
    // Lead que ja conversou antes nao ouve a abertura de novo: reapresentar o
    // menu a quem ja respondeu e como o cliente aprende que ninguem escutou
    // (caso real de 27/08 no projeto Chase).
    const primeiraMensagem = Number((evento.conversa || {}).mensagensDoLead || 0) <= 1;

    return responder(primeiraMensagem ? [MENSAGENS.abertura, pergunta] : [pergunta], {
      motivo: primeiraMensagem ? 'SAUDACAO' : 'LEAD_RETORNANTE',
      proximaPergunta: pergunta,
      followUp: followUpPara(evento)
    });
  }

  // 11. Robo nao entendeu.
  const tentativas = Number((evento.conversa || {}).tentativasSemEntendimento || 0);
  if (tentativas >= MAX_TENTATIVAS_SEM_ENTENDIMENTO) {
    return responder([MENSAGENS.pedidoHumano], {
      motivo: 'SEM_ENTENDIMENTO',
      silenciarBot: true,
      escalonamento: montarEscalonamento('SEM_ENTENDIMENTO', { prioridade: 'media', resumo, agora })
    });
  }

  return responder([MENSAGENS.semEntendimento], {
    motivo: 'SEM_ENTENDIMENTO_TENTATIVA',
    followUp: followUpPara(evento)
  });
}

module.exports = {
  decidirRespostaBot,
  frasseProibida,
  dentroDoHorarioComercial,
  minutosAteAbertura
};
