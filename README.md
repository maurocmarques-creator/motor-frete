# Motor de Frete (PortoEx)

Módulo reaproveitável com **Cadastro** (Serviço, Tabela, Trecho, ICMS, Cidade), **Simulador** e **Auditoria**
de frete. Um arquivo só (`dist/motor-frete.js`, com CSS e telas embutidos); qualquer site inclui e chama
`MotorFrete.iniciar(...)`.

Origem: extraído do Indicador Forte Transportes (`forte.portoexapps.com.br`), set/2026.

## Uso

```html
<div id="motor"></div>
<script src="https://maurocmarques-creator.github.io/motor-frete/dist/motor-frete.js"></script>
<script>
  MotorFrete.iniciar({
    alvo: '#motor',                    // onde montar
    projeto: 'nome_do_cliente',        // obrigatório: separa os dados do projeto
    editores: ['mauro.cesar@portoex.com.br', 'brenda.elicia@portoex.com.br'],
    auditoria: { linhas: minhasMinutas },   // opcional (sem isso a aba Auditoria não aparece)
  });
</script>
```

- **Versão fixa** (não recebe mudanças novas): `https://cdn.jsdelivr.net/gh/maurocmarques-creator/motor-frete@v1.0.0/dist/motor-frete.js`
- **Sempre a última**: o link do GitHub Pages acima (cache de até ~10 min).
- Depende de `@supabase/supabase-js@2` e SheetJS (`xlsx`): o módulo carrega sozinho se a página não tiver.
- O pacote roda isolado (não cria variáveis soltas na página), exceto `window.MotorFrete` e as funções que as
  telas chamam (`simular`, `salvarTabela`, `audDetalhe`...). Não use numa página que já defina funções com esses nomes.

## Opções de `MotorFrete.iniciar`

| Opção | Padrão | O que faz |
|---|---|---|
| `alvo` | — | Elemento ou seletor onde o motor é montado |
| `projeto` | — | Nome curto do projeto; as chaves no banco viram `<projeto>_servicos`, `_tabelas`, `_trechos`, `_simulacoes` |
| `editores` | `[]` | E-mails que podem incluir/editar/excluir e ver a Auditoria |
| `identidade` | login do Cloudflare Access | `async () => 'email'` — de onde vem o e-mail de quem está usando |
| `todosEditam` | `false` | `true` libera edição para todos (só para teste) |
| `abas` | `['cadastro','simulador','auditoria']` | Quais abas mostrar. `'analise-custo'` (v1.1.0; vários arquivos e filtro de mês na v1.1.1) é opcional e não entra por padrão |
| `abaInicial` | `simulador` | `cad-servico`, `cad-tabela`, `cad-grupo`, `cad-icms`, `cad-cidade`, `simulador`, `auditoria`, `analise-custo` |
| `auditoria.linhas` | — | Array (ou função que devolve array) com as minutas — formato abaixo |
| `auditoria.mapear` | — | `r => ({...})` para converter as linhas do projeto para o formato do motor |
| `auditoria.publica` | `false` | `true` mostra a Auditoria para quem não é editor |
| `chaves` | por projeto | Sobrescreve as chaves no banco: `{servicos, tabelas, trechos, simulacoes, icms, cidades}` |
| `supabase` | Supabase PortoEx | `{url, chave}` |

**Dados compartilhados entre projetos**: `cadastro_icms` (alíquotas UF×UF) e `cadastro_cidades` (5.571 municípios IBGE).
**Por projeto**: serviços, tabelas, trechos (grupos de cidades) e simulações salvas.

> Indicador Forte (dados já existentes) — ao migrar, usar
> `chaves: { servicos: 'forte_servicos', tabelas: 'cadastro_tabelas', trechos: 'cadastro_trechos', simulacoes: 'simulacoes_frete' }`.

## Formato da linha da Auditoria

Uma linha por minuta/CT-e. Obrigatórios para calcular: `SERVICO` (nome igual ao do Cadastro > Serviço),
`DATA EMISSAO` (`AAAA-MM-DD`, define a versão da tabela), origem, destino, pesos, valor da NF e `FRETE TOTAL`.

| Campo | Exemplo | Uso |
|---|---|---|
| `MINUTA`, `CTE`, `NF_DOC` | `'299466'` | identificação e busca |
| `DATA EMISSAO` | `'2026-09-01'` | vigência da tabela; `MES` é calculado se faltar |
| `SERVICO` | `'SUBCONTRATO_ECONOMICO'` | casa com o Cadastro > Serviço |
| `TABELA_PORTAL` | `'FORT_ECONOMICO__2026'` | só exibição |
| `COTACAO` / `COTACAO_NUM` | `'S'` / `'92037'` | com cotação → status "Cotação" (fora dos divergentes) |
| `ORIG_CIDADE`, `ORIG_UF` | `'ITAJAI'`, `'SC'` | origem |
| `EFF_CIDADE`, `EFF_UF`, `EFF_LOCAL` | `'BELO HORIZONTE'`, `'MG'`, destinatário | destino |
| `NF VALOR` | `185031.97` | GRIS, Advalorem, % sobre NF |
| `PESO_REAL`, `M3` | `485.06`, `3.523` | peso considerado = maior entre real e m³ × fator da tabela |
| `PESO_CUBADO`, `PESO_CALC` | `1056.9` | só exibição (pesos do sistema de origem) |
| `FRETE TOTAL` | `5894.15` | valor cobrado, comparado com o da tabela |
| `TX. ENTREGA`, `TX. COLETA`, `TX. GRIS`, `TX. PEDAGIO`, `TX. DESPACHO`, `TX. OUTROS`, `TX. NOTA`, `TX. FRETE PESO`, `FRETE TAS`, `FRETE TRT`, `FRETE TDE`, `FRETE SET/CAT`, `VALOR ICMS` | números | detalhe do "Excel (portal)" |

## Aba Análise de custo (v1.1.0; vários arquivos e filtro de mês na v1.1.1)

Ative com `abas: ['cadastro','simulador','auditoria','analise-custo']`. Não usa o banco: a **tela 147 do Brudam**
(relatório de custo por operação, `.xls`/HTML do próprio Brudam ou `.xlsx`) é importada na própria aba
(arrastar o arquivo ou "Escolher arquivo"); os dados ficam só na memória da página.

- **Filtros:** serviço (`SERVICO`), base (`BASE`) e cliente (`CLIENTE TOMADOR`). Por padrão ficam fora CT-e complementar, serviço de repasse e serviço logístico (caixa desmarcável).
- **Quadros:** frete, custo de coleta, transferência e entrega (cada um com **média** = soma dos custos ÷ soma dos pesos e **mediana** por CT-e), soma ICMS + seguro + outros + impostos + comissão, lucro e margem.
- **Análise estatística:** média, mediana, P25, P75 e máximo do custo/kg, por faixa de peso ou por responsável (transportadora); linhas com menos de 5 CT-e ficam com aviso.
- **Lista:** custo/kg de cada CT-e; clicar no cabeçalho ordena do maior para o menor (e inverte); custo/kg acima do P75 da própria faixa de peso aparece em vermelho. Exporta para Excel.
- Colunas lidas da tela 147: `MINUTA, BASE, DATA, CLIENTE TOMADOR, SERVICO, TIPO CTE, DESTINO, VALOR NF, FRETE, PESO, RESP. COLETA/ENTREGA/TRANSF, CUSTO COLETA/ENTREGA/TRANSF, ICMS/ISS, DIFAL, C.DESPACHO, SEGURO, OUTROS, IMPOSTO, COMIS, LUCRO LIQ`.

## Regras de cálculo (resumo)

- Tabela = serviço + vigência (**válida até** + início opcional) + composição; **regras por trecho**
  (origem → destino: cidade, estado todo ou trecho cadastrado; mais específico vence).
- Faixa de peso: valor da faixa; com R$/kg excedente → valor da faixa + (peso − franquia) × R$/kg.
- Peso considerado = maior entre real e cubado (m³ × fator de cubagem da tabela).
- GRIS/Advalorem/% NF sobre o valor da NF; TDE/TAS/TRT/Despacho/SET-CAT fixos; pedágio por fração.
- "Soma ICMS" = SIM → total ÷ (1 − alíquota UF origem→destino).
- Versões: botão "Nova versão (reajuste)" encerra a vigência da anterior automaticamente.

Detalhes no topo de `src/frete-calculo.js` e `src/cadastro-tabela.js`.

## Desenvolvimento

1. Edite os arquivos em `src/` (nunca o `dist/`).
2. `python build.py` → gera `dist/motor-frete.js`.
3. Teste local: `python -m http.server 8936` e abra `teste-local.html` (não vai para o repositório; projeto `teste_claude`, editor liberado).
4. Suba a versão no arquivo `VERSION` (1.0.1 correção, 1.1.0 novidade, 2.0.0 quebra compatibilidade),
   rode o build de novo, faça commit, push e `git tag vX.Y.Z && git push --tags`.
