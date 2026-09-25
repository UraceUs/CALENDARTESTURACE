// Integracao com o Kommo: funis, webhook de mensagens e acoes no card.
const request = require('supertest');
const kommo = require('../../lib/kommo');
const { regras } = require('../../lib/sdr');
const { createApp } = require('../../server');

// Kommo falso em memoria, respondendo como a API v4 via fetch.
function criarKommoFalso({ comFunis = true } = {}) {
  let proximoId = 1000;
  const estado = {
    pipelines: [],
    leads: {},
    chamadas: [],
    notas: [],
    tarefas: [],
    webhooks: []
  };

  function novoPipeline(nome, etapas) {
    const pipeline = {
      id: proximoId++,
      name: nome,
      sort: 10,
      _embedded: {
        statuses: [
          ...etapas.map((etapa, i) => ({ id: proximoId++, name: etapa, sort: 10 + i * 10 })),
          { id: 142, name: 'Closed - won', sort: 10000 },
          { id: 143, name: 'Closed - lost', sort: 11000 }
        ]
      }
    };
    estado.pipelines.push(pipeline);
    return pipeline;
  }

  novoPipeline('Funil antigo', ['Incoming', 'Contato']);
  if (comFunis) {
    kommo.estruturaDesejada().forEach(p => novoPipeline(p.nome, p.etapas));
  }

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
      corpo.forEach(p => novoPipeline(p.name, p._embedded.statuses.map(s => s.name)));
      return responder(200, {});
    }
    const etapas = caminho.match(/^\/leads\/pipelines\/(\d+)\/statuses$/);
    if (metodo === 'POST' && etapas) {
      const pipeline = estado.pipelines.find(p => String(p.id) === etapas[1]);
      corpo.forEach(s => pipeline._embedded.statuses.push({ id: proximoId++, name: s.name, sort: s.sort }));
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

  function pipeline(nome) {
    return estado.pipelines.find(p => p.name === nome);
  }

  function statusId(nomePipeline, etapa) {
    return pipeline(nomePipeline)._embedded.statuses.find(s => s.name === etapa).id;
  }

  function criarLead(id, nomePipeline, etapa, extras = {}) {
    estado.leads[id] = {
      id,
      pipeline_id: pipeline(nomePipeline).id,
      status_id: statusId(nomePipeline, etapa),
      responsible_user_id: 555,
      updated_at: 1790000000,
      closed_at: null,
      _embedded: { tags: [] },
      ...extras
    };
    return estado.leads[id];
  }

  return { estado, fetchImpl, pipeline, statusId, criarLead };
}

const ENV = { KOMMO_SUBDOMINIO: 'urace', KOMMO_TOKEN: 'tok', KOMMO_RESPONSAVEL_ID: '777' };
const T = regras.ETAPAS_ENTRADA;
const C = regras.ESTAGIOS;

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

describe('Kommo — funis', () => {
  it('planeja e cria os funis Entrada e Comercial que faltam', async () => {
    const falso = criarKommoFalso({ comFunis: false });
    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);

    const simulacao = await integracao.sincronizarEstrutura({ aplicar: false });
    expect(simulacao.aplicado).toBe(false);
    expect(simulacao.plano.pipelinesFaltando.map(p => p.nome)).toEqual(['Entrada', 'Comercial']);
    expect(falso.estado.chamadas.some(c => c.metodo === 'POST')).toBe(false);

    const aplicado = await integracao.sincronizarEstrutura({ aplicar: true });
    expect(aplicado.resultado.ok).toBe(true);

    const criacao = falso.estado.chamadas.find(c => c.metodo === 'POST' && c.caminho === '/leads/pipelines');
    expect(criacao.corpo[0].is_unsorted_on).toBe(false);
    // Confirmada e Perdido usam os fechamentos nativos (142/143), nao etapas novas.
    const etapasComercial = criacao.corpo[1]._embedded.statuses.map(s => s.name);
    expect(etapasComercial).not.toContain(C.PERDIDO);
    expect(etapasComercial).not.toContain(C.CONFIRMADA);
  });

  it('completa so as etapas que faltam num funil existente', async () => {
    const falso = criarKommoFalso();
    const entrada = falso.pipeline('Entrada');
    entrada._embedded.statuses = entrada._embedded.statuses.filter(s => s.name !== T.AUTOMATICO);

    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);
    const resultado = await integracao.sincronizarEstrutura({ aplicar: true });

    expect(resultado.plano.etapasFaltando).toEqual([{ pipeline: 'Entrada', etapa: T.AUTOMATICO }]);
    expect(resultado.resultado.ok).toBe(true);
  });

  it('sem configuracao nao cria integracao', () => {
    expect(kommo.criarIntegracaoDoAmbiente({})).toBeNull();
  });
});

describe('Kommo — webhook de mensagem aplica as regras no card', () => {
  const silencioso = { log: () => {}, error: () => {} };

  function integracaoPara(falso, extras = {}) {
    const cliente = kommo.criarClienteKommo({ subdominio: 'urace', token: 't', fetchImpl: falso.fetchImpl });
    return kommo.criarIntegracaoKommo({ cliente, obterMapa: kommo.criarResolvedorDeMapa(cliente), log: silencioso, ...extras });
  }

  it('converte o corpo form-urlencoded do Kommo', () => {
    const corpo = kommo.parseCorpoWebhook(
      'message%5Badd%5D%5B0%5D%5Btext%5D=Oi&message%5Badd%5D%5B0%5D%5Belement_id%5D=42&message%5Badd%5D%5B0%5D%5Belement_type%5D=2',
      'application/x-www-form-urlencoded'
    );
    const [msg] = kommo.extrairMensagensRecebidas(corpo);

    expect(msg.texto).toBe('Oi');
    expect(msg.leadId).toBe('42');
  });

  it('pergunta de preco na Entrada desce o card para o Comercial', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(1, 'Entrada', T.TRIAGEM);
    const integracao = integracaoPara(falso);

    const [resultado] = await integracao.receberWebhook(mensagem(1, 'Quanto custa o coaching?'));

    expect(resultado.acao).toBe('promover_card');
    expect(falso.estado.leads[1].pipeline_id).toBe(falso.pipeline('Comercial').id);
    expect(falso.estado.leads[1].status_id).toBe(falso.statusId('Comercial', C.QUALIFICANDO));
    expect(falso.estado.leads[1]._embedded.tags.map(t => t.name)).toContain('sdr:intencao-comercial');
    expect(falso.estado.notas).toHaveLength(1);
    expect(falso.estado.notas[0].texto).toContain('promover_card');
  });

  it('codigo de verificacao vai para Automaticos e nao gera nota', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(2, 'Entrada', T.TRIAGEM);
    const integracao = integracaoPara(falso);

    await integracao.receberWebhook(mensagem(2, 'Your verification code is 552211', { origin: 'email' }));

    expect(falso.estado.leads[2].status_id).toBe(falso.statusId('Entrada', T.AUTOMATICO));
    expect(falso.estado.notas).toHaveLength(0);
  });

  it('pedido de humano gera nota, tarefa para o responsavel unico e silencia o robo', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(3, 'Entrada', T.TRIAGEM);
    const integracao = integracaoPara(falso, { responsavelId: '777' });
    const agora = new Date('2026-09-23T14:00:00Z');

    const resultado = await integracao.processarMensagem(
      kommo.extrairMensagensRecebidas(mensagem(3, 'Quero falar com alguem'))[0],
      agora
    );

    expect(resultado.tarefa.prioridade).toBe('alta');
    expect(falso.estado.leads[3].pipeline_id).toBe(falso.pipeline('Comercial').id);
    expect(falso.estado.leads[3].status_id).toBe(falso.statusId('Comercial', C.HUMANO));
    expect(falso.estado.tarefas[0].responsible_user_id).toBe(777);
    expect(falso.estado.tarefas[0].entity_type).toBe('leads');
    expect(falso.estado.tarefas[0].complete_till).toBeGreaterThan(agora.getTime() / 1000);
    expect(falso.estado.notas[0].texto).toContain('HANDOFF ALTA');
    const tags = falso.estado.leads[3]._embedded.tags.map(t => t.name);
    expect(tags).toContain('sdr:handoff');
  });

  it('mensagem enviada pela equipe (outgoing) e ignorada', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(4, 'Entrada', T.TRIAGEM);
    const integracao = integracaoPara(falso);

    const resultados = await integracao.receberWebhook(mensagem(4, 'Quanto custa?', { type: 'outgoing' }));

    expect(resultados).toHaveLength(0);
    expect(falso.estado.leads[4].status_id).toBe(falso.statusId('Entrada', T.TRIAGEM));
  });

  it('lead de funil fora do SDR nao e mexido', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(5, 'Funil antigo', 'Contato');
    const integracao = integracaoPara(falso);

    const [resultado] = await integracao.receberWebhook(mensagem(5, 'Quanto custa?'));

    expect(resultado.ignorado).toBe('PIPELINE_FORA_DO_SDR');
    expect(falso.estado.chamadas.some(c => c.metodo === 'PATCH')).toBe(false);
  });

  it('mesma mensagem entregue duas vezes e processada uma vez', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(6, 'Entrada', T.TRIAGEM);
    const integracao = integracaoPara(falso);
    const corpo = mensagem(6, 'Quanto custa?', { id: 'repetida' });

    await integracao.receberWebhook(corpo);
    const [segunda] = await integracao.receberWebhook(corpo);

    expect(segunda.ignorado).toBe('DUPLICADA');
    expect(falso.estado.notas).toHaveLength(1);
  });

  it('lead ja no Comercial so recebe anexo, sem mudar de etapa', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(7, 'Comercial', C.ETAPA1);
    const integracao = integracaoPara(falso);

    const [resultado] = await integracao.receberWebhook(mensagem(7, 'Quanto custa?'));

    expect(resultado.acao).toBe('anexar_card');
    expect(falso.estado.leads[7].status_id).toBe(falso.statusId('Comercial', C.ETAPA1));
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
    expect(receberWebhook).toHaveBeenCalledTimes(1);
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
