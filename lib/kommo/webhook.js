'use strict';

/**
 * Webhook de mensagens do Kommo -> motor do SDR -> acoes no Kommo.
 *
 * Fluxo por mensagem recebida (message[add], type=incoming):
 *   1. le o lead (funil, etapa, tags);
 *   2. avalia com lib/sdr (mesmas regras de POST /api/sdr/avaliar);
 *   3. aplica kommo.destino (move de etapa / desce para o Comercial), tags,
 *      nota e, no handoff, tarefa para o responsavel.
 *
 * As respostas do robo ao lead continuam saindo pelo Salesbot, que chama
 * /api/sdr/avaliar. Aqui so se mexe no card.
 */

const sdr = require('../sdr');
const { STATUS_GANHO, STATUS_PERDIDO } = require('./estrutura');

const TAG_BOT_SILENCIADO = 'sdr:bot-silenciado';
const TIPO_TAREFA_CONTATO = 1;

function definirCaminho(alvo, partes, valor) {
  let atual = alvo;
  partes.forEach((parte, indice) => {
    if (indice === partes.length - 1) {
      atual[parte] = valor;
      return;
    }
    if (typeof atual[parte] !== 'object' || atual[parte] === null) {
      atual[parte] = {};
    }
    atual = atual[parte];
  });
}

/**
 * Converte o corpo x-www-form-urlencoded do Kommo (chaves com colchetes,
 * ex.: message[add][0][text]) em objeto. Aceita JSON tambem.
 */
function parseCorpoWebhook(bruto, contentType = '') {
  const texto = Buffer.isBuffer(bruto) ? bruto.toString('utf8') : String(bruto || '');
  if (!texto.trim()) {
    return {};
  }

  if (contentType.includes('application/json') || texto.trim().startsWith('{')) {
    return JSON.parse(texto);
  }

  const resultado = {};
  new URLSearchParams(texto).forEach((valor, chaveBruta) => {
    const partes = chaveBruta.replace(/\]/g, '').split('[').filter(parte => parte !== '');
    definirCaminho(resultado, partes, valor);
  });
  return resultado;
}

function canalPorOrigem(origem) {
  const valor = String(origem || '').toLowerCase();
  if (valor.includes('whats') || valor.includes('waba') || valor.includes('wa_')) return 'whatsapp';
  if (valor.includes('insta')) return 'instagram';
  if (valor.includes('facebook') || valor.includes('messenger') || valor === 'fb') return 'messenger';
  if (valor.includes('telegram')) return 'telegram';
  if (valor.includes('mail')) return 'email';
  return 'site';
}

/**
 * Mensagens recebidas (do lead) contidas no webhook.
 */
function extrairMensagensRecebidas(corpo) {
  const adicionadas = (corpo && corpo.message && corpo.message.add) || {};

  return Object.values(adicionadas)
    .filter(msg => msg && (!msg.type || msg.type === 'incoming'))
    .map(msg => {
      const tipoEntidade = String(msg.element_type || msg.entity_type || '');
      const ehLead = tipoEntidade === '2' || tipoEntidade === 'lead' || tipoEntidade === 'leads';
      return {
        id: msg.id || null,
        texto: msg.text || '',
        leadId: ehLead ? (msg.element_id || msg.entity_id || null) : null,
        contatoId: msg.contact_id || null,
        chatId: msg.chat_id || null,
        origem: msg.origin || null,
        midia: msg.attachment ? (msg.attachment.type || 'anexo') : null
      };
    });
}

function isoDeUnix(valor) {
  const numero = Number(valor);
  return numero > 0 ? new Date(numero * 1000).toISOString() : null;
}

function tagsDoLead(lead) {
  return ((lead && lead._embedded && lead._embedded.tags) || []).map(tag => tag.name);
}

function montarPayload(mensagem, lead, mapa) {
  const statusId = Number(lead.status_id);
  const fechado = statusId === STATUS_GANHO || statusId === STATUS_PERDIDO;

  return {
    canal: canalPorOrigem(mensagem.origem),
    tipo: 'mensagem',
    texto: mensagem.texto,
    midia: mensagem.texto ? mensagem.midia : (mensagem.midia || 'anexo'),
    origem: mensagem.origem,
    contato: { id: mensagem.contatoId ? String(mensagem.contatoId) : null },
    conversa: { id: mensagem.chatId },
    card: {
      existe: true,
      id: String(lead.id),
      pipeline: mapa.nomePipeline(lead.pipeline_id),
      estagio: mapa.nomeEtapa(lead.pipeline_id, statusId),
      status: fechado ? 'fechado' : 'aberto',
      botSilenciado: tagsDoLead(lead).includes(TAG_BOT_SILENCIADO),
      atualizadoEm: isoDeUnix(lead.updated_at),
      fechadoEm: isoDeUnix(lead.closed_at)
    }
  };
}

function textoDaNota(decisao) {
  const { kommo, robo } = decisao;
  const linhas = [`SDR: ${kommo.acao} (${kommo.motivo}) - ${kommo.descricao}`];

  if (kommo.destino && kommo.destino.mover) {
    linhas.push(`Destino: ${kommo.destino.pipeline} / ${kommo.destino.etapa}`);
  }

  const campos = Object.entries(kommo.campos || {}).map(([k, v]) => `${k}: ${v}`);
  if (campos.length > 0) {
    linhas.push(campos.join(' | '));
  }

  if (robo.escalonamento) {
    const esc = robo.escalonamento;
    linhas.push(`HANDOFF ${esc.prioridade.toUpperCase()}: ${esc.descricao}`);
    if (esc.resumo) {
      linhas.push(Object.entries(esc.resumo)
        .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n'));
    }
  }

  return linhas.join('\n');
}

/**
 * Aplica a decisao do motor a um lead. Devolve o que foi feito (para log).
 */
async function aplicarDecisao(cliente, lead, decisao, mapa, opcoes = {}) {
  const { kommo, robo } = decisao;
  const feito = { leadId: lead.id, acao: kommo.acao, motivo: kommo.motivo, moveu: false, tags: [], nota: false, tarefa: false };

  const atualizacao = {};
  const destino = kommo.destino || {};
  if (destino.mover && destino.etapa) {
    const statusId = mapa.statusId(destino.pipeline, destino.etapa);
    const pipelineId = mapa.pipelines[destino.pipeline] && mapa.pipelines[destino.pipeline].id;

    if (statusId && pipelineId && (Number(lead.status_id) !== statusId || Number(lead.pipeline_id) !== pipelineId)) {
      atualizacao.pipeline_id = pipelineId;
      atualizacao.status_id = statusId;
      feito.moveu = { pipeline: destino.pipeline, etapa: destino.etapa };
    } else if (!statusId) {
      feito.aviso = `Etapa nao encontrada no Kommo: ${destino.pipeline} / ${destino.etapa}`;
    }
  }

  const tags = new Set(kommo.tags || []);
  if (robo.escalonamento) {
    (robo.escalonamento.tags || []).forEach(tag => tags.add(tag));
  }
  if (robo.silenciarBot) {
    tags.add(TAG_BOT_SILENCIADO);
  }
  const existentes = tagsDoLead(lead);
  const novas = [...tags].filter(tag => !existentes.includes(tag));
  if (novas.length > 0) {
    atualizacao.tags_to_add = novas.map(name => ({ name }));
    feito.tags = novas;
  }

  if (Object.keys(atualizacao).length > 0) {
    await cliente.atualizarLead(lead.id, atualizacao);
  }

  // Nota so quando o card entra/volta ao Comercial ou vai para humano:
  // mensagem que so fica na Entrada nao polui o historico.
  const entrouNoComercial = ['criar_card', 'promover_card', 'reabrir_card'].includes(kommo.acao);
  if (entrouNoComercial || robo.escalonamento) {
    await cliente.adicionarNota(lead.id, textoDaNota(decisao));
    feito.nota = true;
  }

  if (robo.escalonamento) {
    const agora = opcoes.agora || new Date();
    const prazoMinutos = (robo.escalonamento.tarefa && robo.escalonamento.tarefa.prazoMinutos) || 15;
    const tarefa = {
      text: robo.escalonamento.tarefa ? robo.escalonamento.tarefa.titulo : `SDR: ${robo.escalonamento.motivo}`,
      complete_till: Math.floor(agora.getTime() / 1000) + prazoMinutos * 60,
      entity_id: Number(lead.id),
      entity_type: 'leads',
      task_type_id: TIPO_TAREFA_CONTATO
    };
    const responsavel = Number(opcoes.responsavelId || lead.responsible_user_id);
    if (responsavel) {
      tarefa.responsible_user_id = responsavel;
    }
    await cliente.criarTarefa(tarefa);
    feito.tarefa = { prazoMinutos, prioridade: robo.escalonamento.prioridade };
  }

  return feito;
}

/**
 * Integracao completa: recebe o corpo do webhook e processa cada mensagem.
 */
function criarIntegracaoKommo({ cliente, obterMapa, responsavelId = null, log = console }) {
  const processadas = new Set();

  async function processarMensagem(mensagem, agora = new Date()) {
    if (!mensagem.leadId) {
      return { ignorado: 'SEM_LEAD', mensagemId: mensagem.id };
    }

    if (mensagem.id) {
      if (processadas.has(mensagem.id)) {
        return { ignorado: 'DUPLICADA', mensagemId: mensagem.id };
      }
      processadas.add(mensagem.id);
      if (processadas.size > 2000) {
        processadas.delete(processadas.values().next().value);
      }
    }

    const mapa = await obterMapa();
    const lead = await cliente.obterLead(mensagem.leadId);

    // Lead em funil antigo/outro: fora do SDR, nao mexe.
    if (!mapa.nomePipeline(lead.pipeline_id)) {
      return { ignorado: 'PIPELINE_FORA_DO_SDR', leadId: lead.id, pipelineId: lead.pipeline_id };
    }

    const payload = montarPayload(mensagem, lead, mapa);
    const erros = sdr.validarEvento(payload);
    if (erros.length > 0) {
      return { ignorado: 'EVENTO_INVALIDO', leadId: lead.id, erros };
    }

    const decisao = sdr.avaliarInteracao(payload, { agora });
    return aplicarDecisao(cliente, lead, decisao, mapa, { agora, responsavelId });
  }

  async function receberWebhook(corpo) {
    const mensagens = extrairMensagensRecebidas(corpo);
    const resultados = [];

    for (const mensagem of mensagens) {
      try {
        resultados.push(await processarMensagem(mensagem));
      } catch (error) {
        log.error('Kommo: falha ao processar mensagem', mensagem.id, error.message, error.detalhes || '');
        resultados.push({ erro: error.message, mensagemId: mensagem.id });
      }
    }

    resultados.forEach(r => log.log('Kommo SDR:', JSON.stringify(r)));
    return resultados;
  }

  return { receberWebhook, processarMensagem };
}

module.exports = {
  TAG_BOT_SILENCIADO,
  parseCorpoWebhook,
  extrairMensagensRecebidas,
  canalPorOrigem,
  montarPayload,
  aplicarDecisao,
  criarIntegracaoKommo
};
