// Teste de rota inexistente
const https = require('https');

describe('404 da API pública', () => {
  it('deve retornar 404 para rota inexistente', done => {
    https.get('https://calendar-backend-w6wm.onrender.com/rota-inexistente', res => {
      expect(res.statusCode).toBe(404);
      done();
    }).on('error', err => {
      done(err);
    });
  });
});
