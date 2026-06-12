# ATOM SDR — Métricas

Dashboard estático de métricas do SDR IA da ATOM. Coleta via script Node.js, agendamento via GitHub Actions, hospedagem na Vercel.

**Produção:** https://metricasatom.cognitaai.com.br · https://metricas-atom.vercel.app

## Estrutura

```
.
├── dashboard/
│   ├── index.html              # Single-file com Chart.js
│   └── data/
│       ├── daily.json          # Snapshot do dia (sobrescrito a cada execução)
│       └── weekly.json         # Snapshot da semana
├── scripts/
│   └── backfill.mjs            # Coleta NocoDB + Chatwoot e gera os JSONs
└── cron/
    ├── Dockerfile              # Container Node + node-cron
    ├── scheduler.mjs           # Schedule diário + semanal, commita no Git
    ├── package.json
    └── README.md               # Instruções de deploy no EasyPanel
```

## Métricas calculadas

**Funil:** disparos (split Reativação/Campanha), respondidos (lead enviou ≥1 mensagem), qualificados, desqualificados, suporte, transferidos + taxas de cada etapa.

**Performance da IA:** tempo mediano até 1ª resposta da IA, mensagens por conversa (média/p50/p90), tempo até qualificação, mídias processadas (Whisper/Vision), conversas abandonadas (>48h sem resposta), `#reset` solicitados.

**Mix:** distribuição por Interesse e Conhecimento entre qualificados.

## Setup (já feito)

1. Vercel — projeto `metricas-atom` (team `devops17`) ligado a este repo, rootDirectory=`dashboard`
2. Cloudflare — `metricasatom.cognitaai.com.br` aponta via CNAME para `5ccd935d3ab9549b.vercel-dns-017.com` (Proxy DNS only)
3. Cron — container Node rodando no EasyPanel. Setup em `cron/README.md`. **NÃO usar GitHub Actions** (runners ficam fora do BR e o servidor EasyPanel bloqueia esses IPs).

## Rodar manualmente (local)

```bash
CHATWOOT_TOKEN=xxx NOCODB_TOKEN=yyy node scripts/backfill.mjs 2026-06-08 2026-06-11
```
Gera `dashboard/data/{daily,weekly}.json` localmente. Commitar + push = Vercel rebuilda em segundos.

## Rodar manualmente (EasyPanel)

Configure temporariamente `RUN_ON_START=range`, `RANGE_INI=YYYY-MM-DD`, `RANGE_FIM=YYYY-MM-DD` no app do EasyPanel e faça Redeploy. Mais detalhes em `cron/README.md`.

## Variáveis de ambiente do script

| Var | Default | Obrigatório |
|---|---|---|
| `CHATWOOT_TOKEN` | — | sim |
| `CHATWOOT_HOST` | `https://n8n-chatwoot.8lzhsq.easypanel.host` | não |
| `CHATWOOT_ACCOUNT` | `1` | não |
| `CHATWOOT_INBOX` | `3` | não |
| `NOCODB_TOKEN` | — | sim |
| `NOCODB_HOST` | `https://n8n-nocodb.8lzhsq.easypanel.host` | não |
| `NOCODB_TABLE_ID` | id da tabela `leads` | não |

## Decisões

- **Sem n8n** — pipeline 100% código, mais previsível e auditável
- **Cron no EasyPanel** (não GitHub Actions) — servidor Hostinger bloqueia IPs Azure dos runners
- **Hosting:** Vercel + commits do scheduler → autodeploy
- **Auth:** público, slug não-listado
- **Cadência:** diário (ter-sáb 07:00 BRT, processa o dia anterior) + semanal (seg 08:00 BRT, processa semana anterior)
- **Sem histórico em DB próprio** — JSONs versionados no Git são o histórico. Auditável via `git log dashboard/data/`.
