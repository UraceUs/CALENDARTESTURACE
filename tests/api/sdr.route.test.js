// Endpoints do SDR: webhook de avaliacao e consulta das regras ativas.
const request = require('supertest');
const http = require('http');
const { createApp } = require('../../server');

describe('Endpoints do SDR', () => {
  let server;
  const tokenOriginal = process.env.SDR_WEBHOOK_TOKEN;

  beforeAll(() => {
    delete process.env.SDR_WEBHOOK_TOKEN;
    const app = createApp({ repo: {}, configRepo: {}, emailService: {} });
    server = http.createServer((req, res) => {
      app(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
  });

  afterAll(() => {
    if (tokenOriginal === undefined) {
      delete process.env.SDR_WEBHOOK_TOKEN;
    } else {
      process.env.SDR_WEBHOOK_TOKEN = tokenOriginal;
    }
  });

  it('GET /api/sdr/regras devolve a parametrizacao ativa', async () => {
    const resposta = await request(server).get('/api/sdr/regras');

    expect(resposta.status).toBe(200);
    expect(resposta.body.ok).toBe(true);
    expect(resposta.body.regras.entrada.limiarScore).toBe(40);
    expect(resposta.body.regras.canais.comRobo).toContain('whatsapp');
  });

  it('POST /api/sdr/avaliar decide criar card para intencao comercial', async () => {
    const resposta = await request(server)
      .post('/api/sdr/avaliar')
      .send({ canal: 'whatsapp', tipo: 'mensagem', texto: 'Quanto custa o Professional Coaching?' });

    expect(resposta.status).toBe(200);
    expect(resposta.body.ok).toBe(true);
    expect(resposta.body.kommo.criarCard).toBe(true);
    expect(resposta.body.robo.responder).toBe(true);
    expect(Array.isArray(resposta.body.robo.mensagens)).toBe(true);
  });

  it('POST /api/sdr/avaliar nao cria card para saudacao isolada', async () => {
    const resposta = await request(server)
      .post('/api/sdr/avaliar')
      .send({ canal: 'instagram', tipo: 'mensagem', texto: 'Oi' });

    expect(resposta.status).toBe(200);
    expect(resposta.body.kommo.criarCard).toBe(false);
    expect(resposta.body.kommo.acao).toBe('somente_conversa');
  });

  it('POST /api/sdr/avaliar recusa evento invalido', async () => {
    const resposta = await request(server)
      .post('/api/sdr/avaliar')
      .send({ tipo: 'mensagem', texto: 'Oi' });

    expect(resposta.status).toBe(400);
    expect(resposta.body.error.code).toBe('VALIDATION_ERROR');
    expect(resposta.body.error.details).toContain('CANAL_OBRIGATORIO');
  });

  it('POST /api/sdr/avaliar recusa JSON malformado', async () => {
    const resposta = await request(server)
      .post('/api/sdr/avaliar')
      .set('Content-Type', 'application/json')
      .send('{ isso nao e json');

    expect(resposta.status).toBe(400);
    expect(resposta.body.error.code).toBe('INVALID_JSON');
  });
});

describe('Protecao por token do webhook do SDR', () => {
  let server;
  const tokenOriginal = process.env.SDR_WEBHOOK_TOKEN;

  beforeAll(() => {
    process.env.SDR_WEBHOOK_TOKEN = 'token-secreto';
    const app = createApp({ repo: {}, configRepo: {}, emailService: {} });
    server = http.createServer((req, res) => {
      app(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
  });

  afterAll(() => {
    if (tokenOriginal === undefined) {
      delete process.env.SDR_WEBHOOK_TOKEN;
    } else {
      process.env.SDR_WEBHOOK_TOKEN = tokenOriginal;
    }
  });

  it('recusa requisicao sem token quando SDR_WEBHOOK_TOKEN esta configurado', async () => {
    const resposta = await request(server)
      .post('/api/sdr/avaliar')
      .send({ canal: 'whatsapp', texto: 'Quanto custa?' });

    expect(resposta.status).toBe(401);
    expect(resposta.body.error.code).toBe('UNAUTHORIZED');
  });

  it('aceita requisicao com token correto', async () => {
    const resposta = await request(server)
      .post('/api/sdr/avaliar')
      .set('Authorization', 'Bearer token-secreto')
      .send({ canal: 'whatsapp', texto: 'Quanto custa?' });

    expect(resposta.status).toBe(200);
    expect(resposta.body.ok).toBe(true);
  });
});
