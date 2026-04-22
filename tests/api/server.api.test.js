const request = require('supertest');

const dbState = {
  reservas: [],
  disponibilidade: [],
  capacidade: [],
  config: []
};

let idCounter = 0;

function snapshotFromRecord(record) {
  return {
    id: record.id,
    exists: Boolean(record),
    data: () => ({ ...record })
  };
}

function getCollectionRecords(name) {
  return dbState[name];
}

function getDocById(name, id) {
  return getCollectionRecords(name).find(item => item.id === id) || null;
}

function setDocById(name, id, value) {
  const list = getCollectionRecords(name);
  const index = list.findIndex(item => item.id === id);
  const next = { id, ...value };

  if (index === -1) {
    list.push(next);
  } else {
    list[index] = next;
  }

  return next;
}

const apps = [];

const db = {
  collection(name) {
    return {
      async get() {
        const records = getCollectionRecords(name);
        return {
          forEach(callback) {
            records.forEach(record => callback(snapshotFromRecord(record)));
          }
        };
      },
      async add(payload) {
        const id = `reserva-${++idCounter}`;
        const created = {
          id,
          ...payload,
          createdAt: new Date().toISOString()
        };
        getCollectionRecords(name).push(created);

        return {
          id,
          async get() {
            return snapshotFromRecord(created);
          }
        };
      },
      doc(id) {
        return {
          async get() {
            const record = getDocById(name, id);
            if (!record) {
              return {
                id,
                exists: false,
                data: () => ({})
              };
            }
            return snapshotFromRecord(record);
          },
          async set(payload) {
            setDocById(name, id, payload);
          },
          async update(payload) {
            const current = getDocById(name, id);
            if (!current) {
              throw new Error('NOT_FOUND');
            }
            setDocById(name, id, { ...current, ...payload });
          },
          async delete() {
            const list = getCollectionRecords(name);
            const index = list.findIndex(item => item.id === id);
            if (index !== -1) {
              list.splice(index, 1);
            }
          }
        };
      }
    };
  }
};

const firestore = () => db;
firestore.FieldValue = {
  serverTimestamp() {
    return new Date();
  }
};

jest.mock('firebase-admin', () => ({
  apps,
  initializeApp: jest.fn(() => {
    apps.push({ initialized: true });
  }),
  credential: {
    cert: jest.fn(() => ({})),
    applicationDefault: jest.fn(() => ({}))
  },
  firestore
}));

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn(async () => ({ messageId: 'mock-message-id' }))
  }))
}));

const { createServer } = require('../../server');

let app;

function resetState() {
  dbState.reservas.length = 0;
  dbState.disponibilidade.length = 0;
  dbState.capacidade.length = 0;
  dbState.config.length = 0;
  idCounter = 0;
}

beforeAll(() => {
  app = createServer();
});

beforeEach(() => {
  resetState();
});

describe('API routes', () => {
  it('GET /api/reservas returns current reservations', async () => {
    const response = await request(app).get('/api/reservas');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(0);
  });

  it('POST /api/reservas saves reservation and returns immediate email delivery status', async () => {
    const payload = {
      nomePiloto: 'Teste Piloto',
      responsavelPiloto: 'Teste Responsavel',
      servico: 'Professional Coaching',
      data: '2026-05-20',
      periodo: 'manha',
      email: 'piloto@example.com',
      telefone: '11999999999',
      age: '25',
      height: '1.70m',
      weight: '70kg',
      waist: '80cm',
      kartingExperience: 'Nao'
    };

    const response = await request(app)
      .post('/api/reservas')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      reserva: {
        nomePiloto: payload.nomePiloto,
        responsavelPiloto: payload.responsavelPiloto,
        servico: payload.servico,
        data: payload.data,
        periodo: payload.periodo,
        email: payload.email
      },
      emailConfirmation: {
        sent: false,
        reason: 'EMAIL_NOT_CONFIGURED'
      },
      supportNotification: {
        sent: false,
        reason: 'EMAIL_NOT_CONFIGURED'
      }
    });

    expect(dbState.reservas).toHaveLength(1);
    expect(dbState.reservas[0].nomePiloto).toBe(payload.nomePiloto);
  });

  it('POST /api/disponibilidade blocks and unblocks a period', async () => {
    const blockResponse = await request(app)
      .post('/api/disponibilidade')
      .set('Content-Type', 'application/json')
      .send({ data: '2026-06-10', periodo: 'manha', bloqueado: true });

    expect(blockResponse.status).toBe(200);
    expect(blockResponse.body.disponibilidade).toEqual(
      expect.arrayContaining([{ data: '2026-06-10', periodo: 'manha' }])
    );

    const unblockResponse = await request(app)
      .post('/api/disponibilidade')
      .set('Content-Type', 'application/json')
      .send({ data: '2026-06-10', periodo: 'manha', bloqueado: false });

    expect(unblockResponse.status).toBe(200);
    expect(unblockResponse.body.disponibilidade).toEqual([]);
  });

  it('POST /api/disponibilidade applies blocking across a date range', async () => {
    const response = await request(app)
      .post('/api/disponibilidade')
      .set('Content-Type', 'application/json')
      .send({ dataInicial: '2026-06-10', dataFinal: '2026-06-12', periodo: 'manha', bloqueado: true });

    expect(response.status).toBe(200);
    expect(response.body.disponibilidade).toEqual(
      expect.arrayContaining([
        { data: '2026-06-10', periodo: 'manha' },
        { data: '2026-06-11', periodo: 'manha' },
        { data: '2026-06-12', periodo: 'manha' }
      ])
    );
  });

  it('POST /api/capacidade increments capacity for a period', async () => {
    const response = await request(app)
      .post('/api/capacidade')
      .set('Content-Type', 'application/json')
      .send({ data: '2026-06-11', periodo: 'tarde', quantidade: 3 });

    expect(response.status).toBe(200);
    expect(response.body.capacidade).toMatchObject({
      data: '2026-06-11',
      periodo: 'tarde',
      vagas: 7
    });

    const getResponse = await request(app).get('/api/capacidade');
    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toEqual(
      expect.arrayContaining([{ data: '2026-06-11', periodo: 'tarde', vagas: 7 }])
    );
  });

  it('POST /api/capacidade applies extra capacity across a date range', async () => {
    const response = await request(app)
      .post('/api/capacidade')
      .set('Content-Type', 'application/json')
      .send({ dataInicial: '2026-06-11', dataFinal: '2026-06-13', periodo: 'tarde', quantidade: 2 });

    expect(response.status).toBe(200);

    const getResponse = await request(app).get('/api/capacidade');
    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toEqual(
      expect.arrayContaining([
        { data: '2026-06-11', periodo: 'tarde', vagas: 6 },
        { data: '2026-06-12', periodo: 'tarde', vagas: 6 },
        { data: '2026-06-13', periodo: 'tarde', vagas: 6 }
      ])
    );
  });

  it('DELETE /api/capacidade removes manual capacity adjustment for a period', async () => {
    await request(app)
      .post('/api/capacidade')
      .set('Content-Type', 'application/json')
      .send({ data: '2026-06-11', periodo: 'tarde', quantidade: 2 });

    const deleteResponse = await request(app)
      .delete('/api/capacidade')
      .set('Content-Type', 'application/json')
      .send({ data: '2026-06-11', periodo: 'tarde' });

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body).toMatchObject({
      removed: true,
      capacidade: {
        data: '2026-06-11',
        periodo: 'tarde'
      }
    });

    const getResponse = await request(app).get('/api/capacidade');
    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toEqual([]);
  });

  it('POST /api/disponibilidade returns validation error for invalid period', async () => {
    const response = await request(app)
      .post('/api/disponibilidade')
      .set('Content-Type', 'application/json')
      .send({ data: '2026-06-10', periodo: 'noite', bloqueado: true });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR'
      }
    });
  });

  it('POST /api/capacidade returns validation error for invalid quantity', async () => {
    const response = await request(app)
      .post('/api/capacidade')
      .set('Content-Type', 'application/json')
      .send({ data: '2026-06-11', periodo: 'manha', quantidade: 0 });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR'
      }
    });
  });

  it('OPTIONS /api/reservas returns CORS preflight response', async () => {
    const response = await request(app)
      .options('/api/reservas');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('DELETE /api/reservas/:id returns 404 when reservation does not exist', async () => {
    const response = await request(app)
      .delete('/api/reservas/inexistente');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: {
        code: 'NOT_FOUND'
      }
    });
  });

  it('POST /api/reservas/:id/resend-confirmation resends user and admin confirmations', async () => {
    const payload = {
      nomePiloto: 'Piloto Reenvio',
      responsavelPiloto: 'Resp Reenvio',
      servico: 'Professional Coaching',
      data: '2026-05-21',
      periodo: 'tarde',
      email: 'reenvio@example.com',
      telefone: '11988887777',
      age: '30',
      height: '1.75m',
      weight: '75kg',
      waist: '82cm',
      kartingExperience: 'Nao'
    };

    const createResponse = await request(app)
      .post('/api/reservas')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(createResponse.status).toBe(201);
    const reservaId = createResponse.body && createResponse.body.reserva && createResponse.body.reserva.id;
    expect(reservaId).toBeTruthy();

    const resendResponse = await request(app)
      .post(`/api/reservas/${encodeURIComponent(reservaId)}/resend-confirmation`);

    expect(resendResponse.status).toBe(200);
    expect(resendResponse.body).toMatchObject({
      id: reservaId,
      emailConfirmation: {
        sent: false,
        reason: 'EMAIL_NOT_CONFIGURED'
      },
      supportNotification: {
        sent: false,
        reason: 'EMAIL_NOT_CONFIGURED'
      }
    });
  });

  it('GET /api/config/servicos returns default visibility for all services', async () => {
    const response = await request(app)
      .get('/api/config/servicos');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      allServices: expect.arrayContaining([
        'Professional Coaching',
        'Summer Camp',
        'Trackside Support'
      ]),
      enabledServices: expect.arrayContaining([
        'Professional Coaching',
        'Summer Camp',
        'Trackside Support'
      ])
    });
  });

  it('POST /api/config/servicos updates visible services', async () => {
    const response = await request(app)
      .post('/api/config/servicos')
      .set('Content-Type', 'application/json')
      .send({ enabledServices: ['Professional Coaching', 'Trackside Support'] });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabledServices: ['Professional Coaching', 'Trackside Support']
    });

    const getResponse = await request(app)
      .get('/api/config/servicos');

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.enabledServices).toEqual(['Professional Coaching', 'Trackside Support']);
  });

  it('POST /api/config/servicos allows adding a new service to the catalog', async () => {
    const response = await request(app)
      .post('/api/config/servicos')
      .set('Content-Type', 'application/json')
      .send({
        allServices: ['Professional Coaching', 'Driver Development'],
        enabledServices: ['Driver Development']
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      allServices: ['Professional Coaching', 'Driver Development'],
      enabledServices: ['Driver Development']
    });
  });

  it('POST /api/reservas rejects reservation for disabled service', async () => {
    await request(app)
      .post('/api/config/servicos')
      .set('Content-Type', 'application/json')
      .send({ enabledServices: ['Trackside Support'] });

    const payload = {
      nomePiloto: 'Piloto Bloqueado',
      responsavelPiloto: 'Resp Bloqueado',
      servico: 'Professional Coaching',
      data: '2026-05-22',
      periodo: 'manha',
      email: 'bloqueado@example.com',
      telefone: '11988887777',
      age: '31',
      height: '1.72m',
      weight: '72kg',
      waist: '81cm',
      kartingExperience: 'Nao'
    };

    const response = await request(app)
      .post('/api/reservas')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR'
      }
    });
  });
});
