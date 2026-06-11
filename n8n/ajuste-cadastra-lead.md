# Ajuste no subworkflow `Cadastra Lead` — capturar `Hora_Qualificacao`

## Por quê
A métrica **tempo médio até qualificação** precisa de timestamp do momento em que `Status` virou `Qualificado`. Hoje o NocoDB não preserva histórico de mudanças de status — quando o agente atualiza, o valor antigo é perdido. A solução é gravar `Hora_Qualificacao` explicitamente no mesmo update.

## Passos

### 1. Adicionar coluna no NocoDB
- Tabela: leads (id `{{NOCODB_LEADS_TABLE_ID}}`)
- Nome do campo: `Hora_Qualificacao`
- Tipo: `DateTime`
- Default: vazio

### 2. Ajuste no Caminho 1 (tool do agente)
No subworkflow `Cadastra Lead`, no node que faz `PATCH` no NocoDB quando a tool `cadastra_lead` é executada:

Atualmente o payload contém algo como:
```json
{ "Nome": "...", "Email": "...", "Interesse": "...", "Conhecimento": "...",
  "Status": "{{$json.Status}}", "Resumo Vendedor": "..." }
```

Adicionar lógica condicional via Set ou Code node imediatamente antes do PATCH:
```javascript
const input = $input.first().json;
const out = { ...input };
if (input.Status === 'Qualificado' && !input.Hora_Qualificacao) {
  out.Hora_Qualificacao = new Date().toISOString();
}
return [{ json: out }];
```

E incluir o campo no body do PATCH ao NocoDB:
```json
{ ...campos existentes..., "Hora_Qualificacao": "{{$json.Hora_Qualificacao}}" }
```

> Importante: o `if` evita sobrescrever um `Hora_Qualificacao` já preenchido se o agente reexecutar a tool após a qualificação inicial.

### 3. Caminho 2 (webhook NocoDB) — não precisa mudar
O webhook só dispara quando `Status=Qualificado` E `Resumo Vendedor` preenchido. Nesse ponto `Hora_Qualificacao` já foi gravado pelo Caminho 1. Deixar como está.

### 4. Backfill (opcional)
Para leads que já estão `Qualificado` mas sem `Hora_Qualificacao`, popular com a data da 1ª nota privada da conversa no Chatwoot (proxy razoável do momento do handoff):

```sql
-- Script único, rodar manualmente
-- Pseudo: usar export do NocoDB + API Chatwoot para preencher
```

Se for muito trabalho, aceitar `null` para histórico anterior à implantação — a métrica fica vazia para esses leads e o dashboard mostra `—`.

## Verificação
1. Qualificar um lead de teste via playground
2. Conferir no NocoDB que `Hora_Qualificacao` foi populado com timestamp atual
3. Re-executar a tool no mesmo lead — `Hora_Qualificacao` NÃO deve mudar
