# ATOM SDR — Métricas

Instrumentação de métricas do SDR IA da ATOM. Coleta diária + consolidação semanal, persistência em Postgres, dashboard HTML estático hospedado no domínio Cognita (via Vercel/Netlify + Git).

## Estrutura

```
.
├── migrations/
│   └── 001_metricas.sql              # Schema das tabelas metricas_diarias e metricas_semanais
├── dashboard/
│   ├── index.html                    # Dashboard single-file com Chart.js
│   └── data/
│       ├── daily.json                # Atualizado pelo workflow diário
│       └── weekly.json               # Atualizado pelo workflow semanal
├── n8n/
│   ├── workflow-diario.md            # Spec completa do workflow diário
│   ├── workflow-semanal.md           # Spec completa do workflow semanal
│   └── ajuste-cadastra-lead.md       # Ajuste no subworkflow p/ capturar Hora_Qualificacao
└── Handover_Atom_SDR_Cognita (1).docx  # Documento de handover (referência)
```

## Métricas

**Funil:** disparos, respondidos, em qualificação, qualificados, transferidos + taxas de cada etapa + split por origem (Reativação / Campanha) + mix de qualificação (Interesse / Conhecimento / Objetivo).

**Performance da IA:** tempo médio até 1ª resposta, mensagens por conversa (média, p50, p90), tempo médio até qualificação, mídias processadas (Whisper / Vision), taxa de FUP necessário, conversas abandonadas (>48h sem resposta), `#reset` solicitados.

## Setup — passo a passo

### 1. Aplicar migration Postgres
```bash
psql "$POSTGRES_URL" -f migrations/001_metricas.sql
```
Validar:
```sql
\dt metricas*
```

### 2. Ajustar subworkflow Cadastra Lead
Seguir `n8n/ajuste-cadastra-lead.md` — adicionar coluna `Hora_Qualificacao` no NocoDB e popular via o Caminho 1 quando `Status` mudar para `Qualificado`.

### 3. Criar repo do dashboard no GitHub
- Novo repo (privado ok): `atom-sdr-metrics-dashboard`
- Push do conteúdo da pasta `dashboard/`
- Conectar ao Vercel/Netlify (deploy automático a cada push)
- Domínio: configurar subdomínio Cognita com slug não-listado (ex: `cognita.com.br/atom-sdr-x7k2/`)

### 4. Configurar credenciais no n8n
Variáveis de ambiente / credentials:
- `GITHUB_PAT` — Personal Access Token com escopo `repo`
- `GITHUB_OWNER`, `GITHUB_REPO`
- Postgres, NocoDB, Chatwoot — já existem

### 5. Montar workflows no n8n
- Importar / construir conforme `n8n/workflow-diario.md`
- Importar / construir conforme `n8n/workflow-semanal.md`
- Testar com execução manual antes de habilitar o schedule

### 6. Backfill
Rodar o workflow diário manualmente para cada dia 21/05 a 10/06/2026, ajustando o node `Set: janela`. Esperado bater com 1ª reativação: **98 disparos / 26 respostas / 8 transferidos**.

### 7. Habilitar schedules
- Diário: 07:00 BRT (cron `0 10 * * *` UTC)
- Semanal: segundas 08:00 BRT (cron `0 11 * * 1` UTC)

## Verificação end-to-end
1. `SELECT * FROM metricas_diarias ORDER BY data DESC LIMIT 5` retorna linhas válidas
2. `curl https://{dashboard-url}/data/daily.json | jq .gerado_em` mostra timestamp recente
3. Dashboard abre sem erro JS no console, todos os charts renderizam
4. Comparar números do dashboard com contagem manual no NocoDB/Chatwoot para 1-2 dias amostrais

## Decisões registradas
- **Hosting:** Vercel/Netlify + Git (n8n commita JSON via GitHub Contents API)
- **Timestamp de qualificação:** nova coluna `Hora_Qualificacao` no NocoDB, populada pelo subworkflow Cadastra Lead
- **Auth do dashboard:** público com slug não-listado (sem login)
- **Cadência:** diária (seg-sex 07:00) + semanal consolidada (seg 08:00)
- **Histórico:** Postgres existente, tabelas `metricas_diarias` (PK `data`) e `metricas_semanais` (PK `semana_inicio`)

## Roadmap

| # | Item | Esforço |
|---|---|---|
| 1 | Migration Postgres | 30 min |
| 2 | Ajuste Cadastra Lead (`Hora_Qualificacao`) | 1h |
| 3 | Repo + deploy Vercel | 1-2h |
| 4 | Workflow diário | meio dia |
| 5 | Workflow semanal | 2-3h |
| 6 | Backfill 21/05 → hoje | 1h |
| 7 | Validação com Chrystian | 1 ciclo |

**Total:** 3-4 dias focados.
