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
