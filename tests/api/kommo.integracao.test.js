// Integracao com o Kommo: mapa para os funis reais, webhook de mensagens e
// acoes no card. O Kommo falso parte da estrutura real da conta (fixture).
const request = require('supertest');
const kommo = require('../../lib/kommo');
const { regras } = require('../../lib/sdr');
const { createApp } = require('../../server');
const FIXTURE = require('./fixtures/kommo-funis.json');

// IDs reais (urace.kommo.com) usados nas verificacoes.
const URACE = 9903543;
const COMERCIAL = 14512484;
const CONTACT_LIST = 9957459;
const ST = {
  incoming: 76050835,
  firstContact: 105276412,
  conversa: 90232403,
  coldLeads: 77188783,
  hotLeads: 78606031,
  suppliers: 76999131,
  cEntrada: 112100844,
  cAtendimento: 112100852,
  cProposta: 112113592,
  cFechamento: 112113596,
  interactions: 76442723
};

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

describe('Kommo — mapa para os funis reais', () => {
  it('a conta atual ja tem tudo que o mapa usa: nada a criar', async () => {
    const falso = criarKommoFalso();
    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);

    const resultado = await integracao.sincronizarEstrutura({ aplicar: true });

    expect(resultado.plano.ok).toBe(true);
    expect(resultado.aplicado).toBe(false);
    expect(falso.escritas()).toHaveLength(0);
    expect(resultado.mapa.Entrada.id).toBe(URACE);
    expect(resultado.mapa.Comercial.id).toBe(COMERCIAL);
  });

  it('aponta a etapa FECHAMENTO repetida no funil Comercial', async () => {
    const plano = kommo.planejarEstrutura(FIXTURE.pipelines);
    expect(plano.etapasDuplicadas).toEqual([{ pipeline: 'Comercial', etapa: 'FECHAMENTO', ocorrencias: 2 }]);
  });

  it('nunca acrescenta etapa em funil que ja existe', async () => {
    const semStandBy = JSON.parse(JSON.stringify(FIXTURE.pipelines));
    const comercial = semStandBy.find(p => p.name === 'Comercial');
    comercial._embedded.statuses = comercial._embedded.statuses.filter(s => s.name.trim() !== 'PROPOSTA');
    const falso = criarKommoFalso(semStandBy);
    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);

    const resultado = await integracao.sincronizarEstrutura({ aplicar: true });

    expect(resultado.plano.ok).toBe(false);
    expect(resultado.plano.etapasFaltando).toEqual([{ pipeline: 'Comercial', etapa: 'PROPOSTA' }]);
    expect(falso.escritas()).toHaveLength(0);
  });

  it('cria um funil inteiro so quando ele nao existe e com aplicar', async () => {
    const semComercial = FIXTURE.pipelines.filter(p => p.name !== 'Comercial');
    const falso = criarKommoFalso(semComercial);
    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);

    const simulacao = await integracao.sincronizarEstrutura({ aplicar: false });
    expect(simulacao.plano.pipelinesFaltando[0].nome).toBe('Comercial');
    expect(falso.escritas()).toHaveLength(0);

    const aplicado = await integracao.sincronizarEstrutura({ aplicar: true });
    expect(aplicado.resultado.ok).toBe(true);
    const criado = falso.escritas()[0].corpo[0];
    expect(criado.is_unsorted_on).toBe(false);
    expect(criado._embedded.statuses.map(s => s.name)).toEqual(['ENTRADA', 'ATENDIMENTO', 'PROPOSTA', 'FECHAMENTO', 'PERDIDO / NAO QUALIFICADO']);
  });

  it('sem configuracao nao cria integracao', () => {
    expect(kommo.criarIntegracaoDoAmbiente({})).toBeNull();
  });

  it('integracao do ambiente comeca em modo observar', () => {
    expect(kommo.criarIntegracaoDoAmbiente(ENV).modo).toBe('observar');
    expect(kommo.criarIntegracaoDoAmbiente({ ...ENV, KOMMO_MODO: 'aplicar' }).modo).toBe('aplicar');
  });
});

describe('Kommo — webhook de mensagem aplica as regras no card', () => {
  it('converte o corpo form-urlencoded do Kommo', () => {
    const corpo = kommo.parseCorpoWebhook(
      'message%5Badd%5D%5B0%5D%5Btext%5D=Oi&message%5Badd%5D%5B0%5D%5Belement_id%5D=42&message%5Badd%5D%5B0%5D%5Belement_type%5D=2',
      'application/x-www-form-urlencoded'
    );
    const [msg] = kommo.extrairMensagensRecebidas(corpo);

    expect(msg.texto).toBe('Oi');
    expect(msg.leadId).toBe('42');
  });

  it('pergunta de preco em First Contact desce para Comercial / ENTRADA', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(1, URACE, ST.firstContact);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(1, 'Quanto custa o coaching?'));

    expect(resultado.acao).toBe('promover_card');
    expect(falso.estado.leads[1].pipeline_id).toBe(COMERCIAL);
    expect(falso.estado.leads[1].status_id).toBe(ST.cEntrada);
    expect(falso.estado.leads[1]._embedded.tags.map(t => t.name)).toContain('sdr:intencao-comercial');
    expect(falso.estado.notas[0].texto).toContain('promover_card');
  });

  it('em modo observar calcula tudo e nao escreve nada', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(1, URACE, ST.firstContact);

    const [resultado] = await integracaoPara(falso, { modo: 'observar' }).receberWebhook(mensagem(1, 'Quanto custa o coaching?'));

    expect(resultado.modo).toBe('observar');
    expect(resultado.moveu).toEqual({ pipeline: 'Comercial', etapa: regras.ESTAGIOS.QUALIFICANDO });
    expect(resultado.nota).toBe(true);
    expect(falso.escritas()).toHaveLength(0);
  });

  it('codigo de login vai para Cold Leads com a tag nao_e_lead, sem nota', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(2, URACE, ST.firstContact);

    await integracaoPara(falso).receberWebhook(mensagem(2, '713157 is your code to log in to Kommo', { origin: 'email' }));

    expect(falso.estado.leads[2].status_id).toBe(ST.coldLeads);
    expect(falso.estado.leads[2]._embedded.tags.map(t => t.name)).toEqual(expect.arrayContaining(['sdr:automatico', 'nao_e_lead']));
    expect(falso.estado.notas).toHaveLength(0);
  });

  it('pedido de humano vai para ATENDIMENTO com nota, tarefa e robo silenciado', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(3, URACE, ST.firstContact);
    const agora = new Date('2026-09-23T14:00:00Z');
    const integracao = integracaoPara(falso, { responsavelId: '777' });

    const resultado = await integracao.processarMensagem(
      kommo.extrairMensagensRecebidas(mensagem(3, 'Quero falar com alguem'))[0],
      agora
    );

    expect(resultado.tarefa.prioridade).toBe('alta');
    expect(falso.estado.leads[3].pipeline_id).toBe(COMERCIAL);
    expect(falso.estado.leads[3].status_id).toBe(ST.cAtendimento);
    expect(falso.estado.tarefas[0].responsible_user_id).toBe(777);
    expect(falso.estado.tarefas[0].complete_till).toBeGreaterThan(agora.getTime() / 1000);
    expect(falso.estado.notas[0].texto).toContain('HANDOFF ALTA');
    expect(falso.estado.leads[3]._embedded.tags.map(t => t.name)).toContain('sdr:handoff');
  });

  it('lead em etapa da equipe no funil Urace (Hot Leads) nao e mexido', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(4, URACE, ST.hotLeads);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(4, 'Obrigado!'));

    expect(resultado.ignorado).toBe('ETAPA_DA_EQUIPE');
    expect(falso.escritas()).toHaveLength(0);
  });

  it('lead perdido no Urace so volta se for para descer ao Comercial', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(5, URACE, 143, { closed_at: 1789000000 });
    falso.criarLead(6, URACE, 143, { closed_at: 1789000000 });
    const integracao = integracaoPara(falso);

    const [semSinal] = await integracao.receberWebhook(mensagem(5, 'Obrigado!'));
    const [comSinal] = await integracao.receberWebhook(mensagem(6, 'Tem vaga no sabado? Quanto custa?'));

    expect(semSinal.ignorado).toBe('FECHADO_SEM_SINAL');
    expect(falso.estado.leads[5].status_id).toBe(143);
    expect(comSinal.acao).toBe('promover_card');
    expect(falso.estado.leads[6].pipeline_id).toBe(COMERCIAL);
  });

  it('lead ainda em Incoming leads nao e mexido', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(7, URACE, ST.incoming);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(7, 'Quanto custa?'));

    expect(resultado.ignorado).toBe('INCOMING_LEADS');
  });

  it('lead ja no Comercial (PROPOSTA) so recebe anexo, sem mudar de etapa', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(8, COMERCIAL, ST.cProposta);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(8, 'Quanto custa?'));

    expect(resultado.acao).toBe('anexar_card');
    expect(falso.estado.leads[8].status_id).toBe(ST.cProposta);
  });

  it('reserva confirmada no site fecha como ganho (142)', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(9, COMERCIAL, ST.cFechamento);
    const cliente = kommo.criarClienteKommo({ subdominio: 'urace', token: 't', fetchImpl: falso.fetchImpl });
    const mapa = await kommo.criarResolvedorDeMapa(cliente)();
    const decisao = require('../../lib/sdr').avaliarInteracao({
      canal: 'site',
      tipo: 'reserva_etapa2',
      reserva: { pitId: 'PIT-AB12-XYZ9', etapa: 2 },
      card: { existe: true, id: '9', pipeline: 'Comercial', status: 'aberto' }
    });

    await kommo.aplicarDecisao(cliente, falso.estado.leads[9], decisao, mapa, { modo: 'aplicar' });

    expect(falso.estado.leads[9].status_id).toBe(142);
  });

  it('opt-out no Urace fecha como perdido com a tag opt_out', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(10, URACE, ST.conversa);

    await integracaoPara(falso).receberWebhook(mensagem(10, 'Pare de mandar mensagem'));

    expect(falso.estado.leads[10].status_id).toBe(143);
    expect(falso.estado.leads[10]._embedded.tags.map(t => t.name)).toContain('opt_out');
  });

  it('mensagem da equipe (outgoing), repetida ou de outro funil e ignorada', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(11, URACE, ST.firstContact);
    falso.criarLead(12, CONTACT_LIST, ST.interactions);
    const integracao = integracaoPara(falso);

    expect(await integracao.receberWebhook(mensagem(11, 'Quanto custa?', { type: 'outgoing' }))).toHaveLength(0);
    const [outroFunil] = await integracao.receberWebhook(mensagem(12, 'Quanto custa?'));
    expect(outroFunil.ignorado).toBe('PIPELINE_FORA_DO_SDR');

    const corpo = mensagem(11, 'Quanto custa?', { id: 'repetida' });
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
