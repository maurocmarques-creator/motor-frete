#!/usr/bin/env python3
r"""
gerar-cidaten.py — gera dist/cidaten-trechos.json a partir da planilha Cidaten (aba Planilha1:
SERVICO, ORIGEM, UF, DESTINO, ..., TARIFA).  Trecho = UF + TARIFA (ex.: "SP CAPITAL", "SP INTERIOR 3").
A aba "Analise de custo" usa esse arquivo como padrao para cruzar a cidade de destino da tela 147 com o trecho.

Uso:  python gerar-cidaten.py "caminho\Cidaten_Maio_2026_Ajustado1.xlsx"
"""
import json, re, sys, unicodedata
from collections import defaultdict
from pathlib import Path

import openpyxl

RAIZ = Path(__file__).parent


def norm(s):
    return re.sub(r"\s+", " ", "".join(c for c in unicodedata.normalize("NFD", str(s or "")) if unicodedata.category(c) != "Mn")).upper().strip()


def main(caminho):
    ws = openpyxl.load_workbook(caminho, read_only=True, data_only=True)["Planilha1"]
    cab = [norm(c) for c in next(ws.iter_rows(values_only=True))]
    i_uf, i_dest, i_tar, i_orig = cab.index("UF"), cab.index("DESTINO"), cab.index("TARIFA"), cab.index("ORIGEM")
    por_trecho, conflito, origens = defaultdict(set), {}, set()
    vistos = {}
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r[i_uf] or not r[i_dest] or not r[i_tar]:
            continue
        uf, cidade, tarifa = str(r[i_uf]).strip().upper(), str(r[i_dest]).strip(), norm(r[i_tar])
        origens.add(norm(r[i_orig]))
        chave = (uf, norm(cidade))
        if chave in vistos and vistos[chave] != tarifa:
            conflito[chave] = (vistos[chave], tarifa)   # mesma cidade com tarifas diferentes entre servicos
        vistos.setdefault(chave, tarifa)
        por_trecho[f"{uf} {tarifa}"].add(cidade)
    trechos = [{"nome": n, "uf": n.split(" ")[0], "cidades": sorted(c)} for n, c in sorted(por_trecho.items())]
    saida = {"fonte": Path(caminho).name, "origem": sorted(origens), "trechos": trechos}
    (RAIZ / "dist").mkdir(exist_ok=True)
    (RAIZ / "dist" / "cidaten-trechos.json").write_text(json.dumps(saida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"dist/cidaten-trechos.json: {len(trechos)} trechos, {sum(len(t['cidades']) for t in trechos)} cidades (origem {', '.join(sorted(origens))})")
    if conflito:
        print(f"ATENCAO: {len(conflito)} cidade(s) com tarifas diferentes entre servicos (vale a primeira):", list(conflito.items())[:5])


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1])
