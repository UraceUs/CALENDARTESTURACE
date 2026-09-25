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

const VERSAO_REGRAS = '2.0.0';

// ---------------------------------------------------------------------------
// Canais e tipos de evento
// ---------------------------------------------------------------------------

// Todos os canais continuam recebendo e entregando mensagens normalmente.
// A lista abaixo so define onde o robo chat pode responder automaticamente.
const CANAIS_CONHECIDOS = ['whatsapp', 'instagram', 'messenger', 'telegram', 'site', 'email', 'telefone'];
const CANAIS_COM_ROBO = ['whatsapp', 'instagram', 'messenger', 'telegram', 'site'];

// Remetentes de maquina (e-mail): tudo que vem deles fica em Automaticos.
const REMETENTES_AUTOMATICOS = /^(no-?reply|do-?not-?reply|nao-?responda|notifications?|notificacoes|mailer-daemon|postmaster|bounces?)([+._-][^@]*)?@/i;

const TIPOS_EVENTO = [
  'mensagem',
  'reserva_etapa1',
  'reserva_etapa2',
  'reserva_etapa1_parada',
  'chamada_perdida',
  'formulario'
];

// ---------------------------------------------------------------------------
// Pipelines do Kommo
// ---------------------------------------------------------------------------
//
// Modelo de dois funis:
//   ENTRADA   recebe tudo (mensagens, e-mails, codigos, notificacoes). E a
//             caixa de triagem: nada aqui e trabalho do comercial.
//   COMERCIAL so recebe o que e lead. E a unica visao que o comercial abre.
// O motor decide para qual funil/etapa o card vai e quando ele DESCE da
// Entrada para o Comercial. Com uma pessoa so no atendimento, o Comercial
// precisa estar limpo: nada entra la sem regra.

const PIPELINES = {
  ENTRADA: 'Entrada',
  COMERCIAL: 'Comercial'
};

const ETAPAS_ENTRADA = {
  TRIAGEM: 'Triagem (novo contato)',
  AGUARDANDO_CONTEXTO: 'Aguardando contexto (robo perguntou)',
  SEM_SINAL: 'Conversa sem sinal comercial',
  AUTOMATICO: 'Automaticos (e-mails, codigos, notificacoes)',
  RUIDO: 'Ruido (spam, fornecedor, interno)',
  NAO_CONTATAR: 'Nao contatar (opt-out)'
};

// Etapas do funil Comercial.
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

// Toda acao se refere ao funil COMERCIAL. Fora dele, o card fica na Entrada
// (etapa indicada em kommo.destino) e nao ocupa o comercial.
const ACOES = {
  IGNORAR: 'ignorar',                 // fica na Entrada, sem resposta automatica
  SOMENTE_CONVERSA: 'somente_conversa', // fica na Entrada, nao desce para o Comercial
  CRIAR_CARD: 'criar_card',           // contato sem card: cria direto no Comercial
  PROMOVER_CARD: 'promover_card',     // card da Entrada desce para o Comercial
  ANEXAR_CARD: 'anexar_card',         // ja existe card aberto no Comercial
  REABRIR_CARD: 'reabrir_card'        // card fechado recente volta ao Comercial
};

// Quem atende. Com uma pessoa so, nao ha rodizio: todo handoff vai para o
// mesmo responsavel, e so prioridade alta interrompe; o resto vira fila.
const ATENDIMENTO = {
  pessoasNoComercial: 1,
  atribuicao: 'responsavel_unico',
  interrompeSomentePrioridade: 'alta'
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
  MENSAGEM_AUTOMATICA: 'E-mail automatico, codigo de verificacao ou notificacao de sistema.',
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
  MENSAGEM_AUTOMATICA: 'Mensagem automatica (e-mail de sistema, codigo, notificacao).',
  CONTATO_INTERNO: 'Contato interno/teste da equipe.',
  AGRADECIMENTO_OU_ENCERRAMENTO: 'Encerramento de conversa, nada a responder.',
  SEM_TEXTO_UTIL: 'Evento sem texto para interpretar.',
  FLUXO_AUTOMATICO: 'Evento de sistema tratado sem resposta automatica.',
  OPT_OUT: 'Lead pediu para nao receber mensagens.'
};

const MOTIVOS_ESCALONAMENTO = {
  LEAD_QUALIFICADO: 'Qualificacao completa, handoff para vendas.',
  SINAL_CONVERSAO: 'Lead sinalizou que quer avancar; nao espera formulario.',
  PILOTO_COMPETIDOR: 'Piloto que compete atualmente (classificacao D).',
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
  // Mensagens de maquina que poluem a Entrada: codigos de verificacao,
  // confirmacoes de cadastro, notificacoes de plataforma, newsletters.
  // Checado antes de opt-out porque rodape de newsletter traz "unsubscribe".
  automatico: [
    'codigo de verificacao', 'codigo de confirmacao', 'codigo de acesso', 'seu codigo e',
    'seu codigo de', 'verification code', 'your code is', 'security code', 'one-time code',
    'one time password', 'nao responda este e-mail', 'nao responda a este e-mail',
    'do not reply', 'please do not reply', 'this is an automated', 'mensagem automatica',
    'e-mail automatico', 'confirme seu e-mail', 'confirme seu email', 'confirm your email',
    'verify your email',
    'redefinir sua senha', 'reset your password', 'new sign-in', 'novo acesso a sua conta',
    'view this email in your browser', 'you are receiving this email'
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
  // Sinais de conversao: o lead disse que quer avancar. Escalam na hora,
  // mesmo com dados faltando (licao do Chase, cenario 19: lead convertendo
  // nunca espera atras de pergunta de formulario).
  conversao: [
    'quero fechar', 'vamos fechar', 'pode fechar', 'quando pode comecar',
    'quando ele comeca', 'quando podemos comecar', 'como faco o pagamento',
    'como pago', 'manda o link', 'me manda o link', 'bora', 'fechado entao',
    'lets do it', 'let s do it', 'when can he start', 'when can we start',
    'we want to move forward', 'move forward', 'sign me up', 'how do i pay'
  ],
  // Piloto que compete atualmente (classificacao D): escalacao imposta.
  compete: [
    'compito', 'eu corro', 'corro atualmente', 'estou competindo', 'competindo', 'campeonato',
    'minha classe', 'categoria que corro', 'piloto federado',
    'i compete', 'i race', 'currently racing', 'my class', 'championship'
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
  conversao: 40,
  compete: 40,
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
const GATILHOS_DIRETOS = ['preco', 'agenda', 'contratacao', 'humano', 'corporativo', 'conversao', 'compete'];

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

// Janela real do Salesbot do Kommo medida na operacao do Chase: ~58s.
// Toda notificacao a humano sai fora do caminho da resposta ao lead.
const JANELA_SALESBOT_SEGUNDOS = 58;

// Teto de re-alertas antes de virar tarefa no Kommo (licao do Chase:
// alarme sem teto x lead escalado repetindo a pergunta sem reaviso).
const MAX_REALERTAS = 4;

const SLA = {
  primeiraRespostaBotSegundos: 30,
  notificacaoHumanoSegundos: 10,
  handoffMinutos: 5,
  tarefaHumanoMinutos: 15,
  tarefaHumanoPrioritariaMinutos: 5,
  reservaParadaHoras: 24
};

// Cadencia da trilha 1 do Chase (decisao C11): +2h, +24h, +3d, +7d, fecha.
// Regra de ouro herdada: nunca duas trilhas no mesmo lead; resposta do lead
// ou escalacao mata a trilha na hora.
const FOLLOW_UP_MINUTOS = [120, 1440, 4320, 10080];

// Trilha 2 (link de programa/calendario enviado, sem resposta).
const FOLLOW_UP_POS_LINK_MINUTOS = [10, 1440, 4320, 10080];
const MAX_TENTATIVAS_SEM_ENTENDIMENTO = 2;

// A U-RACE opera em Orlando (Orlando Kart Center), entao o fuso e o de la.
//
// ATENCAO - valores pendentes de confirmacao: a janela abaixo veio do arquivo
// do projeto Chase ("9h-18h, horario de Orlando"), e o arquivo daquele projeto
// nao vale como regra ate ser reconfirmado (decisao D-2026-08-31). O horario
// de OPERACAO DA PISTA confirmado por Italo em atendimento real foi outro
// (quarta a domingo, 8h-13h) e conflita com esta janela de ATENDIMENTO.
// Confirmar os dois antes de publicar o robo.
const HORARIO_COMERCIAL = {
  fuso: 'America/New_York',
  diasSemana: [3, 4, 5, 6, 0], // quarta a domingo
  inicioHora: 9,
  fimHora: 18,
  confirmacaoPendente: true,
  origem: 'arquivo do projeto Chase (nao reconfirmado)'
};

// ---------------------------------------------------------------------------
// Ordem de qualificacao do SDR (uma pergunta por vez)
// ---------------------------------------------------------------------------

// Classificacao de experiencia do Chase. E o primeiro movimento de todo lead
// novo e vem antes de qualquer valor: nunca citar preco antes de classificar.
const CLASSIFICACAO_EXPERIENCIA = {
  A: 'nunca andou de kart',
  B: 'ja andou de kart de aluguel',
  C: 'ja correu kart de competicao no passado',
  D: 'compete atualmente'
};

// Classificacao D escala direto para o dono do time (regra imposta por codigo
// no Chase). Nao atrasar com formulario nem pedir visita ao site.
const CLASSIFICACAO_ESCALA_DIRETO = ['D'];

// Ordem de qualificacao (decisao C1 do Chase): experiencia decide o
// roteamento, origem decide o produto, e so depois vem o resto. Uma pergunta
// por vez, sempre.
const CAMPOS_QUALIFICACAO = [
  { campo: 'experiencia', pergunta: 'Qual opcao descreve melhor o piloto? A) nunca andou de kart B) ja andou de kart de aluguel C) ja correu no passado D) compete atualmente' },
  { campo: 'origem', pergunta: 'Voce e de Orlando ou vem de fora?' },
  { campo: 'servico', pergunta: 'Qual servico voce procura: Professional Coaching, Summer Camp ou Trackside Support?' },
  { campo: 'data', pergunta: 'Para qual data voce quer reservar?' },
  { campo: 'periodo', pergunta: 'Prefere o periodo da manha ou da tarde?' },
  { campo: 'pilotos', pergunta: 'Quantos pilotos vao participar?' },
  { campo: 'nome', pergunta: 'Qual o seu nome completo?' },
  { campo: 'contato', pergunta: 'Qual o melhor e-mail para enviarmos a confirmacao?' }
];

// ---------------------------------------------------------------------------
// Limites de estilo das respostas automaticas
// ---------------------------------------------------------------------------

const ESTILO_RESPOSTA = {
  maxMensagensPorTurno: 2,
  maxCaracteresPorMensagem: 350,
  maxEmojisPorMensagem: 0,       // o manual do Chase proibe emoji com o lead
  travessaoProibido: true,       // travessao denuncia texto de IA
  umaPerguntaPorVez: true,
  umProgramaPorVez: true,        // nunca despejar o cardapio inteiro
  nuncaInventar: ['preco fechado', 'disponibilidade', 'promessa de data', 'condicao de pagamento']
};

// Frases que o robo nunca pode emitir. Cada uma custou um incidente real no
// projeto Chase; a lista e verificada nos testes e no envio.
const NUNCA_DIZER = [
  { termo: 'all-inclusive', motivo: 'driver pass e pit pass sao pagos direto a pista, nunca inclusos.' },
  { termo: 'all inclusive', motivo: 'driver pass e pit pass sao pagos direto a pista, nunca inclusos.' },
  { termo: 'tudo incluso', motivo: 'driver pass e pit pass sao pagos direto a pista, nunca inclusos.' },
  { termo: 'come by', motivo: 'todo servico e por agendamento; nao existe visita sem hora marcada.' },
  { termo: 'stop by', motivo: 'todo servico e por agendamento; nao existe visita sem hora marcada.' },
  { termo: 'passe por aqui', motivo: 'todo servico e por agendamento; nao existe visita sem hora marcada.' },
  { termo: 'apareca quando quiser', motivo: 'todo servico e por agendamento; nao existe visita sem hora marcada.' },
  { termo: 'reserva confirmada', motivo: 'reserva so e confirmada depois do pagamento compensar.' },
  { termo: 'esta reservado', motivo: 'reserva so e confirmada depois do pagamento compensar.' },
  { termo: 'vandalismo', motivo: 'explicar o deposito de forma simples e neutra.' },
  { termo: 'vandalism', motivo: 'explicar o deposito de forma simples e neutra.' },
  { termo: 'e so um test drive', motivo: 'nunca diminuir o 1-Day, que e a porta de entrada.' },
  { termo: 'garanto sua vaga', motivo: 'vaga, equipamento e resultado nao sao prometidos pelo robo.' }
];

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
  foraDoHorario: 'Nosso time atende de quarta a domingo, das 9h as 18h (horario de Orlando). Assim que abrirmos, alguem te responde por aqui.',
  optOut: 'Tudo certo, nao vamos mais te enviar mensagens. Se precisar, e so chamar.',
  recuperacaoEtapa1: 'Vi que sua reserva ficou na Etapa 1. Quer que eu te ajude a concluir o Driver Briefing?',
  conversao: 'Otimo. Ja estou chamando o time para fechar isso com voce agora.',
  compete: 'Voce ja compete, entao quem fala com voce e o proprio time. Ja estou avisando.',
  precoAntesDaClassificacao: 'Antes do valor preciso entender o nivel do piloto, porque muda o programa.'
};

module.exports = {
  VERSAO_REGRAS,
  CANAIS_CONHECIDOS,
  CANAIS_COM_ROBO,
  TIPOS_EVENTO,
  PIPELINES,
  ETAPAS_ENTRADA,
  ESTAGIOS,
  ACOES,
  ATENDIMENTO,
  REMETENTES_AUTOMATICOS,
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
  JANELA_SALESBOT_SEGUNDOS,
  MAX_REALERTAS,
  FOLLOW_UP_MINUTOS,
  FOLLOW_UP_POS_LINK_MINUTOS,
  MAX_TENTATIVAS_SEM_ENTENDIMENTO,
  HORARIO_COMERCIAL,
  CAMPOS_QUALIFICACAO,
  CLASSIFICACAO_EXPERIENCIA,
  CLASSIFICACAO_ESCALA_DIRETO,
  ESTILO_RESPOSTA,
  NUNCA_DIZER,
  LINKS,
  MENSAGENS
};
