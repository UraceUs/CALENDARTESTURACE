'use strict';

/**
 * Ponto de entrada do motor de regras do SDR.
 *
 * Fluxo: normalizar evento -> classificar -> triagem (Kommo) -> robo chat.
 * Nenhuma chamada externa: a decisao e deterministica e pode ser testada e
 * auditada isoladamente. Quem aplica a decisao (criar card, mover estagio,
 * enviar mensagem) e a automacao do Kommo/Salesbot.
 */

const regras = require('./regras');
const { classificarMensagem } = require('./classificador');
const { avaliarEntradaKommo } = require('./triagem');
const { decidirRespostaBot } = require('./robochat');

function textoOuNulo(valor) {
  return typeof valor === 'string' && valor.trim().length > 0 ? valor.trim() : null;
}

function numeroOuNulo(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? numero : null;
}

/**
 * Valida o payload recebido do Kommo/Salesbot.
 * @returns {string[]} lista de erros (vazia quando valido)
 */
function validarEvento(payload) {
  const erros = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['PAYLOAD_INVALIDO'];
  }

  const canal = textoOuNulo(payload.canal);
  if (!canal) {
    erros.push('CANAL_OBRIGATORIO');
  } else if (!regras.CANAIS_CONHECIDOS.includes(canal.toLowerCase())) {
    erros.push('CANAL_DESCONHECIDO');
  }

  const tipo = textoOuNulo(payload.tipo) || 'mensagem';
  if (!regras.TIPOS_EVENTO.includes(tipo)) {
    erros.push('TIPO_EVENTO_INVALIDO');
  }

  if (tipo === 'mensagem' && !textoOuNulo(payload.texto) && !textoOuNulo(payload.midia)) {
    erros.push('MENSAGEM_SEM_CONTEUDO');
  }

  return erros;
}

/**
 * Normaliza o payload cru em um evento com formato estavel.
 */
function normalizarEvento(payload = {}) {
  const contato = payload.contato || {};
  const conversa = payload.conversa || {};
  const card = payload.card || {};
  const reserva = payload.reserva || {};
  const qualificacao = payload.qualificacao || {};

  return {
    canal: (textoOuNulo(payload.canal) || '').toLowerCase(),
    tipo: textoOuNulo(payload.tipo) || 'mensagem',
    texto: textoOuNulo(payload.texto) || '',
    midia: textoOuNulo(payload.midia),
    origem: textoOuNulo(payload.origem),
    interno: Boolean(payload.interno),
    recebidoEm: textoOuNulo(payload.recebidoEm),
    contato: {
      id: textoOuNulo(contato.id),
      nome: textoOuNulo(contato.nome),
      telefone: textoOuNulo(contato.telefone),
      email: textoOuNulo(contato.email)
    },
    conversa: {
      id: textoOuNulo(conversa.id),
      ehGrupo: Boolean(conversa.ehGrupo),
      ehTransmissao: Boolean(conversa.ehTransmissao),
      mensagensDoLead: numeroOuNulo(conversa.mensagensDoLead) || 0,
      tentativasSemEntendimento: numeroOuNulo(conversa.tentativasSemEntendimento) || 0,
      tentativasFollowUp: numeroOuNulo(conversa.tentativasFollowUp) || 0
    },
    card: {
      existe: Boolean(card.existe || card.id),
      id: textoOuNulo(card.id),
      estagio: textoOuNulo(card.estagio),
      status: textoOuNulo(card.status) || (card.existe || card.id ? 'aberto' : null),
      responsavelHumano: textoOuNulo(card.responsavelHumano),
      botSilenciado: Boolean(card.botSilenciado),
      atualizadoEm: textoOuNulo(card.atualizadoEm),
      fechadoEm: textoOuNulo(card.fechadoEm)
    },
    reserva: {
      pitId: textoOuNulo(reserva.pitId),
      etapa: numeroOuNulo(reserva.etapa),
      encontrada: typeof reserva.encontrada === 'boolean' ? reserva.encontrada : null
    },
    qualificacao: {
      servico: textoOuNulo(qualificacao.servico),
      // Classificacao A/B/C/D do piloto e origem do lead (local de Orlando ou
      // viajante): as duas perguntas que decidem roteamento e produto.
      origem: textoOuNulo(qualificacao.origem),
      data: textoOuNulo(qualificacao.data),
      periodo: textoOuNulo(qualificacao.periodo),
      pilotos: numeroOuNulo(qualificacao.pilotos),
      experiencia: textoOuNulo(qualificacao.experiencia),
      nome: textoOuNulo(qualificacao.nome),
      contato: textoOuNulo(qualificacao.contato)
    }
  };
}

/**
 * Avalia uma interacao completa.
 *
 * @param {object} payload evento cru vindo do Kommo/Salesbot ou do site
 * @param {object} [opcoes] { agora: Date }
 * @returns {object} { versao, evento, analise, kommo, robo }
 */
function avaliarInteracao(payload, opcoes = {}) {
  const agora = opcoes.agora instanceof Date ? opcoes.agora : new Date();
  const evento = normalizarEvento(payload);
  const analise = classificarMensagem(evento);
  const kommo = avaliarEntradaKommo(evento, analise, agora);
  const robo = decidirRespostaBot(evento, analise, kommo, agora);

  return {
    versaoRegras: regras.VERSAO_REGRAS,
    avaliadoEm: agora.toISOString(),
    evento,
    analise: {
      idioma: analise.idioma,
      intencoes: analise.intencoes,
      sinais: analise.sinais,
      score: analise.score,
      flags: {
        spam: analise.spam,
        optOut: analise.optOut,
        sensivel: analise.sensivel,
        desconto: analise.desconto,
        insatisfacao: analise.insatisfacao,
        grupoGrande: analise.grupoGrande,
        saudacaoIsolada: analise.saudacaoIsolada,
        encerramento: analise.encerramento,
        pedeHumano: analise.pedeHumano
      }
    },
    kommo,
    robo
  };
}

/**
 * Resumo das regras ativas (para auditoria e para o painel admin).
 */
function descreverRegras() {
  return {
    versao: regras.VERSAO_REGRAS,
    canais: { conhecidos: regras.CANAIS_CONHECIDOS, comRobo: regras.CANAIS_COM_ROBO },
    tiposEvento: regras.TIPOS_EVENTO,
    estagios: regras.ESTAGIOS,
    entrada: {
      limiarScore: regras.LIMIAR_CARD,
      gatilhosDiretos: regras.GATILHOS_DIRETOS,
      pesos: regras.PESOS,
      janelaReaberturaDias: regras.JANELA_REABERTURA_DIAS,
      motivosEntrada: regras.MOTIVOS_ENTRADA,
      motivosNaoEntrada: regras.MOTIVOS_NAO_ENTRADA
    },
    robo: {
      estilo: regras.ESTILO_RESPOSTA,
      qualificacao: regras.CAMPOS_QUALIFICACAO,
      followUpMinutos: regras.FOLLOW_UP_MINUTOS,
      maxTentativasSemEntendimento: regras.MAX_TENTATIVAS_SEM_ENTENDIMENTO,
      horarioComercial: regras.HORARIO_COMERCIAL,
      sla: regras.SLA,
      motivosNaoResposta: regras.MOTIVOS_NAO_RESPOSTA,
      motivosEscalonamento: regras.MOTIVOS_ESCALONAMENTO
    }
  };
}

module.exports = {
  avaliarInteracao,
  normalizarEvento,
  validarEvento,
  descreverRegras,
  regras
};
