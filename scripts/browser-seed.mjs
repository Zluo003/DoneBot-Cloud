import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const destination = process.argv[2];
if (!destination) throw new Error('usage: node scripts/browser-seed.mjs /absolute/temporary/seed.json');
const source = resolve(process.env.DONEBOT_SOURCE_DIR || '../DoneBot');
const { launchVerificationServer, runControlOmb } = await import(pathToFileURL(join(source, 'scripts/control-omb.ts')).href);
const fixture = await launchVerificationServer();
try {
  await runControlOmb(['new-bot', '--name', 'Offline browser fixture', '--url', fixture.info.url]);
  const rows = JSON.parse(await readFile(join(fixture.info.dataDir, 'bots.json'), 'utf8'));
  const bot = rows.find(row => row.name === 'Offline browser fixture');
  if (!bot) throw new Error('fixture did not create the seed bot');
  bot.browser = true;
  await writeFile(destination, JSON.stringify([bot]), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ exported: true, syntheticBotOnly: true }));
} finally { await fixture.close(); }
