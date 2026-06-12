// Backfill ad-hoc: puxa Chatwoot + NocoDB e gera dashboard/data/{daily,weekly}.json
// Uso:  node scripts/backfill.mjs 2026-06-08 2026-06-11
// Requer env:  CHATWOOT_HOST, CHATWOOT_TOKEN, CHATWOOT_ACCOUNT, CHATWOOT_INBOX,
//              NOCODB_HOST, NOCODB_TOKEN, NOCODB_TABLE_ID

import fs from 'node:fs/promises';
import path from 'node:path';

const TZ_OFFSET_HOURS = -3;  // BRT
const argInicio = process.argv[2] || '2026-06-08';
const argFim    = process.argv[3] || '2026-06-11';

const env = {
  CHATWOOT_HOST:    process.env.CHATWOOT_HOST    || 'https://n8n-chatwoot.8lzhsq.easypanel.host',
  CHATWOOT_TOKEN:   process.env.CHATWOOT_TOKEN,
  CHATWOOT_ACCOUNT: process.env.CHATWOOT_ACCOUNT || '1',
  CHATWOOT_INBOX:   process.env.CHATWOOT_INBOX   || '3',
  NOCODB_HOST:      process.env.NOCODB_HOST      || 'https://n8n-nocodb.8lzhsq.easypanel.host',
  NOCODB_TOKEN:     process.env.NOCODB_TOKEN,
  NOCODB_TABLE_ID:  process.env.NOCODB_TABLE_ID  || 'mrd7m696ery14jw'
};
for (const [k, v] of Object.entries(env)) if (!v) { console.error('Faltando env:', k); process.exit(1); }

// Retry helper — EasyPanel SSL/Traefik oscila; tenta 5x com backoff
async function fetchRetry(url, opts = {}, label = '') {
  let lastErr;
  for (let i = 1; i <= 5; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      const wait = i * 2000;
      process.stderr.write(`  ⟳ retry ${i}/5 (${label}) em ${wait}ms — ${e.cause?.code || e.message}\n`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const dayKey = (ts) => {
  // ts em segundos (Chatwoot) ou ISO string
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  const local = new Date(d.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
  return local.toISOString().slice(0, 10);
};
const inRange = (date) => date >= argInicio && date <= argFim;

// ────────────────────────────────────────────────────────────────────
// Chatwoot
// ────────────────────────────────────────────────────────────────────
async function fetchAllConversations() {
  const url = `${env.CHATWOOT_HOST}/api/v1/accounts/${env.CHATWOOT_ACCOUNT}/conversations`;
  const headers = { api_access_token: env.CHATWOOT_TOKEN };
  const all = [];
  // Paginação Chatwoot: até encontrar conversas mais antigas que argInicio
  for (let page = 1; page <= 50; page++) {
    const res = await fetchRetry(`${url}?inbox_id=${env.CHATWOOT_INBOX}&page=${page}&assignee_type=all&status=all`, { headers }, `convs p${page}`);
    if (!res.ok) throw new Error(`Chatwoot ${res.status}`);
    const json = await res.json();
    const payload = json.data?.payload || [];
    if (!payload.length) break;
    all.push(...payload);
    // Se a última conversa da página já é muito antiga, paramos
    const last = payload[payload.length - 1];
    if (last.created_at && dayKey(last.created_at) < argInicio) break;
  }
  return all.filter(c => {
    const created = c.created_at ? dayKey(c.created_at) : null;
    const lastAct = c.last_activity_at ? dayKey(c.last_activity_at) : null;
    return (created && inRange(created)) || (lastAct && inRange(lastAct));
  });
}

async function fetchMessages(conversationId) {
  const url = `${env.CHATWOOT_HOST}/api/v1/accounts/${env.CHATWOOT_ACCOUNT}/conversations/${conversationId}/messages`;
  try {
    const res = await fetchRetry(url, { headers: { api_access_token: env.CHATWOOT_TOKEN } }, `msgs ${conversationId}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.payload || [];
  } catch (e) {
    process.stderr.write(`  ✗ msgs ${conversationId} desistiu: ${e.message}\n`);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────
// NocoDB
// ────────────────────────────────────────────────────────────────────
async function fetchLeadsRange() {
  const headers = { 'xc-token': env.NOCODB_TOKEN };
  const all = [];
  let offset = 0, pageSize = 200;
  while (offset < 5000) {
    const url = `${env.NOCODB_HOST}/api/v2/tables/${env.NOCODB_TABLE_ID}/records?limit=${pageSize}&offset=${offset}&sort=-CreatedAt`;
    const res = await fetchRetry(url, { headers }, `nocodb off=${offset}`);
    if (!res.ok) throw new Error(`NocoDB ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const list = json.list || [];
    if (!list.length) break;
    all.push(...list);
    if (list.length < pageSize) break;
    offset += pageSize;
    // Para se a última data já é < argInicio
    const last = list[list.length - 1];
    const lastDate = last.CreatedAt || last.created_at;
    if (lastDate && dayKey(lastDate) < argInicio) break;
  }
  return all.filter(l => {
    const created = (l.CreatedAt || l.created_at)?.slice(0, 10);
    const updated = (l.UpdatedAt || l.updated_at)?.slice(0, 10);
    return inRange(created) || inRange(updated);
  });
}

// ────────────────────────────────────────────────────────────────────
// Agregação por dia
// ────────────────────────────────────────────────────────────────────
function aggregateDay(date, conversas, leads, msgsPorConv) {
  const convDoDia = conversas.filter(c => dayKey(c.created_at) === date);
  const leadsDoDia = leads.filter(l => (l.CreatedAt || l.created_at || '').slice(0,10) === date);
  // Status muda via UpdatedAt — usar essa janela como proxy do "momento da qualificação"
  const leadsAtualizadosNoDia = leads.filter(l => (l.UpdatedAt || l.updated_at || '').slice(0,10) === date);
  const qualifsDoDia      = leadsAtualizadosNoDia.filter(l => l.Status === 'Qualificado');
  const desqualifsDoDia   = leadsAtualizadosNoDia.filter(l => l.Status === 'Desqualificado');
  const suporteDoDia      = leadsAtualizadosNoDia.filter(l => l.Status === 'Suporte');
  const transfDoDia       = leadsAtualizadosNoDia.filter(l => l.Transferido === true);

  const disparosReativacao = leadsDoDia.filter(l => l.Origem === 'Reativação').length;
  const disparosCampanha   = leadsDoDia.filter(l => l.Origem === 'Campanha').length;
  const disparos = disparosReativacao + disparosCampanha;

  // Respondidos = conversas do dia onde o LEAD enviou ≥1 mensagem (message_type=0 incoming)
  const respondidos = convDoDia.filter(c =>
    (msgsPorConv[c.id] || []).some(m => m.message_type === 0)
  ).length;

  // Tempo até 1ª resposta da IA: diff entre 1ª incoming do lead e 1ª outgoing seguinte do bot
  const tempos1aRespRaw = [];
  for (const c of convDoDia) {
    const ms = (msgsPorConv[c.id] || []).sort((a,b) => a.created_at - b.created_at);
    const firstIn  = ms.find(m => m.message_type === 0);
    if (!firstIn) continue;
    const firstOut = ms.find(m => m.message_type === 1 && m.created_at > firstIn.created_at);
    if (!firstOut) continue;
    const dt = firstOut.created_at - firstIn.created_at;
    if (dt > 0 && dt < 3600) tempos1aRespRaw.push(dt);
  }
  const percentile = (arr, q) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a,b)=>a-b);
    return s[Math.floor(s.length * q)];
  };
  const median = arr => percentile(arr, 0.5);
  const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;

  // Msgs por conversa do dia
  const msgsCounts = convDoDia.map(c => (msgsPorConv[c.id] || []).length);
  // Mídias
  const allMsgsDoDia = convDoDia.flatMap(c => msgsPorConv[c.id] || []);
  const audios   = allMsgsDoDia.filter(m => m.attachments?.some(a => a.file_type === 'audio')).length;
  const imagens  = allMsgsDoDia.filter(m => m.attachments?.some(a => a.file_type === 'image')).length;
  const resets   = allMsgsDoDia.filter(m => m.content?.trim() === '#reset').length;

  // Tempo até qualificação — proxy: UpdatedAt − CreatedAt para leads que viraram Qualificado hoje
  const tempoQualifs = qualifsDoDia
    .filter(l => l.UpdatedAt && l.CreatedAt)
    .map(l => (new Date(l.UpdatedAt) - new Date(l.CreatedAt)) / 1000)
    .filter(t => t > 0 && t < 7 * 24 * 3600);  // descarta > 7 dias (provavelmente backfill manual)

  const countBy = (arr, key) => arr.reduce((acc, x) => {
    const k = x[key]; if (k) acc[k] = (acc[k] || 0) + 1; return acc;
  }, {});

  return {
    data: date,
    disparos, disparos_reativacao: disparosReativacao, disparos_campanha: disparosCampanha,
    falhas_envio: 0,  // requer Postgres leads_reativacao, não disponível neste backfill
    respondidos,
    em_qualificacao: leadsDoDia.filter(l => l.FollowUpStatus === 'pendente' && l.Status !== 'Qualificado').length,
    qualificados: qualifsDoDia.length,
    desqualificados: desqualifsDoDia.length,
    suporte: suporteDoDia.length,
    transferidos: transfDoDia.length,
    taxa_resposta:               disparos ? +(respondidos / disparos).toFixed(4) : null,
    taxa_qualificacao:           respondidos ? +(qualifsDoDia.length / respondidos).toFixed(4) : null,
    taxa_transferencia_disparos: disparos ? +(transfDoDia.length / disparos).toFixed(4) : null,
    taxa_transferencia_respostas: respondidos ? +(transfDoDia.length / respondidos).toFixed(4) : null,
    tempo_medio_1a_resposta_seg: median(tempos1aRespRaw),
    msgs_por_conversa_media: msgsCounts.length ? +(msgsCounts.reduce((a,b)=>a+b,0)/msgsCounts.length).toFixed(2) : null,
    msgs_por_conversa_p50: percentile(msgsCounts, 0.5),
    msgs_por_conversa_p90: percentile(msgsCounts, 0.9),
    tempo_medio_qualificacao_seg: avg(tempoQualifs),
    midias_processadas: audios + imagens,
    audios_transcritos: audios,
    imagens_processadas: imagens,
    taxa_fup_necessario: null,  // requer histórico FollowUpStatus
    conversas_abandonadas: convDoDia.filter(c => {
      const ult = (msgsPorConv[c.id] || []).slice(-1)[0];
      return ult && (Date.now() - ult.created_at*1000) > 48*3600*1000 && c.status !== 'resolved';
    }).length,
    resets_solicitados: resets,
    mix_interesse:    countBy(qualifsDoDia, 'Interesse'),
    mix_conhecimento: countBy(qualifsDoDia, 'Conhecimento'),
    mix_objetivo:     {}  // campo não existe no schema atual
  };
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n▶ Backfill ${argInicio} → ${argFim}\n`);

  console.log('Chatwoot: buscando conversas…');
  const conversas = await fetchAllConversations();
  console.log(`  ${conversas.length} conversas no intervalo`);

  console.log('Chatwoot: buscando mensagens…');
  const msgsPorConv = {};
  let i = 0;
  for (const c of conversas) {
    msgsPorConv[c.id] = await fetchMessages(c.id);
    if (++i % 10 === 0) process.stdout.write(`  ${i}/${conversas.length}\r`);
  }
  console.log(`  ${i}/${conversas.length} ✓`);

  console.log('NocoDB: buscando leads…');
  const leads = await fetchLeadsRange();
  console.log(`  ${leads.length} leads no intervalo`);

  // Gerar dia a dia
  const dias = [];
  const start = new Date(argInicio + 'T00:00:00Z');
  const end   = new Date(argFim    + 'T00:00:00Z');
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dias.push(d.toISOString().slice(0, 10));
  }

  const agregados = dias.map(d => aggregateDay(d, conversas, leads, msgsPorConv));
  console.log('\nResumo por dia:');
  console.table(agregados.map(a => ({
    data: a.data,
    disparos: a.disparos,
    respondidos: a.respondidos,
    qualificados: a.qualificados,
    transferidos: a.transferidos,
    'taxa_resp_%': a.taxa_resposta != null ? (a.taxa_resposta*100).toFixed(1) : '—',
    'tempo_1a_resp': a.tempo_medio_1a_resposta_seg != null ? a.tempo_medio_1a_resposta_seg + 's' : '—'
  })));

  // Último dia vira o snapshot "atual" do daily.json
  const ultimo = agregados[agregados.length - 1];

  // Histórico para o card de tendências (últimos 30 dias do range disponível)
  const historico = agregados.map(a => ({
    data: a.data, disparos: a.disparos, respondidos: a.respondidos,
    qualificados: a.qualificados, desqualificados: a.desqualificados,
    suporte: a.suporte, transferidos: a.transferidos,
    taxa_resposta: a.taxa_resposta, taxa_qualificacao: a.taxa_qualificacao
  }));

  const dailyJson = {
    gerado_em: new Date().toISOString(),
    data: ultimo.data,
    periodo: 'diario',
    funil: {
      disparos: ultimo.disparos, disparos_reativacao: ultimo.disparos_reativacao,
      disparos_campanha: ultimo.disparos_campanha, falhas_envio: ultimo.falhas_envio,
      respondidos: ultimo.respondidos, em_qualificacao: ultimo.em_qualificacao,
      qualificados: ultimo.qualificados, desqualificados: ultimo.desqualificados,
      suporte: ultimo.suporte, transferidos: ultimo.transferidos,
      taxa_resposta: ultimo.taxa_resposta, taxa_qualificacao: ultimo.taxa_qualificacao,
      taxa_transferencia_disparos: ultimo.taxa_transferencia_disparos,
      taxa_transferencia_respostas: ultimo.taxa_transferencia_respostas
    },
    performance_ia: {
      tempo_medio_1a_resposta_seg: ultimo.tempo_medio_1a_resposta_seg,
      msgs_por_conversa_media: ultimo.msgs_por_conversa_media,
      msgs_por_conversa_p50: ultimo.msgs_por_conversa_p50,
      msgs_por_conversa_p90: ultimo.msgs_por_conversa_p90,
      tempo_medio_qualificacao_seg: ultimo.tempo_medio_qualificacao_seg,
      midias_processadas: ultimo.midias_processadas,
      audios_transcritos: ultimo.audios_transcritos,
      imagens_processadas: ultimo.imagens_processadas,
      taxa_fup_necessario: ultimo.taxa_fup_necessario,
      conversas_abandonadas: ultimo.conversas_abandonadas,
      resets_solicitados: ultimo.resets_solicitados
    },
    mix: { interesse: ultimo.mix_interesse, conhecimento: ultimo.mix_conhecimento, objetivo: ultimo.mix_objetivo },
    historico
  };

  // Weekly: agregar tudo do range como uma "semana" para visão consolidada
  const somar = (k) => agregados.reduce((a, x) => a + (x[k] || 0), 0);
  const totalDisp  = somar('disparos');
  const totalResp  = somar('respondidos');
  const totalQual  = somar('qualificados');
  const totalTrans = somar('transferidos');
  const sumObj = (k) => agregados.reduce((acc, x) => {
    for (const [kk, vv] of Object.entries(x[k] || {})) acc[kk] = (acc[kk] || 0) + vv;
    return acc;
  }, {});

  const weeklyJson = {
    gerado_em: new Date().toISOString(),
    semana_inicio: argInicio,
    semana_fim: argFim,
    periodo: 'semanal',
    funil: {
      disparos: totalDisp,
      disparos_reativacao: somar('disparos_reativacao'),
      disparos_campanha: somar('disparos_campanha'),
      falhas_envio: somar('falhas_envio'),
      respondidos: totalResp,
      qualificados: totalQual,
      desqualificados: somar('desqualificados'),
      suporte: somar('suporte'),
      transferidos: totalTrans,
      taxa_resposta:                totalDisp ? +(totalResp / totalDisp).toFixed(4) : null,
      taxa_qualificacao:            totalResp ? +(totalQual / totalResp).toFixed(4) : null,
      taxa_transferencia_disparos:  totalDisp ? +(totalTrans / totalDisp).toFixed(4) : null,
      taxa_transferencia_respostas: totalResp ? +(totalTrans / totalResp).toFixed(4) : null
    },
    performance_ia: {
      tempo_medio_1a_resposta_seg: (() => {
        const valid = agregados.filter(a => a.tempo_medio_1a_resposta_seg != null);
        return valid.length ? Math.round(valid.reduce((acc,a)=>acc + a.tempo_medio_1a_resposta_seg*a.respondidos,0) / valid.reduce((acc,a)=>acc+a.respondidos,0)) : null;
      })(),
      msgs_por_conversa_media: (() => {
        const v = agregados.filter(a => a.msgs_por_conversa_media != null);
        return v.length ? +(v.reduce((s,a)=>s+a.msgs_por_conversa_media*a.respondidos,0)/v.reduce((s,a)=>s+a.respondidos,0)).toFixed(2) : null;
      })(),
      msgs_por_conversa_p90: Math.max(0, ...agregados.map(a => a.msgs_por_conversa_p90 || 0)) || null,
      tempo_medio_qualificacao_seg: (() => {
        const v = agregados.filter(a => a.tempo_medio_qualificacao_seg != null);
        return v.length ? Math.round(v.reduce((s,a)=>s+a.tempo_medio_qualificacao_seg*a.qualificados,0)/v.reduce((s,a)=>s+a.qualificados,0)) : null;
      })(),
      midias_processadas: somar('midias_processadas'),
      taxa_fup_necessario: null,
      conversas_abandonadas: somar('conversas_abandonadas')
    },
    mix: {
      interesse: sumObj('mix_interesse'),
      conhecimento: sumObj('mix_conhecimento'),
      objetivo: sumObj('mix_objetivo')
    },
    delta_semana_anterior: {
      taxa_resposta: null, taxa_qualificacao: null, taxa_transferencia: null,
      disparos: 0, qualificados: 0, transferidos: 0
    },
    historico_semanal: [{
      semana_inicio: argInicio, semana_fim: argFim,
      disparos: totalDisp, respondidos: totalResp,
      qualificados: totalQual, transferidos: totalTrans,
      taxa_resposta: totalDisp ? +(totalResp/totalDisp).toFixed(4) : null,
      taxa_qualificacao: totalResp ? +(totalQual/totalResp).toFixed(4) : null,
      taxa_transferencia_disparos: totalDisp ? +(totalTrans/totalDisp).toFixed(4) : null
    }]
  };

  const root = path.resolve(process.cwd(), 'dashboard', 'data');
  await fs.writeFile(path.join(root, 'daily.json'),  JSON.stringify(dailyJson, null, 2));
  await fs.writeFile(path.join(root, 'weekly.json'), JSON.stringify(weeklyJson, null, 2));
  console.log('\n✓ dashboard/data/daily.json e weekly.json atualizados');
})();
