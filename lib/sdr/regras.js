'use strict';

/**
 * Regras de negocio do SDR (Kommo + robo chat).
 *
 * Este arquivo concentra TODA a parametrizacao: palavras-chave, pesos,
 * limiares, estagios do pipeline, SLAs e textos padrao. Alterar politica de
 * atendimento significa alterar este arquivo — a logica (classificador,
 * triagem e robo chat) nao precisa ser tocada.
 *
 * Documentacao completa: docs/kommo-sdr-regras.md
 */

const VERSAO_REGRAS = '1.0.0';

// ---------------------------------------------------------------------------
// Canais e tipos de evento
// ---------------------------------------------------------------------------

// Todos os canais continuam recebendo e entregando mensagens normalmente.
// A lista abaixo so define onde o robo chat pode responder automaticamente.
const CANAIS_CONHECIDOS = ['whatsapp', 'instagram', 'messenger', 'telegram', 'site', 'email', 'telefone'];
const CANAIS_COM_ROBO = ['whatsapp', 'instagram', 'messenger', 'telegram', 'site'];

const TIPOS_EVENTO = [
  'mensagem',
  'reserva_etapa1',
  'reserva_etapa2',
  'reserva_etapa1_parada',
  'chamada_perdida',
  'formulario'
];

// ---------------------------------------------------------------------------
// Pipeline (estagios do card no Kommo)
// ---------------------------------------------------------------------------

const ESTAGIOS = {
  NOVO: 'Novo lead (SDR)',
  QUALIFICANDO: 'Em qualificacao (bot)',
  HUMANO: 'Qualificado - humano',
  ETAPA1: 'Reserva Etapa 1 (Pit ID gerado)',
  ETAPA2: 'Briefing Etapa 2 pendente',
  CONFIRMADA: 'Reserva confirmada',
  PERDIDO: 'Perdido'
};

// ---------------------------------------------------------------------------
// Acoes possiveis de triagem
// ---------------------------------------------------------------------------

const ACOES = {
  IGNORAR: 'ignorar',                 // nem card, nem resposta automatica
  SOMENTE_CONVERSA: 'somente_conversa', // mensagem fica no inbox, sem card
  CRIAR_CARD: 'criar_card',
  ANEXAR_CARD: 'anexar_card',         // ja existe card aberto para o contato
  REABRIR_CARD: 'reabrir_card'        // card fechado recente volta ao pipeline
};

// ---------------------------------------------------------------------------
// Motivos (codigos auditaveis usados em tags e relatorios)
// ---------------------------------------------------------------------------

const MOTIVOS_ENTRADA = {
  RESERVA_ETAPA1: 'Reserva iniciada no site (Pit ID gerado).',
  RESERVA_ETAPA2: 'Driver Briefing concluido (Etapa 2).',
  RESERVA_PARADA: 'Reserva na Etapa 1 parada alem do SLA.',
  FORMULARIO_SITE: 'Formulario do site preenchido com contato.',
  CHAMADA_PERDIDA: 'Chamada perdida de numero desconhecido.',
  INTENCAO_COMERCIAL: 'Sinal comercial explicito (preco, agenda, contratacao).',
  PEDIDO_HUMANO: 'Lead pediu falar com uma pessoa.',
  DEMANDA_CORPORATIVA: 'Demanda corporativa/evento/grupo.',
  TEMA_SENSIVEL: 'Tema sensivel que exige dono humano.',
  SCORE_QUALIFICACAO: 'Soma de sinais atingiu o limiar de qualificacao.',
  DADOS_QUALIFICACAO: 'Lead informou servico, data e contato.',
  PIT_ID_INFORMADO: 'Lead informou um Pit ID existente.'
};

const MOTIVOS_NAO_ENTRADA = {
  CONTATO_INTERNO: 'Contato interno/teste da equipe.',
  GRUPO_OU_TRANSMISSAO: 'Grupo ou lista de transmissao.',
  SPAM_OU_OFERTA: 'Spam, prospeccao de fornecedor ou curriculo.',
  OPT_OUT: 'Lead pediu para nao receber mensagens.',
  SAUDACAO_ISOLADA: 'Apenas saudacao, sem intencao declarada.',
  AGRADECIMENTO_OU_ENCERRAMENTO: 'Agradecimento, confirmacao ou encerramento.',
  MIDIA_SEM_CONTEXTO: 'Audio/imagem/sticker sem texto util.',
  SEM_SINAL_COMERCIAL: 'Conversa sem sinal comercial suficiente.',
  CARD_ABERTO_EXISTENTE: 'Contato ja possui card aberto (sem duplicar).'
};

const MOTIVOS_NAO_RESPOSTA = {
  CANAL_SEM_ROBO: 'Canal nao atendido pelo robo chat.',
  HUMANO_NO_ATENDIMENTO: 'Humano ja assumiu a conversa.',
  BOT_SILENCIADO: 'Robo silenciado manualmente neste card.',
  GRUPO_OU_TRANSMISSAO: 'Grupo ou lista de transmissao.',
  SPAM_OU_OFERTA: 'Spam ou prospeccao.',
  CONTATO_INTERNO: 'Contato interno/teste da equipe.',
  AGRADECIMENTO_OU_ENCERRAMENTO: 'Encerramento de conversa, nada a responder.',
  SEM_TEXTO_UTIL: 'Evento sem texto para interpretar.',
  FLUXO_AUTOMATICO: 'Evento de sistema tratado sem resposta automatica.',
  OPT_OUT: 'Lead pediu para nao receber mensagens.'
};

const MOTIVOS_ESCALONAMENTO = {
  LEAD_QUALIFICADO: 'Qualificacao completa — handoff para vendas.',
  PEDIDO_HUMANO: 'Lead pediu atendimento humano.',
  TEMA_SENSIVEL: 'Tema sensivel (juridico, saude, cobranca, imprensa).',
  NEGOCIACAO: 'Pedido de desconto ou condicao comercial especial.',
  CORPORATIVO: 'Demanda corporativa, evento ou grupo grande.',
  SEM_ENTENDIMENTO: 'Robo nao entendeu apos tentativas permitidas.',
  LEAD_INSATISFEITO: 'Lead demonstrou irritacao ou insatisfacao.',
  FALHA_TECNICA: 'Falha tecnica no atendimento automatico.',
  RESERVA_PARADA: 'Reserva parada entre Etapa 1 e Etapa 2.'
};

// ---------------------------------------------------------------------------
// Palavras-chave (texto ja normalizado: minusculo e sem acentos)
// ---------------------------------------------------------------------------

const PALAVRAS = {
  preco: [
    'preco', 'precos', 'valor', 'valores', 'quanto custa', 'quanto fica', 'quanto sai',
    'orcamento', 'tabela de preco', 'pacote', 'pacotes', 'investimento por',
    'price', 'prices', 'how much', 'cost'
  ],
  agenda: [
    'agenda', 'agendar', 'disponibilidade', 'disponivel', 'disponiveis', 'vaga', 'vagas',
    'reservar', 'reserva para', 'marcar', 'horario disponivel', 'tem data', 'que dias',
    'book', 'booking', 'schedule', 'availability'
  ],
  contratacao: [
    'quero contratar', 'quero agendar', 'quero reservar', 'quero fechar', 'como faco para',
    'como contrato', 'como reservo', 'gostaria de agendar', 'gostaria de contratar',
    'quero marcar', 'quero fazer', 'inscricao', 'inscrever', 'matricula',
    'i want to book', 'sign up'
  ],
  // Apenas termos que indicam interesse no servico. Palavras genericas do
  // negocio ('kart', 'pista', 'piloto') ficam de fora: sozinhas nao sao sinal
  // comercial e abririam card para qualquer pergunta operacional.
  servico: [
    'coaching', 'professional coaching', 'summer camp', 'trackside', 'trackside support',
    'treino', 'treinamento', 'aula', 'aulas', 'instrutor'
  ],
  informacao: [
    'como funciona', 'o que e', 'quanto tempo', 'duracao', 'onde fica', 'endereco',
    'localizacao', 'idade minima', 'requisito', 'requisitos', 'precisa levar',
    'o que preciso', 'how does it work', 'where are you'
  ],
  humano: [
    'falar com alguem', 'falar com uma pessoa', 'atendente', 'atendimento humano', 'humano',
    'me liga', 'me ligue', 'ligacao', 'telefone de voces', 'quero falar com',
    'talk to someone', 'talk to a human', 'call me'
  ],
  desconto: [
    'desconto', 'cupom', 'condicao especial', 'parcelar', 'parcelamento', 'mais barato',
    'promocao para mim', 'discount'
  ],
  corporativo: [
    'empresa', 'corporativo', 'cnpj', 'evento da', 'team building', 'confraternizacao',
    'nota fiscal', 'contrato com a empresa', 'patrocinio', 'corporate'
  ],
  sensivel: [
    'acidente', 'lesao', 'machuquei', 'me machuquei', 'ambulancia', 'advogado', 'juridico',
    'processo judicial', 'procon', 'reclame aqui', 'reembolso', 'estorno',
    'cobranca indevida', 'cobrado duas vezes', 'jornalista', 'imprensa', 'reportagem',
    'menor de idade', 'responsavel legal', 'seguro do'
  ],
  spam: [
    'divulgacao', 'trafego pago', 'marketing digital', 'seguidores', 'impulsionar',
    'emprestimo', 'consorcio', 'investimento garantido', 'cripto', 'bitcoin',
    'curriculo', 'vaga de emprego', 'trabalhe conosco', 'sou representante',
    'nossa empresa oferece', 'parceria de divulgacao', 'planos de internet'
  ],
  optOut: [
    'nao quero mais receber', 'nao quero mais mensagem', 'pare de mandar', 'parem de mandar',
    'sair da lista', 'descadastrar', 'remover meu numero', 'unsubscribe', 'stop'
  ],
  saudacao: [
    'oi', 'ola', 'opa', 'eai', 'e ai', 'bom dia', 'boa tarde', 'boa noite', 'tudo bem',
    'hello', 'hi', 'hey'
  ],
  encerramento: [
    'obrigado', 'obrigada', 'valeu', 'agradecido', 'ok', 'okay', 'blz', 'beleza',
    'entendi', 'perfeito', 'show', 'thanks', 'thank you'
  ],
  insatisfacao: [
    'pessimo', 'absurdo', 'ridiculo', 'descaso', 'ninguem responde', 'ate agora nada',
    'cansei', 'horrivel', 'nao aguento', 'ja pedi'
  ]
};

// ---------------------------------------------------------------------------
// Pontuacao de qualificacao
// ---------------------------------------------------------------------------

const PESOS = {
  preco: 40,
  agenda: 40,
  contratacao: 40,
  humano: 40,
  corporativo: 30,
  pitId: 30,
  servico: 20,
  informacao: 20,
  data: 15,
  pilotos: 15,
  contato: 15
};

// Sinais que, sozinhos, ja justificam um card.
const GATILHOS_DIRETOS = ['preco', 'agenda', 'contratacao', 'humano', 'corporativo'];

// Soma minima de sinais fracos para abrir card sem gatilho direto.
const LIMIAR_CARD = 40;

// ---------------------------------------------------------------------------
// Deduplicacao / reabertura
// ---------------------------------------------------------------------------

const JANELA_REABERTURA_DIAS = 30; // card fechado ha menos que isso e reaberto
const GRUPO_LIMITE_PILOTOS = 4;    // acima disso e negociacao humana

// ---------------------------------------------------------------------------
// SLAs e cadencia
// ---------------------------------------------------------------------------

const SLA = {
  primeiraRespostaBotSegundos: 30,
  handoffMinutos: 5,
  tarefaHumanoMinutos: 15,
  tarefaHumanoPrioritariaMinutos: 5,
  reservaParadaHoras: 24
};

const FOLLOW_UP_MINUTOS = [30, 1440, 4320]; // +30min, +24h, +72h
const MAX_TENTATIVAS_SEM_ENTENDIMENTO = 2;

const HORARIO_COMERCIAL = {
  fuso: 'America/Sao_Paulo',
  offsetHoras: -3,
  diasSemana: [1, 2, 3, 4, 5, 6], // segunda a sabado
  inicioHora: 9,
  fimHora: 19
};

// ---------------------------------------------------------------------------
// Ordem de qualificacao do SDR (uma pergunta por vez)
// ---------------------------------------------------------------------------

const CAMPOS_QUALIFICACAO = [
  { campo: 'servico', pergunta: 'Qual servico voce procura: Professional Coaching, Summer Camp ou Trackside Support?' },
  { campo: 'data', pergunta: 'Para qual data voce quer reservar?' },
  { campo: 'periodo', pergunta: 'Prefere o periodo da manha ou da tarde?' },
  { campo: 'pilotos', pergunta: 'Quantos pilotos vao participar?' },
  { campo: 'experiencia', pergunta: 'Os pilotos ja tem experiencia com kart?' },
  { campo: 'nome', pergunta: 'Qual o seu nome completo?' },
  { campo: 'contato', pergunta: 'Qual o melhor e-mail para enviarmos a confirmacao?' }
];

// ---------------------------------------------------------------------------
// Limites de estilo das respostas automaticas
// ---------------------------------------------------------------------------

const ESTILO_RESPOSTA = {
  maxMensagensPorTurno: 2,
  maxCaracteresPorMensagem: 350,
  maxEmojisPorMensagem: 1,
  umaPerguntaPorVez: true,
  nuncaInventar: ['preco fechado', 'disponibilidade', 'promessa de data', 'condicao de pagamento']
};

const LINKS = {
  calendario: 'https://uraceus.github.io/CALENDARTESTURACE/Calendar.html',
  briefing: 'https://uraceus.github.io/CALENDARTESTURACE/DriverBriefing.html'
};

// ---------------------------------------------------------------------------
// Textos padrao do robo
// ---------------------------------------------------------------------------

const MENSAGENS = {
  abertura: 'Oi! Aqui e o atendimento da U-RACE. Posso te ajudar a reservar um horario na pista.',
  preco: 'Os valores variam conforme o servico e a duracao. Vou confirmar a condicao exata com o time.',
  agenda: 'Voce pode ver as datas e periodos livres direto no nosso calendario: ' + LINKS.calendario,
  informacao: 'Trabalhamos com Professional Coaching, Summer Camp e Trackside Support, todos com instrutor na pista.',
  encaminharCalendario: 'Para garantir o horario, faca a Etapa 1 em ' + LINKS.calendario + ' e guarde o Pit ID gerado.',
  briefingPendente: 'Sua reserva esta na Etapa 1. Conclua o Driver Briefing com o seu Pit ID em ' + LINKS.briefing + '.',
  pitIdNaoEncontrado: 'Nao localizei esse Pit ID. Vou pedir para o time verificar e te retornar.',
  pedidoHumano: 'Claro. Ja estou chamando alguem do time para falar com voce.',
  sensivel: 'Entendi. Esse assunto vou encaminhar agora para uma pessoa do time cuidar diretamente com voce.',
  negociacao: 'Condicoes comerciais quem fecha e o time de vendas. Ja estou passando seu contato para eles.',
  corporativo: 'Para grupos e eventos corporativos montamos uma proposta especifica. Vou acionar o time comercial.',
  semEntendimento: 'Nao tenho certeza se entendi. Voce quer saber sobre servicos, datas disponiveis ou valores?',
  pedirTexto: 'Nao consegui ouvir/abrir o seu envio. Pode me escrever em texto o que voce precisa?',
  handoff: 'Perfeito, ja tenho o que preciso. Um consultor da U-RACE assume a conversa a partir daqui.',
  foraDoHorario: 'Nosso time atende de segunda a sabado, das 9h as 19h. Assim que abrirmos, alguem te responde por aqui.',
  optOut: 'Tudo certo, nao vamos mais te enviar mensagens. Se precisar, e so chamar.',
  recuperacaoEtapa1: 'Vi que sua reserva ficou na Etapa 1. Quer que eu te ajude a concluir o Driver Briefing?'
};

module.exports = {
  VERSAO_REGRAS,
  CANAIS_CONHECIDOS,
  CANAIS_COM_ROBO,
  TIPOS_EVENTO,
  ESTAGIOS,
  ACOES,
  MOTIVOS_ENTRADA,
  MOTIVOS_NAO_ENTRADA,
  MOTIVOS_NAO_RESPOSTA,
  MOTIVOS_ESCALONAMENTO,
  PALAVRAS,
  PESOS,
  GATILHOS_DIRETOS,
  LIMIAR_CARD,
  JANELA_REABERTURA_DIAS,
  GRUPO_LIMITE_PILOTOS,
  SLA,
  FOLLOW_UP_MINUTOS,
  MAX_TENTATIVAS_SEM_ENTENDIMENTO,
  HORARIO_COMERCIAL,
  CAMPOS_QUALIFICACAO,
  ESTILO_RESPOSTA,
  LINKS,
  MENSAGENS
};
