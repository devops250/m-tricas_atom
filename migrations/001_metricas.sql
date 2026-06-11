-- Migration: tabelas de métricas do SDR IA ATOM
-- Aplicar uma vez no Postgres do n8n (credential interna do n8n — ver Vault)
-- psql ... -f 001_metricas.sql

BEGIN;

CREATE TABLE IF NOT EXISTS metricas_diarias (
  data                          DATE PRIMARY KEY,

  -- Funil
  disparos                      INT NOT NULL DEFAULT 0,
  disparos_reativacao           INT NOT NULL DEFAULT 0,
  disparos_campanha             INT NOT NULL DEFAULT 0,
  falhas_envio                  INT NOT NULL DEFAULT 0,
  respondidos                   INT NOT NULL DEFAULT 0,
  em_qualificacao               INT NOT NULL DEFAULT 0,
  qualificados                  INT NOT NULL DEFAULT 0,
  transferidos                  INT NOT NULL DEFAULT 0,
  taxa_resposta                 NUMERIC(5,4),
  taxa_qualificacao             NUMERIC(5,4),
  taxa_transferencia_disparos   NUMERIC(5,4),
  taxa_transferencia_respostas  NUMERIC(5,4),

  -- Performance da IA
  tempo_medio_1a_resposta_seg   INT,
  msgs_por_conversa_media       NUMERIC(6,2),
  msgs_por_conversa_p50         INT,
  msgs_por_conversa_p90         INT,
  tempo_medio_qualificacao_seg  INT,
  midias_processadas            INT NOT NULL DEFAULT 0,
  audios_transcritos            INT NOT NULL DEFAULT 0,
  imagens_processadas           INT NOT NULL DEFAULT 0,
  taxa_fup_necessario           NUMERIC(5,4),
  conversas_abandonadas         INT NOT NULL DEFAULT 0,
  resets_solicitados            INT NOT NULL DEFAULT 0,

  -- Mix de qualificação (snapshots como JSON: {"Formação": 7, "Avaliação": 2, "Consultoria": 1})
  mix_interesse                 JSONB,
  mix_conhecimento              JSONB,
  mix_objetivo                  JSONB,

  -- Distribuição entre vendedores (opcional, p/ futuro)
  distribuicao_agentes          JSONB,

  gerado_em                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metricas_diarias_gerado_em
  ON metricas_diarias (gerado_em DESC);

CREATE TABLE IF NOT EXISTS metricas_semanais (
  semana_inicio                 DATE PRIMARY KEY,  -- segunda-feira
  semana_fim                    DATE NOT NULL,     -- domingo

  -- Agregados de funil (somas e taxas recalculadas, NÃO média de taxas diárias)
  disparos                      INT NOT NULL DEFAULT 0,
  disparos_reativacao           INT NOT NULL DEFAULT 0,
  disparos_campanha             INT NOT NULL DEFAULT 0,
  falhas_envio                  INT NOT NULL DEFAULT 0,
  respondidos                   INT NOT NULL DEFAULT 0,
  qualificados                  INT NOT NULL DEFAULT 0,
  transferidos                  INT NOT NULL DEFAULT 0,
  taxa_resposta                 NUMERIC(5,4),
  taxa_qualificacao             NUMERIC(5,4),
  taxa_transferencia_disparos   NUMERIC(5,4),
  taxa_transferencia_respostas  NUMERIC(5,4),

  -- Performance da IA (médias ponderadas por # conversas)
  tempo_medio_1a_resposta_seg   INT,
  msgs_por_conversa_media       NUMERIC(6,2),
  msgs_por_conversa_p90         INT,
  tempo_medio_qualificacao_seg  INT,
  midias_processadas            INT NOT NULL DEFAULT 0,
  taxa_fup_necessario           NUMERIC(5,4),
  conversas_abandonadas         INT NOT NULL DEFAULT 0,

  -- Mix
  mix_interesse                 JSONB,
  mix_conhecimento              JSONB,
  mix_objetivo                  JSONB,
  distribuicao_agentes          JSONB,

  -- Comparativo vs semana anterior (delta absoluto em pontos percentuais)
  delta_taxa_resposta           NUMERIC(6,4),
  delta_taxa_qualificacao       NUMERIC(6,4),
  delta_taxa_transferencia      NUMERIC(6,4),
  delta_disparos                INT,
  delta_qualificados            INT,
  delta_transferidos            INT,

  gerado_em                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metricas_semanais_gerado_em
  ON metricas_semanais (gerado_em DESC);

COMMIT;

-- Verificação:
-- \dt metricas*
-- \d metricas_diarias
-- \d metricas_semanais
