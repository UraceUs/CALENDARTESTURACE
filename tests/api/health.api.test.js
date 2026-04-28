// Teste de health check da API pública
const https = require('https');

describe('Health check da API pública', () => {
  it('deve retornar status 200 em /health', done => {
    https.get('https://calendar-backend-w6wm.onrender.com/health', res => {
      expect(res.statusCode).toBe(200);
      done();
    }).on('error', err => {
      done(err);
    });
  });
});
