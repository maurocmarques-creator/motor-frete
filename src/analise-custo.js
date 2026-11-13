// analise-custo.js — aba "Análise de custo": custo por kg de coleta, transferência e entrega
// a partir da tela 147 do Brudam (relatório de custo por operação), importada na própria tela
// (arquivo .xls/.html exportado pelo Brudam ou .xlsx). Filtros: serviço, base e cliente.
//
// Medidas (para cada custo): MÉDIA = soma dos custos ÷ soma dos pesos (custo real por kg) e
// MEDIANA = valor típico por CT-e (custo ÷ peso de cada CT-e). A tabela estatística quebra por
// faixa de peso ou por responsável e mostra P25/P75; na lista, o custo/kg acima do P75 da faixa
// de peso aparece em vermelho. Mediana/P25/P75 usam só os CT-e que têm aquele custo (> 0).
//
// Fica de fora (marcado por padrão, dá para desligar): CT-e complementar, serviço de repasse e
// serviço logístico — não fazem parte da análise de custo por kg.

let _ancLinhas = [];       // todas as linhas importadas
let _ancHdr = [];          // cabeçalho da tela 147 (para a exportação)
let _ancArquivos = [];     // arquivos importados: { nome, n }
let _ancBase = [];         // linhas depois dos filtros
let _ancOrd = null;        // { k: 'coleta'|'entrega'|'transf'|'frete', d: -1 | 1 }
let _ancDropOk = false;
const ANC_LIM_TELA = 500;

const ANC_FAIXAS = [[0, 50, 'até 50 kg'], [50, 100, '51 a 100 kg'], [100, 300, '101 a 300 kg'],
  [300, 1000, '301 a 1.000 kg'], [1000, Infinity, 'acima de 1.000 kg']];
const ANC_CUSTOS = { coleta: 'Coleta', entrega: 'Entrega', transf: 'Transferência' };
const ANC_RESP = { coleta: 'RESP. COLETA', entrega: 'RESP. ENTREGA', transf: 'RESP. TRANSF' };

// ---------- utilidades ----------
function ancNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace('%', '').trim();
  if (!s) return 0;
  return s.includes(',') ? (parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0) : (parseFloat(s) || 0);
}
function ancFmt(v, d = 2) {
  return (v == null || isNaN(v)) ? '' : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function ancPct(v) { return (v == null || !isFinite(v)) ? '' : ancFmt(v * 100, 2) + '%'; }
function ancQuantil(arr, q) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y), pos = (a.length - 1) * q, b = Math.floor(pos), r = pos - b;
  return a[b + 1] !== undefined ? a[b] + r * (a[b + 1] - a[b]) : a[b];
}
function ancFaixaDe(p) { const i = ANC_FAIXAS.findIndex(f => p > f[0] && p <= f[1]); return i < 0 ? 0 : i; }
function ancIsoData(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(v ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
function ancSoma(lista, f) { return lista.reduce((s, c) => s + (f(c) || 0), 0); }
function ancOutrosCusto(c) { return c.custos.outros + c.custos.difal + c.custos.desp; }
function ancSomaCustos(c) { return c.icms + c.custos.seguro + ancOutrosCusto(c) + c.imposto + c.comis; }

// Média (soma/soma) e mediana por CT-e de um custo; lista = linhas do filtro
function ancEstat(lista, valor) {
  const L = lista.filter(c => c.peso > 0 && valor(c) > 0), v = L.map(c => valor(c) / c.peso);
  const pesoT = ancSoma(L, c => c.peso), custoT = ancSoma(L, valor);
  return { n: L.length, pesoT, custoT, pond: pesoT ? custoT / pesoT : 0, med: ancQuantil(v, .5),
    p25: ancQuantil(v, .25), p75: ancQuantil(v, .75), max: v.length ? Math.max(...v) : 0 };
}

// ---------- leitura da tela 147 ----------
async function ancLerArquivo(arquivo) {   // devolve as linhas com .arquivo = nome do arquivo
  const buf = await arquivo.arrayBuffer(), u8 = new Uint8Array(buf);
  const cab = new TextDecoder('utf-8').decode(u8.slice(0, 4096));
  let aoa;
  if (/<table|<style|<html/i.test(cab)) {   // o .xls do Brudam é HTML disfarçado
    const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(u8), 'text/html');
    aoa = [...doc.querySelectorAll('tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
  } else {
    if (!window.XLSX) await mfCarregarScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    const wb = window.XLSX.read(buf, { type: 'array' });
    aoa = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  }
  const h = aoa.findIndex(r => r && freteNorm(r[0]) === 'MINUTA');
  if (h < 0) throw new Error('Cabeçalho "MINUTA" não encontrado: use o arquivo da tela 147 (relatório de custo por operação).');
  const hd = aoa[h].map(x => freteNorm(x));
  const ix = n => hd.indexOf(n);
  const falta = ['FRETE', 'PESO', 'CUSTO COLETA', 'CUSTO ENTREGA', 'CUSTO TRANSF'].filter(n => ix(n) < 0);
  if (falta.length) throw new Error('Colunas ausentes na tela 147: ' + falta.join(', '));
  const g = (r, n) => (ix(n) >= 0 ? r[ix(n)] : '');
  const linhas = [];
  for (let i = h + 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (!r || !/^\d+$/.test(String(r[0]).trim()) || r.length < 20) continue;   // ignora linhas de total
    if (!String(g(r, 'DESTINO')).trim() || !String(g(r, 'TIPO CTE')).trim()) continue;
    const c = {
      minuta: String(g(r, 'MINUTA')), base: String(g(r, 'BASE') || '').trim(), data: ancIsoData(g(r, 'DATA')),
      cliente: String(g(r, 'CLIENTE TOMADOR') || '').trim(), servico: String(g(r, 'SERVICO') || '').trim(),
      tipo: String(g(r, 'TIPO CTE') || '').trim(), destino: String(g(r, 'DESTINO') || '').trim(),
      nf: ancNum(g(r, 'VALOR NF')), frete: ancNum(g(r, 'FRETE')), peso: ancNum(g(r, 'PESO')),
      icms: ancNum(g(r, 'ICMS/ISS')), imposto: ancNum(g(r, 'IMPOSTO')), comis: ancNum(g(r, 'COMIS')), lucro: ancNum(g(r, 'LUCRO LIQ')),
      custos: { coleta: ancNum(g(r, 'CUSTO COLETA')), entrega: ancNum(g(r, 'CUSTO ENTREGA')), transf: ancNum(g(r, 'CUSTO TRANSF')),
        seguro: ancNum(g(r, 'SEGURO')), outros: ancNum(g(r, 'OUTROS')), difal: ancNum(g(r, 'DIFAL')), desp: ancNum(g(r, 'C.DESPACHO')) },
      resp: { coleta: String(g(r, 'RESP. COLETA') || '').trim(), entrega: String(g(r, 'RESP. ENTREGA') || '').trim(), transf: String(g(r, 'RESP. TRANSF') || '').trim() },
    };
    c.arquivo = arquivo.name;
    c.excl = /COMPLEM/i.test(c.tipo) ? 'complemento' : /REPASSE/i.test(c.servico) ? 'repasse' : /LOGISTIC/i.test(c.servico) ? 'logistico' : '';
    linhas.push(c);
  }
  if (!linhas.length) throw new Error('Nenhum CT-e encontrado no arquivo.');
  return { linhas, hdr: aoa[h].map(x => String(x ?? '').trim()) };
}

async function ancImportar(arquivos) {
  arquivos = [...arquivos];
  const msg = document.getElementById('anc-msg');
  msg.style.color = '#64748b';
  const erros = [];
  for (const arq of arquivos) {
    msg.textContent = 'Lendo "' + arq.name + '"...';
    try {
      const { linhas, hdr } = await ancLerArquivo(arq);
      const porMinuta = new Map(_ancLinhas.map(c => [c.minuta, c]));
      let novas = 0, trocadas = 0;
      linhas.forEach(c => { porMinuta.has(c.minuta) ? trocadas++ : novas++; porMinuta.set(c.minuta, c); });   // mesma minuta: vale a do arquivo mais novo
      _ancLinhas = [...porMinuta.values()];
      _ancHdr = hdr; _ancOrd = null;
      const existente = _ancArquivos.find(x => x.nome === arq.name);
      if (existente) { existente.n = linhas.length; } else _ancArquivos.push({ nome: arq.name, n: linhas.length });
      if (trocadas) erros.push(`"${arq.name}": ${trocadas} CT-e já estavam importados e foram atualizados.`);
    } catch (e) {
      console.error(e);
      erros.push(`"${arq.name}": ${e.message || 'não foi possível ler o arquivo.'}`);
    }
  }
  msg.style.color = erros.some(x => !/atualizados\.$/.test(x)) ? '#b91c1c' : '#64748b';
  msg.textContent = erros.join(' ');
  ancMostrarArquivos();
  ancMontarFiltros(false);
  ancAplicar();
}
function ancEscolheu(input) { const f = input.files && input.files.length ? [...input.files] : []; if (f.length) ancImportar(f); input.value = ''; }
function ancMostrarArquivos() {
  document.getElementById('anc-arq-nome').innerHTML = _ancArquivos.map((a, i) =>
    `<span class="anc-chip">📄 ${cadEsc(a.nome)} (${a.n} CT-e) <b onclick="ancRemoverArquivo(${i})" title="Remover este arquivo" style="cursor:pointer;color:#b91c1c">✕</b></span>`).join('');
}
// remove um arquivo: as linhas dele saem; os demais arquivos são relidos da memória (guardamos a origem de cada linha)
function ancRemoverArquivo(i) {
  const nome = _ancArquivos[i] && _ancArquivos[i].nome;
  _ancArquivos.splice(i, 1);
  _ancLinhas = _ancLinhas.filter(c => c.arquivo !== nome);
  ancMostrarArquivos(); ancMontarFiltros(false); ancAplicar();
}
function ancLimpar() {
  _ancLinhas = []; _ancHdr = []; _ancArquivos = []; _ancBase = []; _ancOrd = null;
  document.getElementById('anc-msg').textContent = '';
  ancMostrarArquivos();
  ancMontarFiltros(true);
  ancAplicar();
}

// ---------- tela ----------
function carregarAnaliseCusto() {
  const drop = document.getElementById('anc-drop');
  if (drop && !_ancDropOk) {
    _ancDropOk = true;
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('sobre'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('sobre'); }));
    drop.addEventListener('drop', e => { const f = e.dataTransfer.files ? [...e.dataTransfer.files] : []; if (f.length) ancImportar(f); });
  }
  ancMontarFiltros(false);
  ancAplicar();
}

function ancMontarFiltros(zerar) {
  const encher = (id, valores, rotulo) => {
    const sel = document.getElementById(id), atual = zerar ? '' : sel.value;
    sel.innerHTML = `<option value="">${rotulo}</option>` +
      valores.map(v => `<option value="${cadEsc(v)}"${v === atual ? ' selected' : ''}>${cadEsc(v)}</option>`).join('');
  };
  const u = k => [...new Set(_ancLinhas.map(c => c[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const meses = [...new Set(_ancLinhas.map(c => c.data.slice(0, 7)).filter(Boolean))].sort().reverse();
  { const sel = document.getElementById('anc-f-mes'), atual = zerar ? '' : sel.value;
    sel.innerHTML = '<option value="">Todos os meses</option>' + meses.map(m => `<option value="${m}"${m === atual ? ' selected' : ''}>${cadEsc(mfMesNome(m))}</option>`).join(''); }
  encher('anc-f-servico', u('servico'), 'Todos os serviços');
  encher('anc-f-base', u('base'), 'Todas as bases');
  encher('anc-f-cliente', u('cliente'), 'Todos os clientes');
}

function ancAplicar() {
  const v = id => document.getElementById(id).value;
  const mes = v('anc-f-mes'), servico = v('anc-f-servico'), base = v('anc-f-base'), cliente = v('anc-f-cliente');
  const tirar = document.getElementById('anc-f-excl').checked;
  _ancBase = _ancLinhas.filter(c => (!mes || c.data.slice(0, 7) === mes) && (!servico || c.servico === servico) && (!base || c.base === base) &&
    (!cliente || c.cliente === cliente) && !(tirar && c.excl));
  ancRenderResumo();
  ancRenderEstat();
  ancRenderTabela();
}

function ancRenderResumo() {
  const el = document.getElementById('anc-resumo');
  if (!_ancLinhas.length) { el.innerHTML = '<div style="font-size:.8rem;color:#64748b">Importe a tela 147 para ver a análise.</div>'; return; }
  const rows = _ancBase, F = ancSoma(rows, c => c.frete), L = ancSoma(rows, c => c.lucro), PESO = ancSoma(rows, c => c.peso);
  const card = (rot, val, linhas) => `<div class="aud-card"><div class="aud-card-rot">${rot}</div><div class="aud-card-val">${val}</div>${(linhas || []).map(l => `<div style="font-size:.72rem;color:#475569">${l}</div>`).join('')}</div>`;
  const kg = (valor, titulo) => {
    const e = ancEstat(rows, valor);
    return [`média: <b>R$ ${ancFmt(PESO ? ancSoma(rows, valor) / PESO : 0)}</b>`, `mediana: <b>R$ ${ancFmt(e.med)}</b>`];
  };
  const somaMed = ancQuantil(rows.filter(c => c.peso > 0 && ancSomaCustos(c) > 0).map(c => ancSomaCustos(c) / c.peso), .5);
  const fretMed = ancQuantil(rows.filter(c => c.peso > 0 && c.frete > 0).map(c => c.frete / c.peso), .5);
  const html = [
    card('Frete', ancFmt(F), [`média: <b>R$ ${ancFmt(PESO ? F / PESO : 0)}</b>`, `mediana: <b>R$ ${ancFmt(fretMed)}</b>`]),
    ...Object.keys(ANC_CUSTOS).map(k => card('Custo de ' + ANC_CUSTOS[k], ancFmt(ancSoma(rows, c => c.custos[k])), kg(c => c.custos[k]))),
    card('Soma: ICMS + Seguro + Outros + Impostos + Comissão', ancFmt(ancSoma(rows, ancSomaCustos)),
      [`média: <b>R$ ${ancFmt(PESO ? ancSoma(rows, ancSomaCustos) / PESO : 0)}</b>`, `mediana: <b>R$ ${ancFmt(somaMed)}</b>`]),
    card('Lucro/Prejuízo', `<span style="color:${L < 0 ? '#dc2626' : '#16a34a'}">${ancFmt(L)}</span>`),
    card('Margem %', ancPct(F ? L / F : 0)),
    card('CT-e na análise', String(rows.length), [`de ${_ancLinhas.length} importados`, `${ancFmt(PESO)} kg`]),
  ];
  el.innerHTML = html.join('');
}

function ancRenderEstat() {
  const t = document.getElementById('anc-estat');
  if (!_ancLinhas.length) { t.innerHTML = ''; return; }
  const key = document.getElementById('anc-kg-custo').value, por = document.getElementById('anc-kg-quebra').value;
  const val = c => c.custos[key];
  let grupos;
  if (por === 'faixa') grupos = ANC_FAIXAS.map((f, i) => [f[2], _ancBase.filter(c => ancFaixaDe(c.peso) === i)]);
  else {
    const m = new Map();
    _ancBase.forEach(c => { const r = c.resp[key] || '(sem responsável)'; if (!m.has(r)) m.set(r, []); m.get(r).push(c); });
    grupos = [...m.entries()];
  }
  const lin = grupos.map(([nome, l]) => ({ nome, e: ancEstat(l, val) })).filter(g => g.e.n > 0);
  if (por !== 'faixa') lin.sort((a, b) => b.e.custoT - a.e.custoT);
  const tot = ancEstat(_ancBase, val);
  const th = (r, t0) => `<th style="text-align:${t0 || 'right'}">${r}</th>`;
  let h = `<thead><tr>${th(por === 'faixa' ? 'Faixa de peso' : 'Responsável', 'left')}${th('CT-e com custo')}${th('Peso total (kg)')}${th('Custo total')}${th('Média R$/kg')}${th('Mediana R$/kg')}${th('P25')}${th('P75')}${th('Máx.')}</tr></thead><tbody>`;
  const td = x => `<td style="text-align:right">${x}</td>`;
  lin.forEach(g => {
    const e = g.e, fraco = e.n < 5;
    h += `<tr${fraco ? ' style="opacity:.6" title="Poucos CT-e: baixa confiança"' : ''}><td>${cadEsc(g.nome)}${fraco ? ' ⚠' : ''}</td>${td(e.n)}${td(ancFmt(e.pesoT))}${td(ancFmt(e.custoT))}${td('<b>' + ancFmt(e.pond) + '</b>')}${td(ancFmt(e.med))}${td(ancFmt(e.p25))}${td(ancFmt(e.p75))}${td(ancFmt(e.max))}</tr>`;
  });
  h += `<tr style="font-weight:700;background:#eef2f7"><td>Total</td>${td(tot.n)}${td(ancFmt(tot.pesoT))}${td(ancFmt(tot.custoT))}${td(ancFmt(tot.pond))}${td(ancFmt(tot.med))}${td(ancFmt(tot.p25))}${td(ancFmt(tot.p75))}${td(ancFmt(tot.max))}</tr></tbody>`;
  t.innerHTML = h;
}

// custo/kg de uma linha (0 quando não há custo ou peso)
function ancKg(c, k) { const v = k === 'frete' ? c.frete : c.custos[k]; return c.peso > 0 ? v / c.peso : 0; }

function ancOrdenar(k) {
  _ancOrd = (_ancOrd && _ancOrd.k === k) ? { k, d: -_ancOrd.d } : { k, d: -1 };   // 1º clique: maior → menor
  ancRenderTabela();
}

function ancRenderTabela() {
  const tb = document.getElementById('anc-tb'), th = document.getElementById('anc-thead'), rod = document.getElementById('anc-rodape');
  const cols = [['frete', 'Frete/kg'], ['coleta', 'Coleta/kg'], ['entrega', 'Entrega/kg'], ['transf', 'Transf./kg']];
  const seta = k => (_ancOrd && _ancOrd.k === k ? (_ancOrd.d < 0 ? ' ▼' : ' ▲') : ' ⇅');
  const R = 'text-align:right';
  th.innerHTML = `<tr><th>Minuta</th><th>Data</th><th>Base</th><th>Cliente</th><th>Serviço</th><th>Destino</th><th style="${R}">Peso (kg)</th><th style="${R}">Valor NF</th><th style="${R}">Frete</th>` +
    `<th style="${R};cursor:pointer;background:#2563a8" onclick="ancOrdenar('frete')" title="Clique para ordenar">Frete/kg${seta('frete')}</th>` +
    ['coleta', 'entrega', 'transf'].map(k => `<th style="${R}">${ANC_CUSTOS[k]}</th><th style="${R};cursor:pointer;background:#2563a8" onclick="ancOrdenar('${k}')" title="Clique para ordenar (maior ↔ menor)">${ANC_CUSTOS[k]}/kg${seta(k)}</th>`).join('') +
    `<th style="${R}">Lucro</th><th style="${R}">Margem</th></tr>`;
  if (!_ancBase.length) {
    tb.innerHTML = `<tr><td colspan="19" style="color:#64748b">${_ancLinhas.length ? 'Nenhum CT-e com esses filtros.' : 'Nenhum arquivo importado.'}</td></tr>`;
    rod.textContent = '';
    return;
  }
  // limite P75 por faixa de peso (só faixas com 5+ CT-e) para o destaque em vermelho
  const p75 = {};
  ['coleta', 'entrega', 'transf'].forEach(k => { p75[k] = ANC_FAIXAS.map((f, i) => { const e = ancEstat(_ancBase.filter(c => ancFaixaDe(c.peso) === i), c => c.custos[k]); return e.n >= 5 ? e.p75 : Infinity; }); });
  let rows = _ancBase;
  if (_ancOrd) rows = [...rows].sort((a, b) => (ancKg(a, _ancOrd.k) - ancKg(b, _ancOrd.k)) * _ancOrd.d);
  const dt = iso => iso ? iso.split('-').reverse().join('/') : '';
  const num = (x, d) => `<td style="text-align:right">${ancFmt(x, d)}</td>`;
  tb.innerHTML = rows.slice(0, ANC_LIM_TELA).map(c => {
    const kgCel = k => { const v = ancKg(c, k), alto = k !== 'frete' && v > p75[k][ancFaixaDe(c.peso)]; return `<td style="text-align:right;${alto ? 'background:#fde2e2;color:#b42318;font-weight:600' : ''}">${v ? ancFmt(v) : ''}</td>`; };
    return `<tr${c.excl ? ' style="opacity:.55"' : ''}><td>${cadEsc(c.minuta)}</td><td>${dt(c.data)}</td><td>${cadEsc(c.base)}</td><td>${cadEsc(c.cliente)}</td><td>${cadEsc(c.servico)}</td><td>${cadEsc(c.destino)}</td>` +
      num(c.peso) + num(c.nf) + num(c.frete) + kgCel('frete') +
      ['coleta', 'entrega', 'transf'].map(k => num(c.custos[k]) + kgCel(k)).join('') +
      `<td style="text-align:right;color:${c.lucro < 0 ? '#dc2626' : '#16a34a'}">${ancFmt(c.lucro)}</td><td style="text-align:right">${ancPct(c.frete ? c.lucro / c.frete : 0)}</td></tr>`;
  }).join('');
  rod.textContent = `${_ancBase.length} CT-e na análise` + (_ancBase.length > ANC_LIM_TELA ? ` (mostrando os primeiros ${ANC_LIM_TELA}; a exportação leva todos)` : '') +
    '. Custo/kg em vermelho = acima do P75 da própria faixa de peso.';
}

async function ancExportar() {
  if (!_ancBase.length) return;
  if (!window.XLSX) await mfCarregarScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  const aoa = [['Minuta', 'Data', 'Base', 'Cliente', 'Serviço', 'Destino', 'Peso (kg)', 'Valor NF', 'Frete', 'Frete/kg',
    'Custo coleta', 'Coleta/kg', 'Custo entrega', 'Entrega/kg', 'Custo transferência', 'Transf./kg', 'Resp. coleta', 'Resp. entrega', 'Resp. transferência',
    'ICMS', 'Seguro', 'Outros', 'Impostos', 'Comissão', 'Lucro líquido', 'Margem']];
  _ancBase.forEach(c => aoa.push([c.minuta, c.data, c.base, c.cliente, c.servico, c.destino, c.peso, c.nf, c.frete, ancKg(c, 'frete'),
    c.custos.coleta, ancKg(c, 'coleta'), c.custos.entrega, ancKg(c, 'entrega'), c.custos.transf, ancKg(c, 'transf'), c.resp.coleta, c.resp.entrega, c.resp.transf,
    c.icms, c.custos.seguro, ancOutrosCusto(c), c.imposto, c.comis, c.lucro, c.frete ? c.lucro / c.frete : 0]));
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(aoa), 'Analise de custo');
  window.XLSX.writeFile(wb, 'analise_custo.xlsx');
}
