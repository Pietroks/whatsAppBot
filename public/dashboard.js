const API_BOT = window.location.origin;
const socket = io();
const modalQr = new bootstrap.Modal(document.getElementById('modalQr'));
const modalTeste = new bootstrap.Modal(document.getElementById('modalTeste'));
const botaoAcao = document.getElementById('botao-acao');

// ... (funções de controle, sockets e histórico permanecem as mesmas)
async function showToast(message, type = 'info') {
    const toastContainer = document.querySelector('.toast-container');
    if (!toastContainer) return;

    const toastColor = {
        success: 'bg-success',
        danger: 'bg-danger',
        warning: 'bg-warning',
        info: 'bg-info'
    }[type];

    const toastId = `toast-${Date.now()}`;

    const toastHTML = `
        <div id="${toastId}" class="toast align-items-center text-white ${toastColor} border-0" role="alert" aria-live="assertive" aria-atomic="true">
            <div class="d-flex">
                <div class="toast-body">
                ${message}
                </div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
        </div>
    `;

    toastContainer.insertAdjacentHTML('beforeend', toastHTML);

    const toastElement = document.getElementById(toastId);
    const toast = new bootstrap.Toast(toastElement, { delay: 4000 });
    toast.show();

    toastElement.addEventListener('hidden.bs.toast', () => {
        toastElement.remove();
    });
}

function showConfirm(question) {
    const modalElement = document.getElementById('modalConfirm');
    const confirmModal = bootstrap.Modal.getOrCreateInstance(modalElement);

    document.getElementById('confirmQuestion').textContent = question;

    return new Promise((resolve) => {
        const okBtn = document.getElementById('confirmOkBtn');
        const cancelBtn = document.getElementById('confirmCancelBtn');

        const onOk = () => {
            resolve(true);
            confirmModal.hide();
            cleanup();
        };

        const onCancel = () => {
            resolve(false);
            confirmModal.hide();
            cleanup();
        };

        const cleanup = () => {
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
        }

        okBtn.addEventListener('click', onOk, { once: true });
        cancelBtn.addEventListener('click', onCancel, { once: true });

        confirmModal.show();
    });
}

async function verificarStatus() {
    try {
        const res = await fetch(`${API_BOT}/api/status`);
        const { status } = await res.json();
        if (status === 'conectado') {
            botaoAcao.textContent = '🔌 Desconectar WhatsApp';
            botaoAcao.className = 'btn btn-outline-danger';
            botaoAcao.onclick = desconectarBot;
        } else {
            botaoAcao.textContent = '🔑 Conectar WhatsApp';
            botaoAcao.className = 'btn btn-outline-success';
            botaoAcao.onclick = abrirQrCode;
        }
    } catch {
        botaoAcao.textContent = '❌ Bot offline';
        botaoAcao.className = 'btn btn-outline-secondary';
        botaoAcao.onclick = () => showToast('❌ Servidor não disponível', 'danger');
    }
}

async function carregarConfig() {
    const res = await fetch('/api/config');
    if (res.ok) {
        const cfg = await res.json();
        document.getElementById('intervalo').value = cfg.intervaloMinutos;
        document.getElementById('delay').value = cfg.delayEnvioMs;
    }
}

async function atualizarConfig() {
    const minutos = parseInt(document.getElementById('intervalo').value);
    const delay = parseInt(document.getElementById('delay').value);
    if (!minutos || minutos < 1) return showToast('⚠️ Informe um intervalo válido (mínimo 1 minuto)', 'warning');
    if (!delay || delay < 1000) return showToast('⚠️ Informe um delay válido (mínimo 1000ms)', 'warning');

    const res = await fetch(`${API_BOT}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intervaloMinutos: minutos, delayEnvioMs: delay })
    });
    if (res.ok) showToast(`💾 Configurações atualizadas!`, 'success');
    else showToast(`❌ Erro ao atualizar.`, 'danger');
}

function abrirQrCode() { modalQr.show(); }

async function desconectarBot() {
    if (!await showConfirm('Deseja mesmo desconectar do WhatsApp?')) return;
    const res = await fetch(`${API_BOT}/api/desconectar`, { method: 'POST' });
    if (res.ok) showToast('🔌 Desconectado do WhatsApp!', 'info');
    else showToast('❌ Erro ao desconectar.', 'danger');
    verificarStatus();
}

function acaoBot() {}

socket.on('log', msg => {
    const logs = document.getElementById('logs');
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    logs.innerHTML += `<div><span class="timestamp">[${hora}]</span> ➤ ${msg}</div>`;
    logs.scrollTop = logs.scrollHeight;
});
socket.on('qr', qrData => {
    document.getElementById('qrcode').innerHTML = `<img src="${qrData}" alt="QR Code" class="img-fluid">`;
    modalQr.show();
});
socket.on('status', status => {
    verificarStatus();
    if (status === 'conectado') modalQr.hide();
});

async function carregarMensagens(pagina = 1) {
    const res = await fetch(`/api/mensagens?page=${pagina}&limit=10`);
    const dados = await res.json();

    const tbody = document.getElementById('tabela-mensagens');
    tbody.innerHTML = '';
    
    dados.mensagens.forEach(msg => {
        const linha = `<tr><td>${msg.nomeGrupo}</td><td>${msg.mensagem}</td><td>${new Date(msg.horario).toLocaleString()}</td></tr>`;
        tbody.insertAdjacentHTML('beforeend', linha);
    });

    renderizarPaginacao(dados.paginaAtual, dados.totalPaginas);
}

async function carregarDadosGraficos() {
    const res = await fetch('/api/mensagens/all');
    const dados = await res.json();
    const contagemPorGrupo = {};
    const todasMsgs = Object.values(dados).flat();

    todasMsgs.forEach(msg => {
    contagemPorGrupo[msg.nomeGrupo] = (contagemPorGrupo[msg.nomeGrupo] || 0) + 1;
    });
    desenharGrafico(contagemPorGrupo)
}

function renderizarPaginacao(paginaAtual, totalPaginas) {
    const containerPaginacao = document.getElementById('paginacao');
    containerPaginacao.innerHTML = '';

    if (totalPaginas <= 1) return; // nao mostra paginaçao se só tiver 1 pagina

    // botao anterior
    const liAnterior = document.createElement('li');
    liAnterior.className = `page-item ${paginaAtual === 1 ? 'disabled' : ''}`;
    const btnAnterior = document.createElement('a');
    btnAnterior.className = `page-link`;
    btnAnterior.href= '#';
    btnAnterior.innerText = 'Anterior';
    btnAnterior.onclick = (e) => {
    e.preventDefault();
    if (paginaAtual > 1) carregarMensagens(paginaAtual - 1);
    };
    liAnterior.appendChild(btnAnterior);
    containerPaginacao.appendChild(liAnterior);

    // botoes das paginas
    for (let i = 1; i <= totalPaginas; i ++) {
    const li = document.createElement('li');
    li.className = `page-item ${i === paginaAtual ? 'active' : ''}`;
    const btn = document.createElement('a');
    btn.className = 'page-link';
    btn.href = '#';
    btn.innerText = i;
    btn.onclick = (e) => {
        e.preventDefault();
        carregarMensagens(i);
    };
    li.appendChild(btn);
    containerPaginacao.appendChild(li);
    }

    const liProximo = document.createElement('li');
    liProximo.className = `page-item ${paginaAtual === totalPaginas ? 'disabled' : ''}`;
    const btnProximo = document.createElement('a');
    btnProximo.className = 'page-link';
    btnProximo.href = '#';
    btnProximo.innerHTML = 'Proximo';
    btnProximo.onclick = (e) => {
    e.preventDefault();
    if (paginaAtual < totalPaginas) carregarMensagens(paginaAtual + 1);
    };
    liProximo.appendChild(btnProximo);
    containerPaginacao.appendChild(liProximo);
} 

function desenharGrafico(contagem) {
    const ctx = document.getElementById('chart').getContext('2d');
    if (window.grafico) window.grafico.destroy();
    window.grafico = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: Object.keys(contagem),
            datasets: [{
                label: 'Mensagens por Grupo',
                data: Object.values(contagem),
                backgroundColor: 'rgba(54, 162, 235, 0.7)'
            }]
        },
        options: { responsive: true, scales: { y: { beginAtZero: true } } }
    });
}

async function iniciarBot() {
    await fetch(`${API_BOT}/api/iniciar`, { method: 'POST' });
    showToast('✅ Bot iniciado', 'success');
}
async function pararBot() {
    await fetch(`${API_BOT}/api/parar`, { method: 'POST' });
    showToast('⏹️ Bot parado', 'info');
}

// --- LÓGICA DE GRUPOS ATUALIZADA ---
async function carregarGruposNaoSync() {
    const res = await fetch('/api/grupos-nao-sincronizados');
    const grupos = await res.json();
    const tbody = document.getElementById('tabela-grupos-nao-sync');
    tbody.innerHTML = '';
    if (grupos.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" class="text-center">🎉 Nenhum grupo novo.</td></tr>`;
        return;
    }
    grupos.forEach(grupo => {
        const linha = `<tr><td>${grupo.name}</td><td><button class="btn btn-sm btn-success" onclick="sincronizarGrupo('${grupo.id}', '${grupo.name.replace(/'/g, "\\'")}')">➕ Sincronizar</button></td></tr>`;
        tbody.insertAdjacentHTML('beforeend', linha);
    });
}

async function carregarGruposSync() {
    const res = await fetch('/api/grupos-sincronizados');
    const grupos = await res.json();
    const tbody = document.getElementById('tabela-grupos-sync');
    tbody.innerHTML = '';
    if (grupos.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" class="text-center">Nenhum grupo sincronizado.</td></tr>`;
        return;
    }
    grupos.forEach(grupo => {
        const linha = `<tr>
                        <td>${grupo.name}</td>
                        <td class="text-end">
                            <button class="btn btn-sm btn-info me-1" onclick="testarMensagem('${grupo.id}', '${grupo.name.replace(/'/g, "\\'")}')">🧪 Testar</button>
                            <button class="btn btn-sm btn-danger" onclick="desincronizarGrupo('${grupo.id}', '${grupo.name.replace(/'/g, "\\'")}')">➖ Desincronizar</button>
                        </td>
                        </tr>`;
        tbody.insertAdjacentHTML('beforeend', linha);
    });
}

async function desincronizarGrupo(id, name) {
    if (!await showConfirm(`Deseja realmente DESINCRONIZAR o grupo "${name}"?`)) return;

    const res = await fetch('/api/desincronizar-grupo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name })
    });

    if (res.ok) {
    showToast(`➖ Grupo "${name}" foi desincronizado!`, 'info');
    // atualiza as duas tabelas para garantir a mudança
    carregarGruposSync();
    carregarGruposNaoSync();
    } else {
    showToast(`❌ Erro ao desincronizar.`, 'danger');
    }
}

async function sincronizarGrupo(id, name) {
    if (!await showConfirm(`Deseja realmente sincronizar o grupo "${name}"?`)) return;
    const res = await fetch('/api/sincronizar-grupo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name })
    });
    if (res.ok) {
        showToast(`✅ Grupo "${name}" sincronizado!`, 'success');
        carregarGruposSync();
        carregarGruposNaoSync();
    } else {
        showToast(`❌ Erro ao sincronizar.`, 'danger');
    }
}

// --- NOVA FUNÇÃO PARA TESTAR MENSAGEM ---
async function testarMensagem(id, name) {
    document.getElementById('conteudo-teste').innerHTML = 'Gerando mensagem, aguarde...';
    modalTeste.show();

    const res = await fetch('/api/testar-mensagem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, name: name })
    });
    
    if (res.ok) {
        const data = await res.json();
        document.getElementById('conteudo-teste').innerText = data.mensagem;
    } else {
        document.getElementById('conteudo-teste').innerText = 'Falha ao gerar a mensagem de teste.';
    }
}

// Lógica para salvar a aba ativa
document.querySelectorAll('#tabs a').forEach(tab => {
    tab.addEventListener('shown.bs.tab', e => localStorage.setItem('activeTab', e.target.getAttribute('href')));
});
const activeTab = localStorage.getItem('activeTab');
if (activeTab) {
    const tabTrigger = document.querySelector(`#tabs a[href="${activeTab}"]`);
    if(tabTrigger) new bootstrap.Tab(tabTrigger).show();
}

// 🏁 Inicialização
verificarStatus();
carregarConfig();
carregarMensagens();
carregarDadosGraficos();
carregarGruposSync();
carregarGruposNaoSync();
setInterval(verificarStatus, 15000);