const { test, expect } = require('@playwright/test');

const apiBase = 'http://127.0.0.1:3100';

test.describe.configure({ mode: 'serial' });

test('cliente envia reserva com sucesso', async ({ page }) => {
  await page.goto(`/Calendar.html?apiBase=${encodeURIComponent(apiBase)}`);

  await page.locator('.service-card[data-service="Professional Coaching"]').click();
  await page.locator('#daysGrid button').first().click();
  await page.locator('.period-card[data-period="manha"]').click();

  await page.fill('#nomePiloto', 'Teste Playwright');
  await page.fill('#responsavelPiloto', 'Responsavel Playwright');
  await page.fill('#email', 'playwright@example.com');
  await page.fill('#telefone', '11999999999');
  await page.fill('#age', '28');
  await page.fill('#height', '1.74m');
  await page.fill('#weight', '70kg');
  await page.fill('#waist', '79cm');

  await page.selectOption('#kartingExperience', 'Sim');
  await page.fill('#experienceDescription', 'Treinos mensais de kart em pista indoor.');

  await page.getByRole('button', { name: 'Enviar reserva' }).click();

  await expect(page.locator('#formFeedback')).toContainText('Confirmacao enviada');
});

test('admin visualiza reserva criada', async ({ page }) => {
  await page.goto(`/Admin.html?apiBase=${encodeURIComponent(apiBase)}`);

  await expect(page.locator('#reservationTableBody')).toContainText('Teste Playwright');
  await expect(page.locator('#reservationTableBody')).toContainText('Responsavel Playwright');
});
