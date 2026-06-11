# Workflow n8n — Métricas SDR (Diário)

**Nome:** `Metricas SDR — Diaria`
**Schedule:** todos os dias 07:00 BRT (cron `0 10 * * *` em UTC)
**Objetivo:** consolidar métricas do dia anterior e atualizar o dashboard.

## Visão de nós (esquerda → direita)

```
[Schedule Trigger]
    ↓
[Set: janela]   ← define ontem em BRT (inicio/fim ISO)
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Em paralelo (3 branches que convergem no Merge):            │
│                                                             │
│ A. [Postgres: leads_reativacao] → contagem de disparos      │
│ B. [NocoDB: leads]              → status, mix, qualificação │
│ C. [HTTP Request: Chatwoot]     → conversas + mensagens     │
└─────────────────────────────────────────────────────────────┘
    ↓
[Merge by Position]
    ↓
[Code: calcular métricas]   ← agrega tudo num único objeto
    ↓
[Postgres: UPSERT metricas_diarias]
    ↓
[Code: montar JSON daily.json]   ← lê últimos 30 dias do Postgres p/ histórico
    ↓
[Postgres: SELECT últimos 30 dias]
    ↓
[Code: final JSON]
    ↓
[HTTP Request: GitHub Contents API]   ← commit no repo do dashboard
    ↓
[IF: status === 200 || 201]
    ↓ true                      ↓ false
[NoOp ok]               [Chatwoot: nota interna alertando falha]
```

## Detalhe dos nodes

### 1. Schedule Trigger
- Trigger Interval: Cron
- Cron Expression: `0 10 * * *`  (= 07:00 BRT, UTC-3)

### 2. Set — janela
Variáveis:
- `dia_iso` = `{{ $now.minus({days: 1}).setZone('America/Sao_Paulo').toISODate() }}`
- `dia_inicio` = `{{ $now.minus({days: 1}).setZone('America/Sao_Paulo').startOf('day').toISO() }}`
- `dia_fim` = `{{ $now.minus({days: 1}).setZone('America/Sao_Paulo').endOf('day').toISO() }}`

### 3A. Postgres — disparos do dia
Credential: Postgres n8n (ver Vault — id `{{POSTGRES_CRED_ID}}`)
```sql
SELECT
  COUNT(*) FILTER (WHERE disparo = true)                                                AS disparos,
  COUNT(*) FILTER (WHERE pausado = true AND tem_whatsapp = 'Não')                       AS falhas_envio
FROM leads_reativacao
WHERE data_disparo >= $1::timestamptz AND data_disparo < $2::timestamptz;
```
Parâmetros: `{{$json.dia_inicio}}`, `{{$json.dia_fim}}`.

> Se a tabela `leads_reativacao` não tiver coluna `data_disparo`, adicione ou use `updated_at`/`created_at` conforme o schema real (validar antes do go-live).

### 3B. NocoDB — leads do dia
HTTP Request com credential do NocoDB (header `xc-token: {{NOCODB_TOKEN}}`).
```
GET https://{{NOCODB_HOST}}/api/v2/tables/{{NOCODB_LEADS_TABLE_ID}}/records
  ?where=(CreatedAt,gte,{{ $json.dia_inicio }})~and(CreatedAt,lt,{{ $json.dia_fim }})
  &limit=1000
```
Mesma chamada com filtro por `Hora_Qualificacao` (nova coluna — ver `ajuste-cadastra-lead.md`) e por `Transferido,eq,true` para contagens de qualificação e handoff dentro da janela.

### 3C. Chatwoot — conversas do dia
```
GET https://{{CHATWOOT_HOST}}/api/v1/accounts/1/conversations
Headers: api_access_token: {{CHATWOOT_TOKEN}}
Query:  inbox_id=3 & updated_since={{ $json.dia_inicio }} & page=1
```
Paginar até `meta.current_page == meta.total_pages`. Para cada conversation, fazer um segundo GET `/api/v1/accounts/1/conversations/{id}/messages` (paralelo, com Split In Batches para limitar concorrência a ~5).

### 4. Code — calcular métricas
Entrada: resultado dos 3 ramos.
```javascript
// CONTEXTO: este node recebe um array de itens; use .first() em loops
const pg     = $('Postgres: leads_reativacao').first().json;
const leads  = $('NocoDB: leads').all().map(i => i.json);
const convs  = $('Chatwoot: conversations').all().map(i => i.json);
const msgs   = $('Chatwoot: messages').all().map(i => i.json); // achatada

// Funil
const disparos = Number(pg.disparos) || 0;
const falhas_envio = Number(pg.falhas_envio) || 0;
const disparos_reativacao = leads.filter(l => l.Origem === 'Reativação').length;
const disparos_campanha   = leads.filter(l => l.Origem === 'Campanha').length;

const conversasComIncoming = new Set(
  msgs.filter(m => m.message_type === 0 /* incoming */).map(m => m.conversation_id)
);
const respondidos = conversasComIncoming.size;

const qualificados_arr = leads.filter(l => l.Status === 'Qualificado');
const qualificados = qualificados_arr.length;
const transferidos = leads.filter(l => l.Transferido === true).length;
const em_qualificacao = leads.filter(l => l.FollowUpStatus === 'pendente' && l.Status !== 'Qualificado').length;

const taxa_resposta              = disparos ? respondidos / disparos : null;
const taxa_qualificacao          = respondidos ? qualificados / respondidos : null;
const taxa_transferencia_disp    = disparos ? transferidos / disparos : null;
const taxa_transferencia_resp    = respondidos ? transferidos / respondidos : null;

// Performance da IA
// Tempo até 1ª resposta: por conversa, pega 1ª incoming e 1ª outgoing posterior
const byConv = {};
for (const m of msgs) {
  (byConv[m.conversation_id] ||= []).push(m);
}
const temposPrimeiraResposta = [];
const msgsPorConversa = [];
for (const cid of Object.keys(byConv)) {
  const ordenadas = byConv[cid].sort((a,b) => a.created_at - b.created_at);
  msgsPorConversa.push(ordenadas.length);
  const firstIn  = ordenadas.find(m => m.message_type === 0);
  const firstOut = firstIn ? ordenadas.find(m => m.message_type === 1 && m.created_at > firstIn.created_at) : null;
  if (firstIn && firstOut) temposPrimeiraResposta.push(firstOut.created_at - firstIn.created_at);
}
const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
const p   = (arr,q) => { if(!arr.length) return null; const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length*q)]; };

const tempo_medio_1a_resposta_seg = avg(temposPrimeiraResposta);
const msgs_por_conversa_media     = msgsPorConversa.length ? +(msgsPorConversa.reduce((a,b)=>a+b,0)/msgsPorConversa.length).toFixed(2) : null;
const msgs_por_conversa_p50       = p(msgsPorConversa, 0.5);
const msgs_por_conversa_p90       = p(msgsPorConversa, 0.9);

// Tempo até qualificação (usa nova coluna Hora_Qualificacao do NocoDB)
const temposQualif = qualificados_arr
  .filter(l => l.Hora_Qualificacao && l.CreatedAt)
  .map(l => (new Date(l.Hora_Qualificacao) - new Date(l.CreatedAt)) / 1000);
const tempo_medio_qualificacao_seg = avg(temposQualif);

// Mídias
const audios_transcritos  = msgs.filter(m => m.attachments?.some(a => a.file_type === 'audio')).length;
const imagens_processadas = msgs.filter(m => m.attachments?.some(a => a.file_type === 'image')).length;
const midias_processadas  = audios_transcritos + imagens_processadas;

// FUP necessário
const qualifsComFup = qualificados_arr.filter(l => l.FollowUpStatus && l.FollowUpStatus !== 'nao_enviado').length;
const taxa_fup_necessario = qualificados ? qualifsComFup / qualificados : null;

// Abandonadas e resets
const agora = Date.now();
const conversas_abandonadas = convs.filter(c => {
  const ult = (msgs.filter(m => m.conversation_id === c.id).sort((a,b)=>b.created_at-a.created_at)[0]);
  return ult && (agora - ult.created_at*1000) > 48*3600*1000 && c.status !== 'resolved';
}).length;
const resets_solicitados = msgs.filter(m => m.content?.trim() === '#reset').length;

// Mix
const countBy = (arr, key) => arr.reduce((acc, x) => { const k = x[key]; if (k) acc[k] = (acc[k]||0)+1; return acc; }, {});
const mix_interesse    = countBy(qualificados_arr, 'Interesse');
const mix_conhecimento = countBy(qualificados_arr, 'Conhecimento');
const mix_objetivo     = countBy(qualificados_arr, 'Objetivo');

// Distribuição por agente (notas privadas de handoff já têm assigned_agent)
const distribuicao_agentes = convs.reduce((acc, c) => {
  if (c.meta?.assignee?.name && c.meta.assignee.name !== 'Atom Cognita') {
    acc[c.meta.assignee.name] = (acc[c.meta.assignee.name]||0)+1;
  } return acc;
}, {});

return [{ json: {
  data: $('Set: janela').first().json.dia_iso,
  disparos, disparos_reativacao, disparos_campanha, falhas_envio,
  respondidos, em_qualificacao, qualificados, transferidos,
  taxa_resposta, taxa_qualificacao,
  taxa_transferencia_disparos: taxa_transferencia_disp,
  taxa_transferencia_respostas: taxa_transferencia_resp,
  tempo_medio_1a_resposta_seg,
  msgs_por_conversa_media, msgs_por_conversa_p50, msgs_por_conversa_p90,
  tempo_medio_qualificacao_seg,
  midias_processadas, audios_transcritos, imagens_processadas,
  taxa_fup_necessario, conversas_abandonadas, resets_solicitados,
  mix_interesse, mix_conhecimento, mix_objetivo, distribuicao_agentes
}}];
```

### 5. Postgres — UPSERT metricas_diarias
Operation: Execute Query.
```sql
INSERT INTO metricas_diarias (
  data, disparos, disparos_reativacao, disparos_campanha, falhas_envio,
  respondidos, em_qualificacao, qualificados, transferidos,
  taxa_resposta, taxa_qualificacao, taxa_transferencia_disparos, taxa_transferencia_respostas,
  tempo_medio_1a_resposta_seg, msgs_por_conversa_media, msgs_por_conversa_p50, msgs_por_conversa_p90,
  tempo_medio_qualificacao_seg, midias_processadas, audios_transcritos, imagens_processadas,
  taxa_fup_necessario, conversas_abandonadas, resets_solicitados,
  mix_interesse, mix_conhecimento, mix_objetivo, distribuicao_agentes
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
  $25::jsonb, $26::jsonb, $27::jsonb, $28::jsonb
)
ON CONFLICT (data) DO UPDATE SET
  disparos = EXCLUDED.disparos,
  disparos_reativacao = EXCLUDED.disparos_reativacao,
  disparos_campanha = EXCLUDED.disparos_campanha,
  falhas_envio = EXCLUDED.falhas_envio,
  respondidos = EXCLUDED.respondidos,
  em_qualificacao = EXCLUDED.em_qualificacao,
  qualificados = EXCLUDED.qualificados,
  transferidos = EXCLUDED.transferidos,
  taxa_resposta = EXCLUDED.taxa_resposta,
  taxa_qualificacao = EXCLUDED.taxa_qualificacao,
  taxa_transferencia_disparos = EXCLUDED.taxa_transferencia_disparos,
  taxa_transferencia_respostas = EXCLUDED.taxa_transferencia_respostas,
  tempo_medio_1a_resposta_seg = EXCLUDED.tempo_medio_1a_resposta_seg,
  msgs_por_conversa_media = EXCLUDED.msgs_por_conversa_media,
  msgs_por_conversa_p50 = EXCLUDED.msgs_por_conversa_p50,
  msgs_por_conversa_p90 = EXCLUDED.msgs_por_conversa_p90,
  tempo_medio_qualificacao_seg = EXCLUDED.tempo_medio_qualificacao_seg,
  midias_processadas = EXCLUDED.midias_processadas,
  audios_transcritos = EXCLUDED.audios_transcritos,
  imagens_processadas = EXCLUDED.imagens_processadas,
  taxa_fup_necessario = EXCLUDED.taxa_fup_necessario,
  conversas_abandonadas = EXCLUDED.conversas_abandonadas,
  resets_solicitados = EXCLUDED.resets_solicitados,
  mix_interesse = EXCLUDED.mix_interesse,
  mix_conhecimento = EXCLUDED.mix_conhecimento,
  mix_objetivo = EXCLUDED.mix_objetivo,
  distribuicao_agentes = EXCLUDED.distribuicao_agentes,
  gerado_em = NOW();
```

### 6. Postgres — SELECT histórico (últimos 30 dias)
```sql
SELECT data, disparos, respondidos, qualificados, transferidos,
       taxa_resposta, taxa_qualificacao
FROM metricas_diarias
WHERE data >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY data ASC;
```

### 7. Code — montar JSON final
```javascript
const m = $('Code: calcular métricas').first().json;
const hist = $('Postgres: histórico').all().map(i => i.json);
return [{ json: {
  gerado_em: new Date().toISOString(),
  data: m.data,
  periodo: 'diario',
  funil: {
    disparos: m.disparos, disparos_reativacao: m.disparos_reativacao,
    disparos_campanha: m.disparos_campanha, falhas_envio: m.falhas_envio,
    respondidos: m.respondidos, em_qualificacao: m.em_qualificacao,
    qualificados: m.qualificados, transferidos: m.transferidos,
    taxa_resposta: m.taxa_resposta, taxa_qualificacao: m.taxa_qualificacao,
    taxa_transferencia_disparos: m.taxa_transferencia_disparos,
    taxa_transferencia_respostas: m.taxa_transferencia_respostas
  },
  performance_ia: {
    tempo_medio_1a_resposta_seg: m.tempo_medio_1a_resposta_seg,
    msgs_por_conversa_media: m.msgs_por_conversa_media,
    msgs_por_conversa_p50: m.msgs_por_conversa_p50,
    msgs_por_conversa_p90: m.msgs_por_conversa_p90,
    tempo_medio_qualificacao_seg: m.tempo_medio_qualificacao_seg,
    midias_processadas: m.midias_processadas,
    audios_transcritos: m.audios_transcritos,
    imagens_processadas: m.imagens_processadas,
    taxa_fup_necessario: m.taxa_fup_necessario,
    conversas_abandonadas: m.conversas_abandonadas,
    resets_solicitados: m.resets_solicitados
  },
  mix: {
    interesse: m.mix_interesse,
    conhecimento: m.mix_conhecimento,
    objetivo: m.mix_objetivo
  },
  distribuicao_agentes: m.distribuicao_agentes,
  historico: hist
}}];
```

### 8. HTTP Request — GitHub Contents API (commit do JSON)
Credential: PAT do GitHub com escopo `repo`.

**Etapa 1 — obter SHA atual** (necessário p/ update):
```
GET https://api.github.com/repos/{OWNER}/{REPO}/contents/dashboard/data/daily.json?ref=main
Header: Authorization: Bearer {PAT}
```
Capturar `sha` da resposta. Se 404 (primeira vez), seguir sem SHA.

**Etapa 2 — PUT do conteúdo:**
```
PUT https://api.github.com/repos/{OWNER}/{REPO}/contents/dashboard/data/daily.json
Header: Authorization: Bearer {PAT}
Body (JSON):
{
  "message": "chore(metrics): atualizar daily.json {{$json.data}}",
  "content": "{{ Buffer.from(JSON.stringify($json, null, 2)).toString('base64') }}",
  "sha": "{{ $('GitHub GET').first().json.sha }}",
  "branch": "main"
}
```

Vercel/Netlify rebuilda automaticamente ao detectar o commit.

### 9. IF — verificar sucesso
- True: NoOp
- False: criar nota privada em uma conversa de teste no Chatwoot (ou disparar email/webhook) alertando falha — evitar silent failure.

## Variáveis de ambiente n8n
- `GITHUB_PAT`
- `GITHUB_OWNER`
- `GITHUB_REPO`
- `NOCODB_HOST`
- `CHATWOOT_TOKEN` (já existe)

## Backfill inicial
Após criar o workflow, executar manualmente para cada dia 21/05 a 10/06 (ajustar manualmente o node `Set: janela` ou criar versão temporária com loop). Validar que totais batem com a 1ª reativação (98/26/8).
