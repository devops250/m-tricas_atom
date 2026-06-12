// Scheduler do dashboard ATOM SDR Metrics.
// - Mantém um clone local do repo
// - Em cada tick: git pull → roda backfill → commita JSONs se mudaram → git push
// - Vercel rebuilda automaticamente ao detectar o push

import cron from 'node-cron';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_URL  = 'https://github.com/devops250/m-tricas_atom.git';
const REPO_DIR  = '/app/repo';
const TZ        = 'America/Sao_Paulo';

const required = ['GITHUB_TOKEN', 'CHATWOOT_TOKEN', 'NOCODB_TOKEN'];
for (const k of required) {
  if (!process.env[k]) { console.error(`Faltando env: ${k}`); process.exit(1); }
}

const authedUrl = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/devops250/m-tricas_atom.git`;

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

function sh(cmd, opts = {}) {
  log('$', cmd);
  return execSync(cmd, { stdio: 'inherit', cwd: REPO_DIR, ...opts });
}

function shCapture(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_DIR, ...opts }).toString().trim();
}

function setupRepo() {
  if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
    log('Clonando repo…');
    execSync(`git clone ${authedUrl} ${REPO_DIR}`, { stdio: 'inherit' });
  } else {
    log('Repo já existe, atualizando origin…');
    execSync(`git -C ${REPO_DIR} remote set-url origin ${authedUrl}`);
  }
  sh('git config user.name  "metricas-bot"');
  sh('git config user.email "metricas-bot@cognitaai.com.br"');
  sh('git config pull.rebase false');
}

function ymd(d) {
  // YYYY-MM-DD em BRT
  const local = new Date(d.getTime() - 3 * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

async function runBackfill(label, inicio, fim) {
  log(`▶ ${label} ${inicio} → ${fim}`);
  try {
    sh('git pull --ff-only');
    sh(`node scripts/backfill.mjs ${inicio} ${fim}`, {
      env: { ...process.env, CHATWOOT_TOKEN: process.env.CHATWOOT_TOKEN, NOCODB_TOKEN: process.env.NOCODB_TOKEN }
    });

    sh('git add dashboard/data/daily.json dashboard/data/weekly.json');
    const status = shCapture('git status --porcelain dashboard/data');
    if (!status) {
      log('Sem mudanças nos JSONs');
      return;
    }
    sh(`git commit -m "chore(metrics): ${label} ${fim}"`);
    sh('git push origin main');
    log(`✓ ${label} commitado e pushed`);
  } catch (e) {
    log(`✗ Falhou ${label}:`, e.message);
  }
}

function daily() {
  const ontem = new Date(Date.now() - 24 * 3600 * 1000);
  const d = ymd(ontem);
  return runBackfill('daily', d, d);
}

function weekly() {
  // Última segunda encerrada (semana passada completa)
  const now = new Date();
  // toLocaleString gambiarra evita problema de timezone — pegar dia da semana em BRT
  const dowBRT = parseInt(now.toLocaleString('en-US', { timeZone: TZ, weekday: 'short' })
    .replace(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/, m => ({Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[m])), 10);
  const offset = dowBRT === 1 ? 7 : ((dowBRT - 1 + 7) % 7) + 7;
  const ini = new Date(now.getTime() - offset * 24 * 3600 * 1000);
  const fim = new Date(ini.getTime() + 6 * 24 * 3600 * 1000);
  return runBackfill('weekly', ymd(ini), ymd(fim));
}

// ────────────────────────────────────────────────────────────────────
setupRepo();
log(`Scheduler iniciado. TZ=${TZ}`);

// Diário: ter-sáb 07:00 BRT (processa dia anterior)
cron.schedule('0 7 * * 2-6', daily,  { timezone: TZ });
// Semanal: seg 08:00 BRT (processa semana anterior)
cron.schedule('0 8 * * 1',   weekly, { timezone: TZ });

// Heartbeat — log a cada hora pra confirmar que o processo segue vivo
cron.schedule('0 * * * *', () => log('heartbeat'), { timezone: TZ });

// Execução opcional ao subir (útil pra backfill manual via redeploy)
//   RUN_ON_START=daily      → roda daily uma vez ao subir
//   RUN_ON_START=weekly     → roda weekly uma vez ao subir
//   RUN_ON_START=range      → roda backfill com RANGE_INI / RANGE_FIM
if (process.env.RUN_ON_START === 'daily')  daily();
if (process.env.RUN_ON_START === 'weekly') weekly();
if (process.env.RUN_ON_START === 'range' && process.env.RANGE_INI && process.env.RANGE_FIM) {
  runBackfill('range', process.env.RANGE_INI, process.env.RANGE_FIM);
}

// Mantém o processo vivo
process.on('SIGTERM', () => { log('SIGTERM recebido, encerrando'); process.exit(0); });
