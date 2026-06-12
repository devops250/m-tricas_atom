# Cron service — Métricas ATOM SDR

Container minúsculo (Node 20 + `node-cron`) que roda no EasyPanel, na mesma rede do Chatwoot/NocoDB (sem problemas de firewall). A cada tick: pull do repo → executa `scripts/backfill.mjs` → commita os JSONs alterados → push. Vercel republica.

## Cronograma

| Job | Quando | O que faz |
|---|---|---|
| `daily` | ter-sáb 07:00 BRT | Backfill do dia anterior |
| `weekly` | seg 08:00 BRT | Backfill da semana anterior (seg→dom) |
| `heartbeat` | a cada hora | Log de vida |

## Deploy no EasyPanel — passo a passo

### 1. Criar Personal Access Token no GitHub

Fine-grained PAT com **acesso APENAS ao repo** `devops250/m-tricas_atom`:

1. https://github.com/settings/personal-access-tokens/new
2. Resource owner: sua conta
3. Repository access: **Only select repositories** → `devops250/m-tricas_atom`
4. Permissions → Repository permissions:
   - **Contents: Read and write**
   - **Metadata: Read-only** (automático)
5. Expiration: 1 ano
6. Generate → copia o token (começa com `github_pat_...`)

### 2. Criar app no EasyPanel

1. EasyPanel → projeto (mesmo do Chatwoot) → **+ Service** → **App**
2. **Source**:
   - Type: **GitHub** (ou Git URL)
   - Repository: `devops250/m-tricas_atom`
   - Branch: `main`
   - Build Path: `cron/`
3. **Build**:
   - Type: **Dockerfile**
   - Dockerfile path: `Dockerfile` (relativo ao Build Path)
4. **Deploy** → ainda não inicia, falta env

### 3. Configurar Environment Variables

Settings → Environment:
```
GITHUB_TOKEN=github_pat_... (do passo 1)
CHATWOOT_TOKEN=798DvzYBuwfGY5kjxzf2pCqJ
NOCODB_TOKEN=zduIBacatyuOkAktr_5RPGJ_IkEjECaT-bbiLf8m
```

### 4. (Opcional) Volume persistente

Sem volume, o repo é re-clonado a cada restart do container — funciona, só é ~1MB extra de tráfego por restart.

Para evitar re-clone, monte um volume em `/app/repo`:
- EasyPanel → app → Mounts → Add → Type: Volume → Mount Path: `/app/repo`

### 5. Deploy

Botão **Deploy**. Acompanhe os logs:

```
[<timestamp>] Clonando repo…
[<timestamp>] Scheduler iniciado. TZ=America/Sao_Paulo
[<timestamp>] heartbeat
```

### 6. Testar antes de esperar o cron

Para validar end-to-end sem esperar até amanhã 07:00 BRT, configure temporariamente:
```
RUN_ON_START=range
RANGE_INI=2026-06-08
RANGE_FIM=2026-06-11
```

Faz **Redeploy**. O scheduler vai rodar o backfill uma vez ao subir, commitar, fazer push. Confira o repo → deve aparecer um commit `chore(metrics): range 2026-06-11`. Depois **remova essas 3 env vars** para evitar reexecução em cada restart.

## Logs / debug

EasyPanel → app → **Logs**. Heartbeat horário confirma que o processo está vivo. Erros saem com prefixo `✗ Falhou`.

## Recursos

Container consome desprezível: ~30 MB RAM idle, processa o backfill em <1 min e volta a dormir. Sem persistência de estado além do clone Git.
