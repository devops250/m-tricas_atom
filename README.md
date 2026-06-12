# ATOM SDR — Métricas

Dashboard estático de métricas do SDR IA da ATOM. Workflow simples: roda comando local quando quer atualizar, git push, Vercel deploya.

**Produção:** https://metricasatom.cognitaai.com.br · https://metricas-atom.vercel.app

## Estrutura

```
.
├── dashboard/
│   ├── index.html              # Single-file com Chart.js
│   └── data/
│       ├── daily.json          # Snapshot do dia
│       └── weekly.json         # Snapshot da semana
└── scripts/
    └── backfill.mjs            # Coleta NocoDB + Chatwoot e gera os JSONs
```

## Como atualizar as métricas

Roda local quando quiser. Sem cron, sem CI — você dispara.

```bash
# Janela arbitrária
CHATWOOT_TOKEN=798DvzYBuwfGY5kjxzf2pCqJ NOCODB_TOKEN=zduIBacatyuOkAktr_5RPGJ_IkEjECaT-bbiLf8m \
  node scripts/backfill.mjs 2026-06-08 2026-06-11

git add dashboard/data
git commit -m "metrics: atualizado"
git push
```

Vercel republica em ~30s.

> **Atenção:** os tokens NÃO vão no código (repo é público). Cola eles na frente do comando ou usa um `.env` local.

## Métricas calculadas

**Funil:** disparos (split Reativação/Campanha), respondidos, qualificados/desqualificados/suporte, transferidos + taxas de cada etapa.

**Performance da IA:** tempo mediano até 1ª resposta, mensagens/conversa (média/p50/p90), tempo até qualificação, mídias processadas (Whisper/Vision), conversas abandonadas, `#reset` solicitados.

**Mix:** distribuição por Interesse e Conhecimento entre qualificados.

## Setup (já feito)

1. Vercel — projeto `metricas-atom` (team `devops17`) ligado a este repo, rootDirectory=`dashboard`
2. Cloudflare — `metricasatom.cognitaai.com.br` aponta via CNAME para `5ccd935d3ab9549b.vercel-dns-017.com` (Proxy DNS only)

## Variáveis do script

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

- **Workflow manual** — roda comando, push, deploy. Sem cron container, sem GitHub Actions
- **Hosting:** Vercel + commits manuais → autodeploy
- **Tokens via env** — repo é público, não pode hardcodar
- **Sem n8n** — pipeline 100% código
- **Sem histórico em DB próprio** — JSONs versionados no Git são o histórico. Auditável via `git log dashboard/data/`
