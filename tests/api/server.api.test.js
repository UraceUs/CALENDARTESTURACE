// Teste básico do backend (Node.js)
const https = require('https');

describe('Servidor Backend (Render)', () => {
  it('deve responder no backend do Render', done => {
    https.get('https://calendar-backend-w6wm.onrender.com', res => {
      expect(res.statusCode).toBe(200);
      done();
    }).on('error', err => {
      done(err);
    });
  });
});
