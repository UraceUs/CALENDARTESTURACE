// Integracao com o Kommo: mapa para os funis reais, webhook de mensagens e
// acoes no card. O Kommo falso parte da estrutura real da conta (fixture).
const request = require('supertest');
const kommo = require('../../lib/kommo');
const { regras } = require('../../lib/sdr');
const { createApp } = require('../../server');
const FIXTURE = require('./fixtures/kommo-funis.json');

// IDs reais (urace.kommo.com) dos funis da equipe, que o SDR nao toca.
const URACE = 9903543;
const COMERCIAL_DA_EQUIPE = 14512484;
const FIRST_CONTACT = 105276412;

function criarKommoFalso(pipelines = FIXTURE.pipelines) {
  let proximoId = 900000;
  const estado = {
    pipelines: JSON.parse(JSON.stringify(pipelines)),
    leads: {},
    chamadas: [],
    notas: [],
    tarefas: [],
    webhooks: []
  };

  async function fetchImpl(url, opcoes) {
    const caminho = url.replace('https://urace.kommo.com/api/v4', '');
    const metodo = opcoes.method;
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    estado.chamadas.push({ metodo, caminho, corpo });

    const responder = (status, dados) => ({
      ok: status < 400,
      status,
      text: async () => (dados === undefined ? '' : JSON.stringify(dados))
    });

    if (metodo === 'GET' && caminho === '/leads/pipelines') {
      return responder(200, { _embedded: { pipelines: estado.pipelines } });
    }
    if (metodo === 'POST' && caminho === '/leads/pipelines') {
      corpo.forEach(p => estado.pipelines.push({
        id: proximoId++,
        name: p.name,
        sort: p.sort,
        _embedded: { statuses: p._embedded.statuses.map(s => ({ id: proximoId++, name: s.name, sort: s.sort, type: 0 })) }
      }));
      return responder(200, {});
    }
    const lead = caminho.match(/^\/leads\/(\d+)$/);
    if (lead && metodo === 'GET') {
      const encontrado = estado.leads[lead[1]];
      return encontrado ? responder(200, encontrado) : responder(404, { title: 'Not found' });
    }
    if (lead && metodo === 'PATCH') {
      const alvo = estado.leads[lead[1]];
      if (corpo.pipeline_id) alvo.pipeline_id = corpo.pipeline_id;
      if (corpo.status_id) alvo.status_id = corpo.status_id;
      (corpo.tags_to_add || []).forEach(tag => alvo._embedded.tags.push(tag));
      return responder(200, alvo);
    }
    const nota = caminho.match(/^\/leads\/(\d+)\/notes$/);
    if (nota && metodo === 'POST') {
      estado.notas.push({ leadId: nota[1], texto: corpo[0].params.text });
      return responder(200, {});
    }
    if (caminho === '/tasks' && metodo === 'POST') {
      estado.tarefas.push(corpo[0]);
      return responder(200, {});
    }
    if (caminho === '/webhooks' && metodo === 'GET') {
      return responder(200, { _embedded: { webhooks: estado.webhooks } });
    }
    if (caminho === '/webhooks' && metodo === 'POST') {
      estado.webhooks.push(corpo);
      return responder(200, corpo);
    }
    return responder(404, { title: 'rota falsa inexistente', caminho });
  }

  function criarLead(id, pipelineId, statusId, extras = {}) {
    estado.leads[id] = {
      id,
      pipeline_id: pipelineId,
      status_id: statusId,
      responsible_user_id: 555,
      updated_at: 1790000000,
      closed_at: null,
      _embedded: { tags: [] },
      ...extras
    };
    return estado.leads[id];
  }

  const escritas = () => estado.chamadas.filter(c => c.metodo !== 'GET');

  return { estado, fetchImpl, criarLead, escritas };
}

const silencioso = { log: () => {}, error: () => {} };

function integracaoPara(falso, extras = {}) {
  const cliente = kommo.criarClienteKommo({ subdominio: 'urace', token: 't', fetchImpl: falso.fetchImpl });
  return kommo.criarIntegracaoKommo({
    cliente,
    obterMapa: kommo.criarResolvedorDeMapa(cliente),
    log: silencioso,
    modo: 'aplicar',
    ...extras
  });
}

function mensagem(leadId, texto, extras = {}) {
  return {
    message: {
      add: {
        0: {
          id: extras.id || `m-${Math.random()}`,
          text: texto,
          type: extras.type || 'incoming',
          element_type: '2',
          element_id: String(leadId),
          contact_id: '9',
          chat_id: 'chat-1',
          origin: extras.origin || 'waba'
        }
      }
    }
  };
}

const ENV = { KOMMO_SUBDOMINIO: 'urace', KOMMO_TOKEN: 'tok' };
const NOVO = regras.NOVO_FUNIL;

// Conta real + "Novo funil" criado pelo setup. Devolve ids por nome de etapa.
async function contaComNovoFunil() {
  const falso = criarKommoFalso();
  const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);
  await integracao.sincronizarEstrutura({ aplicar: true });
  falso.estado.chamadas.length = 0;

  const funil = falso.estado.pipelines.find(p => p.name === NOVO);
  const etapa = nome => funil._embedded.statuses.find(st => st.name === nome).id;
  return { falso, funilId: funil.id, etapa };
}

describe('Kommo — Novo funil', () => {
  it('na conta atual falta so o Novo funil, com as 10 etapas na ordem', () => {
    const plano = kommo.planejarEstrutura(FIXTURE.pipelines);

    expect(plano.etapasFaltando).toEqual([]);
    expect(plano.pipelinesFaltando).toHaveLength(1);
    expect(plano.pipelinesFaltando[0].nome).toBe('Novo funil');
    expect(plano.pipelinesFaltando[0].etapas).toEqual(regras.KOMMO_MAPA.ordemEtapas);
  });

  it('sem aplicar nao escreve nada', async () => {
    const falso = criarKommoFalso();
    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);

    const resultado = await integracao.sincronizarEstrutura({ aplicar: false });

    expect(resultado.aplicado).toBe(false);
    expect(falso.escritas()).toHaveLength(0);
  });

  it('com aplicar cria so o Novo funil, sem tocar nos funis da equipe', async () => {
    const falso = criarKommoFalso();
    const antes = JSON.stringify(falso.estado.pipelines);
    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);

    const resultado = await integracao.sincronizarEstrutura({ aplicar: true });

    expect(resultado.resultado.ok).toBe(true);
    expect(falso.escritas()).toHaveLength(1);
    const criado = falso.escritas()[0].corpo;
    expect(criado).toHaveLength(1);
    expect(criado[0].name).toBe('Novo funil');
    expect(criado[0].is_main).toBe(false);
    expect(criado[0].is_unsorted_on).toBe(false);
    expect(JSON.stringify(falso.estado.pipelines.slice(0, FIXTURE.pipelines.length))).toBe(antes);

    // Rodar de novo nao cria outro.
    const deNovo = await integracao.sincronizarEstrutura({ aplicar: true });
    expect(deNovo.aplicado).toBe(false);
    expect(falso.escritas()).toHaveLength(1);
  });

  it('nunca acrescenta etapa no Novo funil se alguem apagar uma', async () => {
    const { falso } = await contaComNovoFunil();
    const funil = falso.estado.pipelines.find(p => p.name === NOVO);
    funil._embedded.statuses = funil._embedded.statuses.filter(st => st.name !== 'Briefing Etapa 2');
    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);

    const resultado = await integracao.sincronizarEstrutura({ aplicar: true });

    expect(resultado.plano.etapasFaltando).toEqual([{ pipeline: 'Novo funil', etapa: 'Briefing Etapa 2' }]);
    expect(falso.escritas()).toHaveLength(0);
  });

  it('sem configuracao nao cria integracao; com configuracao comeca em observar', () => {
    expect(kommo.criarIntegracaoDoAmbiente({})).toBeNull();
    expect(kommo.criarIntegracaoDoAmbiente(ENV).modo).toBe('observar');
    expect(kommo.criarIntegracaoDoAmbiente({ ...ENV, KOMMO_MODO: 'aplicar' }).modo).toBe('aplicar');
  });
});

describe('Kommo — webhook aplica as regras dentro do Novo funil', () => {
  it('converte o corpo form-urlencoded do Kommo', () => {
    const corpo = kommo.parseCorpoWebhook(
      'message%5Badd%5D%5B0%5D%5Btext%5D=Oi&message%5Badd%5D%5B0%5D%5Belement_id%5D=42&message%5Badd%5D%5B0%5D%5Belement_type%5D=2',
      'application/x-www-form-urlencoded'
    );
    const [msg] = kommo.extrairMensagensRecebidas(corpo);

    expect(msg.texto).toBe('Oi');
    expect(msg.leadId).toBe('42');
  });

  it('"oi" em Triagem vai para Aguardando contexto', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(1, funilId, etapa('Triagem'));

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(1, 'Oi'));

    expect(resultado.acao).toBe('somente_conversa');
    expect(falso.estado.leads[1].status_id).toBe(etapa('Aguardando contexto'));
    expect(falso.estado.notas).toHaveLength(0);
  });

  it('pergunta de preco desce para Em qualificacao (robo) com nota', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(2, funilId, etapa('Aguardando contexto'));

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(2, 'Quanto custa o coaching?'));

    expect(resultado.acao).toBe('promover_card');
    expect(falso.estado.leads[2].pipeline_id).toBe(funilId);
    expect(falso.estado.leads[2].status_id).toBe(etapa('Em qualificação (robô)'));
    expect(falso.estado.leads[2]._embedded.tags.map(t => t.name)).toContain('sdr:intencao-comercial');
    expect(falso.estado.notas[0].texto).toContain('promover_card');
  });

  it('em modo observar calcula tudo e nao escreve nada', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(3, funilId, etapa('Triagem'));

    const [resultado] = await integracaoPara(falso, { modo: 'observar' }).receberWebhook(mensagem(3, 'Quanto custa o coaching?'));

    expect(resultado.modo).toBe('observar');
    expect(resultado.moveu).toEqual({ pipeline: 'Comercial', etapa: regras.ESTAGIOS.QUALIFICANDO });
    expect(resultado.nota).toBe(true);
    expect(falso.escritas()).toHaveLength(0);
  });

  it('codigo de login vai para Automaticos com a tag nao_e_lead, sem nota', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(4, funilId, etapa('Triagem'));

    await integracaoPara(falso).receberWebhook(mensagem(4, '713157 is your code to log in to Kommo', { origin: 'email' }));

    expect(falso.estado.leads[4].status_id).toBe(etapa('Automáticos (e-mails e códigos)'));
    expect(falso.estado.leads[4]._embedded.tags.map(t => t.name)).toEqual(expect.arrayContaining(['sdr:automatico', 'nao_e_lead']));
    expect(falso.estado.notas).toHaveLength(0);
  });

  it('spam de fornecedor vai para Ruido', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(5, funilId, etapa('Triagem'));

    await integracaoPara(falso).receberWebhook(mensagem(5, 'Nossa empresa oferece trafego pago para voces'));

    expect(falso.estado.leads[5].status_id).toBe(etapa('Ruído (spam e fornecedores)'));
  });

  it('pedido de humano vai para Atendimento humano com nota, tarefa e robo silenciado', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(6, funilId, etapa('Triagem'));
    const agora = new Date('2026-09-23T14:00:00Z');

    const resultado = await integracaoPara(falso, { responsavelId: '777' }).processarMensagem(
      kommo.extrairMensagensRecebidas(mensagem(6, 'Quero falar com alguem'))[0],
      agora
    );

    expect(resultado.tarefa.prioridade).toBe('alta');
    expect(falso.estado.leads[6].status_id).toBe(etapa('Atendimento humano'));
    expect(falso.estado.tarefas[0].responsible_user_id).toBe(777);
    expect(falso.estado.tarefas[0].complete_till).toBeGreaterThan(agora.getTime() / 1000);
    expect(falso.estado.notas[0].texto).toContain('HANDOFF ALTA');
    expect(falso.estado.leads[6]._embedded.tags.map(t => t.name)).toContain('sdr:handoff');
  });

  it('lead em etapa de venda so recebe anexo, sem voltar de etapa', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(7, funilId, etapa('Reserva Etapa 1 (Pit ID)'));

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(7, 'Obrigado!'));

    expect(resultado.acao).toBe('anexar_card');
    expect(falso.estado.leads[7].status_id).toBe(etapa('Reserva Etapa 1 (Pit ID)'));
  });

  it('Driver Briefing concluido fecha como ganho (142)', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(8, funilId, etapa('Briefing Etapa 2'));
    const cliente = kommo.criarClienteKommo({ subdominio: 'urace', token: 't', fetchImpl: falso.fetchImpl });
    const mapa = await kommo.criarResolvedorDeMapa(cliente)();
    const decisao = require('../../lib/sdr').avaliarInteracao({
      canal: 'site',
      tipo: 'reserva_etapa2',
      reserva: { pitId: 'PIT-AB12-XYZ9', etapa: 2 },
      card: { existe: true, id: '8', pipeline: 'Comercial', status: 'aberto' }
    });

    await kommo.aplicarDecisao(cliente, falso.estado.leads[8], decisao, mapa, { modo: 'aplicar' });

    expect(falso.estado.leads[8].status_id).toBe(142);
  });

  it('opt-out fecha como perdido com a tag opt_out', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(9, funilId, etapa('Aguardando contexto'));

    await integracaoPara(falso).receberWebhook(mensagem(9, 'Pare de mandar mensagem'));

    expect(falso.estado.leads[9].status_id).toBe(143);
    expect(falso.estado.leads[9]._embedded.tags.map(t => t.name)).toContain('opt_out');
  });

  it('lead perdido que volta pedindo agenda reabre em Em qualificacao', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(10, funilId, 143, { closed_at: Math.floor(Date.now() / 1000) - 5 * 86400 });

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(10, 'Tem vaga no sabado? Quanto custa?'));

    expect(resultado.acao).toBe('reabrir_card');
    expect(falso.estado.leads[10].status_id).toBe(etapa('Em qualificação (robô)'));
  });

  it('leads dos funis da equipe (Urace, Comercial) nao sao tocados', async () => {
    const { falso } = await contaComNovoFunil();
    falso.criarLead(11, URACE, FIRST_CONTACT);
    falso.criarLead(12, COMERCIAL_DA_EQUIPE, 112100844);
    const integracao = integracaoPara(falso);

    const [a] = await integracao.receberWebhook(mensagem(11, 'Quanto custa?'));
    const [b] = await integracao.receberWebhook(mensagem(12, 'Quero falar com alguem'));

    expect(a.ignorado).toBe('PIPELINE_FORA_DO_SDR');
    expect(b.ignorado).toBe('PIPELINE_FORA_DO_SDR');
    expect(falso.escritas()).toHaveLength(0);
  });

  it('etapa criada a mao no Novo funil nao e do robo', async () => {
    const { falso, funilId } = await contaComNovoFunil();
    const funil = falso.estado.pipelines.find(p => p.name === NOVO);
    funil._embedded.statuses.push({ id: 777001, name: 'Etapa da equipe', sort: 500, type: 0 });
    falso.criarLead(13, funilId, 777001);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(13, 'Quanto custa?'));

    expect(resultado.ignorado).toBe('ETAPA_DA_EQUIPE');
  });

  it('mensagem da equipe (outgoing) e repetida sao ignoradas', async () => {
    const { falso, funilId, etapa } = await contaComNovoFunil();
    falso.criarLead(14, funilId, etapa('Triagem'));
    const integracao = integracaoPara(falso);

    expect(await integracao.receberWebhook(mensagem(14, 'Quanto custa?', { type: 'outgoing' }))).toHaveLength(0);

    const corpo = mensagem(14, 'Quanto custa?', { id: 'repetida' });
    await integracao.receberWebhook(corpo);
    const [segunda] = await integracao.receberWebhook(corpo);
    expect(segunda.ignorado).toBe('DUPLICADA');
    expect(falso.estado.notas).toHaveLength(1);
  });
});

describe('Kommo — rotas', () => {
  const ENV_ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
  });

  function appCom(integracao) {
    return createApp({ kommo: integracao, repo: {}, configRepo: {}, emailService: {} });
  }

  it('webhook sem integracao configurada responde 503', async () => {
    const resposta = await request(appCom(null)).post('/api/kommo/webhook?token=x').send('a=1');
    expect(resposta.status).toBe(503);
  });

  it('webhook com token errado responde 401', async () => {
    process.env.KOMMO_WEBHOOK_TOKEN = 'segredo';
    const resposta = await request(appCom({ receberWebhook: jest.fn() })).post('/api/kommo/webhook?token=errado').send('a=1');
    expect(resposta.status).toBe(401);
  });

  it('webhook valido responde na hora e processa em segundo plano', async () => {
    process.env.KOMMO_WEBHOOK_TOKEN = 'segredo';
    const receberWebhook = jest.fn().mockResolvedValue([]);

    const resposta = await request(appCom({ receberWebhook }))
      .post('/api/kommo/webhook?token=segredo')
      .type('form')
      .send('message[add][0][text]=Oi&message[add][0][element_id]=1&message[add][0][element_type]=2');

    expect(resposta.status).toBe(200);
    expect(resposta.body.recebidas).toBe(1);
    expect(receberWebhook.mock.calls[0][0].message.add['0'].text).toBe('Oi');
  });

  it('estrutura exige o token administrativo definido', async () => {
    delete process.env.SDR_WEBHOOK_TOKEN;
    const resposta = await request(appCom({ sincronizarEstrutura: jest.fn() })).post('/api/kommo/estrutura').send({});
    expect(resposta.status).toBe(401);
  });

  it('estrutura sem aplicar so devolve o plano', async () => {
    process.env.SDR_WEBHOOK_TOKEN = 'admin';
    const sincronizarEstrutura = jest.fn().mockResolvedValue({ aplicado: false, plano: { ok: true } });

    const resposta = await request(appCom({ sincronizarEstrutura }))
      .post('/api/kommo/estrutura')
      .set('Authorization', 'Bearer admin')
      .send({});

    expect(resposta.status).toBe(200);
    expect(sincronizarEstrutura).toHaveBeenCalledWith({ aplicar: false });
  });
});

describe('Servico enxuto do SDR (sdr-server.js)', () => {
  const { createSdrApp } = require('../../sdr-server');
  const ENV_ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
  });

  it('sobe sem Firebase e informa o modo do Kommo', async () => {
    const resposta = await request(createSdrApp({ kommo: { modo: 'observar' } })).get('/health');

    expect(resposta.status).toBe(200);
    expect(resposta.body).toEqual({ ok: true, service: 'sdr-agent-urace', kommo: 'observar' });
  });

  it('avalia interacoes pela mesma rota do backend completo', async () => {
    delete process.env.SDR_WEBHOOK_TOKEN;
    const resposta = await request(createSdrApp({ kommo: null }))
      .post('/api/sdr/avaliar')
      .send({ canal: 'whatsapp', texto: 'Quanto custa o coaching?' });

    expect(resposta.status).toBe(200);
    expect(resposta.body.kommo.entraNoComercial).toBe(true);
  });

  it('recebe o webhook do Kommo e processa em segundo plano', async () => {
    process.env.KOMMO_WEBHOOK_TOKEN = 'segredo';
    const receberWebhook = jest.fn().mockResolvedValue([]);

    const resposta = await request(createSdrApp({ kommo: { receberWebhook } }))
      .post('/api/kommo/webhook?token=segredo')
      .type('form')
      .send('message[add][0][text]=Oi&message[add][0][element_id]=1&message[add][0][element_type]=2');

    expect(resposta.status).toBe(200);
    expect(receberWebhook).toHaveBeenCalledTimes(1);
  });

  it('rota desconhecida responde 404', async () => {
    const resposta = await request(createSdrApp({ kommo: null })).get('/api/reservas');
    expect(resposta.status).toBe(404);
  });
});
