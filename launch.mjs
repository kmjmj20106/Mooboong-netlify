import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT에는 1~65535 사이의 포트 번호를 입력해 주세요.');
  process.exit(1);
}
const address = `http://127.0.0.1:${port}`;

function openBrowser() {
  if (process.platform !== 'darwin' || process.env.MOOBOONG_NO_OPEN === '1') return;
  const browser = spawn('/usr/bin/open', [address], { stdio: 'ignore' });
  browser.on('error', () => console.log(`브라우저에서 ${address}를 열어 주세요.`));
  browser.unref();
}

async function existingSite() {
  let response;
  try {
    response = await fetch(address + '/api/status', { signal: AbortSignal.timeout(3000), redirect: 'error' });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw new Error(`${port}번 포트의 실행 상태를 확인하지 못했습니다. 잠시 뒤 다시 실행해 주세요.`);
  }
  const status = await response.json().catch(() => null);
  if (response.ok && typeof status?.setupRequired === 'boolean') {
    const page = await fetch(address, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (page.ok && (await page.text()).includes('<title>무붕 · OUR BAND, OUR SPACE</title>')) return true;
  }
  throw new Error(`${port}번 포트를 다른 프로그램이 사용하고 있습니다. 해당 프로그램을 확인하거나 PORT를 다른 번호로 지정해 주세요.`);
}

try {
  if (await existingSite()) {
    console.log(`무붕 사이트가 이미 실행 중입니다: ${address}`);
    console.log('기존 사이트를 엽니다. 이 창은 닫아도 됩니다.');
    openBrowser();
  } else {
    const { server, initializeApp } = await import('./server.mjs');
    await initializeApp();
    server.listen(port, '127.0.0.1', () => {
      console.log(`무붕 사이트: ${address}`);
      console.log('브라우저에서 테스트해 주세요. 종료하려면 이 창에서 Ctrl+C를 누르세요.');
      openBrowser();
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
