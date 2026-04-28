// Teste básico do frontend (Calendar.html)
const { chromium } = require('playwright');

describe('Página de Reserva - Calendar.html', () => {
  let browser, page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  }, 20000); // timeout aumentado para 20s
  afterAll(async () => {
    await browser.close();
  });

  it('deve exibir o título da página', async () => {
    await page.goto('file://' + process.cwd() + '/public/Calendar.html');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  }, 20000); // timeout aumentado para 20s
});
