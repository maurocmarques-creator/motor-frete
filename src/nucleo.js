// nucleo.js — Motor de Frete: configuracao, banco (Supabase), permissao e utilidades.
// Primeiro arquivo do pacote; os demais usam estas funcoes/variaveis globais.

const MF = { cfg: {}, versao: '__MF_VERSAO__', linhasCache: null };
// Endereco deste script (dist/motor-frete.js): arquivos de apoio, como cidaten-trechos.json, ficam na mesma pasta.
const MF_SCRIPT_URL = (document.currentScript && document.currentScript.src) || '';

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
