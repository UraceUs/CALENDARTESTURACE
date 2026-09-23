'use strict';

/**
 * Classificador de interacoes.
 *
 * Recebe o evento normalizado e devolve os sinais encontrados no texto.
 * Nao decide nada: apenas descreve a mensagem para triagem.js e robochat.js.
 */

const { PALAVRAS, PESOS, GRUPO_LIMITE_PILOTOS } = require('./regras');

const REGEX_PIT_ID = /\bPIT-[A-Z0-9]{3,6}-[A-Z0-9]{4,8}\b/i;
const REGEX_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const REGEX_TELEFONE = /(?:\+?55\s*)?\(?\d{2}\)?\s*9?\d{4}[-.\s]?\d{4}/;
const REGEX_PILOTOS = /(\d{1,3})\s*(pilotos?|pessoas?|alunos?|criancas?|drivers?|participantes?)/;
const REGEX_DATA_NUMERICA = /\b\d{1,2}\s*[/-]\s*\d{1,2}(\s*[/-]\s*\d{2,4})?\b/;
const REGEX_PALAVRAS_EN = /\b(hi|hello|how much|price|prices|available|availability|booking|book|schedule|do you have|i would like|thanks)\b/;
const REGEX_PALAVRAS_PT = /\b(oi|ola|bom dia|boa tarde|quero|gostaria|voces|preco|valor|data|horario|obrigado)\b/;

const PALAVRAS_DATA = [
  'hoje', 'amanha', 'depois de amanha', 'semana que vem', 'proxima semana', 'fim de semana',
  'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo',
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
];

const PALAVRAS_PERIODO = { manha: ['manha', 'matutino'], tarde: ['tarde', 'vespertino'] };

const SERVICOS = [
  { valor: 'Professional Coaching', termos: ['professional coaching', 'coaching', 'treino', 'aula', 'instrutor'] },
  { valor: 'Summer Camp', termos: ['summer camp', 'camp', 'colonia', 'ferias'] },
  { valor: 'Trackside Support', termos: ['trackside support', 'trackside', 'suporte de pista', 'apoio na pista'] }
];

function normalizarTexto(valor) {
  if (typeof valor !== 'string') {
    return '';
  }

  return valor
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function contemAlgum(texto, termos) {
  return termos.some(termo => texto.includes(termo));
}

function ehSomenteTermosDe(texto, termos) {
  const limpo = texto.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) {
    return false;
  }

  const palavras = limpo.split(' ');
  if (palavras.length > 5) {
    return false;
  }

  return contemAlgum(limpo, termos);
}

function detectarServico(texto) {
  const encontrado = SERVICOS.find(servico => contemAlgum(texto, servico.termos));
  return encontrado ? encontrado.valor : null;
}

function detectarPeriodo(texto) {
  if (contemAlgum(texto, PALAVRAS_PERIODO.manha)) {
    return 'manha';
  }
  if (contemAlgum(texto, PALAVRAS_PERIODO.tarde)) {
    return 'tarde';
  }
  return null;
}

function detectarQuantidadePilotos(texto) {
  const encontrado = texto.match(REGEX_PILOTOS);
  if (!encontrado) {
    return null;
  }

  const quantidade = Number(encontrado[1]);
  return Number.isFinite(quantidade) && quantidade > 0 ? quantidade : null;
}

function detectarIdioma(texto) {
  if (REGEX_PALAVRAS_PT.test(texto)) {
    return 'pt';
  }
  return REGEX_PALAVRAS_EN.test(texto) ? 'en' : 'pt';
}

/**
 * @param {object} evento evento normalizado (ver index.js)
 * @returns {object} sinais encontrados na mensagem
 */
function classificarMensagem(evento) {
  const texto = normalizarTexto(evento && evento.texto);
  const temTexto = texto.length > 0;

  const intencoes = [];
  if (contemAlgum(texto, PALAVRAS.preco)) intencoes.push('preco');
  if (contemAlgum(texto, PALAVRAS.agenda)) intencoes.push('agenda');
  if (contemAlgum(texto, PALAVRAS.contratacao)) intencoes.push('contratacao');
  if (contemAlgum(texto, PALAVRAS.humano)) intencoes.push('humano');
  if (contemAlgum(texto, PALAVRAS.corporativo)) intencoes.push('corporativo');
  if (contemAlgum(texto, PALAVRAS.servico)) intencoes.push('servico');
  if (contemAlgum(texto, PALAVRAS.informacao)) intencoes.push('informacao');

  const pitId = temTexto && REGEX_PIT_ID.test(evento.texto) ? evento.texto.match(REGEX_PIT_ID)[0].toUpperCase() : null;
  const quantidadePilotos = detectarQuantidadePilotos(texto);

  const sinais = {
    pitId,
    email: temTexto && REGEX_EMAIL.test(evento.texto) ? evento.texto.match(REGEX_EMAIL)[0] : null,
    telefone: temTexto && REGEX_TELEFONE.test(evento.texto) ? evento.texto.match(REGEX_TELEFONE)[0] : null,
    servico: detectarServico(texto),
    periodo: detectarPeriodo(texto),
    quantidadePilotos,
    dataMencionada: REGEX_DATA_NUMERICA.test(texto) || contemAlgum(texto, PALAVRAS_DATA)
  };

  const spam = contemAlgum(texto, PALAVRAS.spam);
  const optOut = contemAlgum(texto, PALAVRAS.optOut);
  const sensivel = contemAlgum(texto, PALAVRAS.sensivel);
  const desconto = contemAlgum(texto, PALAVRAS.desconto);
  const insatisfacao = contemAlgum(texto, PALAVRAS.insatisfacao);

  const saudacaoIsolada = intencoes.length === 0 && ehSomenteTermosDe(texto, PALAVRAS.saudacao);
  const encerramento = intencoes.length === 0 && !saudacaoIsolada && ehSomenteTermosDe(texto, PALAVRAS.encerramento);

  const grupoGrande = Boolean(quantidadePilotos && quantidadePilotos > GRUPO_LIMITE_PILOTOS);

  const score = calcularScore(intencoes, sinais);

  return {
    texto: temTexto ? evento.texto : '',
    textoNormalizado: texto,
    temTextoUtil: temTexto,
    idioma: detectarIdioma(texto),
    intencoes,
    sinais,
    score,
    spam,
    optOut,
    sensivel,
    desconto,
    insatisfacao,
    grupoGrande,
    saudacaoIsolada,
    encerramento,
    pedeHumano: intencoes.includes('humano')
  };
}

function calcularScore(intencoes, sinais) {
  let total = 0;

  intencoes.forEach(intencao => {
    total += PESOS[intencao] || 0;
  });

  if (sinais.pitId) total += PESOS.pitId;
  if (sinais.dataMencionada) total += PESOS.data;
  if (sinais.quantidadePilotos) total += PESOS.pilotos;
  if (sinais.email || sinais.telefone) total += PESOS.contato;

  return total;
}

module.exports = {
  classificarMensagem,
  normalizarTexto,
  calcularScore
};
