const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PLAYWRIGHT_PORT || 3100);
const publicDir = path.join(__dirname, '..', '..', 'public');

const state = {
  reservas: [],
  disponibilidade: [],
  capacidade: []
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function findCapacity(data, periodo) {
  return state.capacidade.find(item => item.data === data && item.periodo === periodo) || null;
}

function serveStaticFile(res, absolutePath) {
  fs.readFile(absolutePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const extension = path.extname(absolutePath).toLowerCase();
    const contentType = extension === '.html'
      ? 'text/html; charset=utf-8'
      : extension === '.js'
        ? 'application/javascript; charset=utf-8'
        : 'text/plain; charset=utf-8';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const moveMatch = url.pathname.match(/^\/api\/reservas\/([^/]+)\/move$/);
  const deleteMatch = url.pathname.match(/^\/api\/reservas\/([^/]+)$/);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/reservas' && req.method === 'GET') {
    sendJson(res, 200, state.reservas);
    return;
  }

  if (url.pathname === '/api/reservas' && req.method === 'POST') {
    try {
      const payload = await parseJsonBody(req);
      const reserva = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        nome: payload.nomePiloto || '',
        nomePiloto: payload.nomePiloto || '',
        responsavelPiloto: payload.responsavelPiloto || '',
        servico: payload.servico || '',
        data: payload.data || '',
        periodo: payload.periodo || '',
        email: payload.email || '',
        telefone: payload.telefone || '',
        serviceDatesForMonth: payload.serviceDatesForMonth || '',
        age: payload.age || '',
        height: payload.height || '',
        weight: payload.weight || '',
        waist: payload.waist || '',
        kartingExperience: payload.kartingExperience || '',
        experienceDescription: payload.experienceDescription || '',
        createdAt: new Date().toISOString()
      };

      state.reservas.push(reserva);

      sendJson(res, 201, {
        reserva,
        emailConfirmation: {
          sent: true,
          messageId: 'playwright-message-id'
        },
        automation: {
          trigger: 'SITE_RESERVA_CREATED',
          asana: { created: false, reason: 'ASANA_NOT_CONFIGURED' },
          docusign: { triggered: false, reason: 'DOCUSIGN_NOT_CONFIGURED' },
          checklist: { synced: false, reason: 'ASANA_TASK_MISSING' }
        }
      });
    } catch (error) {
      sendJson(res, 400, { error: { code: 'INVALID_JSON', message: 'JSON invalido.' } });
    }
    return;
  }

  if (moveMatch && req.method === 'PUT') {
    const id = decodeURIComponent(moveMatch[1]);
    const target = state.reservas.find(item => item.id === id);

    if (!target) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Reserva nao encontrada.' } });
      return;
    }

    const payload = await parseJsonBody(req);
    target.data = payload.data || target.data;
    target.periodo = payload.periodo || target.periodo;
    target.movedAt = new Date().toISOString();

    sendJson(res, 200, { reserva: target });
    return;
  }

  if (deleteMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(deleteMatch[1]);
    const index = state.reservas.findIndex(item => item.id === id);

    if (index === -1) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Reserva nao encontrada.' } });
      return;
    }

    state.reservas.splice(index, 1);
    sendJson(res, 200, { deleted: true, id });
    return;
  }

  if (url.pathname === '/api/disponibilidade' && req.method === 'GET') {
    sendJson(res, 200, state.disponibilidade);
    return;
  }

  if (url.pathname === '/api/disponibilidade' && req.method === 'POST') {
    const payload = await parseJsonBody(req);
    const key = `${payload.data}|${payload.periodo}`;
    const index = state.disponibilidade.findIndex(item => `${item.data}|${item.periodo}` === key);

    if (payload.bloqueado) {
      if (index === -1) {
        state.disponibilidade.push({ data: payload.data, periodo: payload.periodo });
      }
    } else if (index !== -1) {
      state.disponibilidade.splice(index, 1);
    }

    sendJson(res, 200, { disponibilidade: state.disponibilidade });
    return;
  }

  if (url.pathname === '/api/capacidade' && req.method === 'GET') {
    sendJson(res, 200, state.capacidade);
    return;
  }

  if (url.pathname === '/api/capacidade' && req.method === 'POST') {
    const payload = await parseJsonBody(req);
    const quantidade = Number(payload.quantidade ?? payload.extras ?? 0);
    const current = findCapacity(payload.data, payload.periodo);
    const currentValue = current ? Number(current.vagas) : 4;
    const vagas = currentValue + quantidade;

    if (current) {
      current.vagas = vagas;
    } else {
      state.capacidade.push({ data: payload.data, periodo: payload.periodo, vagas });
    }

    sendJson(res, 200, {
      capacidade: { data: payload.data, periodo: payload.periodo, vagas },
      capacidades: state.capacidade
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/Calendar.html') {
    serveStaticFile(res, path.join(publicDir, 'Calendar.html'));
    return;
  }

  if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/Admin.html') {
    serveStaticFile(res, path.join(publicDir, 'Admin.html'));
    return;
  }

  if (url.pathname.startsWith('/js/')) {
    const relativePath = url.pathname.replace(/^\//, '');
    serveStaticFile(res, path.join(publicDir, relativePath));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Playwright mock server running at http://127.0.0.1:${PORT}`);
});
