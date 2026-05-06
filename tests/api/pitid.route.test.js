const request = require('supertest');
const { createApp } = require('../../server');

function createInMemoryRepo() {
  const map = new Map();

  return {
    async getByPitId(pitId) {
      const data = map.get(pitId);
      return {
        exists: Boolean(data),
        id: pitId,
        ref: null,
        data: data || null
      };
    },

    async upsertStageOne(pitId, stageData) {
      const current = map.get(pitId) || {};
      const next = {
        ...current,
        pitId,
        ...stageData,
        bookingProgress: 50,
        bookingStageStatus: 'incompleta'
      };
      map.set(pitId, next);
      return {
        id: pitId,
        data: next
      };
    },

    async updateStageTwo(pitId, stageData) {
      const current = map.get(pitId);
      if (!current) {
        return null;
      }

      const next = {
        ...current,
        pitId,
        ...stageData,
        bookingProgress: 100,
        bookingStageStatus: 'completa'
      };
      map.set(pitId, next);
      return {
        id: pitId,
        data: next
      };
    },

    _map: map
  };
}

describe('PATCH /api/reservas/pit/:pitId', () => {
  let repo;
  let app;

  beforeEach(() => {
    repo = createInMemoryRepo();
    app = createApp({ repo });
  });

  it('deve criar/atualizar etapa 1 usando pitId como chave principal', async () => {
    const response = await request(app)
      .patch('/api/reservas/pit/pit-abc-123')
      .send({
        etapa: 1,
        data: '2026-06-15',
        periodo: 'manha',
        servico: 'Professional Coaching'
      });

    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({ stage: 1, key: 'pitId' });
    expect(response.body.reserva.pitId).toBe('PIT-ABC-123');
    expect(repo._map.has('PIT-ABC-123')).toBe(true);
    expect(repo._map.get('PIT-ABC-123').bookingProgress).toBe(50);
  });

  it('deve rejeitar etapa 1 com payload invalido', async () => {
    const response = await request(app)
      .patch('/api/reservas/pit/PIT-XYZ')
      .send({
        etapa: 1,
        data: '15/06/2026',
        periodo: 'noite',
        servico: ''
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(response.body.error.details)).toBe(true);
    expect(response.body.error.details.length).toBeGreaterThan(0);
  });

  it('deve atualizar etapa 2 no mesmo pitId existente', async () => {
    await request(app)
      .patch('/api/reservas/pit/PIT-STAGE-2')
      .send({
        etapa: 1,
        data: '2026-07-10',
        periodo: 'tarde',
        servico: 'Summer Camp'
      });

    const response = await request(app)
      .patch('/api/reservas/pit/PIT-STAGE-2')
      .send({
        etapa: 2,
        nomePiloto: 'Joao Silva',
        responsavelPiloto: 'Maria Silva',
        email: 'joao@example.com',
        telefone: '+55 61 99999-0000',
        age: '17',
        height: '1.72m',
        weight: '63kg',
        waist: '78cm',
        kartingExperience: 'Sim',
        experienceDescription: 'Treinos regionais'
      });

    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({ stage: 2, key: 'pitId' });
    expect(response.body.reserva.pitId).toBe('PIT-STAGE-2');
    expect(repo._map.get('PIT-STAGE-2').bookingProgress).toBe(100);
    expect(repo._map.get('PIT-STAGE-2').email).toBe('joao@example.com');
    expect(repo._map.get('PIT-STAGE-2').servico).toBe('Summer Camp');
  });

  it('deve retornar 404 na etapa 2 se pitId nao existir', async () => {
    const response = await request(app)
      .patch('/api/reservas/pit/PIT-NOT-FOUND')
      .send({
        etapa: 2,
        nomePiloto: 'Teste',
        responsavelPiloto: 'Teste',
        email: 'teste@example.com',
        telefone: '6199999999',
        age: '20',
        height: '1.70',
        weight: '70',
        waist: '80',
        kartingExperience: 'Nao'
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
