/*! Motor de Frete v1.1.0 — PortoEx — gerado em 13/11/2026 07:37 por build.py (nao editar: mude src/ e rode o build) */
(function () {
'use strict';

// ===== nucleo.js =====
// nucleo.js — Motor de Frete: configuracao, banco (Supabase), permissao e utilidades.
// Primeiro arquivo do pacote; os demais usam estas funcoes/variaveis globais.

const MF = { cfg: {}, versao: '1.1.0', linhasCache: null };

// Banco: Supabase da PortoEx (tabela app_config, um documento JSON por chave).
// MotorFrete.iniciar({supabase: {url, chave}}) troca, se precisar.
let SUPABASE_URL = 'https://tgurfzpdpdxpodxewotv.supabase.co';
let SUPABASE_KEY = 'sb_publishable_9DHQudX1xPJEIRzSXGyCgA_u9qxgzWd';
let _db = null;
function getDb() {
  if (!_db && window.supabase) _db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return _db;
}

// Quem pode incluir/editar/excluir (e ver a Auditoria): e-mails de
// MotorFrete.iniciar({editores}). O e-mail do usuario vem de cfg.identidade()
// ou, por padrao, do login do Cloudflare Access (/cdn-cgi/access/get-identity).
// E uma trava de tela: a chave do Supabase fica no codigo da pagina.
let CAD_EDITORES = [];
let _cadPodeEditar = null;
let _cadEmail = '';
async function cadPodeEditar() {
  if (_cadPodeEditar !== null) return _cadPodeEditar;
  try {
    let email = '';
    if (typeof MF.cfg.identidade === 'function') {
      email = await MF.cfg.identidade();
    } else {
      const r = await fetch('/cdn-cgi/access/get-identity', { credentials: 'same-origin' });
      const id = r.ok ? await r.json() : {};
      email = id.email;
    }
    _cadEmail = String(email || '').toLowerCase();
    _cadPodeEditar = MF.cfg.todosEditam === true || CAD_EDITORES.includes(_cadEmail);
  } catch (e) {
    _cadPodeEditar = MF.cfg.todosEditam === true;
  }
  return _cadPodeEditar;
}

function cadEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MF_MESES = { '01': 'Jan', '02': 'Fev', '03': 'Mar', '04': 'Abr', '05': 'Mai', '06': 'Jun',
  '07': 'Jul', '08': 'Ago', '09': 'Set', '10': 'Out', '11': 'Nov', '12': 'Dez' };
function mfMesNome(m) {
  const [a, mm] = String(m || '').split('-');
  return MF_MESES[mm] ? `${MF_MESES[mm]}/${a}` : (m || '');
}

// Linhas da Auditoria (formato no README): cfg.auditoria.linhas (array ou
// funcao que devolve array), passando por cfg.auditoria.mapear se houver.
function mfLinhas() {
  if (MF.linhasCache) return MF.linhasCache;
  const a = MF.cfg.auditoria || {};
  let linhas = typeof a.linhas === 'function' ? a.linhas() : (a.linhas || []);
  if (typeof a.mapear === 'function') linhas = linhas.map(a.mapear);
  linhas = linhas.map(r => ({
    ...r,
    MES: r.MES || String(r['DATA EMISSAO'] || '').slice(0, 7),
    MINUTA: String(r.MINUTA ?? ''),
  }));
  MF.linhasCache = linhas;
  return linhas;
}

function mfCarregarScript(src) {
  return new Promise((ok, erro) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => erro(new Error('Não carregou ' + src));
    document.head.appendChild(s);
  });
}


// ===== frete-calculo.js =====
// frete-calculo.js — motor de calculo das tabelas de frete (Cadastro > Tabela).
//
// Nao depende de tela: e usado pelo Simulador e vai ser usado pela
// auditoria Excel x tabela. Pode ser copiado para outros projetos junto
// com o formato das tabelas (ver topo do cadastro-tabela.js).

// Itens da composicao: [chave gravada, rotulo, tipo de regra].
// Nao renomear chaves ja gravadas (so o rotulo pode mudar).
// Tipos:
//   PCT_NF     % sobre o valor da mercadoria (NF)          regra: {pct}
//   PCT_CTE    % sobre o valor do CT-e                      regra: {pct}
//   FIXO       valor fixo, somado se informado             regra: {valor}
//   FRACAO     arred. p/ cima(peso / fracao) x valor       regra: {fracaoKg, valor, franquia, valorFranquia}
//   FAIXA_PESO valor da faixa (+ excedente por kg)         regra: {faixas:[{de,ate,valorFranquia,franquia,valor}]}
//              valorFranquia = VALOR DA FAIXA (R$ fixo); valor = R$/kg EXCEDENTE; franquia = kg a partir do qual
//              cobra excedente. Sem excedente: frete = valor da faixa. Com excedente: frete = valor da faixa +
//              (peso - franquia) x R$/kg. Franquia vazia = 'ate' da faixa anterior (ou 'de' da propria);
//              valor da faixa vazio com excedente = valor da faixa anterior ("pega o valor ate a faixa").
//   FAIXA_M3   m3 x valor da faixa de m3                   regra: {faixas:[{de,ate,valor}]}
//   null       regra ainda nao definida (nao entra no calculo)
// Franquia (so onde a base e kg): ate `franquia` kg cobra `valorFranquia`;
//   acima, valorFranquia + excedente (peso - franquia) cobrado pela regra
//   (FAIXA_PESO: excedente x R$/kg da faixa; FRACAO: arred. p/ cima(excedente / fracao) x valor).
//   Ex.: faixa 0 a 3000, franquia 10 kg = R$ 200, excedente R$ 0,50/kg:
//   100 kg -> 200 + (100 - 10) x 0,50 = R$ 245.
// Todos aceitam {minimo}: o item nunca fica abaixo do preco minimo.
// Peso usado em tudo que e por kg = PESO CONSIDERADO = maior entre o peso real e
// o peso cubado (m3 x tabela.fatorCubagem, em kg/m3). Sem fator, vale o peso real.
const TAB_COMPOSICAO = [
  ['FRETE_COLETA', 'Frete Coleta', 'FAIXA_PESO'],
  ['FRETE_ENTREGA', 'Frete Entrega', 'FAIXA_PESO'],
  ['PERCENTUAL_NF', 'Percentual sobre NF', 'PCT_NF'],
  ['ADVALOREM', 'Advalorem', 'PCT_NF'],
  ['GRIS', 'GRIS', 'PCT_NF'],
  ['DESPACHO', 'Despacho', 'FIXO'],
  ['PEDAGIO', 'Pedágio', 'FRACAO'],
  ['PERCENTUAL_CTE', 'Percentual sobre CT-e', 'PCT_CTE'],
  ['PEDAGIO_FRACAO', 'Pedágio por Fração', 'FRACAO'],
  ['TAXA_TRT', 'Taxa TRT', 'FIXO'],
  ['TAXA_TAS', 'Taxa TAS', 'FIXO'],
  ['TAXA_TDE', 'Taxa TDE', 'FIXO'],
  ['TAXA_SET_CAT', 'Taxa SET/CAT', 'FIXO'],
  ['TAXA_M3', 'Taxa por m³', 'FAIXA_M3'],
];
const TAB_ROTULO = Object.fromEntries(TAB_COMPOSICAO.map(([k, r]) => [k, r]));
const TAB_TIPO = Object.fromEntries(TAB_COMPOSICAO.map(([k, , t]) => [k, t]));

const FRETE_UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB',
  'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];

// Texto para comparacao: maiusculo, sem acento, espacos simples.
function freteNorm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim().replace(/\s+/g, ' ');
}

// Numero digitado no padrao brasileiro ("1.234,56" ou "1,5") -> Number; vazio -> null.
function freteNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/\s/g, '').replace(/^R\$/i, '');
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function freteFmt(n, dec = 2) {
  return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function freteFmtNum(n) {
  return Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 6 });
}

// ---------- TRECHO ----------

// Trechos cadastrados (Cadastro > Trecho): grupos de cidades com nome, que
// podem ser origem/destino de um trecho de tabela (origemGrupoId/destinoGrupoId).
// Quem usa o motor carrega a lista e chama freteDefinirGrupos(lista).
let _freteGrupos = {};
let _freteGruposLista = [];
function freteDefinirGrupos(lista) {
  _freteGruposLista = lista || [];
  _freteGrupos = Object.fromEntries(_freteGruposLista.map(g => [g.id, g]));
}

// Um lado do trecho (origem ou destino) casa com o lugar? -1 = nao;
// 0 = estado todo, 1 = trecho cadastrado (grupo), 2 = cidade.
function freteLadoPontos(tr, lado, lugar) {
  const gid = tr[lado + 'GrupoId'];
  // Lugar informado como trecho cadastrado (Simulador: "trecho de inicio/fim"):
  // casa com o mesmo trecho cadastrado, ou com "estado todo" se todas as
  // cidades do trecho forem dessa UF; nunca com uma cidade especifica.
  if (lugar.grupoId) {
    if (gid) return gid === lugar.grupoId ? 1 : -1;
    if (tr[lado + 'Cidade']) return -1;
    return freteGrupoUf(lugar.grupoId) === freteNorm(tr[lado + 'Uf']) ? 0 : -1;
  }
  if (gid) {
    const g = _freteGrupos[gid];
    if (!g) return -1;
    const ok = g.cidades.some(c => c.uf === freteNorm(lugar.uf) && freteNorm(c.nome) === freteNorm(lugar.cidade));
    return ok ? 1 : -1;
  }
  if (freteNorm(tr[lado + 'Uf']) !== freteNorm(lugar.uf)) return -1;
  const cid = tr[lado + 'Cidade'];
  if (!cid) return 0;
  return freteNorm(cid) === freteNorm(lugar.cidade) ? 2 : -1;
}

// Pontua o quanto um trecho casa com origem/destino: -1 = nao casa.
// Mais especifico vence: cidade > trecho cadastrado > estado todo; o destino
// pesa mais que a origem.
function freteTrechoPontos(tr, origem, destino) {
  const o = freteLadoPontos(tr, 'origem', origem);
  if (o < 0) return -1;
  const d = freteLadoPontos(tr, 'destino', destino);
  if (d < 0) return -1;
  return o + d * 4;
}

// UF de um trecho cadastrado quando todas as cidades sao do mesmo estado ('' se misturado).
function freteGrupoUf(grupoId) {
  const g = _freteGrupos[grupoId];
  const ufs = g ? [...new Set(g.cidades.map(c => c.uf))] : [];
  return ufs.length === 1 ? ufs[0] : '';
}

// Texto de um lado do trecho: "Itajaí/SC", "SP (estado todo)" ou "Trecho SC_Capital".
function freteLadoTxt(tr, lado) {
  const gid = tr[lado + 'GrupoId'];
  if (gid) return `Trecho ${(_freteGrupos[gid] || {}).nome || tr[lado + 'GrupoNome'] || '?'}`;
  const cid = tr[lado + 'Cidade'];
  return cid ? `${cid}/${tr[lado + 'Uf']}` : `${tr[lado + 'Uf']} (estado todo)`;
}

function freteTrechoTxt(tr) {
  return `${freteLadoTxt(tr, 'origem')} → ${freteLadoTxt(tr, 'destino')}`;
}

function freteMelhorTrecho(tabela, origem, destino) {
  let melhor = null;
  for (const tr of tabela.trechos || []) {
    const p = freteTrechoPontos(tr, origem, destino);
    if (p >= 0 && (!melhor || p > melhor.pontos)) melhor = { trecho: tr, pontos: p };
  }
  return melhor;
}

// Vigencia: `vigencia` e a data FINAL (tabela "valida ate"); `vigenciaInicio`
// e opcional (vazia = vale desde sempre ate a data final).
function freteVigente(t, data) {
  if (!data) return true;
  if (t.vigencia && data > t.vigencia) return false;
  if (t.vigenciaInicio && data < t.vigenciaInicio) return false;
  return true;
}

function freteVigTxt(t) {
  const f = iso => iso ? iso.split('-').reverse().join('/') : '';
  return t.vigenciaInicio ? `${f(t.vigenciaInicio)} a ${f(t.vigencia)}` : `válida até ${f(t.vigencia)}`;
}

// Escolhe a tabela para um frete: mesmo servico, vigente na data (data <=
// valida ate, e >= inicio se houver) e com trecho que case com origem/destino.
// Entre as candidatas: a de inicio mais recente (sem inicio = mais antiga);
// empate -> trecho mais especifico (com cidade); empate -> a que termina antes.
// Retorna {tabela, trecho, pontos} ou null.
function freteAcharTabela(tabelas, { servicoId, data, origem, destino }) {
  let melhor = null;
  for (const t of tabelas) {
    if (servicoId && t.servicoId !== servicoId) continue;
    if (!freteVigente(t, data)) continue;
    const m = freteMelhorTrecho(t, origem, destino);
    if (!m) continue;
    const ini = t.vigenciaInicio || '', iniM = melhor ? (melhor.tabela.vigenciaInicio || '') : '';
    if (!melhor || ini > iniM ||
        (ini === iniM && (m.pontos > melhor.pontos ||
          (m.pontos === melhor.pontos && (t.vigencia || '9999') < (melhor.tabela.vigencia || '9999'))))) {
      melhor = { tabela: t, ...m };
    }
  }
  return melhor;
}

// ---------- CALCULO ----------

function freteFaixa(faixas, x) {
  return (faixas || []).find(f => x >= (f.de ?? 0) && (f.ate === null || f.ate === undefined || x <= f.ate)) || null;
}

// As regras (valores) sao de cada TRECHO: trecho.regras = {GRIS: {...}, ...};
// a tabela so diz quais itens entram (composicao) e as opcoes gerais.
// entrada: {peso (kg, peso REAL), m3, valorNF, valorCte (opcional), ufOrigem, ufDestino}
// aliquotasIcms: {'SC-SP': 12, ...} (Cadastro > ICMS) — usado se a tabela
//   tiver "Soma ICMS ao frete" = SIM: total = subtotal / (1 - aliquota/100).
// Retorna {itens:[{item, rotulo, valor, conta, obs:[]}], subtotal,
//   icms: null | {aliquota, valor, conta}, total, avisos:[],
//   pesos: {real, m3, fator, cubado, considerado}}
function freteCalcular(tabela, trecho, entrada, aliquotasIcms) {
  const regras = (trecho && trecho.regras) || {};
  const dec = Number.isInteger(tabela.precisao) ? tabela.precisao : 2;
  const arred = v => Math.round(v * 10 ** dec) / 10 ** dec;
  const pesoReal = +entrada.peso || 0;
  const m3 = +entrada.m3 || 0;
  const fator = +tabela.fatorCubagem || 0;
  const pesoCubado = fator > 0 ? Math.round(m3 * fator * 1000) / 1000 : 0;
  const peso = Math.max(pesoReal, pesoCubado);   // peso considerado
  const nf = +entrada.valorNF || 0;
  const temCte = entrada.valorCte !== null && entrada.valorCte !== undefined && entrada.valorCte !== '';

  const comp = (tabela.composicao || []).filter(k => k in TAB_ROTULO);
  // % sobre CT-e por ultimo: sem valor de CT-e informado, a base e a soma dos demais itens.
  const ordem = comp.filter(k => TAB_TIPO[k] !== 'PCT_CTE').concat(comp.filter(k => TAB_TIPO[k] === 'PCT_CTE'));

  const itens = [];
  const avisos = [];
  let subtotal = 0;

  for (const k of ordem) {
    const r = regras[k] || {};
    const tipo = TAB_TIPO[k];
    const rotulo = TAB_ROTULO[k];
    const obs = [];
    let valor = 0;
    let conta = '';

    if (!tipo) {
      itens.push({ item: k, rotulo, valor: 0, conta: 'Regra a definir — não calculado', obs });
      avisos.push(`${rotulo}: regra ainda não definida, ficou fora do total.`);
      continue;
    }

    switch (tipo) {
      case 'PCT_NF': {
        const pct = r.pct || 0;
        valor = nf * pct / 100;
        conta = `R$ ${freteFmt(nf)} (NF) × ${freteFmtNum(pct)}%`;
        break;
      }
      case 'PCT_CTE': {
        const pct = r.pct || 0;
        const base = temCte ? +entrada.valorCte : subtotal;
        valor = base * pct / 100;
        conta = `R$ ${freteFmt(base)} (${temCte ? 'CT-e informado' : 'soma dos demais itens'}) × ${freteFmtNum(pct)}%`;
        break;
      }
      case 'FIXO': {
        valor = r.valor || 0;
        conta = r.valor ? 'valor fixo' : 'não informado';
        break;
      }
      case 'FRACAO': {
        if (!r.fracaoKg) {
          conta = 'fração (kg) não informada';
          avisos.push(`${rotulo}: informe a fração em kg na tabela.`);
          break;
        }
        if (r.franquia > 0) {
          if (peso <= r.franquia) {
            valor = r.valorFranquia || 0;
            conta = `${freteFmtNum(peso)} kg dentro da franquia (até ${freteFmtNum(r.franquia)} kg) = R$ ${freteFmt(r.valorFranquia)}`;
          } else {
            const exc = peso - r.franquia;
            const qtd = Math.ceil(exc / r.fracaoKg);
            valor = (r.valorFranquia || 0) + qtd * (r.valor || 0);
            conta = `franquia ${freteFmtNum(r.franquia)} kg = R$ ${freteFmt(r.valorFranquia)} + excedente ${freteFmtNum(exc)} kg ÷ ${freteFmtNum(r.fracaoKg)} kg = ${qtd} fração(ões) × R$ ${freteFmt(r.valor)}`;
          }
          break;
        }
        const qtd = Math.ceil(peso / r.fracaoKg);
        valor = qtd * (r.valor || 0);
        conta = `${freteFmtNum(peso)} kg ÷ ${freteFmtNum(r.fracaoKg)} kg = ${qtd} fração(ões) × R$ ${freteFmt(r.valor)}`;
        break;
      }
      case 'FAIXA_PESO':
      case 'FAIXA_M3': {
        const porPeso = tipo === 'FAIXA_PESO';
        const x = porPeso ? peso : m3;
        const un = porPeso ? 'kg' : 'm³';
        const f = freteFaixa(r.faixas, x);
        if (!f) {
          conta = `${freteFmtNum(x)} ${un} fora das faixas cadastradas`;
          avisos.push(`${rotulo}: ${freteFmtNum(x)} ${un} não cai em nenhuma faixa da tabela.`);
          break;
        }
        const ate = f.ate === null || f.ate === undefined ? 'acima' : freteFmtNum(f.ate);
        const nomeFaixa = `faixa ${freteFmtNum(f.de ?? 0)} a ${ate} ${un}`;
        if (porPeso) {
          const lista = r.faixas || [];
          const ant = lista[lista.indexOf(f) - 1] || null;
          const vazio = v => v === null || v === undefined || v === '';
          const excKg = +f.valor || 0;                     // R$/kg excedente
          let fixo = f.valorFranquia;                       // valor da faixa
          if (vazio(fixo) && excKg > 0 && ant) fixo = ant.valorFranquia;
          fixo = +fixo || 0;
          if (excKg > 0) {
            const franq = !vazio(f.franquia) ? +f.franquia : (ant && !vazio(ant.ate) ? +ant.ate : +(f.de || 0));
            const exc = Math.max(0, x - franq);
            valor = fixo + exc * excKg;
            conta = `R$ ${freteFmt(fixo)} (até ${freteFmtNum(franq)} kg) + excedente ${freteFmtNum(exc)} kg × R$ ${freteFmt(excKg)} (${nomeFaixa})`;
          } else {
            valor = fixo;
            conta = `${freteFmtNum(x)} kg na ${nomeFaixa} = R$ ${freteFmt(fixo)}`;
          }
          break;
        }
        valor = x * (f.valor || 0);
        conta = `${freteFmtNum(x)} ${un} × R$ ${freteFmt(f.valor)} (${nomeFaixa})`;
        break;
      }
    }

    if (r.minimo > 0 && valor < r.minimo) {
      valor = r.minimo;
      obs.push(`abaixo do mínimo → R$ ${freteFmt(r.minimo)}`);
    }

    valor = arred(valor);
    subtotal += valor;
    itens.push({ item: k, rotulo, valor, conta, obs });
  }

  subtotal = arred(subtotal);
  let icms = null;
  let total = subtotal;
  if (tabela.somaIcms) {
    const chave = `${freteNorm(entrada.ufOrigem)}-${freteNorm(entrada.ufDestino)}`;
    const aliq = (aliquotasIcms || {})[chave];
    if (aliq === undefined || aliq === null) {
      avisos.push(`ICMS: sem alíquota cadastrada para ${chave} (Cadastro > ICMS) — total sem ICMS.`);
    } else {
      total = arred(subtotal / (1 - aliq / 100));
      icms = {
        aliquota: aliq,
        valor: arred(total - subtotal),
        conta: `R$ ${freteFmt(subtotal, dec)} ÷ (1 − ${freteFmtNum(aliq)}%) = R$ ${freteFmt(total, dec)} (${chave})`,
      };
    }
  }

  return { itens, subtotal, icms, total, avisos,
    pesos: { real: pesoReal, m3, fator, cubado: pesoCubado, considerado: peso } };
}


// ===== cadastro-servico.js =====
// cadastro-servico.js — Cadastro > Servico: lista de servicos do projeto (ex.: SUBCONTRATO_ECONOMICO).
// Supabase app_config, chave CAD_SERVICOS_KEY (por projeto; MotorFrete.iniciar define).
// Formato: [{ id, nome, criadoEm }]

let CAD_SERVICOS_KEY = 'servicos';
let _servicos = [];

async function lerServicos() {
  const db = getDb();
  if (!db) throw new Error('Supabase indisponível');
  const { data, error } = await db.from('app_config').select('value').eq('key', CAD_SERVICOS_KEY).maybeSingle();
  if (error) throw error;
  return Array.isArray(data && data.value) ? data.value : [];
}

async function gravarServicos(lista) {
  const { error } = await getDb().from('app_config')
    .upsert({ key: CAD_SERVICOS_KEY, value: lista, updated_at: new Date().toISOString() });
  if (error) throw error;
}

function cadMsg(txt, erro) {
  const el = document.getElementById('cad-servico-msg');
  el.textContent = txt;
  el.style.color = erro ? '#b91c1c' : '#64748b';
}

async function carregarServicos() {
  cadMsg('Carregando...');
  try {
    const podeEditar = await cadPodeEditar();
    document.getElementById('cad-servico-form').style.display = podeEditar ? 'flex' : 'none';
    _servicos = await lerServicos();
    renderServicos();
    cadMsg(_servicos.length ? '' : 'Nenhum serviço cadastrado ainda.');
  } catch (e) {
    console.error(e);
    cadMsg('Não foi possível carregar os serviços (verifique a conexão).', true);
  }
}

function renderServicos() {
  const tb = document.getElementById('tb-cad-servico');
  tb.innerHTML = _servicos.map(s => `<tr>
      <td>${cadEsc(s.nome)}</td>
      <td>${cadEsc(s.criadoEm || '')}</td>
      <td style="text-align:right">${_cadPodeEditar ? `<button class="cad-del" type="button" onclick="excluirServico('${s.id}')">Excluir</button>` : ''}</td>
    </tr>`).join('');
}

async function salvarServico() {
  const input = document.getElementById('cad-servico-input');
  const btn = document.getElementById('cad-servico-btn');
  const nome = input.value.trim();
  if (!(await cadPodeEditar())) { cadMsg('Somente leitura.', true); return; }
  if (!nome) { cadMsg('Digite o serviço antes de salvar.', true); input.focus(); return; }
  btn.disabled = true;
  cadMsg('Salvando...');
  try {
    // Relê antes de gravar, para nao apagar o que outra pessoa salvou nesse meio tempo.
    const lista = await lerServicos();
    if (lista.some(s => s.nome.toUpperCase() === nome.toUpperCase())) {
      _servicos = lista; renderServicos();
      cadMsg(`"${nome}" já está cadastrado.`, true);
      return;
    }
    lista.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      nome,
      criadoEm: new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
    });
    await gravarServicos(lista);
    _servicos = lista;
    renderServicos();
    input.value = '';
    cadMsg(`"${nome}" salvo.`);
  } catch (e) {
    console.error(e);
    cadMsg('Não foi possível salvar (verifique a conexão).', true);
  } finally {
    btn.disabled = false;
  }
}

async function excluirServico(id) {
  const alvo = _servicos.find(s => s.id === id);
  if (!(await cadPodeEditar())) return;
  if (!alvo || !confirm(`Excluir o serviço "${alvo.nome}"?`)) return;
  cadMsg('Excluindo...');
  try {
    const lista = (await lerServicos()).filter(s => s.id !== id);
    await gravarServicos(lista);
    _servicos = lista;
    renderServicos();
    cadMsg(`"${alvo.nome}" excluído.`);
  } catch (e) {
    console.error(e);
    cadMsg('Não foi possível excluir (verifique a conexão).', true);
  }
}


// ===== cadastro-tabela.js =====
// cadastro-tabela.js — Cadastro > Tabela (tabelas de frete) + trechos.
//
// Script classico carregado depois do script principal do index.html e do
// frete-calculo.js: usa getDb(), cadPodeEditar(), cadEsc(), lerServicos()
// e as constantes/funcoes TAB_* / frete* de la.
//
// As tabelas ficam no Supabase da PortoEx (tabela app_config, chave
// CAD_TABELAS_KEY) com uma chave generica de proposito: a ideia e outros
// projetos lerem as mesmas tabelas. Formato:
//   [{ id, nome, referencia, servicoId, servicoNome,
//      tipo: 'VENDA'|'COMPRA', vigencia: 'AAAA-MM-DD' (data FINAL, "valida ate"),
//      vigenciaInicio: 'AAAA-MM-DD' | '' (opcional; vazio = vale desde sempre), precisao (2..5),
//      fatorCubagem (kg por m3; peso cubado = m3 x fator; peso considerado = maior entre real e cubado),
//      somaIcms, descontoIcmsFretePeso, negociaTarifa (booleans),
//      composicao: ['GRIS', ...],             // itens que a tabela usa (TAB_COMPOSICAO)
//      trechos: [{ id, origemUf, origemCidade, destinoUf, destinoCidade,  // cidade '' = estado todo
//                  origemGrupoId, destinoGrupoId (+ ...GrupoNome) — trecho cadastrado (grupo de cidades) no lugar de UF/cidade,
//                  regras: { GRIS: {pct, minimo},
//                            FRETE_COLETA: {faixas:[{de,ate,franquia,valorFranquia,valor}], minimo}, ... } }],
//      criadoEm, atualizadoEm (ISO) }, ...]
// As regras (valores) sao sempre de cada trecho (origem -> destino); a
// tabela so diz quais itens entram. Regra de cada tipo: topo do frete-calculo.js.

let CAD_TABELAS_KEY = 'cadastro_tabelas';   // por projeto: MotorFrete.iniciar define

// Opcoes SIM/NAO do cabecalho: [campo, rotulo, padrao]
const TAB_SIMNAO = [
  ['somaIcms', 'Soma imposto (ICMS) ao frete', false],
  ['descontoIcmsFretePeso', 'Aplica desconto de ICMS sobre Frete Peso', false],
  ['negociaTarifa', 'Negocia tarifa', false],
];

let _tabelas = [];
let _tabEditando = null;   // id da tabela aberta (null = nova)
let _trEditando = null;    // id do trecho aberto (null = novo)
let _tabRegras = {};       // regras do trecho em edicao (copia de trabalho)
let _tabComp = [];         // composicao usada para desenhar os blocos de regra
let _tabServicos = [];

function novoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function lerTabelas() {
  const db = getDb();
  if (!db) throw new Error('Supabase indisponível');
  const { data, error } = await db.from('app_config').select('value').eq('key', CAD_TABELAS_KEY).maybeSingle();
  if (error) throw error;
  return Array.isArray(data && data.value) ? data.value : [];
}

async function gravarTabelas(lista) {
  const { error } = await getDb().from('app_config')
    .upsert({ key: CAD_TABELAS_KEY, value: lista, updated_at: new Date().toISOString() });
  if (error) throw error;
}

function tabMsg(txt, erro) {
  const el = document.getElementById('cad-tabela-msg');
  el.textContent = txt;
  el.style.color = erro ? '#b91c1c' : '#64748b';
}

function tabFmtData(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

// Numero -> texto para campo (virgula decimal); null -> vazio.
function tabInp(n) {
  return n === null || n === undefined ? '' : String(n).replace('.', ',');
}

function tabVista(qual) {
  document.getElementById('cad-tabela-lista').style.display = qual === 'lista' ? '' : 'none';
  document.getElementById('cad-tabela-form').style.display = qual === 'form' ? '' : 'none';
  document.getElementById('cad-tabela-trechos').style.display = qual === 'trechos' ? '' : 'none';
  window.scrollTo(0, 0);
}

function tabLugar(uf, cid) {
  return cid ? `${cadEsc(cid)}/${uf}` : `<i>${uf} — estado todo</i>`;
}

// ---------- LISTA DE TABELAS ----------

async function carregarTabelas() {
  tabVista('lista');
  tabMsg('Carregando...');
  try {
    const podeEditar = await cadPodeEditar();
    document.getElementById('cad-tabela-nova').style.display = podeEditar ? '' : 'none';
    _tabelas = await lerTabelas();
    renderTabelas();
    tabMsg(_tabelas.length ? '' : 'Nenhuma tabela cadastrada ainda.');
  } catch (e) {
    console.error(e);
    tabMsg('Não foi possível carregar as tabelas (verifique a conexão).', true);
  }
}

// Situacao de uma versao de tabela na data de hoje.
function tabSituacao(t) {
  const hoje = new Date().toISOString().slice(0, 10);
  if (t.vigencia && t.vigencia < hoje) return ['Encerrada', '#64748b', '#f1f5f9'];
  if (t.vigenciaInicio && t.vigenciaInicio > hoje) return ['Futura', '#1d4ed8', '#dbeafe'];
  return ['Vigente', '#15803d', '#dcfce7'];
}

function renderTabelas() {
  // versoes da mesma tabela (mesmo nome e servico) ficam juntas, da mais nova para a mais antiga
  const lista = [..._tabelas].sort((a, b) => a.nome.localeCompare(b.nome) || (a.servicoNome || '').localeCompare(b.servicoNome || '') ||
    (b.vigenciaInicio || '').localeCompare(a.vigenciaInicio || '') || (b.vigencia || '').localeCompare(a.vigencia || ''));
  document.getElementById('tb-cad-tabela').innerHTML = lista.map(t => {
    const [sit, cor, fundo] = tabSituacao(t);
    return `
    <tr style="cursor:pointer" onclick="abrirTabela('${t.id}')" title="Abrir tabela">
      <td><b>${cadEsc(t.nome)}</b>${t.referencia ? ` <span style="color:#64748b;font-size:.75rem">(${cadEsc(t.referencia)})</span>` : ''}</td>
      <td>${cadEsc(t.servicoNome || '—')}</td>
      <td style="font-size:.8rem">${freteVigTxt(t)}</td>
      <td><span class="aud-st" style="background:${fundo};color:${cor}">${sit}</span></td>
      <td>${t.tipo === 'COMPRA' ? 'Compra' : 'Venda'}</td>
      <td style="color:#64748b;font-size:.78rem">${(t.trechos || []).length} trecho(s)</td>
    </tr>`;
  }).join('');
}

// ---------- FORMULARIO DA TABELA (cabecalho + composicao) ----------

function novaTabela() {
  return abrirTabela(null);
}

async function abrirTabela(id) {
  const podeEditar = await cadPodeEditar();
  const t = id ? _tabelas.find(x => x.id === id) : null;
  if (!t && !podeEditar) return;
  _tabEditando = t ? t.id : null;
  try { _tabServicos = await lerServicos(); } catch (e) { _tabServicos = []; }

  const f = document.getElementById('cad-tabela-form');
  tabVista('form');

  const v = t || {
    nome: '', referencia: '', servicoId: '', tipo: 'VENDA', vigencia: '', precisao: 2, composicao: [],
    ...Object.fromEntries(TAB_SIMNAO.map(([k, , pad]) => [k, pad])),
  };
  const simNao = (campo, valor) => `
    <select id="tf-${campo}">
      <option value="1"${valor ? ' selected' : ''}>SIM</option>
      <option value="0"${valor ? '' : ' selected'}>NÃO</option>
    </select>`;
  const servicoSumiu = v.servicoId && !_tabServicos.some(s => s.id === v.servicoId);

  f.innerHTML = `
    <h3 style="margin-bottom:14px">${t ? 'Tabela — ' + cadEsc(t.nome) : 'Cadastrar nova tabela'}</h3>
    <div class="tf-grid">
      <div class="tf-col">
        <label class="tf-lbl">Nome *</label>
        <input id="tf-nome" type="text" maxlength="120" value="${cadEsc(v.nome)}">
        <label class="tf-lbl">Referência</label>
        <input id="tf-referencia" type="text" maxlength="120" value="${cadEsc(v.referencia || '')}">
        <label class="tf-lbl">Serviço *</label>
        <select id="tf-servico" style="width:100%;margin-bottom:10px">
          <option value="">— selecione —</option>
          ${_tabServicos.map(s => `<option value="${s.id}"${s.id === v.servicoId ? ' selected' : ''}>${cadEsc(s.nome)}</option>`).join('')}
          ${servicoSumiu ? `<option value="${v.servicoId}" selected>${cadEsc(v.servicoNome || '?')} (excluído)</option>` : ''}
        </select>
        ${_tabServicos.length ? '' : '<div style="font-size:.74rem;color:#b91c1c;margin:-6px 0 10px">Nenhum serviço cadastrado — cadastre em Cadastro ▾ > Serviço.</div>'}
        <div class="tf-linha">
          <div><label class="tf-lbl">Tipo de tabela</label>
            <select id="tf-tipo">
              <option value="VENDA"${v.tipo !== 'COMPRA' ? ' selected' : ''}>Venda</option>
              <option value="COMPRA"${v.tipo === 'COMPRA' ? ' selected' : ''}>Compra</option>
            </select></div>
          <div><label class="tf-lbl">Início (opcional)</label>
            <input id="tf-vig-inicio" type="date" value="${v.vigenciaInicio || ''}"></div>
          <div><label class="tf-lbl">Válida até *</label>
            <input id="tf-vigencia" type="date" value="${v.vigencia || ''}"></div>
          <div><label class="tf-lbl">Cubagem (kg/m³)</label>
            <input id="tf-cubagem" type="text" inputmode="decimal" style="width:90px" value="${tabInp(v.fatorCubagem)}" placeholder="ex.: 300"></div>
          <div><label class="tf-lbl">Precisão</label>
            <select id="tf-precisao">
              ${[2, 3, 4, 5].map(n => `<option value="${n}"${+v.precisao === n ? ' selected' : ''}>${n} decimais</option>`).join('')}
            </select></div>
        </div>
        <div class="tf-dica" style="margin:-4px 0 8px">Peso cubado = cubagem (m³) × este fator. No cálculo vale o <b>peso considerado</b>: o maior entre o peso real e o peso cubado.</div>
        ${TAB_SIMNAO.map(([k, rot]) => `
          <div class="tf-simnao"><span>${rot}</span>${simNao(k, v[k])}</div>`).join('')}
      </div>
      <div class="tf-col">
        <label class="tf-lbl">Composição da tabela <span style="font-weight:400;color:#64748b">(marque os itens que a tabela usa)</span></label>
        <div class="tf-comp">
          ${TAB_COMPOSICAO.map(([k, rot]) => `
            <label><input type="checkbox" value="${k}"${(v.composicao || []).includes(k) ? ' checked' : ''}> ${rot}</label>`).join('')}
        </div>
        <div class="tf-dica" style="margin-top:10px">Os valores de cada item (%, faixas, franquia, mínimo...) são preenchidos em cada trecho (origem → destino).</div>
      </div>
    </div>
    <div id="tf-msg" style="font-size:.78rem;margin:10px 0 0;min-height:1em"></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button id="tf-salvar" class="cad-btn" type="button" onclick="salvarTabela()">💾 Salvar e ir para os trechos</button>
      ${t ? `<button class="cad-btn" type="button" style="background:var(--primary-light)" onclick="abrirTrechos('${t.id}')">Trechos (${(t.trechos || []).length})</button>` : ''}
      ${t ? `<button class="cad-btn tf-so-editor" type="button" style="background:#7c3aed" onclick="tabAbrirVersao()">🔁 Nova versão (reajuste)</button>` : ''}
      <button class="cad-btn" type="button" style="background:#64748b" onclick="carregarTabelas()">Voltar</button>
      ${t ? '<button class="cad-del" type="button" style="margin-left:auto" onclick="excluirTabela()">Excluir tabela</button>' : ''}
    </div>
    <div id="tf-versao" class="tf-versao" hidden>
      <div class="tf-lbl">Nova versão desta tabela</div>
      <div style="font-size:.76rem;color:#475569;margin-bottom:8px">Copia todos os trechos e regras para uma nova versão com outro período e, se informado, aplica o reajuste nos valores em R$ (faixas, excedente, valores fixos, fração e mínimos; percentuais como GRIS e Advalorem não mudam). A versão atual é ajustada para não sobrepor: termina na véspera da nova (ou começa no dia seguinte, se a nova for anterior).</div>
      <div class="tf-linha">
        <div><label class="tf-lbl">Início da nova versão</label><input id="tv-inicio" type="date"></div>
        <div><label class="tf-lbl">Válida até *</label><input id="tv-ate" type="date"></div>
        <div><label class="tf-lbl">Reajuste (%)</label><input id="tv-pct" type="text" inputmode="decimal" placeholder="ex.: 4,5 ou -4,22" style="width:120px"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="cad-btn" type="button" style="background:#7c3aed" onclick="tabCriarVersao()">Criar versão</button>
        <button class="cad-btn" type="button" style="background:#64748b" onclick="document.getElementById('tf-versao').hidden = true">Cancelar</button>
      </div>
      <div id="tv-msg" style="font-size:.78rem;margin-top:8px;min-height:1em"></div>
    </div>`;

  if (!podeEditar) {
    f.querySelectorAll('input,select').forEach(el => { el.disabled = true; });
    f.querySelectorAll('#tf-salvar,.cad-del,.tf-so-editor').forEach(el => el.remove());
  }
}

// ---------- VERSOES (reajuste) ----------

function tabDiaMais(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function tabAbrirVersao() {
  const t = _tabelas.find(x => x.id === _tabEditando);
  if (!t) return;
  const box = document.getElementById('tf-versao');
  box.hidden = false;
  // sugestao: a nova versao comeca no dia seguinte ao fim da atual e vale 1 ano
  if (!document.getElementById('tv-inicio').value && t.vigencia) {
    const ini = tabDiaMais(t.vigencia, 1);
    document.getElementById('tv-inicio').value = ini;
    document.getElementById('tv-ate').value = tabDiaMais(tabDiaMais(ini, 365), -1);
  }
  box.scrollIntoView({ block: 'nearest' });
}

// Aplica o reajuste (fator) nos valores em R$ das regras de um trecho.
function tabReajustarRegras(regras, fator) {
  const r2 = v => (v === null || v === undefined || v === '') ? v : Math.round(v * fator * 100) / 100;
  const out = JSON.parse(JSON.stringify(regras || {}));
  for (const [k, r] of Object.entries(out)) {
    const tipo = TAB_TIPO[k];
    if (tipo === 'PCT_NF' || tipo === 'PCT_CTE') { r.minimo = r2(r.minimo); continue; }
    ['valor', 'valorFranquia', 'minimo'].forEach(c => { if (c in r) r[c] = r2(r[c]); });
    (r.faixas || []).forEach(f => { f.valor = r2(f.valor); f.valorFranquia = r2(f.valorFranquia); });
  }
  return out;
}

function tvMsg(txt, erro) {
  const el = document.getElementById('tv-msg');
  el.textContent = txt;
  el.style.color = erro ? '#b91c1c' : '#16a34a';
}

async function tabCriarVersao() {
  if (!(await cadPodeEditar())) return;
  const ini = document.getElementById('tv-inicio').value;
  const ate = document.getElementById('tv-ate').value;
  const pctTxt = document.getElementById('tv-pct').value.trim();
  const pct = pctTxt ? freteNum(pctTxt.replace('%', '')) : 0;
  if (!ate) { tvMsg('Informe até quando a nova versão vale.', true); return; }
  if (ini && ini > ate) { tvMsg('O início não pode ser depois da data "válida até".', true); return; }
  if (pct === null) { tvMsg('Reajuste inválido. Use por exemplo 4,5 ou -4,22.', true); return; }
  try {
    const lista = await lerTabelas();
    const orig = lista.find(x => x.id === _tabEditando);
    if (!orig) { tvMsg('Tabela não encontrada.', true); return; }
    const origIni = orig.vigenciaInicio || '';
    const origFim = orig.vigencia || '';
    // Nova versao DEPOIS da atual: a atual termina na vespera do inicio da nova.
    // Nova versao ANTES da atual: a atual passa a comecar no dia seguinte ao fim da nova.
    let ajuste;
    if (!origFim || ate > origFim) {
      // Nova versao DEPOIS da atual: a atual termina na vespera do inicio da nova.
      if (!ini) { tvMsg('Informe o início da nova versão — a versão atual vai terminar na véspera.', true); return; }
      if (origIni && ini <= origIni) { tvMsg('O início da nova versão tem que ser depois do início da atual (' + tabFmtData(origIni) + ').', true); return; }
      ajuste = (origFim && ini > tabDiaMais(origFim, 1)) ? null : { vigencia: tabDiaMais(ini, -1) };
    } else if (ate < origFim) {
      // Nova versao ANTES da atual: a atual passa a comecar no dia seguinte ao fim da nova.
      if (origIni && ini && ini >= origIni) { tvMsg('Uma versão anterior tem que começar antes da atual (' + tabFmtData(origIni) + ').', true); return; }
      ajuste = (origIni && ate < origIni) ? null : { vigenciaInicio: tabDiaMais(ate, 1) };
    } else {
      tvMsg('A nova versão não pode terminar no mesmo dia da atual (' + tabFmtData(origFim) + ').', true); return;
    }
    if (lista.some(x => x.id !== orig.id && x.nome.toUpperCase() === orig.nome.toUpperCase() && x.vigencia === ate)) {
      tvMsg('Já existe uma versão desta tabela com essa data "válida até".', true); return;
    }
    const agora = new Date().toISOString();
    const fator = 1 + (pct || 0) / 100;
    const nova = {
      ...JSON.parse(JSON.stringify(orig)),
      id: novoId(),
      vigenciaInicio: ini || '',
      vigencia: ate,
      reajustePct: pct || 0,
      versaoDe: orig.id,
      trechos: (orig.trechos || []).map(tr => ({ ...tr, id: novoId(), regras: tabReajustarRegras(tr.regras, fator) })),
      criadoEm: agora,
      atualizadoEm: agora,
    };
    const final = lista.map(x => (x.id === orig.id && ajuste ? { ...x, ...ajuste, atualizadoEm: agora } : x)).concat(nova);
    await gravarTabelas(final);
    _tabelas = final;
    await abrirTabela(nova.id);
    tfMsg(`Nova versão criada (${freteVigTxt(nova)}${pct ? `, reajuste ${freteFmtNum(pct)}%` : ''}).` +
      (ajuste ? ` A versão anterior ficou ${freteVigTxt({ ...orig, ...ajuste })}.` : ''), false);
  } catch (e) {
    console.error(e);
    tvMsg('Não foi possível criar a versão (verifique a conexão).', true);
  }
}

function tfMsg(txt, erro) {
  const el = document.getElementById('tf-msg');
  el.textContent = txt;
  el.style.color = erro ? '#b91c1c' : '#16a34a';
}

async function salvarTabela() {
  if (!(await cadPodeEditar())) return;
  const nomeEl = document.getElementById('tf-nome');
  const vigEl = document.getElementById('tf-vigencia');
  const srvEl = document.getElementById('tf-servico');
  const nome = nomeEl.value.trim();
  const vigencia = vigEl.value;
  const servicoId = srvEl.value;
  nomeEl.style.borderColor = nome ? '' : '#ef4444';
  vigEl.style.borderColor = vigencia ? '' : '#ef4444';
  srvEl.style.borderColor = servicoId ? '' : '#ef4444';
  if (!nome || !vigencia || !servicoId) { tfMsg('Preencha o nome, o serviço e a data "válida até".', true); return; }
  const vigenciaInicio = document.getElementById('tf-vig-inicio').value;
  if (vigenciaInicio && vigenciaInicio > vigencia) { tfMsg('O início da vigência não pode ser depois da data "válida até".', true); return; }
  const composicao = [...document.querySelectorAll('#cad-tabela-form .tf-comp input:checked')].map(i => i.value);
  if (!composicao.length) { tfMsg('Marque pelo menos um item da composição.', true); return; }

  const btn = document.getElementById('tf-salvar');
  btn.disabled = true;
  tfMsg('Salvando...', false);
  try {
    // Rele antes de gravar para nao apagar o que outra pessoa salvou.
    const lista = await lerTabelas();
    const dup = lista.find(x => x.id !== _tabEditando && x.nome.toUpperCase() === nome.toUpperCase() && x.vigencia === vigencia);
    if (dup) { tfMsg('Já existe uma tabela com esse nome e essa data "válida até".', true); return; }

    const antiga = _tabEditando ? lista.find(x => x.id === _tabEditando) : null;
    const agora = new Date().toISOString();
    const srv = _tabServicos.find(s => s.id === servicoId);
    const tab = {
      ...(antiga || {}),
      id: antiga ? antiga.id : novoId(),
      nome,
      referencia: document.getElementById('tf-referencia').value.trim(),
      servicoId,
      servicoNome: srv ? srv.nome : ((antiga && antiga.servicoNome) || ''),
      tipo: document.getElementById('tf-tipo').value,
      vigencia,
      vigenciaInicio,
      precisao: +document.getElementById('tf-precisao').value,
      fatorCubagem: freteNum(document.getElementById('tf-cubagem').value),
      ...Object.fromEntries(TAB_SIMNAO.map(([k]) => [k, document.getElementById('tf-' + k).value === '1'])),
      composicao,
      trechos: (antiga && antiga.trechos) || [],
      criadoEm: antiga ? antiga.criadoEm : agora,
      atualizadoEm: agora,
    };
    // campos que sairam da tabela
    delete tab.regras; delete tab.permiteDesconto; delete tab.permiteAcrescimo;
    const nova = antiga ? lista.map(x => (x.id === tab.id ? tab : x)) : [...lista, tab];
    await gravarTabelas(nova);
    _tabelas = nova;
    _tabEditando = tab.id;
    abrirTrechos(tab.id, antiga ? `Tabela "${nome}" salva.` : `Tabela "${nome}" salva. Agora inclua os trechos com as regras de cada um.`);
  } catch (e) {
    console.error(e);
    tfMsg('Não foi possível salvar (verifique a conexão).', true);
  } finally {
    btn.disabled = false;
  }
}

async function excluirTabela() {
  if (!(await cadPodeEditar()) || !_tabEditando) return;
  const t = _tabelas.find(x => x.id === _tabEditando);
  if (!t || !confirm(`Excluir a tabela "${t.nome}" e todos os trechos dela? Essa ação não pode ser desfeita.`)) return;
  try {
    const lista = (await lerTabelas()).filter(x => x.id !== t.id);
    await gravarTabelas(lista);
    _tabelas = lista;
    _tabEditando = null;
    await carregarTabelas();
    tabMsg(`Tabela "${t.nome}" excluída.`);
  } catch (e) {
    console.error(e);
    tfMsg('Não foi possível excluir (verifique a conexão).', true);
  }
}

// ---------- LISTA DE TRECHOS ----------

function trMsg(txt, erro) {
  const el = document.getElementById('tr-msg');
  if (!el) return;
  el.textContent = txt;
  el.style.color = erro ? '#b91c1c' : '#16a34a';
}

// Quantos itens da composicao o trecho ja tem preenchidos.
function trPreenchidos(t, tr) {
  const temValor = r => r && Object.entries(r).some(([c, v]) =>
    c === 'faixas' ? (v || []).length > 0 : v !== null && v !== undefined);
  return (t.composicao || []).filter(k => temValor((tr.regras || {})[k])).length;
}

async function abrirTrechos(id, aviso) {
  const podeEditar = await cadPodeEditar();
  try { await lerGrupos(); } catch (e) { /* mostra o nome guardado no trecho */ }
  const t = _tabelas.find(x => x.id === id);
  if (!t) return;
  _tabEditando = id;
  tabVista('trechos');
  const trechos = [...(t.trechos || [])].sort((a, b) =>
    freteTrechoTxt(a).localeCompare(freteTrechoTxt(b)));
  const nComp = (t.composicao || []).length;
  document.getElementById('cad-tabela-trechos').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:4px">
      <h3 style="margin:0">Trechos — ${cadEsc(t.nome)}</h3>
      ${podeEditar ? `<button class="cad-btn" type="button" onclick="abrirTrecho(null)">+ Novo trecho</button>` : ''}
    </div>
    <div style="font-size:.78rem;color:#64748b;margin-bottom:10px">
      Serviço ${cadEsc(t.servicoNome || '—')} · ${freteVigTxt(t)} ·
      cada trecho tem as suas regras. No cálculo, vale o trecho que casar com a origem e o destino
      (cidade em branco = estado todo; com cidade tem prioridade).
    </div>
    <div id="tr-msg" style="font-size:.78rem;margin:4px 0 8px;min-height:1em"></div>
    <table>
      <thead><tr><th>Origem</th><th>Destino</th><th style="width:160px">Itens preenchidos</th></tr></thead>
      <tbody>${trechos.length ? trechos.map(tr => {
        const n = trPreenchidos(t, tr);
        return `<tr style="cursor:pointer" onclick="abrirTrecho('${tr.id}')" title="Abrir trecho">
          <td>${cadEsc(freteLadoTxt(tr, 'origem'))}</td>
          <td>${cadEsc(freteLadoTxt(tr, 'destino'))}</td>
          <td style="color:${n < nComp ? '#b45309' : '#16a34a'};font-weight:600">${n} de ${nComp}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="3" style="color:#64748b">Nenhum trecho cadastrado — sem trecho a tabela não é usada no cálculo.</td></tr>'}</tbody>
    </table>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
      <button class="cad-btn" type="button" style="background:var(--primary-light)" onclick="abrirTabela('${t.id}')">← Voltar para a tabela</button>
      <button class="cad-btn" type="button" style="background:#64748b" onclick="carregarTabelas()">Lista de tabelas</button>
    </div>`;
  if (aviso) trMsg(aviso, false);
}

// ---------- EDITOR DE TRECHO (origem/destino + regras) ----------

// id = trecho existente; null = novo; copiarDe = id de trecho cujas regras
// vem pre-preenchidas (botao Duplicar).
async function abrirTrecho(id, copiarDe) {
  const podeEditar = await cadPodeEditar();
  const t = _tabelas.find(x => x.id === _tabEditando);
  if (!t) return;
  const tr = id ? (t.trechos || []).find(x => x.id === id) : null;
  if (!tr && !podeEditar) return;
  const base = copiarDe ? (t.trechos || []).find(x => x.id === copiarDe) : tr;
  _trEditando = tr ? tr.id : null;
  _tabRegras = JSON.parse(JSON.stringify((base && base.regras) || {}));
  _tabComp = (t.composicao || []).filter(k => k in TAB_ROTULO);

  const ufOpts = sel => '<option value="">UF</option>' + FRETE_UFS.map(u => `<option${u === sel ? ' selected' : ''}>${u}</option>`).join('');
  const titulo = tr ? `Trecho ${cadEsc(freteTrechoTxt(tr))}`
    : copiarDe ? 'Novo trecho (cópia — troque a origem/destino)' : 'Novo trecho';
  tabVista('trechos');
  document.getElementById('cad-tabela-trechos').innerHTML = `
    <h3 style="margin-bottom:4px">${titulo}</h3>
    <div style="font-size:.78rem;color:#64748b;margin-bottom:12px">Tabela ${cadEsc(t.nome)} · ${freteVigTxt(t)} · cidade em branco = estado todo.</div>
    <div class="tr-form">
      <div><label class="tf-lbl">Trecho de início (origem) *</label>
        <div class="cid-ac tr-ac"><input id="tr-orig" type="text" autocomplete="off" placeholder="Cidade, estado ou trecho cadastrado..."><div class="cid-ac-lista" hidden></div>
          <select id="tr-ouf" hidden>${ufOpts('')}</select><input id="tr-ocid" type="hidden"><input id="tr-ogrp" type="hidden"></div>
        <select id="tr-ogrp-sel" class="tr-grp-sel" title="Escolher um trecho cadastrado"><option value="">ou escolha um trecho cadastrado…</option></select></div>
      <div><label class="tf-lbl">Trecho de fim (destino) *</label>
        <div class="cid-ac tr-ac"><input id="tr-dest" type="text" autocomplete="off" placeholder="Cidade, estado ou trecho cadastrado..."><div class="cid-ac-lista" hidden></div>
          <select id="tr-duf" hidden>${ufOpts('')}</select><input id="tr-dcid" type="hidden"><input id="tr-dgrp" type="hidden"></div>
        <select id="tr-dgrp-sel" class="tr-grp-sel" title="Escolher um trecho cadastrado"><option value="">ou escolha um trecho cadastrado…</option></select></div>
    </div>
    <div class="tf-lbl" style="margin-top:14px">Regras deste trecho</div>
    <div id="tf-regras" class="tf-regras"></div>
    <div id="tr-msg" style="font-size:.78rem;margin:10px 0 0;min-height:1em"></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button id="tr-salvar" class="cad-btn" type="button" onclick="salvarTrecho()">💾 Salvar trecho</button>
      ${tr ? `<button class="cad-btn tr-dup" type="button" style="background:var(--primary-light)" onclick="abrirTrecho(null,'${tr.id}')">📄 Duplicar trecho</button>` : ''}
      <button class="cad-btn" type="button" style="background:#64748b" onclick="abrirTrechos('${t.id}')">← Voltar aos trechos</button>
      ${tr ? '<button class="cad-del" type="button" style="margin-left:auto" onclick="excluirTrecho()">Excluir trecho</button>' : ''}
    </div>`;
  tabRenderRegras();
  // Origem/destino: busca Cidade/UF (ou "estado todo"); so vale o que for escolhido na lista.
  try { await Promise.all([lerCidades(), lerGrupos()]); } catch (e) { /* sem cadastro: a busca avisa */ }
  const acO = cidAutocomplete('tr-orig', 'tr-ouf', 'tr-ocid', { estadoTodo: true, grupoId: 'tr-ogrp' });
  const acD = cidAutocomplete('tr-dest', 'tr-duf', 'tr-dcid', { estadoTodo: true, grupoId: 'tr-dgrp' });
  cidLigarSeletorGrupo('tr-ogrp-sel', 'tr-ogrp', acO);
  cidLigarSeletorGrupo('tr-dgrp-sel', 'tr-dgrp', acD);
  if (tr) {
    acO.definir(tr.origemUf, tr.origemCidade, tr.origemGrupoId);
    acD.definir(tr.destinoUf, tr.destinoCidade, tr.destinoGrupoId);
  }
  if (!podeEditar) {
    const box = document.getElementById('cad-tabela-trechos');
    box.querySelectorAll('input,select').forEach(el => { el.disabled = true; });
    box.querySelectorAll('#tr-salvar,.tr-dup,.cad-del,.tf-add-faixa,.tf-del-faixa').forEach(el => el.remove());
  }
}

// Le os valores digitados nos blocos de regra de volta para _tabRegras.
function tabColetarRegras() {
  document.querySelectorAll('#tf-regras .tf-regra').forEach(bl => {
    const k = bl.dataset.item;
    const r = {};
    bl.querySelectorAll('[data-campo]').forEach(inp => {
      if (!inp.closest('.tf-faixa')) r[inp.dataset.campo] = freteNum(inp.value);
    });
    if (bl.querySelector('.tf-faixas')) {
      r.faixas = [...bl.querySelectorAll('.tf-faixa')].map(row =>
        Object.fromEntries([...row.querySelectorAll('[data-campo]')].map(i => [i.dataset.campo, freteNum(i.value)])));
    }
    _tabRegras[k] = r;
  });
}

function tabCampo(campo, rotulo, valor, dica) {
  return `<label>${rotulo}<input type="text" inputmode="decimal" data-campo="${campo}" value="${tabInp(valor)}"${dica ? ` placeholder="${dica}"` : ''}></label>`;
}

function tabBlocoRegra(k) {
  const tipo = TAB_TIPO[k];
  const r = _tabRegras[k] || {};
  let corpo = '';
  switch (tipo) {
    case 'PCT_NF':
      corpo = `<div class="tf-campos">${tabCampo('pct', '% sobre o valor da mercadoria', r.pct, 'ex.: 0,3')}</div>`;
      break;
    case 'PCT_CTE':
      corpo = `<div class="tf-campos">${tabCampo('pct', '% sobre o valor do CT-e', r.pct, 'ex.: 1,5')}</div>`;
      break;
    case 'FIXO':
      corpo = `<div class="tf-campos">${tabCampo('valor', 'Valor fixo (R$)', r.valor, 'em branco = não cobra')}</div>`;
      break;
    case 'FRACAO':
      corpo = `<div class="tf-campos">${tabCampo('fracaoKg', 'Fração (kg)', r.fracaoKg, 'ex.: 100')}${tabCampo('valor', 'Valor por fração (R$)', r.valor)}
          ${tabCampo('franquia', 'Franquia (kg)', r.franquia, 'opcional')}${tabCampo('valorFranquia', 'Valor da franquia (R$)', r.valorFranquia)}</div>
        <div class="tf-dica">peso ÷ fração, arredonda para cima, × valor. Com franquia: até a franquia cobra o valor dela; acima, valor da franquia + (excedente ÷ fração, arredonda para cima) × valor</div>`;
      break;
    case 'FAIXA_PESO':
    case 'FAIXA_M3': {
      const porPeso = tipo === 'FAIXA_PESO';
      const un = porPeso ? 'kg' : 'm³';
      const faixas = r.faixas && r.faixas.length ? r.faixas : [{}];
      const inp = (f, campo, ph) => `<input type="text" inputmode="decimal" data-campo="${campo}" value="${tabInp(f[campo])}"${ph ? ` placeholder="${ph}"` : ''}>`;
      const cls = porPeso ? 'tf-faixa tf-faixa-kg' : 'tf-faixa';
      corpo = `<div class="tf-faixas">
          <div class="${cls.replace('tf-faixa', 'tf-faixa-cab')}"><span>De (${un})</span><span>Até (${un})</span>
            ${porPeso ? '<span>Valor da faixa (R$)</span><span>Franquia (kg)</span><span>R$/kg excedente</span>' : `<span>R$ por ${un}</span>`}<span></span></div>
          ${faixas.map((f, i) => `
            <div class="${cls}">
              ${inp(f, 'de', '0')}${inp(f, 'ate', 'vazio = acima')}
              ${porPeso ? inp(f, 'valorFranquia') + inp(f, 'franquia', 'opcional') + inp(f, 'valor', 'opcional') : inp(f, 'valor')}
              <button type="button" class="tf-del-faixa" title="Remover faixa" onclick="tabDelFaixa('${k}',${i})">✕</button>
            </div>`).join('')}
          <button type="button" class="tf-add-faixa" onclick="tabAddFaixa('${k}')">+ faixa</button>
        </div>
        <div class="tf-dica">${porPeso
          ? 'Vale o peso considerado (maior entre real e cubado). Na faixa em que ele cair: sem excedente, o frete é o valor da faixa; com R$/kg excedente, é o valor da faixa + (peso − franquia) × R$/kg. Franquia vazia = fim da faixa anterior; valor da faixa vazio = valor da faixa anterior. Ex.: faixa 3.000,01 a 12.000 com excedente R$ 1,80 → 3.500 kg = 5.381,31 + 500 × 1,80'
          : 'm³ × valor da faixa em que ele cair'}</div>`;
      break;
    }
    default:
      return `<div class="tf-regra" data-item="${k}">
          <div class="tf-regra-tit">${TAB_ROTULO[k]}</div>
          <div class="tf-regra-vazia">Regra deste item a definir</div>
        </div>`;
  }
  return `<div class="tf-regra" data-item="${k}">
      <div class="tf-regra-tit">${TAB_ROTULO[k]}</div>
      ${corpo}
      <div class="tf-campos" style="margin-top:6px">
        ${tabCampo('minimo', 'Preço mínimo (R$)', r.minimo)}
      </div>
    </div>`;
}

// Desenha um bloco de regra para cada item da composicao da tabela.
function tabRenderRegras() {
  document.getElementById('tf-regras').innerHTML = _tabComp.length
    ? _tabComp.map(tabBlocoRegra).join('')
    : '<div style="color:#64748b;font-size:.8rem">A tabela não tem itens na composição — marque-os na tela da tabela.</div>';
}

function tabAddFaixa(k) {
  tabColetarRegras();
  const r = _tabRegras[k] || (_tabRegras[k] = {});
  r.faixas = r.faixas || [];
  // Sugere o "de" logo depois do "ate" da ultima faixa (ex.: ate 1 -> de 1,01)
  // e repete a franquia da faixa anterior (geralmente e a mesma).
  const ult = r.faixas[r.faixas.length - 1];
  const de = ult && ult.ate !== null && ult.ate !== undefined ? Math.round((ult.ate + 0.01) * 100) / 100 : null;
  r.faixas.push({ de, ate: null, valorFranquia: null, franquia: null, valor: null });
  tabRenderRegras();
}

function tabDelFaixa(k, i) {
  tabColetarRegras();
  const r = _tabRegras[k];
  if (r && r.faixas) r.faixas.splice(i, 1);
  tabRenderRegras();
}

// Regras so dos itens da composicao, sem faixas totalmente vazias.
function tabRegrasParaGravar(composicao) {
  const out = {};
  for (const k of composicao) {
    const r = { ...(_tabRegras[k] || {}) };
    if (r.faixas) {
      r.faixas = r.faixas.filter(f => Object.values(f).some(v => v !== null && v !== undefined))
        .map(f => ({ ...f, de: f.de ?? 0, ate: f.ate ?? null, valor: f.valor ?? 0 }))
        .sort((a, b) => a.de - b.de);
    }
    // Franquia no nivel do item so existe na regra por fracao (nas faixas de peso ela fica em cada faixa).
    if (TAB_TIPO[k] !== 'FRACAO') { delete r.franquia; delete r.valorFranquia; }
    out[k] = r;
  }
  return out;
}

function tabValidarRegras(regras) {
  for (const [k, r] of Object.entries(regras)) {
    for (const f of r.faixas || []) {
      if (f.ate !== null && f.ate !== undefined && f.ate < f.de) return `${TAB_ROTULO[k]}: faixa com "até" menor que "de".`;
    }
    if (TAB_TIPO[k] === 'FRACAO' && r.valor && !r.fracaoKg) return `${TAB_ROTULO[k]}: informe a fração em kg.`;
  }
  return null;
}

async function salvarTrecho() {
  if (!(await cadPodeEditar())) return;
  tabColetarRegras();
  const dados = {
    origemUf: document.getElementById('tr-ouf').value,
    origemCidade: freteNorm(document.getElementById('tr-ocid').value),
    destinoUf: document.getElementById('tr-duf').value,
    destinoCidade: freteNorm(document.getElementById('tr-dcid').value),
    origemGrupoId: document.getElementById('tr-ogrp').value,
    destinoGrupoId: document.getElementById('tr-dgrp').value,
  };
  dados.origemGrupoNome = dados.origemGrupoId ? ((_freteGrupos[dados.origemGrupoId] || {}).nome || '') : '';
  dados.destinoGrupoNome = dados.destinoGrupoId ? ((_freteGrupos[dados.destinoGrupoId] || {}).nome || '') : '';
  if ((!dados.origemUf && !dados.origemGrupoId) || (!dados.destinoUf && !dados.destinoGrupoId)) { trMsg('Escolha a origem e o destino na lista (digite parte do nome da cidade ou do estado e clique na sugestão).', true); return; }
  try { await lerCidades(); } catch (e) { /* sem cadastro de cidades: nao valida */ }
  for (const [uf, cid, lado] of [[dados.origemUf, dados.origemCidade, 'origem'], [dados.destinoUf, dados.destinoCidade, 'destino']]) {
    if (cid && (_cidades || []).length && !cidadeExiste(uf, cid)) {
      trMsg(`Cidade de ${lado} "${cid}" não existe em ${uf} no Cadastro > Cidade (confira a grafia ou cadastre).`, true);
      return;
    }
  }
  const regras = tabRegrasParaGravar(_tabComp);
  const erro = tabValidarRegras(regras);
  if (erro) { trMsg(erro, true); return; }

  const btn = document.getElementById('tr-salvar');
  btn.disabled = true;
  trMsg('Salvando...', false);
  try {
    const lista = await lerTabelas();
    const t = lista.find(x => x.id === _tabEditando);
    if (!t) { trMsg('Tabela não encontrada (foi excluída?).', true); return; }
    t.trechos = t.trechos || [];
    const chave = x => [x.origemGrupoId || '', x.origemGrupoId ? '' : x.origemUf, x.origemGrupoId ? '' : freteNorm(x.origemCidade),
      x.destinoGrupoId || '', x.destinoGrupoId ? '' : x.destinoUf, x.destinoGrupoId ? '' : freteNorm(x.destinoCidade)].join('|');
    const igual = t.trechos.some(x => x.id !== _trEditando && chave(x) === chave(dados));
    if (igual) { trMsg('Já existe um trecho com essa origem e esse destino nesta tabela.', true); return; }
    const tr = { id: _trEditando || novoId(), ...dados, regras };
    t.trechos = _trEditando ? t.trechos.map(x => (x.id === tr.id ? tr : x)) : [...t.trechos, tr];
    t.atualizadoEm = new Date().toISOString();
    await gravarTabelas(lista);
    _tabelas = lista;
    await abrirTrechos(t.id, 'Trecho salvo.');
  } catch (e) {
    console.error(e);
    trMsg('Não foi possível salvar o trecho (verifique a conexão).', true);
  } finally {
    btn.disabled = false;
  }
}

async function excluirTrecho() {
  if (!(await cadPodeEditar()) || !_trEditando) return;
  if (!confirm('Excluir este trecho e as regras dele?')) return;
  try {
    const lista = await lerTabelas();
    const t = lista.find(x => x.id === _tabEditando);
    if (!t) return;
    t.trechos = (t.trechos || []).filter(x => x.id !== _trEditando);
    t.atualizadoEm = new Date().toISOString();
    await gravarTabelas(lista);
    _tabelas = lista;
    _trEditando = null;
    await abrirTrechos(t.id, 'Trecho excluído.');
  } catch (e) {
    console.error(e);
    trMsg('Não foi possível excluir o trecho (verifique a conexão).', true);
  }
}


// ===== cadastro-icms.js =====
// cadastro-icms.js — Cadastro > ICMS: aliquota de ICMS (rodoviario) por
// UF de origem x UF de destino.
//
// Fica no Supabase da PortoEx (app_config, chave CAD_ICMS_KEY), generica
// para outros projetos lerem. Formato:
//   { aliquotas: { 'SC-SP': 12, 'SC-SC': 17, ... },  // chave 'ORIGEM-DESTINO', valor em %
//     atualizadoEm (ISO) }
// Usado pelo motor (frete-calculo.js) quando a tabela tem "Soma ICMS ao
// frete" = SIM: total = soma dos itens / (1 - aliquota/100).
// Script classico: usa getDb(), cadPodeEditar(), cadEsc(), freteNum(), FRETE_UFS.

let CAD_ICMS_KEY = 'cadastro_icms';   // compartilhada entre projetos
let _icms = {};          // aliquotas gravadas
let _icmsEdit = {};      // copia em edicao na tela

async function lerIcms() {
  const db = getDb();
  if (!db) throw new Error('Supabase indisponível');
  const { data, error } = await db.from('app_config').select('value').eq('key', CAD_ICMS_KEY).maybeSingle();
  if (error) throw error;
  return (data && data.value && data.value.aliquotas) || {};
}

async function gravarIcms(aliquotas) {
  const { error } = await getDb().from('app_config')
    .upsert({ key: CAD_ICMS_KEY, value: { aliquotas, atualizadoEm: new Date().toISOString() }, updated_at: new Date().toISOString() });
  if (error) throw error;
}

function icmsMsg(txt, erro) {
  const el = document.getElementById('cad-icms-msg');
  el.textContent = txt;
  el.style.color = erro ? '#b91c1c' : '#64748b';
}

async function carregarIcms() {
  icmsMsg('Carregando...');
  try {
    const podeEditar = await cadPodeEditar();
    document.getElementById('cad-icms-acoes').style.display = podeEditar ? 'flex' : 'none';
    _icms = await lerIcms();
    _icmsEdit = { ..._icms };
    renderIcms(podeEditar);
    const n = Object.keys(_icms).length;
    icmsMsg(n ? `${n} combinações cadastradas.` : 'Nenhuma alíquota cadastrada ainda — importe a planilha.');
  } catch (e) {
    console.error(e);
    icmsMsg('Não foi possível carregar as alíquotas (verifique a conexão).', true);
  }
}

// Matriz: linhas = UF origem, colunas = UF destino.
function renderIcms(podeEditar) {
  const cel = (o, d) => {
    const v = _icmsEdit[`${o}-${d}`];
    const txt = v === undefined || v === null ? '' : String(v).replace('.', ',');
    const cls = o === d ? ' icms-interna' : '';
    return podeEditar
      ? `<td class="${cls.trim()}"><input data-k="${o}-${d}" value="${txt}" inputmode="decimal" onchange="icmsAlterou(this)"></td>`
      : `<td class="${cls.trim()}">${txt}</td>`;
  };
  document.getElementById('cad-icms-matriz').innerHTML = `
    <table class="icms-tab">
      <thead><tr><th>Orig. ↓ / Dest. →</th>${FRETE_UFS.map(u => `<th>${u}</th>`).join('')}</tr></thead>
      <tbody>${FRETE_UFS.map(o => `<tr><th>${o}</th>${FRETE_UFS.map(d => cel(o, d)).join('')}</tr>`).join('')}</tbody>
    </table>`;
}

function icmsAlterou(inp) {
  const n = freteNum(inp.value);
  if (inp.value.trim() !== '' && (n === null || n < 0 || n >= 100)) {
    inp.style.background = '#fee2e2';
    return;
  }
  inp.style.background = '#fef9c3';
  if (n === null) delete _icmsEdit[inp.dataset.k];
  else _icmsEdit[inp.dataset.k] = n;
  icmsMsg('Alterações ainda não salvas — clique em Salvar.');
}

async function salvarIcms() {
  if (!(await cadPodeEditar())) return;
  if (document.querySelector('#cad-icms-matriz input[style*="fee2e2"]')) {
    icmsMsg('Há alíquotas inválidas (em vermelho). Use um número entre 0 e 99,99.', true);
    return;
  }
  icmsMsg('Salvando...');
  try {
    await gravarIcms(_icmsEdit);
    _icms = { ..._icmsEdit };
    renderIcms(true);
    icmsMsg(`Alíquotas salvas (${Object.keys(_icms).length} combinações).`);
  } catch (e) {
    console.error(e);
    icmsMsg('Não foi possível salvar (verifique a conexão).', true);
  }
}

// Importa uma planilha no formato do Brudam: colunas UF ORIGEM, UF DESTINO,
// ALIQUOTA (o nome so precisa conter essas palavras). Preenche a matriz;
// grava so quando clicar em Salvar.
async function importarIcms(input) {
  const arq = input.files && input.files[0];
  input.value = '';
  if (!arq) return;
  try {
    const wb = XLSX.read(await arq.arrayBuffer(), { type: 'array' });
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
    const cab = (linhas[0] || []).map(c => freteNorm(c));
    const iO = cab.findIndex(c => c.includes('ORIGEM'));
    const iD = cab.findIndex(c => c.includes('DESTINO'));
    const iA = cab.findIndex(c => c.includes('ALIQ'));
    if (iO < 0 || iD < 0 || iA < 0) {
      icmsMsg('Planilha sem as colunas UF ORIGEM, UF DESTINO e ALIQUOTA.', true);
      return;
    }
    const novo = {};
    let ignoradas = 0;
    for (const l of linhas.slice(1)) {
      const o = freteNorm(l[iO]), d = freteNorm(l[iD]), a = freteNum(l[iA]);
      if (FRETE_UFS.includes(o) && FRETE_UFS.includes(d) && a !== null) novo[`${o}-${d}`] = a;
      else if (l.some(x => x !== undefined && x !== '')) ignoradas++;
    }
    _icmsEdit = { ..._icmsEdit, ...novo };
    renderIcms(true);
    icmsMsg(`${Object.keys(novo).length} alíquotas lidas de "${arq.name}"${ignoradas ? ` (${ignoradas} linhas ignoradas)` : ''} — confira e clique em Salvar.`);
  } catch (e) {
    console.error(e);
    icmsMsg('Não foi possível ler a planilha.', true);
  }
}


// ===== cadastro-cidade.js =====
// cadastro-cidade.js — Cadastro > Cidade: cidades do Brasil por UF.
//
// Fica no Supabase da PortoEx (app_config, chave CAD_CIDADES_KEY), generica
// para outros projetos lerem. Formato: [{ ibge: '4208203', nome: 'Itajaí', uf: 'SC' }, ...]
// Carregado em 25/09/2026 com os 5.571 municipios do IBGE
// (servicodados.ibge.gov.br/api/v1/localidades/municipios); da para incluir/excluir.
// Tambem alimenta as sugestoes de cidade nos trechos e no Simulador.
// Script classico: usa getDb(), cadPodeEditar(), cadEsc(), freteNorm(), FRETE_UFS.

let CAD_CIDADES_KEY = 'cadastro_cidades';   // compartilhada entre projetos
const CID_LIMITE_TELA = 300;
let _cidades = null;   // cache (lista grande: le uma vez por carregamento)

async function lerCidades(forcar) {
  if (_cidades && !forcar) return _cidades;
  const db = getDb();
  if (!db) throw new Error('Supabase indisponível');
  const { data, error } = await db.from('app_config').select('value').eq('key', CAD_CIDADES_KEY).maybeSingle();
  if (error) throw error;
  _cidades = Array.isArray(data && data.value) ? data.value : [];
  return _cidades;
}

async function gravarCidades(lista) {
  const { error } = await getDb().from('app_config')
    .upsert({ key: CAD_CIDADES_KEY, value: lista, updated_at: new Date().toISOString() });
  if (error) throw error;
  _cidades = lista;
}

// Cidades de uma UF (para sugestao em campos de cidade). Usa o cache; se
// ainda nao carregou, devolve [] e carrega em segundo plano.
function cidadesDaUf(uf) {
  if (!_cidades) { lerCidades().catch(() => {}); return []; }
  return _cidades.filter(c => c.uf === uf).map(c => c.nome);
}

// Existe essa cidade na UF? (comparacao sem acento/maiuscula)
function cidadeExiste(uf, nome) {
  const n = freteNorm(nome);
  return (_cidades || []).some(c => c.uf === uf && freteNorm(c.nome) === n);
}

// Liga um <select> de UF a um <datalist> de cidades: ao trocar a UF,
// as sugestoes passam a ser as cidades daquela UF.
function cidLigarUf(selectId, datalistId) {
  const sel = document.getElementById(selectId);
  const dl = document.getElementById(datalistId);
  if (!sel || !dl) return;
  const encher = () => { dl.innerHTML = cidadesDaUf(sel.value).map(n => `<option value="${cadEsc(n)}">`).join(''); };
  sel.addEventListener('change', encher);
  lerCidades().then(encher).catch(() => {});
}

// ---------- BUSCA DE CIDADE (autocomplete Cidade/UF) ----------

// Liga um campo de texto a uma lista de sugestoes Cidade/UF do cadastro.
// So vale o que for escolhido na lista: ao escolher, grava a UF no <select>
// ufId e o nome no campo cidId (hidden) e dispara 'change' neles; se o
// texto for mexido depois, os dois sao limpos (evita cidade/UF errada).
const CID_UF_NOMES = {
  AC: 'Acre', AL: 'Alagoas', AM: 'Amazonas', AP: 'Amapá', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MG: 'Minas Gerais', MS: 'Mato Grosso do Sul',
  MT: 'Mato Grosso', PA: 'Pará', PB: 'Paraíba', PE: 'Pernambuco', PI: 'Piauí', PR: 'Paraná',
  RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RO: 'Rondônia', RR: 'Roraima', RS: 'Rio Grande do Sul',
  SC: 'Santa Catarina', SE: 'Sergipe', SP: 'São Paulo', TO: 'Tocantins',
};

// opts.estadoTodo: a lista tambem oferece "UF — estado todo" (cidade vazia),
// usado nos trechos das tabelas.
// opts.grupoId: id de um <input hidden>; a lista tambem oferece os trechos
// cadastrados (Cadastro > Trecho) e grava o id escolhido nele.
function cidAutocomplete(inputId, ufId, cidId, opts = {}) {
  const inp = document.getElementById(inputId);
  const lista = inp.parentElement.querySelector('.cid-ac-lista');
  const ufEl = document.getElementById(ufId);
  const cidEl = document.getElementById(cidId);
  const grpEl = opts.grupoId ? document.getElementById(opts.grupoId) : null;
  let itens = [];
  let ativo = -1;

  const fechar = () => { lista.hidden = true; ativo = -1; };
  const marcarAtivo = () => lista.querySelectorAll('.cid-ac-item').forEach((el, i) => el.classList.toggle('ativo', i === ativo));

  function escolher(c) {
    if (grpEl) grpEl.value = c.grupo ? c.id : '';
    if (c.grupo) {
      ufEl.value = '';
      cidEl.value = '';
      inp.value = `Trecho ${c.nome}`;
      inp.classList.add('cid-ok');
      grpEl.dispatchEvent(new Event('change'));
      fechar();
      return;
    }
    ufEl.value = c.uf;
    cidEl.value = c.estado ? '' : c.nome;
    inp.value = c.estado ? `${c.uf} — estado todo` : `${c.nome}/${c.uf}`;
    inp.classList.add('cid-ok');
    ufEl.dispatchEvent(new Event('change'));
    cidEl.dispatchEvent(new Event('change'));
    fechar();
  }

  function buscar() {
    ufEl.value = '';
    cidEl.value = '';
    if (grpEl) grpEl.value = '';
    inp.classList.remove('cid-ok');
    // aceita "itajai", "itajai sc" ou "itajai/sc"
    const txt = freteNorm(inp.value).replace('/', ' ');
    if (txt.length < 2) { fechar(); return; }
    const m = txt.match(/^(.*?)[\s]+([A-Z]{2})$/);
    const nomeBusca = m && FRETE_UFS.includes(m[2]) ? m[1].trim() : txt;
    const ufBusca = m && FRETE_UFS.includes(m[2]) ? m[2] : '';
    const todas = (_cidades || []).filter(c => !ufBusca || c.uf === ufBusca);
    const comeca = [], contem = [];
    for (const c of todas) {
      const n = freteNorm(c.nome);
      if (n.startsWith(nomeBusca)) comeca.push(c);
      else if (n.includes(nomeBusca)) contem.push(c);
    }
    // nome exato primeiro, depois os mais curtos (ex.: "campinas" -> Campinas/SP antes de Campinas do Piaui)
    const ordem = (a, b) => (freteNorm(b.nome) === nomeBusca) - (freteNorm(a.nome) === nomeBusca) ||
      a.nome.length - b.nome.length || a.nome.localeCompare(b.nome);
    itens = comeca.sort(ordem).concat(contem.sort(ordem)).slice(0, 15);
    if (opts.estadoTodo) {
      // "sp", "sao paulo", "santa cat"... -> oferece o estado inteiro no topo
      const estados = FRETE_UFS.filter(u => u === txt ||
        (txt.length >= 3 && freteNorm(CID_UF_NOMES[u]).startsWith(nomeBusca) && (!ufBusca || u === ufBusca)))
        .map(u => ({ uf: u, nome: CID_UF_NOMES[u], estado: true }));
      // cidade com o nome exato digitado vem antes do estado (ex.: "sao paulo sp" -> cidade, depois estado)
      const exatas = itens.filter(c => freteNorm(c.nome) === nomeBusca);
      itens = exatas.concat(estados, itens.filter(c => !exatas.includes(c))).slice(0, 15);
    }
    if (grpEl) {
      const grupos = (_freteGruposLista || []).filter(g => freteNorm(g.nome).includes(txt) || freteNorm(g.nome).includes(nomeBusca))
        .map(g => ({ grupo: true, id: g.id, nome: g.nome, n: g.cidades.length }));
      // ordem: cidade de nome exato e estado primeiro, depois os trechos cadastrados, depois as demais cidades
      const k = itens.findIndex(c => !(c.estado || freteNorm(c.nome) === nomeBusca));
      const pos = k < 0 ? itens.length : k;
      itens = itens.slice(0, pos).concat(grupos, itens.slice(pos)).slice(0, 15);
    }
    ativo = itens.length ? 0 : -1;
    lista.innerHTML = itens.length
      ? itens.map((c, i) => c.grupo
          ? `<div class="cid-ac-item" data-i="${i}"><span><b>Trecho</b> · ${cadEsc(c.nome)}</span><span class="uf">${c.n} cidade(s)</span></div>`
          : c.estado
          ? `<div class="cid-ac-item" data-i="${i}"><span><b>Estado todo</b> · ${cadEsc(c.nome)}</span><span class="uf">${c.uf}</span></div>`
          : `<div class="cid-ac-item" data-i="${i}"><b>${cadEsc(c.nome)}</b><span class="uf">${c.uf}</span></div>`).join('')
      : `<div class="cid-ac-vazio">${_cidades ? 'Nenhuma cidade encontrada.' : 'Carregando cidades...'}</div>`;
    marcarAtivo();
    lista.hidden = false;
  }

  inp.addEventListener('input', () => {
    if (!_cidades) lerCidades().then(buscar).catch(() => {});
    buscar();
  });
  inp.addEventListener('keydown', e => {
    if (lista.hidden) return;
    if (e.key === 'ArrowDown') { ativo = Math.min(ativo + 1, itens.length - 1); marcarAtivo(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { ativo = Math.max(ativo - 1, 0); marcarAtivo(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (itens[ativo]) escolher(itens[ativo]); e.preventDefault(); }
    else if (e.key === 'Escape') fechar();
  });
  // mousedown (antes do blur) para o clique na sugestao valer
  lista.addEventListener('mousedown', e => {
    const it = e.target.closest('.cid-ac-item');
    if (it) { e.preventDefault(); escolher(itens[+it.dataset.i]); }
  });
  inp.addEventListener('blur', () => setTimeout(fechar, 150));
  lerCidades().catch(() => {});

  // Para preencher por codigo (ex.: Auditoria -> Abrir no Simulador).
  return {
    definir(uf, nome, grupoId) {
      if (grupoId) {
        const g = (_freteGruposLista || []).find(x => x.id === grupoId);
        escolher({ grupo: true, id: grupoId, nome: g ? g.nome : '(trecho excluído)' });
        return;
      }
      if (grpEl) grpEl.value = '';
      if (uf && !nome && opts.estadoTodo) { escolher({ uf, nome: CID_UF_NOMES[uf] || uf, estado: true }); return; }
      const c = (_cidades || []).find(x => x.uf === uf && freteNorm(x.nome) === freteNorm(nome));
      if (c) { escolher(c); return; }
      ufEl.value = uf || '';
      cidEl.value = nome || '';
      inp.value = nome ? `${nome}/${uf}` : '';
      inp.classList.toggle('cid-ok', !!(uf && nome));
    },
  };
}

// Liga um <select> com os trechos cadastrados ao campo de busca: escolher no
// select preenche o campo com o trecho; escolher no campo atualiza o select.
function cidLigarSeletorGrupo(selId, grpId, ac) {
  const sel = document.getElementById(selId);
  const grp = document.getElementById(grpId);
  if (!sel || !grp) return;
  const encher = () => {
    const atual = grp.value;
    sel.innerHTML = '<option value="">ou escolha um trecho cadastrado…</option>' +
      [...(_freteGruposLista || [])].sort((a, b) => a.nome.localeCompare(b.nome))
        .map(g => `<option value="${g.id}"${g.id === atual ? ' selected' : ''}>${cadEsc(g.nome)} (${g.cidades.length} cidades)</option>`).join('');
    if (!(_freteGruposLista || []).length) sel.innerHTML = '<option value="">nenhum trecho cadastrado (Cadastro ▾ > Trecho)</option>';
  };
  encher();
  sel.addEventListener('change', () => { if (sel.value) ac.definir('', '', sel.value); });
  grp.addEventListener('change', () => { sel.value = grp.value || ''; });
  // quando o campo e redigitado o grupo e limpo sem evento: acompanha pelo input
  const inp = sel.parentElement.querySelector('.cid-ac input[type=text]');
  if (inp) inp.addEventListener('input', () => { sel.value = ''; });
}

// ---------- TELA ----------

function cidMsg(txt, erro) {
  const el = document.getElementById('cad-cidade-msg');
  el.textContent = txt;
  el.style.color = erro ? '#b91c1c' : '#64748b';
}

async function carregarCidadesTela() {
  const selUf = document.getElementById('cid-f-uf');
  if (!selUf.options.length) {
    selUf.innerHTML = '<option value="">Todas as UFs</option>' + FRETE_UFS.map(u => `<option>${u}</option>`).join('');
    document.getElementById('cid-n-uf').innerHTML = '<option value="">UF</option>' + FRETE_UFS.map(u => `<option>${u}</option>`).join('');
  }
  cidMsg('Carregando...');
  try {
    const podeEditar = await cadPodeEditar();
    document.getElementById('cad-cidade-form').style.display = podeEditar ? 'flex' : 'none';
    await lerCidades(true);
    renderCidades();
  } catch (e) {
    console.error(e);
    cidMsg('Não foi possível carregar as cidades (verifique a conexão).', true);
  }
}

function renderCidades() {
  const uf = document.getElementById('cid-f-uf').value;
  const busca = freteNorm(document.getElementById('cid-f-busca').value);
  const lista = (_cidades || []).filter(c => (!uf || c.uf === uf) && (!busca || freteNorm(c.nome).includes(busca)));
  const pode = _cadPodeEditar;
  document.getElementById('tb-cad-cidade').innerHTML = lista.slice(0, CID_LIMITE_TELA).map(c => `<tr>
      <td>${cadEsc(c.nome)}</td><td>${c.uf}</td><td style="color:#64748b">${cadEsc(c.ibge || '—')}</td>
      <td style="text-align:right">${pode ? `<button class="cad-del" type="button" onclick="excluirCidade('${c.uf}','${cadEsc(c.nome).replace(/'/g, "\\'")}')">Excluir</button>` : ''}</td>
    </tr>`).join('');
  const total = (_cidades || []).length;
  cidMsg(`${lista.length.toLocaleString('pt-BR')} cidade(s) encontradas de ${total.toLocaleString('pt-BR')} cadastradas` +
    (lista.length > CID_LIMITE_TELA ? ` — mostrando as ${CID_LIMITE_TELA} primeiras; filtre por UF ou busque pelo nome.` : '.'));
}

async function incluirCidade() {
  if (!(await cadPodeEditar())) return;
  const nome = document.getElementById('cid-n-nome').value.trim();
  const uf = document.getElementById('cid-n-uf').value;
  const ibge = document.getElementById('cid-n-ibge').value.trim();
  if (!nome || !uf) { cidMsg('Informe o nome e a UF da cidade.', true); return; }
  try {
    const lista = [...await lerCidades(true)];
    if (lista.some(c => c.uf === uf && freteNorm(c.nome) === freteNorm(nome))) { cidMsg(`${nome}/${uf} já está cadastrada.`, true); return; }
    lista.push({ ibge, nome, uf });
    lista.sort((a, b) => a.uf.localeCompare(b.uf) || a.nome.localeCompare(b.nome));
    await gravarCidades(lista);
    document.getElementById('cid-n-nome').value = '';
    document.getElementById('cid-n-ibge').value = '';
    renderCidades();
    cidMsg(`${nome}/${uf} incluída.`);
  } catch (e) {
    console.error(e);
    cidMsg('Não foi possível salvar (verifique a conexão).', true);
  }
}

async function excluirCidade(uf, nome) {
  if (!(await cadPodeEditar()) || !confirm(`Excluir a cidade ${nome}/${uf}?`)) return;
  try {
    const lista = (await lerCidades(true)).filter(c => !(c.uf === uf && c.nome === nome));
    await gravarCidades(lista);
    renderCidades();
    cidMsg(`${nome}/${uf} excluída.`);
  } catch (e) {
    console.error(e);
    cidMsg('Não foi possível excluir (verifique a conexão).', true);
  }
}


// ===== cadastro-trecho.js =====
// cadastro-trecho.js — Cadastro > Trecho: grupos de cidades com nome
// (ex.: "SC_Capital" = Itajai, Navegantes, Balneario Camboriu...).
//
// Um trecho cadastrado pode ser usado como origem ou destino nos trechos das
// tabelas (Cadastro > Tabela): a regra vale para qualquer cidade do grupo.
// Fica no Supabase da PortoEx (app_config, chave CAD_GRUPOS_KEY), generica:
//   [{ id, nome, cidades: [{uf, nome}], criadoEm, atualizadoEm }]
// Script classico: usa getDb(), cadPodeEditar(), cadEsc(), freteNorm(),
// novoId(), cidAutocomplete(), freteDefinirGrupos().

let CAD_GRUPOS_KEY = 'cadastro_trechos';   // por projeto: MotorFrete.iniciar define
let _grupos = [];
let _grupoEditando = null;   // id do trecho aberto (null = novo)
let _grupoCidades = [];      // cidades em edicao

async function lerGrupos() {
  const db = getDb();
  if (!db) throw new Error('Supabase indisponível');
  const { data, error } = await db.from('app_config').select('value').eq('key', CAD_GRUPOS_KEY).maybeSingle();
  if (error) throw error;
  const lista = Array.isArray(data && data.value) ? data.value : [];
  freteDefinirGrupos(lista);
  return lista;
}

async function gravarGrupos(lista) {
  const { error } = await getDb().from('app_config')
    .upsert({ key: CAD_GRUPOS_KEY, value: lista, updated_at: new Date().toISOString() });
  if (error) throw error;
  freteDefinirGrupos(lista);
}

function grpMsg(txt, erro) {
  const el = document.getElementById('cad-grupo-msg');
  if (!el) return;
  el.textContent = txt;
  el.style.color = erro ? '#b91c1c' : '#64748b';
}

function grpVista(qual) {
  document.getElementById('cad-grupo-lista').style.display = qual === 'lista' ? '' : 'none';
  document.getElementById('cad-grupo-form').style.display = qual === 'form' ? '' : 'none';
}

// ---------- LISTA ----------

async function carregarGrupos() {
  grpVista('lista');
  grpMsg('Carregando...');
  try {
    const podeEditar = await cadPodeEditar();
    document.getElementById('cad-grupo-novo').style.display = podeEditar ? '' : 'none';
    _grupos = await lerGrupos();
    renderGrupos();
    grpMsg(_grupos.length ? '' : 'Nenhum trecho cadastrado ainda.');
  } catch (e) {
    console.error(e);
    grpMsg('Não foi possível carregar os trechos (verifique a conexão).', true);
  }
}

function renderGrupos() {
  const lista = [..._grupos].sort((a, b) => a.nome.localeCompare(b.nome));
  document.getElementById('tb-cad-grupo').innerHTML = lista.map(g => {
    const ufs = [...new Set(g.cidades.map(c => c.uf))].sort().join(', ');
    const amostra = g.cidades.slice(0, 6).map(c => cadEsc(c.nome)).join(', ') + (g.cidades.length > 6 ? '…' : '');
    return `<tr style="cursor:pointer" onclick="abrirGrupo('${g.id}')" title="Abrir trecho">
      <td><b>${cadEsc(g.nome)}</b></td>
      <td>${g.cidades.length}</td>
      <td>${ufs}</td>
      <td style="font-size:.76rem;color:#475569">${amostra}</td>
    </tr>`;
  }).join('');
}

// ---------- FORMULARIO ----------

function novoGrupo() {
  return abrirGrupo(null);
}

async function abrirGrupo(id) {
  const podeEditar = await cadPodeEditar();
  const g = id ? _grupos.find(x => x.id === id) : null;
  if (!g && !podeEditar) return;
  _grupoEditando = g ? g.id : null;
  _grupoCidades = g ? g.cidades.map(c => ({ ...c })) : [];
  grpVista('form');
  const f = document.getElementById('cad-grupo-form');
  f.innerHTML = `
    <h3 style="margin-bottom:12px">${g ? 'Trecho — ' + cadEsc(g.nome) : 'Novo trecho'}</h3>
    <label class="tf-lbl">Nome do trecho *</label>
    <input id="grp-nome" type="text" maxlength="80" value="${cadEsc(g ? g.nome : '')}" placeholder="ex.: SC_Capital"
      style="width:100%;max-width:420px;border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:.85rem;margin-bottom:14px">
    <label class="tf-lbl">Cidades do trecho</label>
    <div class="grp-add">
      <div class="cid-ac" style="flex:1;min-width:260px"><input id="grp-cid-busca" type="text" autocomplete="off" placeholder="Digite a cidade para incluir..."><div class="cid-ac-lista" hidden></div>
        <select id="grp-cid-uf" hidden><option value="">UF</option>${FRETE_UFS.map(u => `<option>${u}</option>`).join('')}</select><input id="grp-cid-nome" type="hidden"></div>
    </div>
    <div class="tf-dica" style="margin:4px 0 6px">Escolha a cidade na lista e ela entra no trecho na hora — ou cole uma relação inteira:</div>
    <div class="grp-colar-acoes">
      <button class="cad-btn grp-so-editor" type="button" style="background:var(--primary-light);padding:5px 12px;font-size:.78rem" onclick="grpAbrirColar()">📋 Colar lista de cidades</button>
      <button class="cad-del grp-so-editor" type="button" onclick="grpLimparCidades()">Tirar todas</button>
    </div>
    <div id="grp-colar" class="grp-colar" hidden>
      <textarea id="grp-colar-txt" rows="7" placeholder="Cole aqui (do Excel, e-mail...). Aceita uma cidade por linha, 'Itajaí/SC', 'Itajaí - SC', 'Itajaí SC', duas colunas cidade | UF, ou várias separadas por vírgula."></textarea>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <label style="font-size:.76rem;color:#475569">UF quando a linha não trouxer
          <select id="grp-colar-uf"><option value="">— nenhuma —</option>${FRETE_UFS.map(u => `<option>${u}</option>`).join('')}</select></label>
        <button class="cad-btn" type="button" onclick="grpProcessarColagem()">Processar</button>
        <button class="cad-btn" type="button" style="background:#64748b" onclick="document.getElementById('grp-colar').hidden = true">Fechar</button>
      </div>
      <div id="grp-colar-res" style="font-size:.78rem;margin-top:8px"></div>
    </div>
    <div id="grp-cidades" class="grp-cidades"></div>
    <div id="grp-msg" style="font-size:.78rem;margin:10px 0 0;min-height:1em"></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button id="grp-salvar" class="cad-btn" type="button" onclick="salvarGrupo()">💾 Salvar trecho</button>
      <button class="cad-btn" type="button" style="background:#64748b" onclick="carregarGrupos()">Voltar</button>
      ${g ? '<button class="cad-del" type="button" style="margin-left:auto" onclick="excluirGrupo()">Excluir trecho</button>' : ''}
    </div>`;
  renderGrupoCidades(podeEditar);
  if (podeEditar) {
    try { await lerCidades(); } catch (e) { /* a busca avisa */ }
    const ac = cidAutocomplete('grp-cid-busca', 'grp-cid-uf', 'grp-cid-nome');
    // ao escolher uma cidade na lista, ja inclui no trecho e limpa a busca
    document.getElementById('grp-cid-nome').addEventListener('change', () => {
      const uf = document.getElementById('grp-cid-uf').value;
      const nome = document.getElementById('grp-cid-nome').value;
      if (!uf || !nome) return;
      if (!_grupoCidades.some(c => c.uf === uf && freteNorm(c.nome) === freteNorm(nome))) {
        _grupoCidades.push({ uf, nome });
        _grupoCidades.sort((a, b) => a.uf.localeCompare(b.uf) || a.nome.localeCompare(b.nome));
      }
      ac.definir('', '');
      const busca = document.getElementById('grp-cid-busca');
      busca.value = '';
      busca.classList.remove('cid-ok');
      busca.focus();
      renderGrupoCidades(true);
    });
  } else {
    f.querySelectorAll('input,select').forEach(el => { el.disabled = true; });
    f.querySelectorAll('#grp-salvar,.cad-del,.grp-so-editor').forEach(el => el.remove());
  }
}

function renderGrupoCidades(podeEditar) {
  const el = document.getElementById('grp-cidades');
  el.innerHTML = _grupoCidades.length
    ? _grupoCidades.map((c, i) => `<span class="grp-chip">${cadEsc(c.nome)}/${c.uf}${podeEditar ? ` <button type="button" title="Tirar do trecho" onclick="tirarCidadeGrupo(${i})">✕</button>` : ''}</span>`).join('')
    : '<span style="color:#64748b;font-size:.8rem">Nenhuma cidade ainda.</span>';
  const msg = document.getElementById('grp-msg');
  if (msg && !msg.dataset.fixo) { msg.textContent = `${_grupoCidades.length} cidade(s) no trecho.`; msg.style.color = '#64748b'; }
}

// ---------- COLAR LISTA ----------

function grpAbrirColar() {
  const box = document.getElementById('grp-colar');
  box.hidden = false;
  // UF padrao: a UF das cidades que ja estao no trecho, se forem todas da mesma
  const ufs = [...new Set(_grupoCidades.map(c => c.uf))];
  const sel = document.getElementById('grp-colar-uf');
  if (!sel.value && ufs.length === 1) sel.value = ufs[0];
  document.getElementById('grp-colar-txt').focus();
}

function grpLimparCidades() {
  if (!_grupoCidades.length || !confirm(`Tirar as ${_grupoCidades.length} cidade(s) deste trecho? (só vale depois de Salvar)`)) return;
  _grupoCidades = [];
  renderGrupoCidades(true);
}

// Acha a cidade no cadastro. Sem UF: usa a UF padrao; se nao houver, aceita
// so quando o nome e unico no Brasil. Retorna {cidade} | {erro, opcoes}.
function grpAcharCidade(nome, uf, ufPadrao) {
  const n = freteNorm(nome);
  const iguais = (_cidades || []).filter(c => freteNorm(c.nome) === n);
  if (uf) {
    const c = iguais.find(x => x.uf === uf);
    return c ? { cidade: c } : { erro: 'não encontrada' };
  }
  if (ufPadrao) {
    const c = iguais.find(x => x.uf === ufPadrao);
    if (c) return { cidade: c };
  }
  if (iguais.length === 1) return { cidade: iguais[0] };
  if (iguais.length > 1) return { erro: 'existe em mais de um estado', opcoes: iguais.map(x => x.uf) };
  return { erro: 'não encontrada' };
}

// Quebra o texto colado em pares {nome, uf}. Aceita linhas, colunas do Excel
// (tab), ";" e ","; uma parte que seja so uma UF vale para a cidade anterior;
// "Nome/UF", "Nome - UF" e "Nome UF" tambem.
function grpQuebrarColagem(txt) {
  const itens = [];
  for (const linha of txt.split(/\r?\n/)) {
    const partes = linha.split(/\t|;|,/).map(s => s.trim()).filter(Boolean);
    for (const parte of partes) {
      const soUf = freteNorm(parte);
      if (FRETE_UFS.includes(soUf) && soUf.length === 2) {
        if (itens.length && !itens[itens.length - 1].uf) itens[itens.length - 1].uf = soUf;
        continue;
      }
      if (/^(cidade|cidades|municipio|município|uf|estado)$/i.test(parte)) continue;   // cabecalho
      const m = parte.match(/^(.*?)\s*(?:\/|\s-\s|\s)\s*([A-Za-z]{2})$/);
      if (m && FRETE_UFS.includes(m[2].toUpperCase()) && m[1].trim()) {
        itens.push({ nome: m[1].trim(), uf: m[2].toUpperCase(), bruto: parte });
      } else {
        itens.push({ nome: parte.replace(/\s+/g, ' '), uf: '', bruto: parte });
      }
    }
  }
  return itens;
}

async function grpProcessarColagem() {
  const res = document.getElementById('grp-colar-res');
  const txt = document.getElementById('grp-colar-txt').value;
  if (!txt.trim()) { res.style.color = '#b91c1c'; res.textContent = 'Cole a relação de cidades na caixa.'; return; }
  try { await lerCidades(); } catch (e) { res.style.color = '#b91c1c'; res.textContent = 'Não foi possível carregar o cadastro de cidades.'; return; }
  const ufPadrao = document.getElementById('grp-colar-uf').value;
  let novas = 0, jaTinha = 0;
  const problemas = [];
  for (const it of grpQuebrarColagem(txt)) {
    // "Nome UF" pode ser nome composto (ex.: "Rio do Sul"): se nao achar com a UF, tenta o texto inteiro
    let r = grpAcharCidade(it.nome, it.uf, ufPadrao);
    if (r.erro && it.uf && it.bruto !== it.nome) {
      const r2 = grpAcharCidade(it.bruto, '', ufPadrao);
      if (r2.cidade) r = r2;
    }
    if (!r.cidade) { problemas.push(`${it.bruto} — ${r.erro}${r.opcoes ? ` (${r.opcoes.join(', ')}; informe a UF)` : ''}`); continue; }
    const c = r.cidade;
    if (_grupoCidades.some(x => x.uf === c.uf && freteNorm(x.nome) === freteNorm(c.nome))) { jaTinha++; continue; }
    _grupoCidades.push({ uf: c.uf, nome: c.nome });
    novas++;
  }
  _grupoCidades.sort((a, b) => a.uf.localeCompare(b.uf) || a.nome.localeCompare(b.nome));
  renderGrupoCidades(true);
  res.style.color = problemas.length ? '#b45309' : '#16a34a';
  res.innerHTML = `<b>${novas}</b> cidade(s) incluída(s)` + (jaTinha ? `, ${jaTinha} já estavam no trecho` : '') +
    (problemas.length ? `. <b>${problemas.length}</b> não entraram:<ul style="margin:4px 0 0 18px">${problemas.map(p => `<li>${cadEsc(p)}</li>`).join('')}</ul>` : '.') +
    `<div style="color:#64748b;margin-top:4px">Confira as cidades e clique em <b>Salvar trecho</b>.</div>`;
  if (!problemas.length) document.getElementById('grp-colar-txt').value = '';
  else document.getElementById('grp-colar-txt').value = problemas.map(p => p.split(' — ')[0]).join('\n');
}

function tirarCidadeGrupo(i) {
  _grupoCidades.splice(i, 1);
  renderGrupoCidades(true);
}

function grpFormMsg(txt, erro) {
  const el = document.getElementById('grp-msg');
  el.textContent = txt;
  el.style.color = erro ? '#b91c1c' : '#16a34a';
}

async function salvarGrupo() {
  if (!(await cadPodeEditar())) return;
  const nome = document.getElementById('grp-nome').value.trim();
  if (!nome) { grpFormMsg('Dê um nome ao trecho.', true); return; }
  if (!_grupoCidades.length) { grpFormMsg('Inclua pelo menos uma cidade.', true); return; }
  const btn = document.getElementById('grp-salvar');
  btn.disabled = true;
  try {
    const lista = await lerGrupos();
    if (lista.some(x => x.id !== _grupoEditando && freteNorm(x.nome) === freteNorm(nome))) {
      grpFormMsg('Já existe um trecho com esse nome.', true);
      return;
    }
    const agora = new Date().toISOString();
    const antigo = _grupoEditando ? lista.find(x => x.id === _grupoEditando) : null;
    const g = { id: antigo ? antigo.id : novoId(), nome, cidades: _grupoCidades, criadoEm: antigo ? antigo.criadoEm : agora, atualizadoEm: agora };
    const nova = antigo ? lista.map(x => (x.id === g.id ? g : x)) : [...lista, g];
    await gravarGrupos(nova);
    _grupos = nova;
    _grupoEditando = g.id;
    grpFormMsg(`Trecho "${nome}" salvo com ${g.cidades.length} cidade(s).`, false);
  } catch (e) {
    console.error(e);
    grpFormMsg('Não foi possível salvar (verifique a conexão).', true);
  } finally {
    btn.disabled = false;
  }
}

async function excluirGrupo() {
  if (!(await cadPodeEditar()) || !_grupoEditando) return;
  const g = _grupos.find(x => x.id === _grupoEditando);
  // nao deixa excluir trecho que alguma tabela usa
  let usos = [];
  try {
    usos = (await lerTabelas()).filter(t => (t.trechos || []).some(tr => tr.origemGrupoId === g.id || tr.destinoGrupoId === g.id)).map(t => t.nome);
  } catch (e) { /* segue */ }
  if (usos.length) { grpFormMsg(`Não dá para excluir: o trecho é usado na(s) tabela(s) ${usos.join(', ')}.`, true); return; }
  if (!g || !confirm(`Excluir o trecho "${g.nome}"?`)) return;
  try {
    const lista = (await lerGrupos()).filter(x => x.id !== g.id);
    await gravarGrupos(lista);
    _grupos = lista;
    _grupoEditando = null;
    await carregarGrupos();
    grpMsg(`Trecho "${g.nome}" excluído.`);
  } catch (e) {
    console.error(e);
    grpFormMsg('Não foi possível excluir (verifique a conexão).', true);
  }
}


// ===== simulador.js =====
// simulador.js — aba Simulador: testa as regras das tabelas (Cadastro >
// Tabela) com dados digitados a mao, usando o motor do frete-calculo.js.
// O calculo nao grava nada; "Salvar simulacao" guarda a entrada + resultado
// no Supabase (app_config, chave SIM_SALVAS_KEY), lista compartilhada:
//   [{ id, criadoEm (ISO), criadoPor (e-mail), descricao,
//      entrada: {servicoId, servicoNome, tabelaId (vazio = automatica), data, origem:{uf,cidade},
//                destino:{uf,cidade}, peso, m3, valorNF, valorCte},
//      resultado: {tabelaNome, vigencia, trecho, pesos, itens:[{rotulo, valor}], subtotal, icms, total} }]

let _simTabelas = [];
let _simServicos = [];
let _simIcms = {};
let _simLigado = false;
let _simOrig = null;
let _simDest = null;
let _simUltima = null;     // ultima simulacao calculada (o que "Salvar" grava)
let _simSalvas = [];
let SIM_SALVAS_KEY = 'simulacoes_frete';   // por projeto: MotorFrete.iniciar define
const SIM_SALVAS_MAX = 2000;

async function carregarSimulador() {
  const el = document.getElementById('sim-msg');
  el.textContent = 'Carregando tabelas...';
  try {
    [_simTabelas, _simServicos, _simIcms] = await Promise.all([lerTabelas(), lerServicos(), lerIcms(), lerGrupos()]);
    el.textContent = _simTabelas.length ? '' : 'Nenhuma tabela cadastrada ainda (Cadastro ▾ > Tabela).';
  } catch (e) {
    console.error(e);
    el.textContent = 'Não foi possível carregar as tabelas (verifique a conexão).';
    return;
  }
  const srv = document.getElementById('sim-servico');
  const atual = srv.value;
  srv.innerHTML = '<option value="">— selecione —</option>' +
    _simServicos.map(s => `<option value="${s.id}"${s.id === atual ? ' selected' : ''}>${cadEsc(s.nome)}</option>`).join('');
  const ufOpts = '<option value="">UF</option>' + FRETE_UFS.map(u => `<option>${u}</option>`).join('');
  ['sim-ouf', 'sim-duf'].forEach(id => {
    const s = document.getElementById(id);
    if (!s.options.length) s.innerHTML = ufOpts;
  });
  const data = document.getElementById('sim-data');
  if (!data.value) data.value = new Date().toISOString().slice(0, 10);
  if (!_simLigado) {
    _simLigado = true;
    _simOrig = cidAutocomplete('sim-orig', 'sim-ouf', 'sim-ocid', { grupoId: 'sim-ogrp' });
    _simDest = cidAutocomplete('sim-dest', 'sim-duf', 'sim-dcid', { grupoId: 'sim-dgrp' });
    cidLigarSeletorGrupo('sim-ogrp-sel', 'sim-ogrp', _simOrig);
    cidLigarSeletorGrupo('sim-dgrp-sel', 'sim-dgrp', _simDest);
  } else {
    // a lista de trechos cadastrados pode ter mudado: refaz as opcoes
    simRecarregarGrupos();
  }
  simAtualizarTabelas();
  await cadPodeEditar();
  carregarSimSalvas();
}

function simRecarregarGrupos() {
  for (const [selId, grpId] of [['sim-ogrp-sel', 'sim-ogrp'], ['sim-dgrp-sel', 'sim-dgrp']]) {
    const sel = document.getElementById(selId);
    const atual = document.getElementById(grpId).value;
    sel.innerHTML = (_freteGruposLista || []).length
      ? '<option value="">ou escolha um trecho cadastrado…</option>' + [...(_freteGruposLista || [])].sort((a, b) => a.nome.localeCompare(b.nome))
          .map(g => `<option value="${g.id}"${g.id === atual ? ' selected' : ''}>${cadEsc(g.nome)} (${g.cidades.length} cidades)</option>`).join('')
      : '<option value="">nenhum trecho cadastrado (Cadastro ▾ > Trecho)</option>';
  }
}

// Lista de tabelas do servico escolhido (para escolher uma na mao).
function simAtualizarTabelas() {
  const srvId = document.getElementById('sim-servico').value;
  const sel = document.getElementById('sim-tabela');
  const atual = sel.value;
  const doServico = _simTabelas.filter(t => t.servicoId === srvId)
    .sort((a, b) => (b.vigencia || '').localeCompare(a.vigencia || ''));
  sel.innerHTML = '<option value="">Automática (vigência + trecho)</option>' +
    doServico.map(t => `<option value="${t.id}"${t.id === atual ? ' selected' : ''}>${cadEsc(t.nome)} — ${freteVigTxt(t)}</option>`).join('');
}

function simerro(txt) {
  _simUltima = null;
  document.getElementById('sim-resultado').innerHTML = `<div class="sim-aviso">${cadEsc(txt)}</div>`;
}

function simPesosTxt(p) {
  if (!p.fator) return `Peso considerado: <b>${freteFmtNum(p.considerado)} kg</b> (peso real; a tabela não tem fator de cubagem)`;
  return `Peso real ${freteFmtNum(p.real)} kg · peso cubado ${freteFmtNum(p.m3)} m³ × ${freteFmtNum(p.fator)} kg/m³ = ${freteFmtNum(p.cubado)} kg · ` +
    `peso considerado: <b>${freteFmtNum(p.considerado)} kg</b> (${p.cubado > p.real ? 'cubado' : 'real'})`;
}

function simular() {
  const v = id => document.getElementById(id).value;
  const servicoId = v('sim-servico');
  const origem = { uf: v('sim-ouf'), cidade: v('sim-ocid'), grupoId: v('sim-ogrp') };
  const destino = { uf: v('sim-duf'), cidade: v('sim-dcid'), grupoId: v('sim-dgrp') };
  // Trecho cadastrado: a UF (para o ICMS) vem das cidades do trecho
  const avisosLugar = [];
  for (const [lug, rot] of [[origem, 'início'], [destino, 'fim']]) {
    if (!lug.grupoId) continue;
    const g = _freteGrupos[lug.grupoId];
    lug.uf = freteGrupoUf(lug.grupoId) || (g && g.cidades[0] ? g.cidades[0].uf : '');
    lug.cidade = '';
    if (!freteGrupoUf(lug.grupoId)) avisosLugar.push(`O trecho de ${rot} "${g ? g.nome : '?'}" tem cidades de mais de um estado — para o ICMS foi usada a UF ${lug.uf}.`);
  }
  const entrada = {
    peso: freteNum(v('sim-peso')) || 0,
    m3: freteNum(v('sim-m3')) || 0,
    valorNF: freteNum(v('sim-nf')) || 0,
    valorCte: freteNum(v('sim-cte')),
    ufOrigem: origem.uf,
    ufDestino: destino.uf,
  };
  if (!servicoId) return simerro('Escolha o serviço.');
  if (!origem.grupoId && (!origem.uf || !origem.cidade)) return simerro('Escolha o trecho de início: uma cidade na lista (digite parte do nome e clique na sugestão) ou um trecho cadastrado.');
  if (!destino.grupoId && (!destino.uf || !destino.cidade)) return simerro('Escolha o trecho de fim: uma cidade na lista (digite parte do nome e clique na sugestão) ou um trecho cadastrado.');

  let escolha;
  let avisoVig = '';
  const tabId = v('sim-tabela');
  if (tabId) {
    const t = _simTabelas.find(x => x.id === tabId);
    const m = freteMelhorTrecho(t, origem, destino);
    if (!m) return simerro(`A tabela "${t.nome}" não tem trecho para essa origem e esse destino — as regras ficam no trecho.`);
    if (!freteVigente(t, v('sim-data'))) avisoVig = `A tabela "${t.nome}" (${freteVigTxt(t)}) não vale na data do frete ${tabFmtData(v('sim-data'))} — calculado mesmo assim porque foi escolhida na mão.`;
    escolha = { tabela: t, trecho: m.trecho, manual: true };
  } else {
    escolha = freteAcharTabela(_simTabelas, { servicoId, data: v('sim-data'), origem, destino });
    if (!escolha) {
      return simerro('Nenhuma tabela deste serviço válida na data do frete tem um trecho que case com essa origem e esse destino.');
    }
  }

  const t = escolha.tabela;
  const res = freteCalcular(t, escolha.trecho, entrada, _simIcms);
  const dec = Number.isInteger(t.precisao) ? t.precisao : 2;
  const lugar = (uf, cid) => cid ? `${cadEsc(cid)}/${uf}` : `${uf} (estado todo)`;
  const trechoTxt = cadEsc(freteTrechoTxt(escolha.trecho));

  const avisos = [...avisosLugar, ...res.avisos];
  if (avisoVig) avisos.unshift(avisoVig);
  _simUltima = {
    entrada: {
      servicoId, servicoNome: (_simServicos.find(s => s.id === servicoId) || {}).nome || '',
      tabelaId: tabId || '', data: v('sim-data'),
      origem: { ...origem, grupoNome: origem.grupoId ? (_freteGrupos[origem.grupoId] || {}).nome || '' : '' },
      destino: { ...destino, grupoNome: destino.grupoId ? (_freteGrupos[destino.grupoId] || {}).nome || '' : '' },
      peso: entrada.peso, m3: entrada.m3, valorNF: entrada.valorNF, valorCte: entrada.valorCte,
    },
    resultado: {
      tabelaNome: t.nome, vigencia: t.vigencia, vigenciaInicio: t.vigenciaInicio || '',
      trecho: trechoTxt.replace(/<[^>]+>/g, ''), pesos: res.pesos,
      itens: res.itens.map(i => ({ rotulo: i.rotulo, valor: i.valor })),
      subtotal: res.subtotal, icms: res.icms ? { aliquota: res.icms.aliquota, valor: res.icms.valor } : null, total: res.total,
    },
  };

  document.getElementById('sim-resultado').innerHTML = `
    <div class="sim-cab">
      <div><b>${cadEsc(t.nome)}</b> · ${freteVigTxt(t)} ${escolha.manual ? '(escolhida na mão)' : '(automática)'}</div>
      <div>Trecho: ${trechoTxt}</div>
      <div>${simPesosTxt(res.pesos)}</div>
    </div>
    <table>
      <thead><tr><th>Item</th><th>Cálculo</th><th style="width:130px;text-align:right">Valor</th></tr></thead>
      <tbody>
        ${res.itens.map(i => `<tr>
          <td><b>${i.rotulo}</b></td>
          <td style="font-size:.78rem">${cadEsc(i.conta)}${i.obs.length ? `<div style="color:#b45309">${i.obs.map(cadEsc).join('<br>')}</div>` : ''}</td>
          <td style="text-align:right">R$ ${freteFmt(i.valor, dec)}</td>
        </tr>`).join('') || '<tr><td colspan="3" style="color:#64748b">A tabela não tem itens na composição.</td></tr>'}
        ${t.somaIcms ? `<tr class="sim-sub"><td colspan="2">Subtotal (sem ICMS)</td><td style="text-align:right">R$ ${freteFmt(res.subtotal, dec)}</td></tr>` : ''}
        ${res.icms ? `<tr><td><b>ICMS ${freteFmtNum(res.icms.aliquota)}%</b></td><td style="font-size:.78rem">${cadEsc(res.icms.conta)}</td><td style="text-align:right">R$ ${freteFmt(res.icms.valor, dec)}</td></tr>` : ''}
        <tr class="sim-total"><td colspan="2">Total do frete${res.icms ? ' (com ICMS)' : ''}</td><td style="text-align:right">R$ ${freteFmt(res.total, dec)}</td></tr>
      </tbody>
    </table>
    ${avisos.length ? `<div class="sim-aviso">${avisos.map(cadEsc).join('<br>')}</div>` : ''}
    ${_cadPodeEditar ? `<div class="sim-salvar">
      <input id="sim-desc" type="text" maxlength="150" placeholder="Descrição da simulação (opcional)">
      <button class="cad-btn" type="button" onclick="salvarSimulacao()">💾 Salvar simulação</button>
      <span id="sim-salvar-msg" style="font-size:.78rem"></span>
    </div>` : ''}`;
}

// ---------- SIMULACOES SALVAS ----------

async function lerSimSalvas() {
  const db = getDb();
  if (!db) throw new Error('Supabase indisponível');
  const { data, error } = await db.from('app_config').select('value').eq('key', SIM_SALVAS_KEY).maybeSingle();
  if (error) throw error;
  return Array.isArray(data && data.value) ? data.value : [];
}

async function gravarSimSalvas(lista) {
  const { error } = await getDb().from('app_config')
    .upsert({ key: SIM_SALVAS_KEY, value: lista, updated_at: new Date().toISOString() });
  if (error) throw error;
}

async function carregarSimSalvas() {
  const msg = document.getElementById('sim-salvas-msg');
  try {
    _simSalvas = await lerSimSalvas();
    renderSimSalvas();
  } catch (e) {
    console.error(e);
    msg.textContent = 'Não foi possível carregar as simulações salvas.';
  }
}

async function salvarSimulacao() {
  if (!(await cadPodeEditar()) || !_simUltima) return;
  const msg = document.getElementById('sim-salvar-msg');
  msg.style.color = '#64748b';
  msg.textContent = 'Salvando...';
  try {
    const lista = await lerSimSalvas();   // rele antes de gravar para nao apagar a de outra pessoa
    const nova = {
      id: novoId(),
      criadoEm: new Date().toISOString(),
      criadoPor: _cadEmail || '',
      descricao: document.getElementById('sim-desc').value.trim(),
      ..._simUltima,
    };
    const final = [nova, ...lista].slice(0, SIM_SALVAS_MAX);
    await gravarSimSalvas(final);
    _simSalvas = final;
    renderSimSalvas();
    msg.style.color = '#16a34a';
    msg.textContent = 'Simulação salva.';
    document.getElementById('sim-desc').value = '';
  } catch (e) {
    console.error(e);
    msg.style.color = '#b91c1c';
    msg.textContent = 'Não foi possível salvar (verifique a conexão).';
  }
}

function simLugarTxt(p) {
  return p.grupoId ? `Trecho ${(_freteGrupos[p.grupoId] || {}).nome || p.grupoNome || '?'}` : `${p.cidade}/${p.uf}`;
}

function simFmtDataHora(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function simSalvasFiltradas() {
  const busca = freteNorm(document.getElementById('sim-salvas-busca').value);
  if (!busca) return _simSalvas;
  return _simSalvas.filter(s => freteNorm([s.descricao, s.entrada.servicoNome, s.resultado.tabelaNome,
    s.entrada.origem.cidade, s.entrada.origem.uf, s.entrada.destino.cidade, s.entrada.destino.uf, s.criadoPor].join(' ')).includes(busca));
}

function renderSimSalvas() {
  const lista = simSalvasFiltradas();
  const lugar = p => p.grupoId ? `Trecho ${cadEsc((_freteGrupos[p.grupoId] || {}).nome || p.grupoNome || '?')}` : `${cadEsc(p.cidade)}/${p.uf}`;
  document.getElementById('tb-sim-salvas').innerHTML = lista.map(s => `<tr>
      <td style="white-space:nowrap">${simFmtDataHora(s.criadoEm)}<div style="font-size:.68rem;color:#64748b">${cadEsc((s.criadoPor || '').split('@')[0])}</div></td>
      <td>${cadEsc(s.descricao || '—')}</td>
      <td style="font-size:.76rem">${cadEsc(s.entrada.servicoNome)}<div style="color:#64748b">${cadEsc(s.resultado.tabelaNome)}</div></td>
      <td>${lugar(s.entrada.origem)} → ${lugar(s.entrada.destino)}</td>
      <td style="text-align:right">${freteFmtNum(s.entrada.peso)}</td>
      <td style="text-align:right">${freteFmtNum(s.entrada.m3)}</td>
      <td style="text-align:right">${freteFmtNum(s.resultado.pesos ? s.resultado.pesos.considerado : s.entrada.peso)}</td>
      <td style="text-align:right">R$ ${freteFmt(s.entrada.valorNF)}</td>
      <td style="text-align:right;font-weight:700">R$ ${freteFmt(s.resultado.total)}</td>
      <td style="white-space:nowrap;text-align:right">
        <button class="cad-btn" type="button" style="padding:4px 10px;font-size:.74rem" onclick="abrirSimulacao('${s.id}')">Abrir</button>
        ${_cadPodeEditar ? `<button class="cad-del" type="button" onclick="excluirSimulacao('${s.id}')">Excluir</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="10" style="color:#64748b">Nenhuma simulação salva.</td></tr>';
  document.getElementById('sim-salvas-msg').textContent =
    `${lista.length.toLocaleString('pt-BR')} simulação(ões)${lista.length !== _simSalvas.length ? ` de ${_simSalvas.length.toLocaleString('pt-BR')}` : ''}.`;
}

// Recarrega a simulacao no formulario e recalcula com as tabelas de hoje.
async function abrirSimulacao(id) {
  const s = _simSalvas.find(x => x.id === id);
  if (!s) return;
  const e = s.entrada;
  const br = n => (n === null || n === undefined) ? '' : String(n).replace('.', ',');
  document.getElementById('sim-servico').value = e.servicoId;
  simAtualizarTabelas();
  document.getElementById('sim-tabela').value = _simTabelas.some(t => t.id === e.tabelaId) ? e.tabelaId : '';
  document.getElementById('sim-data').value = e.data || '';
  await lerCidades().catch(() => {});
  _simOrig.definir(e.origem.uf, e.origem.cidade, e.origem.grupoId);
  _simDest.definir(e.destino.uf, e.destino.cidade, e.destino.grupoId);
  document.getElementById('sim-peso').value = br(e.peso);
  document.getElementById('sim-m3').value = br(e.m3);
  document.getElementById('sim-nf').value = br(e.valorNF);
  document.getElementById('sim-cte').value = br(e.valorCte);
  simular();
  const box = document.getElementById('sim-resultado');
  const totalAgora = _simUltima ? _simUltima.resultado.total : null;
  if (totalAgora !== null && Math.abs(totalAgora - s.resultado.total) >= 0.01) {
    box.insertAdjacentHTML('afterbegin', `<div class="sim-aviso" style="margin:0 0 10px">Salva em ${simFmtDataHora(s.criadoEm)} com total R$ ${freteFmt(s.resultado.total)}. Com as tabelas de hoje o total é R$ ${freteFmt(totalAgora)} (a tabela mudou desde então).</div>`);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function excluirSimulacao(id) {
  if (!(await cadPodeEditar())) return;
  const s = _simSalvas.find(x => x.id === id);
  if (!s || !confirm(`Excluir a simulação ${s.descricao ? '"' + s.descricao + '"' : 'de ' + simFmtDataHora(s.criadoEm)}?`)) return;
  try {
    const lista = (await lerSimSalvas()).filter(x => x.id !== id);
    await gravarSimSalvas(lista);
    _simSalvas = lista;
    renderSimSalvas();
  } catch (e) {
    console.error(e);
    document.getElementById('sim-salvas-msg').textContent = 'Não foi possível excluir (verifique a conexão).';
  }
}

function exportarSimSalvas() {
  const dados = simSalvasFiltradas().map(s => {
    const e = s.entrada, r = s.resultado;
    return {
      'Salva em': simFmtDataHora(s.criadoEm), 'Salva por': s.criadoPor || '', Descrição: s.descricao || '',
      Serviço: e.servicoNome, Tabela: r.tabelaNome, 'Válida até': r.vigencia, 'Início vigência': r.vigenciaInicio || '', 'Data do frete': e.data, Trecho: r.trecho,
      Origem: simLugarTxt(e.origem), Destino: simLugarTxt(e.destino),
      'Peso real (kg)': e.peso, 'Cubagem (m³)': e.m3, 'Peso considerado (kg)': r.pesos ? r.pesos.considerado : e.peso,
      'Valor NF': e.valorNF, 'Valor CT-e informado': e.valorCte ?? '',
      ...Object.fromEntries((r.itens || []).map(i => [i.rotulo, i.valor])),
      'Subtotal': r.subtotal, 'ICMS': r.icms ? r.icms.valor : '', 'Total': r.total,
    };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dados), 'Simulações');
  XLSX.writeFile(wb, `simulacoes_frete_${new Date().toISOString().slice(0, 10)}.xlsx`);
}


// ===== auditoria.js =====
// auditoria.js — aba Auditoria: recalcula cada minuta do Excel do portal
// (linhas passadas em MotorFrete.iniciar({auditoria:{linhas}}), via mfLinhas()) pelas tabelas cadastradas (Cadastro > Tabela) e compara com o
// frete cobrado. Somente leitura. Aba visivel so para CAD_EDITORES.
//
// Por minuta: servico = coluna SERVICO do Excel (casada pelo nome com o
// Cadastro > Servico); data = emissao (tabela valida nessa data: ate `vigencia`, desde `vigenciaInicio`); origem = CIDADE/UF ORIGEM;
// destino = local de entrega efetivo (EFF_CIDADE/EFF_UF, o mesmo do
// dashboard); peso = PESO CALC; cubagem = METRAGEM CUBICA; valor da
// mercadoria = NF VALOR; valor do CT-e (base do "% sobre CT-e") = FRETE TOTAL.

let _audTabelas = [];
let _audServicos = [];
let _audIcms = {};
let _audRes = [];          // resultado de todas as minutas
let _audFiltrado = [];
const AUD_LIMITE_TELA = 400;

// Colunas de taxa do Excel mostradas no detalhe da minuta.
const AUD_EXCEL_ITENS = [
  ['TX. COLETA', 'Coleta'], ['TX. ENTREGA', 'Entrega'], ['TX. FRETE PESO', 'Frete peso'],
  ['TX. GRIS', 'GRIS'], ['TX. PEDAGIO', 'Pedágio'], ['TX. DESPACHO', 'Despacho'],
  ['TX. NOTA', 'Taxa nota'], ['TX. OUTROS', 'Outros'], ['FRETE TAS', 'TAS'], ['FRETE TRT', 'TRT'],
  ['FRETE TDE', 'TDE'], ['FRETE SET/CAT', 'SET/CAT'], ['VALOR ICMS', 'ICMS'],
];

// O relatorio do portal nao traz a coluna do Advalorem: na Forte a diferenca
// entre o FRETE TOTAL e a soma das taxas e 0,25% da NF em ~97% das minutas.
function audNaoDetalhado(r) {
  const soma = AUD_EXCEL_ITENS.reduce((s, [c]) => s + (+r[c] || 0), 0);
  return Math.round(((+r['FRETE TOTAL'] || 0) - soma) * 100) / 100;
}

const AUD_STATUS = {
  OK: ['OK', '#16a34a'],
  DIVERGENTE: ['Divergente', '#dc2626'],
  SEM_TABELA: ['Sem tabela/trecho', '#b45309'],
  SEM_SERVICO: ['Serviço não cadastrado', '#64748b'],
  COTACAO: ['Cotação', '#7c3aed'],
};

async function carregarAuditoria() {
  const msg = document.getElementById('aud-msg');
  msg.textContent = 'Carregando tabelas...';
  try {
    [_audTabelas, _audServicos, _audIcms] = await Promise.all([lerTabelas(), lerServicos(), lerIcms(), lerGrupos()]);
  } catch (e) {
    console.error(e);
    msg.textContent = 'Não foi possível carregar as tabelas (verifique a conexão).';
    return;
  }
  msg.textContent = '';
  audMontarFiltros();
  audCalcularTudo();
  audAplicarFiltros();
}

function audMontarFiltros() {
  const rows = mfLinhas();
  const encher = (id, valores, rotuloTodos, fmt) => {
    const sel = document.getElementById(id);
    const atual = sel.value;
    sel.innerHTML = `<option value="">${rotuloTodos}</option>` +
      valores.map(v => `<option value="${cadEsc(v)}"${v === atual ? ' selected' : ''}>${cadEsc(fmt ? fmt(v) : v)}</option>`).join('');
  };
  encher('aud-f-mes', [...new Set(rows.map(r => r.MES))].sort().reverse(), 'Todos os meses', m => mfMesNome(m));
  encher('aud-f-servico', [...new Set(rows.map(r => r.SERVICO).filter(Boolean))].sort(), 'Todos os serviços');
  encher('aud-f-uf', [...new Set(rows.map(r => r.EFF_UF).filter(Boolean))].sort(), 'Todas as UFs');
}

function audCalcularTudo() {
  const srvPorNome = Object.fromEntries(_audServicos.map(s => [freteNorm(s.nome), s.id]));
  _audRes = mfLinhas().map(r => {
    const excel = +r['FRETE TOTAL'] || 0;
    const base = { r, excel, calc: null, dif: null, escolha: null, res: null };
    const servicoId = srvPorNome[freteNorm(r.SERVICO)];
    if (!servicoId) return { ...base, status: 'SEM_SERVICO' };
    const origem = { uf: r.ORIG_UF, cidade: r.ORIG_CIDADE };
    const destino = { uf: r.EFF_UF, cidade: r.EFF_CIDADE };
    const escolha = freteAcharTabela(_audTabelas, { servicoId, data: r['DATA EMISSAO'], origem, destino });
    if (!escolha) return { ...base, status: 'SEM_TABELA' };
    const res = freteCalcular(escolha.tabela, escolha.trecho, {
      peso: r.PESO_REAL ?? r.PESO_CALC, m3: r.M3, valorNF: r['NF VALOR'], valorCte: excel,
      ufOrigem: r.ORIG_UF, ufDestino: r.EFF_UF,
    }, _audIcms);
    const dif = Math.round((res.total - excel) * 100) / 100;
    return { ...base, calc: res.total, dif, escolha, res, status: 'CALCULADO' };
  });
}

function audTolerancia() {
  const t = freteNum(document.getElementById('aud-f-tol').value);
  return t === null ? 0.1 : Math.abs(t);
}

function audStatusFinal(x) {
  // Frete negociado por cotacao (fora da tabela): status proprio, fora dos
  // divergentes e da soma das diferencas (o calculo continua no detalhe).
  if (x.r.COTACAO === 'S') return 'COTACAO';
  if (x.status !== 'CALCULADO') return x.status;
  return Math.abs(x.dif) <= audTolerancia() ? 'OK' : 'DIVERGENTE';
}

function audAplicarFiltros() {
  const v = id => document.getElementById(id).value;
  const mes = v('aud-f-mes'), srv = v('aud-f-servico'), uf = v('aud-f-uf'), st = v('aud-f-status');
  const busca = freteNorm(v('aud-f-busca'));
  const base = _audRes.filter(x => (!mes || x.r.MES === mes) && (!srv || x.r.SERVICO === srv) && (!uf || x.r.EFF_UF === uf) &&
    (!busca || freteNorm(`${x.r.MINUTA} ${x.r.CTE} ${x.r.NF_DOC} ${x.r.EFF_LOCAL} ${x.r.EFF_CIDADE}`).includes(busca)));
  base.forEach(x => { x.sf = audStatusFinal(x); });
  const comColunas = audFiltrarColunas(base);   // filtros digitados sob o cabecalho da tabela
  _audFiltrado = st ? comColunas.filter(x => x.sf === st) : comColunas;
  audRenderResumo(comColunas);
  audRenderTabela();
}

// ---------- FILTRO POR COLUNA (linha de campos sob o cabecalho da tabela) ----------
// Texto: procura o trecho digitado (sem acento/maiuscula). Valores: numero ou
// comparacao (">100", "<0", ">=500", "=0"); so o numero procura no valor formatado.
const AUD_COLS = [
  { k: 'minuta', txt: x => `${x.r.MINUTA} ${x.r.CTE || ''}` },
  { k: 'emissao', txt: x => tabFmtData(x.r['DATA EMISSAO']) },
  { k: 'servico', txt: x => x.r.SERVICO },
  { k: 'tabela_portal', txt: x => `${x.r.TABELA_PORTAL || ''} ${x.escolha ? x.escolha.tabela.nome : ''}` },
  { k: 'cotacao', txt: x => x.r.COTACAO === 'S' ? `sim ${x.r.COTACAO_NUM || ''}` : 'nao' },
  { k: 'origem', txt: x => `${x.r.ORIG_CIDADE}/${x.r.ORIG_UF}` },
  { k: 'destino', txt: x => `${x.r.EFF_CIDADE}/${x.r.EFF_UF} ${x.r.EFF_LOCAL || ''}` },
  { k: 'nf', num: x => +x.r['NF VALOR'] || 0 },
  { k: 'peso', num: x => +x.r.PESO_CALC || 0 },
  { k: 'm3', num: x => +x.r.M3 || 0 },
  { k: 'excel', num: x => x.excel },
  { k: 'tabela', num: x => x.calc },
  { k: 'dif', num: x => x.dif },
  { k: 'status', txt: x => AUD_STATUS[x.sf][0] },
];

function audPassaColuna(col, x, filtro) {
  if (col.txt) return freteNorm(col.txt(x)).includes(freteNorm(filtro));
  const v = col.num(x);
  const m = filtro.replace(/\s/g, '').match(/^(>=|<=|>|<|=)(-?[\d.,]+)$/);
  if (m) {
    const n = freteNum(m[2]);
    if (v === null || v === undefined || n === null) return false;
    switch (m[1]) {
      case '>': return v > n;
      case '<': return v < n;
      case '>=': return v >= n;
      case '<=': return v <= n;
      default: return Math.abs(v - n) < 0.005;
    }
  }
  if (v === null || v === undefined) return filtro.trim() === '-';
  const f = filtro.replace(/\s/g, '');
  return freteFmt(v).includes(f) || freteFmtNum(v).includes(f) || String(v).includes(f.replace(',', '.'));
}

function audFiltrarColunas(lista) {
  const ativos = AUD_COLS.map(c => {
    const el = document.getElementById('aud-c-' + c.k);
    const f = el ? el.value.trim() : '';
    if (el) el.classList.toggle('ativo', !!f);
    return f ? [c, f] : null;
  }).filter(Boolean);
  if (!ativos.length) return lista;
  return lista.filter(x => ativos.every(([c, f]) => audPassaColuna(c, x, f)));
}

function audRenderResumo(base) {
  const cont = k => base.filter(x => x.sf === k).length;
  const calc = base.filter(x => x.calc !== null && x.sf !== 'COTACAO');
  const somaExcel = calc.reduce((s, x) => s + x.excel, 0);
  const somaCalc = calc.reduce((s, x) => s + x.calc, 0);
  const card = (rot, val, cor, st) => `<div class="aud-card" ${st ? `onclick="audFiltrarStatus('${st}')" style="cursor:pointer"` : ''}>
      <div class="aud-card-rot">${rot}</div><div class="aud-card-val" style="color:${cor || 'var(--primary)'}">${val}</div></div>`;
  document.getElementById('aud-resumo').innerHTML =
    card('Minutas no filtro', base.length.toLocaleString('pt-BR')) +
    card('OK', cont('OK').toLocaleString('pt-BR'), AUD_STATUS.OK[1], 'OK') +
    card('Divergentes', cont('DIVERGENTE').toLocaleString('pt-BR'), AUD_STATUS.DIVERGENTE[1], 'DIVERGENTE') +
    card('Sem tabela/trecho', cont('SEM_TABELA').toLocaleString('pt-BR'), AUD_STATUS.SEM_TABELA[1], 'SEM_TABELA') +
    card('Serviço não cadastrado', cont('SEM_SERVICO').toLocaleString('pt-BR'), AUD_STATUS.SEM_SERVICO[1], 'SEM_SERVICO') +
    card('Com cotação', cont('COTACAO').toLocaleString('pt-BR'), AUD_STATUS.COTACAO[1], 'COTACAO') +
    card('Excel × tabela (calculadas)', `R$ ${freteFmt(somaExcel)}<br><span style="font-size:.75rem">tabela R$ ${freteFmt(somaCalc)} · dif. R$ ${freteFmt(somaCalc - somaExcel)}</span>`);
}

function audFiltrarStatus(st) {
  const sel = document.getElementById('aud-f-status');
  sel.value = sel.value === st ? '' : st;
  audAplicarFiltros();
}

function audRenderTabela() {
  const lugar = (cid, uf) => cid ? `${cadEsc(cid)}/${uf}` : (uf || '—');
  const linhas = _audFiltrado.slice(0, AUD_LIMITE_TELA);
  document.getElementById('tb-auditoria').innerHTML = linhas.map((x, i) => {
    const r = x.r;
    const [rot, cor] = AUD_STATUS[x.sf];
    return `<tr style="cursor:pointer" onclick="audDetalhe(${i})">
      <td><b>${cadEsc(r.MINUTA)}</b><div style="font-size:.7rem;color:#64748b">CT-e ${cadEsc(r.CTE || '—')}</div></td>
      <td>${r['DATA EMISSAO'] ? tabFmtData(r['DATA EMISSAO']) : ''}</td>
      <td style="font-size:.74rem">${cadEsc(r.SERVICO || '—')}</td>
      <td style="font-size:.72rem">${cadEsc(r.TABELA_PORTAL || '—')}${x.escolha ? `<div style="color:#2563a8">calc.: ${cadEsc(x.escolha.tabela.nome)} <span style="color:#64748b">(${freteVigTxt(x.escolha.tabela)})</span></div>` : ''}</td>
      <td>${r.COTACAO === 'S' ? `<span class="aud-st" style="background:#fef3c71a;background:#fef3c7;color:#92400e">Sim${r.COTACAO_NUM ? ' · ' + cadEsc(r.COTACAO_NUM) : ''}</span>` : '<span style="color:#94a3b8;font-size:.76rem">Não</span>'}</td>
      <td>${lugar(r.ORIG_CIDADE, r.ORIG_UF)}</td>
      <td>${lugar(r.EFF_CIDADE, r.EFF_UF)}</td>
      <td style="text-align:right">R$ ${freteFmt(r['NF VALOR'])}</td>
      <td style="text-align:right">${freteFmtNum(r.PESO_CALC)}</td>
      <td style="text-align:right">${freteFmtNum(r.M3)}</td>
      <td style="text-align:right">R$ ${freteFmt(x.excel)}</td>
      <td style="text-align:right">${x.calc !== null ? 'R$ ' + freteFmt(x.calc) : '—'}</td>
      <td style="text-align:right;font-weight:700;color:${x.dif === null || x.sf === 'COTACAO' ? '#64748b' : Math.abs(x.dif) <= audTolerancia() ? '#16a34a' : '#dc2626'}">${x.dif !== null ? freteFmt(x.dif) : '—'}</td>
      <td><span class="aud-st" style="background:${cor}1a;color:${cor}">${rot}</span></td>
    </tr>
    <tr id="aud-det-${i}" style="display:none"><td colspan="14" class="aud-det"></td></tr>`;
  }).join('') || '<tr><td colspan="14" style="color:#64748b">Nenhuma minuta neste filtro.</td></tr>';
  document.getElementById('aud-rodape').textContent = _audFiltrado.length > AUD_LIMITE_TELA
    ? `Mostrando ${AUD_LIMITE_TELA} de ${_audFiltrado.length.toLocaleString('pt-BR')} minutas — use os filtros ou exporte para Excel para ver todas.`
    : `${_audFiltrado.length.toLocaleString('pt-BR')} minuta(s).`;
}

function audDetalhe(i) {
  const tr = document.getElementById('aud-det-' + i);
  if (tr.style.display !== 'none') { tr.style.display = 'none'; return; }
  const x = _audFiltrado[i];
  const r = x.r;
  const excelItens = AUD_EXCEL_ITENS.filter(([c]) => +r[c]).map(([c, rot]) =>
    `<tr><td>${rot}</td><td style="text-align:right">R$ ${freteFmt(r[c])}</td></tr>`).join('') + (() => {
      const nd = audNaoDetalhado(r);
      return Math.abs(nd) >= 0.01 ? `<tr><td>Não detalhado no relatório <span style="color:#64748b;font-size:.68rem">(provável Advalorem: ${freteFmtNum(Math.round(nd / (+r['NF VALOR'] || 1) * 100000) / 1000)}% da NF)</span></td><td style="text-align:right">R$ ${freteFmt(nd)}</td></tr>` : '';
    })();
  let calcHtml;
  if (x.res) {
    const t = x.escolha.tabela, trc = x.escolha.trecho;
    const lugar = (uf, cid) => cid ? `${cadEsc(cid)}/${uf}` : `${uf} (estado todo)`;
    calcHtml = `<div style="font-size:.74rem;color:#475569;margin-bottom:4px">Tabela <b>${cadEsc(t.nome)}</b> (${freteVigTxt(t)}) · trecho ${cadEsc(freteTrechoTxt(trc))}</div>
      <div style="font-size:.72rem;color:#475569;margin-bottom:4px">${simPesosTxt(x.res.pesos)} · portal: ${freteFmtNum(r.PESO_CALC)} kg</div>
      <table class="aud-mini">${x.res.itens.map(it => `<tr><td>${it.rotulo}<div style="font-size:.68rem;color:#64748b">${cadEsc(it.conta)}${it.obs.length ? ' · ' + it.obs.map(cadEsc).join(' · ') : ''}</div></td><td style="text-align:right">R$ ${freteFmt(it.valor)}</td></tr>`).join('')}
      ${x.res.icms ? `<tr><td>ICMS ${freteFmtNum(x.res.icms.aliquota)}%</td><td style="text-align:right">R$ ${freteFmt(x.res.icms.valor)}</td></tr>` : ''}
      <tr style="font-weight:800"><td>Total tabela</td><td style="text-align:right">R$ ${freteFmt(x.res.total)}</td></tr></table>
      ${x.res.avisos.length ? `<div class="sim-aviso">${x.res.avisos.map(cadEsc).join('<br>')}</div>` : ''}`;
  } else if (x.status === 'SEM_SERVICO') {
    calcHtml = `<div class="sim-aviso">O serviço "${cadEsc(r.SERVICO || '(vazio)')}" não está no Cadastro > Serviço.</div>`;
  } else {
    calcHtml = `<div class="sim-aviso">Nenhuma tabela do serviço ${cadEsc(r.SERVICO)} válida em ${tabFmtData(r['DATA EMISSAO'])} tem trecho para ${cadEsc(r.ORIG_CIDADE)}/${r.ORIG_UF} → ${cadEsc(r.EFF_CIDADE)}/${r.EFF_UF}.</div>`;
  }
  tr.firstElementChild.innerHTML = `
    <div class="aud-det-grid">
      <div><div class="tf-lbl">Excel (portal) — tabela ${cadEsc(r.TABELA_PORTAL || '—')}</div>
        <div style="font-size:.72rem;color:#475569;margin-bottom:4px">Peso real ${freteFmtNum(r.PESO_REAL)} kg · cubagem ${freteFmtNum(r.M3)} m³ · peso cubado ${freteFmtNum(r.PESO_CUBADO)} kg${+r.M3 > 0 && +r.PESO_CUBADO > 0 ? ` (${freteFmtNum(Math.round(r.PESO_CUBADO / r.M3))} kg/m³)` : ''} · peso calculado: <b>${freteFmtNum(r.PESO_CALC)} kg</b></div>
        <table class="aud-mini">${excelItens || '<tr><td colspan="2" style="color:#64748b">Sem taxas detalhadas</td></tr>'}
        <tr style="font-weight:800"><td>Frete total</td><td style="text-align:right">R$ ${freteFmt(x.excel)}</td></tr></table>
        <div style="font-size:.7rem;color:#64748b;margin-top:4px">Destinatário: ${cadEsc(r.EFF_LOCAL || '—')} · NF ${cadEsc(r.NF_DOC)}</div></div>
      <div><div class="tf-lbl">Calculado pela tabela</div>${calcHtml}</div>
    </div>
    <button class="cad-btn" type="button" style="margin-top:8px;background:var(--primary-light)" onclick="audAbrirSimulador(${i})">🧮 Abrir no Simulador</button>`;
  tr.style.display = '';
}

// Leva os dados da minuta para o Simulador (para testar mexendo nos valores).
async function audAbrirSimulador(i) {
  const r = _audFiltrado[i].r;
  mfMostrar('simulador');
  await carregarSimulador();
  const srv = _simServicos.find(s => freteNorm(s.nome) === freteNorm(r.SERVICO));
  const set = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('change')); };
  if (srv) set('sim-servico', srv.id);
  simAtualizarTabelas();
  set('sim-data', r['DATA EMISSAO']);
  await lerCidades().catch(() => {});
  _simOrig.definir(r.ORIG_UF, r.ORIG_CIDADE);
  _simDest.definir(r.EFF_UF, r.EFF_CIDADE);
  const br = n => String(n ?? '').replace('.', ',');
  set('sim-peso', br(r.PESO_REAL ?? r.PESO_CALC)); set('sim-m3', br(r.M3)); set('sim-nf', br(r['NF VALOR'])); set('sim-cte', br(r['FRETE TOTAL']));
  simular();
}

function audExportar() {
  const dados = _audFiltrado.map(x => {
    const r = x.r;
    return {
      Minuta: r.MINUTA, 'CT-e': r.CTE, Emissão: r['DATA EMISSAO'], Serviço: r.SERVICO, 'Tabela portal': r.TABELA_PORTAL,
      Cotação: r.COTACAO === 'S' ? 'Sim' : 'Não', 'Nº cotação': r.COTACAO_NUM || '',
      'Origem': r.ORIG_CIDADE, 'UF origem': r.ORIG_UF, 'Destino': r.EFF_CIDADE, 'UF destino': r.EFF_UF, Destinatário: r.EFF_LOCAL,
      'Valor mercadoria': r['NF VALOR'], 'Peso real (kg)': r.PESO_REAL, 'Peso cubado portal (kg)': r.PESO_CUBADO,
      'Peso calc portal (kg)': r.PESO_CALC, 'Cubagem (m³)': r.M3,
      'Peso considerado tabela (kg)': x.res ? x.res.pesos.considerado : '',
      'Frete Excel': x.excel, 'Frete tabela': x.calc, Diferença: x.dif, Status: AUD_STATUS[x.sf][0],
      'Tabela usada': x.escolha ? x.escolha.tabela.nome : '',
      ...Object.fromEntries(AUD_EXCEL_ITENS.map(([c, rot]) => ['Excel ' + rot, +r[c] || 0])),
      'Excel não detalhado (provável Advalorem)': audNaoDetalhado(r),
      ...(x.res ? Object.fromEntries(x.res.itens.map(it => ['Tabela ' + it.rotulo, it.valor])) : {}),
      ...(x.res && x.res.icms ? { 'Tabela ICMS': x.res.icms.valor } : {}),
    };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dados), 'Auditoria');
  XLSX.writeFile(wb, `auditoria_frete_${new Date().toISOString().slice(0, 10)}.xlsx`);
}



// ===== analise-custo.js =====
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
let _ancArquivo = '';
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
async function ancLerArquivo(arquivo) {
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
    c.excl = /COMPLEM/i.test(c.tipo) ? 'complemento' : /REPASSE/i.test(c.servico) ? 'repasse' : /LOGISTIC/i.test(c.servico) ? 'logistico' : '';
    linhas.push(c);
  }
  if (!linhas.length) throw new Error('Nenhum CT-e encontrado no arquivo.');
  return { linhas, hdr: aoa[h].map(x => String(x ?? '').trim()) };
}

async function ancImportar(arquivo) {
  const msg = document.getElementById('anc-msg');
  msg.style.color = '#64748b';
  msg.textContent = 'Lendo "' + arquivo.name + '"...';
  try {
    const { linhas, hdr } = await ancLerArquivo(arquivo);
    _ancLinhas = linhas; _ancHdr = hdr; _ancArquivo = arquivo.name; _ancOrd = null;
    document.getElementById('anc-arq-nome').textContent = '📄 ' + arquivo.name;
    msg.textContent = '';
    ancMontarFiltros(true);
    ancAplicar();
  } catch (e) {
    console.error(e);
    msg.style.color = '#b91c1c';
    msg.textContent = e.message || 'Não foi possível ler o arquivo.';
  }
}
function ancEscolheu(input) { const f = input.files && input.files[0]; if (f) ancImportar(f); input.value = ''; }
function ancLimpar() {
  _ancLinhas = []; _ancHdr = []; _ancArquivo = ''; _ancBase = []; _ancOrd = null;
  document.getElementById('anc-arq-nome').textContent = '';
  document.getElementById('anc-msg').textContent = '';
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
    drop.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) ancImportar(f); });
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
  encher('anc-f-servico', u('servico'), 'Todos os serviços');
  encher('anc-f-base', u('base'), 'Todas as bases');
  encher('anc-f-cliente', u('cliente'), 'Todos os clientes');
}

function ancAplicar() {
  const v = id => document.getElementById(id).value;
  const servico = v('anc-f-servico'), base = v('anc-f-base'), cliente = v('anc-f-cliente');
  const tirar = document.getElementById('anc-f-excl').checked;
  _ancBase = _ancLinhas.filter(c => (!servico || c.servico === servico) && (!base || c.base === base) &&
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


// ===== estilo e telas (embutidos) =====
const MF_CSS = ".mf{--primary:#1a3a5c;--primary-light:#2563a8;--accent:#e8341c;--green:#16a34a;--orange:#ea580c;--yellow:#ca8a04;--gray:#64748b;--light:#f1f5f9;--white:#ffffff;--border:#e2e8f0;--shadow:0 2px 8px rgba(0,0,0,.12);font-family:'Segoe UI',system-ui,sans-serif;color:#1e293b}\n.mf *{box-sizing:border-box}\n.mf .tag-filtro{font-size:.68rem;font-weight:500;text-transform:none;letter-spacing:0;color:#94a3b8}\n.mf .table-card{background:#fff;border-radius:10px;padding:16px;box-shadow:var(--shadow);margin-bottom:16px;overflow:auto}\n.mf .table-card h3{font-size:.82rem;font-weight:700;color:var(--primary);margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px}\n.mf table{width:100%;border-collapse:collapse;font-size:.8rem}\n.mf th{background:var(--primary);color:#fff;padding:8px 10px;text-align:left;font-weight:600;font-size:.75rem}\n.mf td{padding:7px 10px;border-bottom:1px solid var(--border)}\n.mf tr:hover td{background:var(--light)}\n.mf tr:last-child td{border-bottom:none}\n.mf .badge-ok{background:#dcfce7;color:#166534;padding:2px 8px;border-radius:10px;font-weight:600;font-size:.72rem}\n.mf .badge-late{background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;font-weight:600;font-size:.72rem}\n.mf .badge-transit{background:#fef9c3;color:#854d0e;padding:2px 8px;border-radius:10px;font-weight:600;font-size:.72rem}\n.mf .cad-form{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}\n.mf .cad-form input{flex:1;min-width:220px;border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:.85rem}\n.mf .cad-btn{background:var(--primary);color:#fff;border:0;border-radius:6px;padding:8px 18px;font-size:.82rem;font-weight:600;cursor:pointer}\n.mf .cad-btn:disabled{opacity:.6;cursor:default}\n.mf .tf-grid{display:grid;grid-template-columns:minmax(280px,1fr) minmax(280px,1fr);gap:24px}\n@media (max-width:760px){.mf .tf-grid{grid-template-columns:1fr}}\n.mf .tf-col input[type=text],.mf .tf-col input[type=date],.mf .tf-col select{border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:.84rem;background:#fff;color:#1e293b}\n.mf .tf-col input[type=text]{width:100%;margin-bottom:10px}\n.mf .tf-lbl{display:block;font-size:.76rem;font-weight:700;color:var(--primary);margin:0 0 5px;border-bottom:1px solid var(--border);padding-bottom:3px}\n.mf .tf-linha{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px}\n.mf .tf-simnao{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:5px 0;border-bottom:1px dashed var(--border);font-size:.8rem}\n.mf .tf-comp{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:.82rem}\n.mf .tf-comp label{display:flex;align-items:center;gap:6px;cursor:pointer}\n.mf .tf-regras{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}\n.mf .tf-regra{border:1px solid var(--border);border-left:4px solid var(--primary-light);border-radius:6px;padding:10px 12px;background:#f8fafc}\n.mf .tf-regra-tit{font-weight:700;font-size:.82rem;color:var(--primary);margin-bottom:4px}\n.mf .tf-regra-vazia{font-size:.74rem;color:#94a3b8;font-style:italic}\n.mf .tf-regra input{width:100%;border:1px solid var(--border);border-radius:5px;padding:4px 7px;font-size:.8rem;background:#fff}\n.mf .tf-campos{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px}\n.mf .tf-campos label{font-size:.7rem;color:#475569;display:flex;flex-direction:column;gap:2px}\n.mf .sim-num input{border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:.84rem}\n.mf .tf-dica{font-size:.7rem;color:#64748b;margin-top:4px}\n.mf .tf-faixa,.mf .tf-faixa-cab{display:grid;grid-template-columns:1fr 1fr 1fr 22px;gap:4px;align-items:center;margin-bottom:3px}\n.mf .tf-faixa-kg,.mf .tf-faixa-cab-kg{grid-template-columns:repeat(5,1fr) 22px}\n.mf .tf-regra:has(.tf-faixa-kg){grid-column:span 2}\n.mf .tf-faixa-cab span{font-size:.66rem;color:#64748b}\n.mf .tf-del-faixa{border:0;background:transparent;color:#b91c1c;cursor:pointer;font-size:.8rem}\n.mf .tf-add-faixa{border:1px dashed var(--primary-light);background:#fff;color:var(--primary-light);border-radius:5px;padding:2px 8px;font-size:.72rem;cursor:pointer;margin-top:2px}\n.mf .tr-form{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-bottom:6px}\n.mf .tr-par{display:flex;gap:6px}\n.mf .tr-par select,.mf .tr-par input{border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:.84rem;background:#fff}\n.mf .tr-par input{min-width:200px;flex:1}\n.mf .sim-cab{font-size:.82rem;margin-bottom:10px;line-height:1.6}\n.mf .sim-total td{font-weight:800;background:#f0f4ff;border-top:2px solid var(--primary-light)}\n.mf .sim-aviso{margin-top:10px;padding:8px 10px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px;font-size:.78rem;color:#92400e}\n.mf .icms-tab{border-collapse:collapse;font-size:.72rem}\n.mf .icms-tab th{padding:4px 5px;text-align:center;position:sticky;left:0}\n.mf .icms-tab td{padding:1px;text-align:center;border:1px solid var(--border);min-width:38px}\n.mf .icms-tab td input{width:38px;border:0;text-align:center;font-size:.72rem;padding:3px 0;background:transparent}\n.mf .icms-tab td.icms-interna{background:#e0e7ff}\n.mf .sim-sub td{font-weight:700;color:#475569}\n.mf .aud-filtros{display:flex;gap:8px;flex-wrap:wrap;align-items:center}\n.mf .aud-filtros select,.mf .aud-filtros input{border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:.8rem;background:#fff}\n.mf .aud-resumo{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:10px}\n.mf .aud-card{border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:#f8fafc}\n.mf .aud-card-rot{font-size:.68rem;color:#64748b;font-weight:600;text-transform:uppercase}\n.mf .aud-card-val{font-size:1.05rem;font-weight:800}\n.mf .aud-st{padding:2px 8px;border-radius:999px;font-size:.7rem;font-weight:700;white-space:nowrap}\n.mf .aud-det{background:#f8fafc;padding:10px 14px !important}\n.mf .aud-det-grid{display:grid;grid-template-columns:1fr 1.4fr;gap:18px}\n@media (max-width:760px){.mf .aud-det-grid{grid-template-columns:1fr}}\n.mf .aud-mini{width:100%;font-size:.76rem;border-collapse:collapse}\n.mf .aud-mini td{padding:3px 6px;border-bottom:1px solid var(--border);background:#fff}\n.mf .cid-ac{position:relative}\n.mf .tr-ac{min-width:300px}\n.mf .cid-ac input[type=text]{width:100%;border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:.84rem;background:#fff}\n.mf .cid-ac input.cid-ok{border-color:#16a34a;background:#f0fdf4}\n.mf .cid-ac-lista{position:absolute;top:calc(100% + 3px);left:0;right:0;z-index:90;background:#fff;border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);max-height:260px;overflow-y:auto}\n.mf .cid-ac-item{padding:6px 10px;font-size:.82rem;cursor:pointer;display:flex;justify-content:space-between;gap:10px}\n.mf .cid-ac-item b{color:var(--primary)}\n.mf .cid-ac-item .uf{color:#64748b;font-weight:700;font-size:.74rem}\n.mf .cid-ac-item.ativo,.mf .cid-ac-item:hover{background:#eff6ff}\n.mf .cid-ac-vazio{padding:8px 10px;font-size:.78rem;color:#64748b}\n.mf .sim-salvar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}\n.mf .sim-salvar input{flex:1;min-width:200px;border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:.84rem}\n.mf .grp-add{display:flex;gap:8px;flex-wrap:wrap}\n.mf .grp-colar-acoes{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}\n.mf .grp-colar{border:1px dashed var(--primary-light);border-radius:8px;padding:10px;margin-bottom:12px;background:#f8fafc}\n.mf .grp-colar textarea{width:100%;border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:.82rem;font-family:inherit;resize:vertical}\n.mf .grp-colar select{border:1px solid var(--border);border-radius:6px;padding:4px 6px;font-size:.8rem;margin-left:4px}\n.mf .grp-cidades{display:flex;flex-wrap:wrap;gap:6px}\n.mf .grp-chip{display:inline-flex;align-items:center;gap:4px;background:#eff6ff;border:1px solid #bfdbfe;color:var(--primary);border-radius:999px;padding:3px 6px 3px 10px;font-size:.78rem}\n.mf .grp-chip button{border:0;background:transparent;color:#b91c1c;cursor:pointer;font-size:.75rem;padding:0 2px}\n.mf .tr-grp-sel{width:100%;margin-top:4px;border:1px dashed var(--border);border-radius:6px;padding:4px 8px;font-size:.76rem;color:#475569;background:#fff}\n.mf .aud-col-filtros th{background:#e8eef6 !important;padding:4px !important}\n.mf .aud-col-f{width:100%;min-width:60px;border:1px solid var(--border);border-radius:5px;padding:4px 6px;font-size:.74rem;font-weight:400;color:#1e293b;background:#fff}\n.mf .aud-col-f.ativo{border-color:var(--primary-light);background:#eff6ff}\n.mf .tf-versao{border:1px dashed #7c3aed;border-radius:8px;padding:12px;margin-top:14px;background:#faf5ff}\n.mf .tf-versao input{border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:.84rem;background:#fff}\n.mf .cad-del{background:transparent;border:1px solid #fecaca;color:#b91c1c;border-radius:6px;padding:3px 10px;font-size:.75rem;cursor:pointer}\n.mf .anc-drop{display:flex;gap:10px;flex-wrap:wrap;align-items:center;border:2px dashed var(--primary-light);border-radius:10px;padding:12px 14px;background:#f8fbff;font-size:.82rem}\n.mf .anc-drop.sobre{background:#dbeafe;border-style:solid}\n.mf-nav{background:var(--primary);display:flex;gap:2px;padding:0 16px;border-radius:10px 10px 0 0;flex-wrap:wrap;align-items:center}\n.mf-tab{padding:11px 18px;font-size:.84rem;font-weight:600;color:rgba(255,255,255,.7);cursor:pointer;border-bottom:3px solid transparent;white-space:nowrap;user-select:none}\n.mf-tab:hover{color:#fff}\n.mf-tab.ativo{color:#fff;border-bottom-color:var(--accent)}\n.mf-menu{position:relative}\n.mf-sub{display:none;position:absolute;top:100%;left:0;z-index:60;background:#fff;border:1px solid var(--border);border-radius:0 0 8px 8px;box-shadow:var(--shadow);min-width:170px;padding:4px 0}\n.mf-menu:hover .mf-sub,.mf-menu.aberto .mf-sub{display:block}\n.mf-subitem{padding:9px 16px;font-size:.82rem;font-weight:600;color:var(--primary);cursor:pointer;white-space:nowrap}\n.mf-subitem:hover{background:var(--light)}\n.mf-versao{margin-left:auto;font-size:.66rem;color:rgba(255,255,255,.5);padding:0 6px}\n.mf-corpo{background:var(--light);padding:16px;border-radius:0 0 10px 10px}\n.mf-painel{display:none}\n.mf-painel.ativo{display:block}\n.mf h3{font-size:.82rem;font-weight:700;color:var(--primary);text-transform:uppercase;letter-spacing:.5px;margin:0 0 12px}\n.mf input,.mf select,.mf textarea,.mf button{font-family:inherit}\n@media (max-width:600px){.mf-tab{padding:10px 12px}.mf-corpo{padding:10px}}\n";
const MF_PAINEIS = "<!-- TAB: CADASTRO > SERVICO -->\n<div id=\"tab-cad-servico\" class=\"mf-painel\">\n  <div class=\"table-card\">\n    <h3 style=\"margin-bottom:12px\">Cadastro — Serviço</h3>\n    <div class=\"cad-form\" id=\"cad-servico-form\" style=\"display:none\">\n      <input id=\"cad-servico-input\" type=\"text\" maxlength=\"200\" placeholder=\"Digite o serviço...\"\n        onkeydown=\"if(event.key==='Enter')salvarServico()\">\n      <button id=\"cad-servico-btn\" class=\"cad-btn\" type=\"button\" onclick=\"salvarServico()\">Salvar</button>\n    </div>\n    <div id=\"cad-servico-msg\" style=\"font-size:.78rem;color:#64748b;margin-bottom:10px\"></div>\n    <table>\n      <thead><tr><th>Serviço</th><th style=\"width:170px\">Cadastrado em</th><th style=\"width:90px\"></th></tr></thead>\n      <tbody id=\"tb-cad-servico\"></tbody>\n    </table>\n  </div>\n</div>\n\n<!-- TAB: CADASTRO > TABELA (logica em cadastro-tabela.js) -->\n<div id=\"tab-cad-tabela\" class=\"mf-painel\">\n  <div class=\"table-card\" id=\"cad-tabela-lista\">\n    <div style=\"display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap\">\n      <h3 style=\"margin:0\">Cadastro — Tabelas</h3>\n      <button id=\"cad-tabela-nova\" class=\"cad-btn\" type=\"button\" onclick=\"novaTabela()\" style=\"display:none\">+ Cadastrar nova tabela</button>\n    </div>\n    <div id=\"cad-tabela-msg\" style=\"font-size:.78rem;color:#64748b;margin-bottom:10px\"></div>\n    <table>\n      <thead><tr><th>Nome da tabela</th><th>Serviço</th><th style=\"width:170px\">Vigência</th><th style=\"width:100px\">Situação</th><th style=\"width:90px\">Tipo</th><th style=\"width:110px\">Trechos</th></tr></thead>\n      <tbody id=\"tb-cad-tabela\"></tbody>\n    </table>\n  </div>\n  <div class=\"table-card\" id=\"cad-tabela-form\" style=\"display:none\"></div>\n  <div class=\"table-card\" id=\"cad-tabela-trechos\" style=\"display:none\"></div>\n</div>\n\n<!-- TAB: CADASTRO > ICMS (logica em cadastro-icms.js) -->\n<div id=\"tab-cad-icms\" class=\"mf-painel\">\n  <div class=\"table-card\">\n    <h3 style=\"margin-bottom:6px\">Cadastro — ICMS (alíquota rodoviária por UF de origem × destino)</h3>\n    <div style=\"font-size:.76rem;color:#64748b;margin-bottom:10px\">Usada quando a tabela tem \"Soma imposto (ICMS) ao frete\" = SIM: frete com ICMS = soma dos itens ÷ (1 − alíquota).</div>\n    <div id=\"cad-icms-acoes\" style=\"display:none;gap:8px;flex-wrap:wrap;margin-bottom:10px\">\n      <label class=\"cad-btn\" style=\"background:var(--primary-light)\">📥 Importar planilha (.xlsx)\n        <input type=\"file\" accept=\".xlsx,.xls,.csv\" style=\"display:none\" onchange=\"importarIcms(this)\"></label>\n      <button class=\"cad-btn\" type=\"button\" onclick=\"salvarIcms()\">💾 Salvar</button>\n    </div>\n    <div id=\"cad-icms-msg\" style=\"font-size:.78rem;color:#64748b;margin-bottom:10px\"></div>\n    <div id=\"cad-icms-matriz\" style=\"overflow-x:auto\"></div>\n  </div>\n</div>\n\n<!-- TAB: CADASTRO > CIDADE (logica em cadastro-cidade.js) -->\n<div id=\"tab-cad-cidade\" class=\"mf-painel\">\n  <div class=\"table-card\">\n    <h3 style=\"margin-bottom:10px\">Cadastro — Cidades</h3>\n    <div id=\"cad-cidade-form\" style=\"display:none;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px\" class=\"tr-par\">\n      <input id=\"cid-n-nome\" type=\"text\" placeholder=\"Nova cidade\" style=\"min-width:220px\">\n      <select id=\"cid-n-uf\"></select>\n      <input id=\"cid-n-ibge\" type=\"text\" placeholder=\"Código IBGE (opcional)\" style=\"min-width:150px;flex:0\">\n      <button class=\"cad-btn\" type=\"button\" onclick=\"incluirCidade()\">+ Incluir</button>\n    </div>\n    <div class=\"tr-par\" style=\"margin-bottom:8px;flex-wrap:wrap\">\n      <select id=\"cid-f-uf\" onchange=\"renderCidades()\"></select>\n      <input id=\"cid-f-busca\" type=\"text\" placeholder=\"🔍 Buscar cidade...\" oninput=\"renderCidades()\">\n    </div>\n    <div id=\"cad-cidade-msg\" style=\"font-size:.78rem;color:#64748b;margin-bottom:8px\"></div>\n    <table>\n      <thead><tr><th>Cidade</th><th style=\"width:60px\">UF</th><th style=\"width:120px\">Código IBGE</th><th style=\"width:90px\"></th></tr></thead>\n      <tbody id=\"tb-cad-cidade\"></tbody>\n    </table>\n  </div>\n</div>\n\n<!-- TAB: CADASTRO > TRECHO (grupos de cidades; logica em cadastro-trecho.js) -->\n<div id=\"tab-cad-grupo\" class=\"mf-painel\">\n  <div class=\"table-card\" id=\"cad-grupo-lista\">\n    <div style=\"display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;flex-wrap:wrap\">\n      <h3 style=\"margin:0\">Cadastro — Trechos</h3>\n      <button id=\"cad-grupo-novo\" class=\"cad-btn\" type=\"button\" onclick=\"novoGrupo()\" style=\"display:none\">+ Novo trecho</button>\n    </div>\n    <div style=\"font-size:.76rem;color:#64748b;margin-bottom:10px\">Grupo de cidades com nome (ex.: SC_Capital). Pode ser usado como origem ou destino nos trechos das tabelas: a regra vale para qualquer cidade do grupo.</div>\n    <div id=\"cad-grupo-msg\" style=\"font-size:.78rem;color:#64748b;margin-bottom:10px\"></div>\n    <table>\n      <thead><tr><th>Trecho</th><th style=\"width:80px\">Cidades</th><th style=\"width:120px\">UFs</th><th>Cidades (amostra)</th></tr></thead>\n      <tbody id=\"tb-cad-grupo\"></tbody>\n    </table>\n  </div>\n  <div class=\"table-card\" id=\"cad-grupo-form\" style=\"display:none\"></div>\n</div>\n\n<!-- TAB: AUDITORIA (logica em auditoria.js) -->\n<div id=\"tab-auditoria\" class=\"mf-painel\">\n  <div class=\"table-card\" style=\"margin-bottom:12px\">\n    <div style=\"display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px\">\n      <h3 style=\"margin:0\">Auditoria — frete do portal × tabela cadastrada</h3>\n      <button class=\"cad-btn\" type=\"button\" style=\"background:var(--green)\" onclick=\"audExportar()\">📥 Exportar Excel</button>\n    </div>\n    <div style=\"font-size:.74rem;color:#64748b;margin-bottom:10px\">Cada minuta é recalculada pela tabela do serviço dela, vigente na emissão, no trecho origem → local de entrega, com o peso calculado, a cubagem e o valor da mercadoria do Excel. Clique numa minuta para ver item a item.</div>\n    <div class=\"aud-filtros\">\n      <select id=\"aud-f-mes\" onchange=\"audAplicarFiltros()\"></select>\n      <select id=\"aud-f-servico\" onchange=\"audAplicarFiltros()\"></select>\n      <select id=\"aud-f-uf\" onchange=\"audAplicarFiltros()\"></select>\n      <select id=\"aud-f-status\" onchange=\"audAplicarFiltros()\">\n        <option value=\"\">Todos os status</option><option value=\"OK\">OK</option><option value=\"DIVERGENTE\">Divergentes</option>\n        <option value=\"SEM_TABELA\">Sem tabela/trecho</option><option value=\"SEM_SERVICO\">Serviço não cadastrado</option><option value=\"COTACAO\">Com cotação</option>\n      </select>\n      <label style=\"font-size:.74rem;color:#475569\">Tolerância R$ <input id=\"aud-f-tol\" type=\"text\" inputmode=\"decimal\" value=\"0,10\" style=\"width:60px\" onchange=\"audAplicarFiltros()\"></label>\n      <input id=\"aud-f-busca\" type=\"text\" placeholder=\"🔍 Minuta, CT-e, NF, destinatário...\" oninput=\"audAplicarFiltros()\" style=\"min-width:220px;flex:1\">\n    </div>\n    <div id=\"aud-msg\" style=\"font-size:.78rem;color:#64748b;margin-top:6px\"></div>\n    <div id=\"aud-resumo\" class=\"aud-resumo\"></div>\n  </div>\n  <div class=\"table-card\" style=\"overflow-x:auto\">\n    <table>\n      <thead><tr><th>Minuta</th><th>Emissão</th><th>Serviço</th><th>Tabela</th><th>Cotação</th><th>Origem</th><th>Destino</th><th style=\"text-align:right\">Valor mercadoria</th>\n        <th style=\"text-align:right\">Peso (kg)</th><th style=\"text-align:right\">Cubagem (m³)</th><th style=\"text-align:right\">Frete Excel</th>\n        <th style=\"text-align:right\">Frete tabela</th><th style=\"text-align:right\">Diferença</th><th>Status</th></tr>\n        <tr class=\"aud-col-filtros\"><th><input id=\"aud-c-minuta\" class=\"aud-col-f\" type=\"text\" placeholder=\"Minuta / CT-e\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-emissao\" class=\"aud-col-f\" type=\"text\" placeholder=\"dd/mm\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-servico\" class=\"aud-col-f\" type=\"text\" placeholder=\"Serviço\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-tabela_portal\" class=\"aud-col-f\" type=\"text\" placeholder=\"Tabela\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-cotacao\" class=\"aud-col-f\" type=\"text\" placeholder=\"sim/não\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-origem\" class=\"aud-col-f\" type=\"text\" placeholder=\"Origem\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-destino\" class=\"aud-col-f\" type=\"text\" placeholder=\"Destino\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-nf\" class=\"aud-col-f\" type=\"text\" placeholder=\">1000\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-peso\" class=\"aud-col-f\" type=\"text\" placeholder=\">100\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-m3\" class=\"aud-col-f\" type=\"text\" placeholder=\"m³\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-excel\" class=\"aud-col-f\" type=\"text\" placeholder=\"R$\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-tabela\" class=\"aud-col-f\" type=\"text\" placeholder=\"R$\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-dif\" class=\"aud-col-f\" type=\"text\" placeholder=\"<0\" oninput=\"audAplicarFiltros()\"></th><th><input id=\"aud-c-status\" class=\"aud-col-f\" type=\"text\" placeholder=\"Status\" oninput=\"audAplicarFiltros()\"></th></tr></thead>\n      <tbody id=\"tb-auditoria\"></tbody>\n    </table>\n    <div id=\"aud-rodape\" style=\"font-size:.75rem;color:#64748b;margin-top:8px\"></div>\n  </div>\n</div>\n\n<!-- TAB: SIMULADOR (logica em simulador.js) -->\n<div id=\"tab-simulador\" class=\"mf-painel\">\n  <div class=\"tf-grid\" style=\"grid-template-columns:minmax(280px,380px) 1fr;align-items:start\">\n    <div class=\"table-card tf-col\">\n      <h3 style=\"margin-bottom:12px\">Simulador de frete</h3>\n      <div id=\"sim-msg\" style=\"font-size:.78rem;color:#64748b;margin-bottom:8px\"></div>\n      <label class=\"tf-lbl\">Serviço</label>\n      <select id=\"sim-servico\" style=\"width:100%;margin-bottom:10px\" onchange=\"simAtualizarTabelas()\"></select>\n      <label class=\"tf-lbl\">Tabela</label>\n      <select id=\"sim-tabela\" style=\"width:100%;margin-bottom:10px\"></select>\n      <label class=\"tf-lbl\">Data do frete <span style=\"font-weight:400;color:#64748b\">(usa a tabela válida nessa data)</span></label>\n      <input id=\"sim-data\" type=\"date\" style=\"margin-bottom:10px\">\n      <div><label class=\"tf-lbl\">Trecho de início (origem)</label>\n      <div class=\"cid-ac\"><input id=\"sim-orig\" type=\"text\" autocomplete=\"off\" placeholder=\"Cidade ou trecho cadastrado...\"><div class=\"cid-ac-lista\" hidden></div>\n        <select id=\"sim-ouf\" hidden></select><input id=\"sim-ocid\" type=\"hidden\"><input id=\"sim-ogrp\" type=\"hidden\"></div>\n      <select id=\"sim-ogrp-sel\" class=\"tr-grp-sel\" style=\"margin-bottom:10px\"></select></div>\n      <div><label class=\"tf-lbl\">Trecho de fim (destino)</label>\n      <div class=\"cid-ac\"><input id=\"sim-dest\" type=\"text\" autocomplete=\"off\" placeholder=\"Cidade ou trecho cadastrado...\"><div class=\"cid-ac-lista\" hidden></div>\n        <select id=\"sim-duf\" hidden></select><input id=\"sim-dcid\" type=\"hidden\"><input id=\"sim-dgrp\" type=\"hidden\"></div>\n      <select id=\"sim-dgrp-sel\" class=\"tr-grp-sel\" style=\"margin-bottom:10px\"></select></div>\n      <div class=\"tf-campos sim-num\">\n        <label>Peso real (kg)<input id=\"sim-peso\" type=\"text\" inputmode=\"decimal\"></label>\n        <label>Cubagem (m³)<input id=\"sim-m3\" type=\"text\" inputmode=\"decimal\"></label>\n        <label>Valor da NF (R$)<input id=\"sim-nf\" type=\"text\" inputmode=\"decimal\"></label>\n        <label>Valor do CT-e (R$)<input id=\"sim-cte\" type=\"text\" inputmode=\"decimal\" placeholder=\"opcional\"></label>\n      </div>\n      <div class=\"tf-dica\" style=\"margin:4px 0 12px\">Valor do CT-e: base do \"% sobre CT-e\". Em branco, usa a soma dos demais itens.</div>\n      <button class=\"cad-btn\" type=\"button\" onclick=\"simular()\" style=\"width:100%\">Calcular</button>\n    </div>\n    <div class=\"table-card\" id=\"sim-resultado\"><div style=\"color:#64748b;font-size:.85rem\">Preencha ao lado e clique em Calcular.</div></div>\n  </div>\n  <div class=\"table-card\" style=\"margin-top:16px;overflow-x:auto\">\n    <div style=\"display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px\">\n      <h3 style=\"margin:0\">Simulações salvas</h3>\n      <div style=\"display:flex;gap:8px;flex-wrap:wrap\">\n        <input id=\"sim-salvas-busca\" type=\"text\" placeholder=\"🔍 Buscar descrição, cidade, serviço...\" oninput=\"renderSimSalvas()\" style=\"border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:.8rem;min-width:240px\">\n        <button class=\"cad-btn\" type=\"button\" style=\"background:var(--green)\" onclick=\"exportarSimSalvas()\">📥 Exportar Excel</button>\n      </div>\n    </div>\n    <div id=\"sim-salvas-msg\" style=\"font-size:.76rem;color:#64748b;margin-bottom:6px\"></div>\n    <table>\n      <thead><tr><th>Salva em</th><th>Descrição</th><th>Serviço / Tabela</th><th>Origem → Destino</th><th style=\"text-align:right\">Peso real (kg)</th>\n        <th style=\"text-align:right\">Cubagem (m³)</th><th style=\"text-align:right\">Peso consid. (kg)</th><th style=\"text-align:right\">Valor NF</th><th style=\"text-align:right\">Total</th><th></th></tr></thead>\n      <tbody id=\"tb-sim-salvas\"></tbody>\n    </table>\n  </div>\n</div>\n\n<!-- TAB: ANALISE DE CUSTO (tela 147 importada; logica em analise-custo.js) -->\n<div id=\"tab-analise-custo\" class=\"mf-painel\">\n  <div class=\"table-card\" style=\"margin-bottom:12px\">\n    <div style=\"display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px\">\n      <h3 style=\"margin:0\">Análise de custo — custo por kg de coleta, transferência e entrega</h3>\n      <button class=\"cad-btn\" type=\"button\" style=\"background:var(--green)\" onclick=\"ancExportar()\">📥 Exportar Excel</button>\n    </div>\n    <div style=\"font-size:.74rem;color:#64748b;margin-bottom:10px\">Base: tela 147 do Brudam (relatório de custo por operação). <b>Média</b> = soma dos custos ÷ soma dos pesos; <b>mediana</b> = valor típico por CT-e. Por padrão ficam de fora CT-e complementar, repasse e serviço logístico.</div>\n    <div id=\"anc-drop\" class=\"anc-drop\">\n      <span>📂 Arraste aqui o arquivo da <b>tela 147</b> (.xls / .xlsx) ou</span>\n      <label class=\"cad-btn\" style=\"display:inline-block\">Escolher arquivo\n        <input id=\"anc-arquivo\" type=\"file\" accept=\".xls,.xlsx,.html,.htm\" style=\"display:none\" onchange=\"ancEscolheu(this)\"></label>\n      <span id=\"anc-arq-nome\" style=\"font-weight:600;color:var(--primary)\"></span>\n      <button class=\"cad-btn\" type=\"button\" style=\"background:var(--gray);padding:6px 12px\" onclick=\"ancLimpar()\">Limpar</button>\n    </div>\n    <div id=\"anc-msg\" style=\"font-size:.78rem;color:#64748b;margin:6px 0\"></div>\n    <div class=\"aud-filtros\">\n      <select id=\"anc-f-servico\" onchange=\"ancAplicar()\"></select>\n      <select id=\"anc-f-base\" onchange=\"ancAplicar()\"></select>\n      <select id=\"anc-f-cliente\" onchange=\"ancAplicar()\" style=\"min-width:220px\"></select>\n      <label style=\"font-size:.76rem;color:#475569;display:flex;align-items:center;gap:5px\"><input id=\"anc-f-excl\" type=\"checkbox\" checked onchange=\"ancAplicar()\"> Tirar complemento, repasse e serviço logístico</label>\n    </div>\n    <div id=\"anc-resumo\" class=\"aud-resumo\"></div>\n  </div>\n  <div class=\"table-card\" style=\"margin-bottom:12px\">\n    <h3 style=\"margin-bottom:8px\">Custo por kg — análise estatística</h3>\n    <div class=\"aud-filtros\" style=\"margin-bottom:8px\">\n      <select id=\"anc-kg-custo\" onchange=\"ancRenderEstat()\"><option value=\"transf\">Transferência</option><option value=\"coleta\">Coleta</option><option value=\"entrega\">Entrega</option></select>\n      <select id=\"anc-kg-quebra\" onchange=\"ancRenderEstat()\"><option value=\"faixa\">Quebrar por faixa de peso</option><option value=\"resp\">Quebrar por responsável (transportadora)</option></select>\n    </div>\n    <div style=\"overflow-x:auto\"><table id=\"anc-estat\"></table></div>\n    <div style=\"font-size:.72rem;color:#64748b;margin-top:6px\">Mediana, P25 e P75 consideram só os CT-e com o custo selecionado (&gt; 0). Linhas com menos de 5 CT-e têm baixa confiança (⚠).</div>\n  </div>\n  <div class=\"table-card\" style=\"overflow-x:auto\">\n    <table>\n      <thead id=\"anc-thead\"></thead>\n      <tbody id=\"anc-tb\"></tbody>\n    </table>\n    <div id=\"anc-rodape\" style=\"font-size:.75rem;color:#64748b;margin-top:8px\"></div>\n  </div>\n</div>\n";

// ===== ui.js =====
// ui.js — Motor de Frete: monta a interface (menu + telas) e expoe a API
// window.MotorFrete. MF_CSS e MF_PAINEIS sao embutidos pelo build.py.

const MF_ABAS_CARREGAR = {
  'cad-servico': () => carregarServicos(),
  'cad-tabela': () => carregarTabelas(),
  'cad-icms': () => carregarIcms(),
  'cad-cidade': () => carregarCidadesTela(),
  'cad-grupo': () => carregarGrupos(),
  'simulador': () => carregarSimulador(),
  'auditoria': () => carregarAuditoria(),
  'analise-custo': () => carregarAnaliseCusto(),
};

const MF_CADASTROS = [
  ['cad-servico', 'Serviço'], ['cad-tabela', 'Tabela'], ['cad-grupo', 'Trecho'],
  ['cad-icms', 'ICMS'], ['cad-cidade', 'Cidade'],
];

// Mostra uma tela do motor (ids: cad-servico, cad-tabela, cad-grupo, cad-icms,
// cad-cidade, simulador, auditoria, analise-custo) e carrega os dados dela.
function mfMostrar(id) {
  const raiz = document.querySelector('.mf');
  if (!raiz) return;
  raiz.querySelectorAll('.mf-painel').forEach(p => p.classList.toggle('ativo', p.id === 'tab-' + id));
  raiz.querySelectorAll('.mf-tab').forEach(t => t.classList.remove('ativo'));
  const alvo = id.startsWith('cad-') ? raiz.querySelector('.mf-menu') : raiz.querySelector(`.mf-tab[data-mf="${id}"]`);
  if (alvo) alvo.classList.add('ativo');
  raiz.querySelectorAll('.mf-menu').forEach(m => m.classList.remove('aberto'));
  if (MF_ABAS_CARREGAR[id]) MF_ABAS_CARREGAR[id]();
}

function mfMontarHtml(abas) {
  const temCad = abas.includes('cadastro');
  const nav = `<nav class="mf-nav">
    ${temCad ? `<div class="mf-tab mf-menu" onclick="this.classList.toggle('aberto')">Cadastro ▾
      <div class="mf-sub">${MF_CADASTROS.map(([id, rot]) =>
        `<div class="mf-subitem" onclick="event.stopPropagation();mfMostrar('${id}')">${rot}</div>`).join('')}</div></div>` : ''}
    ${abas.includes('simulador') ? `<div class="mf-tab" data-mf="simulador" onclick="mfMostrar('simulador')">🧮 Simulador</div>` : ''}
    ${abas.includes('auditoria') ? `<div class="mf-tab" data-mf="auditoria" id="tab-btn-auditoria" style="display:none" onclick="mfMostrar('auditoria')">🔍 Auditoria</div>` : ''}
    ${abas.includes('analise-custo') ? `<div class="mf-tab" data-mf="analise-custo" onclick="mfMostrar('analise-custo')">📊 Análise de custo</div>` : ''}
    <span class="mf-versao">Motor de Frete v${MF.versao}</span>
  </nav>`;
  // So entram as telas das abas pedidas
  const tmp = document.createElement('div');
  tmp.innerHTML = MF_PAINEIS;
  tmp.querySelectorAll('.mf-painel').forEach(p => {
    const id = p.id.replace(/^tab-/, '');
    const aba = id.startsWith('cad-') ? 'cadastro' : id;
    if (!abas.includes(aba)) p.remove();
  });
  return `<div class="mf">${nav}<div class="mf-corpo">${tmp.innerHTML}</div></div>`;
}

// ---------- API ----------
// MotorFrete.iniciar({
//   alvo: '#motor',                         // elemento (ou seletor) onde o motor e montado
//   projeto: 'forte',                       // obrigatorio: separa Servicos/Tabelas/Trechos/Simulacoes do projeto
//   editores: ['a@portoex.com.br'],         // quem inclui/edita/exclui e ve a Auditoria
//   identidade: async () => 'email',        // opcional; padrao: login do Cloudflare Access
//   todosEditam: false,                     // true = qualquer um edita (ambiente de teste)
//   abas: ['cadastro','simulador','auditoria'],   // opcional: 'analise-custo' (tela 147 importada na tela; custo/kg) — fica de fora por padrao
//   auditoria: { linhas: [...] | () => [...], mapear: r => ({...}) },   // formato no README
//   chaves: { servicos, tabelas, trechos, simulacoes, icms, cidades },  // opcional (sobrescreve as chaves no banco)
//   supabase: { url, chave },               // opcional
// })
async function mfIniciar(cfg) {
  cfg = cfg || {};
  if (!cfg.projeto && !cfg.chaves) throw new Error('MotorFrete.iniciar: informe "projeto" (ex.: "forte").');
  MF.cfg = cfg;
  MF.linhasCache = null;
  const p = cfg.projeto;
  const ch = Object.assign({
    servicos: `${p}_servicos`, tabelas: `${p}_tabelas`, trechos: `${p}_trechos`, simulacoes: `${p}_simulacoes`,
    icms: 'cadastro_icms', cidades: 'cadastro_cidades',   // compartilhadas entre projetos
  }, cfg.chaves || {});
  CAD_SERVICOS_KEY = ch.servicos;
  CAD_TABELAS_KEY = ch.tabelas;
  CAD_GRUPOS_KEY = ch.trechos;
  SIM_SALVAS_KEY = ch.simulacoes;
  CAD_ICMS_KEY = ch.icms;
  CAD_CIDADES_KEY = ch.cidades;
  MF.chaves = ch;
  if (cfg.supabase) { SUPABASE_URL = cfg.supabase.url; SUPABASE_KEY = cfg.supabase.chave; _db = null; }
  CAD_EDITORES = (cfg.editores || []).map(e => String(e).toLowerCase());
  _cadPodeEditar = null;

  // Dependencias: Supabase (obrigatoria) e SheetJS (exportar/importar Excel)
  if (!window.supabase) await mfCarregarScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
  if (!window.XLSX) mfCarregarScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js').catch(() => {});

  if (!document.getElementById('mf-estilo')) {
    const st = document.createElement('style');
    st.id = 'mf-estilo';
    st.textContent = MF_CSS;
    document.head.appendChild(st);
  }
  const alvo = typeof cfg.alvo === 'string' ? document.querySelector(cfg.alvo) : cfg.alvo;
  if (!alvo) throw new Error('MotorFrete.iniciar: "alvo" não encontrado.');
  let abas = cfg.abas || ['cadastro', 'simulador', 'auditoria'];
  if (!cfg.auditoria) abas = abas.filter(a => a !== 'auditoria');
  alvo.innerHTML = mfMontarHtml(abas);
  if (!MF._fecharMenu) {
    MF._fecharMenu = true;
    document.addEventListener('click', e => {
      if (!e.target.closest('.mf-menu')) document.querySelectorAll('.mf-menu.aberto').forEach(m => m.classList.remove('aberto'));
    });
  }

  const pode = await cadPodeEditar();
  const btnAud = document.getElementById('tab-btn-auditoria');
  if (btnAud) btnAud.style.display = (pode || (cfg.auditoria && cfg.auditoria.publica)) ? '' : 'none';
  const primeira = cfg.abaInicial || (abas.includes('simulador') ? 'simulador' : abas.includes('cadastro') ? 'cad-tabela' : 'auditoria');
  mfMostrar(primeira);
  return window.MotorFrete;
}

window.MotorFrete = {
  versao: MF.versao,
  iniciar: mfIniciar,
  abrir: mfMostrar,
  // Motor de calculo, para usar direto em outras telas/relatorios:
  calcular: freteCalcular,              // (tabela, trecho, entrada, aliquotasIcms)
  acharTabela: freteAcharTabela,        // (tabelas, {servicoId, data, origem, destino})
  // Leitura dos cadastros do projeto (depois do iniciar):
  lerTabelas, lerServicos, lerIcms, lerCidades, lerGrupos,
  // Troca as linhas da Auditoria (ex.: depois de atualizar os dados da pagina)
  definirLinhasAuditoria(linhas) { MF.cfg.auditoria = { ...(MF.cfg.auditoria || {}), linhas }; MF.linhasCache = null; },
};


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

})();