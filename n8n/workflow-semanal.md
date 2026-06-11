# Workflow n8n — Métricas SDR (Semanal)

**Nome:** `Metricas SDR — Semanal`
**Schedule:** segundas-feiras 08:00 BRT (cron `0 11 * * 1` em UTC)
**Objetivo:** consolidar a semana encerrada (seg→dom anteriores) e atualizar `weekly.json`.

## Pipeline

```
[Schedule Trigger seg 08:00] → [Set: janela_semana]
                                       ↓
                        [Postgres: agregar semana atual]
                                       ↓
                        [Postgres: agregar semana anterior]
                                       ↓
                        [Code: deltas + montagem]
                                       ↓
                        [Postgres: UPSERT metricas_semanais]
                                       ↓
                        [Postgres: SELECT histórico semanal (12 sem)]
                                       ↓
                        [Code: JSON final]
                                       ↓
                        [HTTP GitHub: commit weekly.json]
```

## Janela
`semana_inicio` = última segunda-feira encerrada (ou seja, 7 dias atrás).
`semana_fim` = domingo (semana_inicio + 6).

```javascript
const hoje = $now.setZone('America/Sao_Paulo');
const offset = hoje.weekday === 1 ? 7 : ((hoje.weekday - 1 + 7) % 7) + 7;
const inicio = hoje.minus({days: offset}).startOf('day');
const fim    = inicio.plus({days: 6}).endOf('day');
return [{ json: {
  semana_inicio: inicio.toISODate(),
  semana_fim:    fim.toISODate()
}}];
```

## Agregação no Postgres
Reagregar a partir das fontes originais (não a partir das taxas diárias — sums e médias ponderadas evitam viés de média de médias). Estratégia mais simples: rodar a mesma lógica do workflow diário com janela expandida.

**Opção pragmática:** somar disparos/respondidos/qualificados/transferidos a partir de `metricas_diarias` (somas são associativas), e **recalcular taxas a partir das somas** — não médias diárias:

```sql
WITH agg AS (
  SELECT
    SUM(disparos)            AS disparos,
    SUM(disparos_reativacao) AS disparos_reativacao,
    SUM(disparos_campanha)   AS disparos_campanha,
    SUM(falhas_envio)        AS falhas_envio,
    SUM(respondidos)         AS respondidos,
    SUM(qualificados)        AS qualificados,
    SUM(transferidos)        AS transferidos,
    SUM(midias_processadas)  AS midias_processadas,
    SUM(conversas_abandonadas) AS conversas_abandonadas,
    -- médias ponderadas pela quantidade de conversas (proxy: respondidos)
    SUM(tempo_medio_1a_resposta_seg * respondidos) / NULLIF(SUM(respondidos),0) AS tempo_medio_1a_resposta_seg,
    SUM(msgs_por_conversa_media   * respondidos) / NULLIF(SUM(respondidos),0) AS msgs_por_conversa_media,
    MAX(msgs_por_conversa_p90)    AS msgs_por_conversa_p90,
    SUM(tempo_medio_qualificacao_seg * qualificados) / NULLIF(SUM(qualificados),0) AS tempo_medio_qualificacao_seg
  FROM metricas_diarias
  WHERE data BETWEEN $1 AND $2
)
SELECT
  *,
  CASE WHEN disparos > 0    THEN respondidos::numeric / disparos    END AS taxa_resposta,
  CASE WHEN respondidos > 0 THEN qualificados::numeric / respondidos END AS taxa_qualificacao,
  CASE WHEN disparos > 0    THEN transferidos::numeric / disparos    END AS taxa_transferencia_disparos,
  CASE WHEN respondidos > 0 THEN transferidos::numeric / respondidos END AS taxa_transferencia_respostas
FROM agg;
```

Mix (interesse/conhecimento/objetivo) precisa de soma de objetos JSONB:
```sql
SELECT jsonb_object_agg(k, soma) AS mix_interesse FROM (
  SELECT k, SUM(v::int) AS soma
  FROM metricas_diarias, jsonb_each(mix_interesse) AS j(k,v)
  WHERE data BETWEEN $1 AND $2
  GROUP BY k
) t;
```
Repetir para `mix_conhecimento` e `mix_objetivo`.

## Cálculo de deltas (Code node)

```javascript
const atual    = $('Postgres: agregar semana atual').first().json;
const anterior = $('Postgres: agregar semana anterior').first().json || {};

const delta_taxa_resposta      = atual.taxa_resposta != null && anterior.taxa_resposta != null
  ? +(atual.taxa_resposta - anterior.taxa_resposta).toFixed(4) : null;
const delta_taxa_qualificacao  = atual.taxa_qualificacao != null && anterior.taxa_qualificacao != null
  ? +(atual.taxa_qualificacao - anterior.taxa_qualificacao).toFixed(4) : null;
const delta_taxa_transferencia = atual.taxa_transferencia_disparos != null && anterior.taxa_transferencia_disparos != null
  ? +(atual.taxa_transferencia_disparos - anterior.taxa_transferencia_disparos).toFixed(4) : null;
const delta_disparos     = (atual.disparos || 0)     - (anterior.disparos || 0);
const delta_qualificados = (atual.qualificados || 0) - (anterior.qualificados || 0);
const delta_transferidos = (atual.transferidos || 0) - (anterior.transferidos || 0);

return [{ json: { ...atual,
  delta_taxa_resposta, delta_taxa_qualificacao, delta_taxa_transferencia,
  delta_disparos, delta_qualificados, delta_transferidos
}}];
```

## UPSERT
Mesma estrutura do diário, alvo `metricas_semanais`, PK `semana_inicio`.

## Histórico (últimas 12 semanas)
```sql
SELECT semana_inicio, semana_fim, disparos, respondidos, qualificados, transferidos,
       taxa_resposta, taxa_qualificacao, taxa_transferencia_disparos
FROM metricas_semanais
WHERE semana_inicio >= CURRENT_DATE - INTERVAL '12 weeks'
ORDER BY semana_inicio ASC;
```

## JSON final (commit em `dashboard/data/weekly.json`)
Mesmo padrão do daily, mas com `periodo: 'semanal'`, campos `semana_inicio` / `semana_fim`, e `delta_semana_anterior`. Commit via mesma GitHub Contents API.
