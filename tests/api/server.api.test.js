const request = require('supertest');

const dbState = {
  reservas: [],
  disponibilidade: [],
  capacidade: []
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

  it('POST /api/reservas returns 503 when SMTP is not configured', async () => {
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

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: {
        code: 'EMAIL_SERVICE_NOT_CONFIGURED'
      }
    });
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
});
