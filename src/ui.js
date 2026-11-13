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
    <span class="mf-versao" id="mf-versao" title="Verificando se há versão mais nova...">Motor de Frete v${MF.versao} · atualizado em ${MF.build}</span>
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

  mfVerificarVersao();   // sem await: não atrasa a tela
  const pode = await cadPodeEditar();
  const btnAud = document.getElementById('tab-btn-auditoria');
  if (btnAud) btnAud.style.display = (pode || (cfg.auditoria && cfg.auditoria.publica)) ? '' : 'none';
  const primeira = cfg.abaInicial || (abas.includes('simulador') ? 'simulador' : abas.includes('cadastro') ? 'cad-tabela' : 'auditoria');
  mfMostrar(primeira);
  return window.MotorFrete;
}

// Compara esta versão com a última publicada (arquivo VERSION do repositório, sem cache) e avisa no canto do menu.
// "Atualizar" baixa de novo o script ignorando o cache do navegador e recarrega a página (não precisa apertar Ctrl+F5 várias vezes).
const MF_SITE = 'https://maurocmarques-creator.github.io/motor-frete/';
function mfVerMaior(a, b) {   // a > b ?
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
async function mfAtualizar() {
  const el = document.getElementById('mf-versao');
  if (el) el.textContent = 'Atualizando...';
  try { await fetch(MF_SCRIPT_URL || (MF_SITE + 'dist/motor-frete.js'), { cache: 'reload' }); } catch (e) { /* recarrega assim mesmo */ }
  location.reload();
}
async function mfVerificarVersao() {
  const el = document.getElementById('mf-versao');
  if (!el) return;
  try {
    const r = await fetch(MF_SITE + 'VERSION?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('sem VERSION');
    const nova = (await r.text()).trim();
    if (!/^\d+\.\d+\.\d+$/.test(nova)) throw new Error('VERSION inválida');
    if (mfVerMaior(nova, MF.versao)) {
      el.innerHTML = `Motor de Frete v${MF.versao} (${MF.build}) · <b style="color:#fbbf24;cursor:pointer;text-decoration:underline" onclick="MotorFrete.atualizar()">⚠ v${nova} disponível — clique para atualizar</b>`;
      el.title = 'Há uma versão mais nova publicada. Clique para baixar e recarregar.';
    } else {
      el.innerHTML = `Motor de Frete v${MF.versao} · atualizado em ${MF.build} <span style="color:#86efac">✓ versão mais recente</span>`;
      el.title = 'Você está usando a versão mais recente publicada.';
    }
  } catch (e) { el.title = 'Não foi possível verificar se há versão mais nova.'; }
}

window.MotorFrete = {
  atualizar: mfAtualizar,
  versao: MF.versao,
  build: MF.build,
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
