#!/usr/bin/env python3
"""
build.py — gera dist/motor-frete.js (um arquivo so, com CSS e HTML embutidos).

Uso:  python build.py
A versao vem do arquivo VERSION. Depois de mudar algo em src/, rode o build,
suba a VERSION (ex.: 1.0.1) e publique (commit + push + tag vX.Y.Z).
"""

import json
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).parent
SRC = RAIZ / "src"

# ordem importa: nucleo primeiro, ui por ultimo
ORDEM = [
    "nucleo.js",
    "frete-calculo.js",
    "cadastro-servico.js",
    "cadastro-tabela.js",
    "cadastro-icms.js",
    "cadastro-cidade.js",
    "cadastro-trecho.js",
    "simulador.js",
    "auditoria.js",
    "analise-custo.js",
]


def main():
    versao = (RAIZ / "VERSION").read_text(encoding="utf-8").strip()
    css = (SRC / "estilo.css").read_text(encoding="utf-8") + (SRC / "estilo-nav.css").read_text(encoding="utf-8")
    paineis = (SRC / "paineis.html").read_text(encoding="utf-8")

    partes = [
        "/*! Motor de Frete v%s — PortoEx — gerado em %s por build.py (nao editar: mude src/ e rode o build) */"
        % (versao, datetime.now().strftime("%d/%m/%Y %H:%M")),
        "(function () {",
        "'use strict';",
    ]
    for nome in ORDEM:
        partes.append(f"\n// ===== {nome} =====\n" + (SRC / nome).read_text(encoding="utf-8"))
    partes.append("\n// ===== estilo e telas (embutidos) =====")
    partes.append("const MF_CSS = " + json.dumps(css, ensure_ascii=False) + ";")
    partes.append("const MF_PAINEIS = " + json.dumps(paineis, ensure_ascii=False) + ";")
    partes.append("\n// ===== ui.js =====\n" + (SRC / "ui.js").read_text(encoding="utf-8"))
    partes.append(EXPOR)
    partes.append("})();")

    js = "\n".join(partes).replace("__MF_VERSAO__", versao)
    (RAIZ / "dist").mkdir(exist_ok=True)
    (RAIZ / "dist" / "motor-frete.js").write_text(js, encoding="utf-8")
    print(f"dist/motor-frete.js v{versao} ({len(js):,} bytes)")


# As telas usam onclick="funcao()" no HTML: essas funcoes precisam existir no
# escopo global. O pacote roda dentro de uma funcao (para nao vazar variaveis
# internas) e publica em window so o que as telas chamam.
EXPOR = """
// ===== funcoes chamadas pelo HTML das telas (onclick/oninput) =====
Object.assign(window, {
  mfMostrar,
  // servico
  salvarServico, excluirServico,
  // tabela / trechos / versoes
  novaTabela, abrirTabela, salvarTabela, excluirTabela, carregarTabelas, abrirTrechos, abrirTrecho, salvarTrecho, excluirTrecho,
  tabAddFaixa, tabDelFaixa, tabAbrirVersao, tabCriarVersao,
  // icms / cidade / trecho (grupos)
  salvarIcms, importarIcms, icmsAlterou, renderCidades, incluirCidade, excluirCidade,
  novoGrupo, abrirGrupo, salvarGrupo, excluirGrupo, carregarGrupos, tirarCidadeGrupo, grpAbrirColar, grpLimparCidades, grpProcessarColagem,
  // simulador
  simular, simAtualizarTabelas, salvarSimulacao, renderSimSalvas, abrirSimulacao, excluirSimulacao, exportarSimSalvas,
  // auditoria
  audAplicarFiltros, audFiltrarStatus, audDetalhe, audAbrirSimulador, audExportar,
  // analise de custo (tela 147)
  ancEscolheu, ancLimpar, ancAplicar, ancOrdenar, ancRenderEstat, ancExportar,
});
"""

if __name__ == "__main__":
    main()
