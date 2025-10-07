const API_BOT = window.location.origin;
const socket = io();
let syncGroupCount = 0;

const modalQrElement = document.getElementById("modalQr");
const modalQr = new bootstrap.Modal(modalQrElement);
const qrScanAbortedListener = () => {
  socket.emit("qr_scan_aborted");
};

const modalTeste = new bootstrap.Modal(document.getElementById("modalTeste"));
const modalConfirm = new bootstrap.Modal(document.getElementById("modalConfirm"));
const botaoAcao = document.getElementById("botao-acao");

async function showToast(message, type = "info") {
  const toastContainer = document.querySelector(".toast-container");
  if (!toastContainer) return;

  const toastColor = {
    success: "bg-success",
    danger: "bg-danger",
    warning: "bg-warning",
    info: "bg-info",
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

  toastContainer.insertAdjacentHTML("beforeend", toastHTML);

  const toastElement = document.getElementById(toastId);
  const toast = new bootstrap.Toast(toastElement, { delay: 4000 });
  toast.show();

  toastElement.addEventListener("hidden.bs.toast", () => {
    toastElement.remove();
  });
}

function showConfirm(question) {
  const modalElement = document.getElementById("modalConfirm");
  const confirmModal = bootstrap.Modal.getOrCreateInstance(modalElement);

  document.getElementById("confirmQuestion").textContent = question;

  return new Promise((resolve) => {
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");

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
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
    };

    okBtn.addEventListener("click", onOk, { once: true });
    cancelBtn.addEventListener("click", onCancel, { once: true });

    confirmModal.show();
  });
}

async function verificarStatus() {
  try {
    const res = await fetch(`${API_BOT}/api/status`);
    const { status } = await res.json();
    botaoAcao.disabled = false;

    if (status === "conectado") {
      botaoAcao.textContent = "🔌 Desconectar WhatsApp";
      botaoAcao.className = "btn btn-outline-danger";
      botaoAcao.onclick = desconectarBot;
    } else {
      botaoAcao.textContent = "🔑 Conectar WhatsApp";
      botaoAcao.className = "btn btn-outline-success";
      botaoAcao.onclick = conectarBot;
    }
  } catch {
    botaoAcao.disabled = false;
    botaoAcao.textContent = "❌ Bot offline";
    botaoAcao.className = "btn btn-outline-secondary";
    botaoAcao.onclick = () => showToast("❌ Servidor não disponível", "danger");
  }
}

async function conectarBot() {
  showToast("🚀 Enviando comando para conectar...", "info");
  botaoAcao.textContent = "🔄 Aguardando QR Code...";
  botaoAcao.disabled = true;
  await fetch(`${API_BOT}/api/conectar`, { method: "POST" });
}

async function desconectarBot() {
  if (!(await showConfirm("Deseja mesmo desconectar do WhatsApp?"))) return;
  const res = await fetch(`${API_BOT}/api/desconectar`, { method: "POST" });
  if (res.ok) {
    showToast("🔌 Desconectado do WhatsApp!", "info");
  } else {
    showToast("❌ Erro ao desconectar.", "danger");
  }
  await verificarStatus();
}

//  função para salvar os prompts
async function salvarPrompts() {
  const promptComPdf = document.getElementById("promptComPdf").value;
  const promptSemPdf = document.getElementById("promptSemPdf").value;

  if (!promptComPdf || !promptSemPdf) {
    return showToast("⚠️ Os dois campos de prompt devem ser preenchidos.", "warning");
  }

  const res = await fetch("/api/config/prompts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ promptComPdf, promptSemPdf }),
  });

  if (res.ok) {
    showToast("✅ Prompts salvos com sucesso!", "success");
  } else {
    showToast("❌ Erro ao salvar os prompts.", "danger");
  }
}

async function carregarConfig() {
  const res = await fetch("/api/config");
  if (res.ok) {
    const cfg = await res.json();
    document.getElementById("intervalo").value = cfg.intervaloMinutos;
    document.getElementById("delay").value = cfg.delayEnvioMs;

    // Preenche os campos de prompt
    if (document.getElementById("promptComPdf")) {
      document.getElementById("promptComPdf").value = cfg.promptComPdf;
      document.getElementById("promptSemPdf").value = cfg.promptSemPdf;
    }
  }
}

async function atualizarConfig() {
  const minutos = parseInt(document.getElementById("intervalo").value);
  const delay = parseInt(document.getElementById("delay").value);
  if (!minutos || minutos < 1) return showToast("⚠️ Informe um intervalo válido (mínimo 1 minuto)", "warning");
  if (!delay || delay < 1000) return showToast("⚠️ Informe um delay válido (mínimo 1000ms)", "warning");

  const res = await fetch(`${API_BOT}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intervaloMinutos: minutos, delayEnvioMs: delay }),
  });
  if (res.ok) showToast(`💾 Configurações atualizadas!`, "success");
  else showToast(`❌ Erro ao atualizar.`, "danger");
}

function abrirQrCode() {
  modalQr.show();
}

function acaoBot() {}

socket.on("log_history", (history) => {
  const logs = document.getElementById("logs");
  logs.innerHTML = "";
  history.forEach((logEntry) => {
    logs.innerHTML += `<div><span class="timestamp">[${logEntry.hora}]</span> ➤ ${logEntry.msg}</div>`;
  });
  logs.scrollTop = logs.scrollHeight;
});
socket.on("log", (logEntry) => {
  const logs = document.getElementById("logs");
  logs.innerHTML += `<div><span class="timestamp">[${logEntry.hora}]</span> ➤ ${logEntry.msg}</div>`;
  logs.scrollTop = logs.scrollHeight;
});

socket.on("qr", (qrData) => {
  document.getElementById("qrcode").innerHTML = `<img src="${qrData}" alt="QR Code" class="img-fluid">`;
  modalQr.show();
  modalQrElement.addEventListener("hidden.bs.modal", qrScanAbortedListener, { once: true });
});

socket.on("status", (status) => {
  verificarStatus();
  if (status === "conectado") {
    modalQrElement.removeEventListener("hidden.bs.modal", qrScanAbortedListener);
    modalQr.hide();
  }
});

async function carregarMensagens(pagina = 1) {
  const res = await fetch(`/api/mensagens?page=${pagina}&limit=10`);
  const dados = await res.json();

  const tbody = document.getElementById("tabela-mensagens");
  tbody.innerHTML = "";

  dados.mensagens.forEach((msg) => {
    const linha = `<tr><td>${msg.nomeGrupo}</td><td>${msg.mensagem}</td><td>${new Date(msg.horario).toLocaleString()}</td></tr>`;
    tbody.insertAdjacentHTML("beforeend", linha);
  });

  renderizarPaginacao(dados.paginaAtual, dados.totalPaginas);
}

async function carregarDadosGraficos() {
  const res = await fetch("/api/mensagens/all");
  const dados = await res.json();
  const contagemPorGrupo = {};
  const todasMsgs = Object.values(dados).flat();

  todasMsgs.forEach((msg) => {
    contagemPorGrupo[msg.nomeGrupo] = (contagemPorGrupo[msg.nomeGrupo] || 0) + 1;
  });
  desenharGrafico(contagemPorGrupo);
}

function renderizarPaginacao(paginaAtual, totalPaginas) {
  const containerPaginacao = document.getElementById("paginacao");
  containerPaginacao.innerHTML = "";

  if (totalPaginas <= 1) return; // nao mostra paginaçao se só tiver 1 pagina

  // botao anterior
  const liAnterior = document.createElement("li");
  liAnterior.className = `page-item ${paginaAtual === 1 ? "disabled" : ""}`;
  const btnAnterior = document.createElement("a");
  btnAnterior.className = `page-link`;
  btnAnterior.href = "#";
  btnAnterior.innerText = "Anterior";
  btnAnterior.onclick = (e) => {
    e.preventDefault();
    if (paginaAtual > 1) carregarMensagens(paginaAtual - 1);
  };
  liAnterior.appendChild(btnAnterior);
  containerPaginacao.appendChild(liAnterior);

  // botoes das paginas
  for (let i = 1; i <= totalPaginas; i++) {
    const li = document.createElement("li");
    li.className = `page-item ${i === paginaAtual ? "active" : ""}`;
    const btn = document.createElement("a");
    btn.className = "page-link";
    btn.href = "#";
    btn.innerText = i;
    btn.onclick = (e) => {
      e.preventDefault();
      carregarMensagens(i);
    };
    li.appendChild(btn);
    containerPaginacao.appendChild(li);
  }

  const liProximo = document.createElement("li");
  liProximo.className = `page-item ${paginaAtual === totalPaginas ? "disabled" : ""}`;
  const btnProximo = document.createElement("a");
  btnProximo.className = "page-link";
  btnProximo.href = "#";
  btnProximo.innerHTML = "Proximo";
  btnProximo.onclick = (e) => {
    e.preventDefault();
    if (paginaAtual < totalPaginas) carregarMensagens(paginaAtual + 1);
  };
  liProximo.appendChild(btnProximo);
  containerPaginacao.appendChild(liProximo);
}

function desenharGrafico(contagem) {
  const ctx = document.getElementById("chart").getContext("2d");
  if (window.grafico) window.grafico.destroy();
  window.grafico = new Chart(ctx, {
    type: "bar",
    data: {
      labels: Object.keys(contagem),
      datasets: [
        {
          label: "Mensagens por Grupo",
          data: Object.values(contagem),
          backgroundColor: "rgba(54, 162, 235, 0.7)",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true },
      },
    },
  });
}

async function iniciarBot() {
  await fetch(`${API_BOT}/api/iniciar`, { method: "POST" });
  showToast("✅ Bot iniciado", "success");
}

async function pararBot() {
  await fetch(`${API_BOT}/api/parar`, { method: "POST" });
  showToast("⏹️ Bot parado", "info");
}

function atualizarControlesBot() {
  const btnIniciar = document.getElementById("btn-iniciar");
  if (btnIniciar) {
    if (syncGroupCount > 0) {
      btnIniciar.disabled = false;
      btnIniciar.title = "Iniciar o envio de mensagens";
    } else {
      btnIniciar.disabled = true;
      btnIniciar.title = "Sincronize pelo menos 1 grupo";
    }
  }
}

// --- LÓGICA DE GRUPOS ATUALIZADA ---
async function carregarGruposNaoSync() {
  const res = await fetch("/api/grupos-nao-sincronizados");
  const grupos = await res.json();
  const tbody = document.getElementById("tabela-grupos-nao-sync");
  tbody.innerHTML = "";
  if (grupos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="2" class="text-center">🎉 Nenhum grupo novo.</td></tr>`;
    return;
  }
  grupos.forEach((grupo) => {
    const linha = `<tr><td>${grupo.name}</td><td><button class="btn btn-sm btn-success" onclick="sincronizarGrupo('${
      grupo.id
    }', '${grupo.name.replace(/'/g, "\\'")}')">➕ Sincronizar</button></td></tr>`;
    tbody.insertAdjacentHTML("beforeend", linha);
  });
}

async function carregarGruposSync() {
  try {
    const res = await fetch("/api/grupos-sincronizados");
    const grupos = await res.json();
    const tbody = document.getElementById("tabela-grupos-sync");

    syncGroupCount = grupos.length;
    tbody.innerHTML = "";

    if (grupos.length === 0) {
      tbody.innerHTML = `<tr><td colspan="2" class="text-center">Nenhum grupo sincronizado.</td></tr>`;
    } else {
      grupos.forEach((grupo) => {
        const escapedName = grupo.name.replace(/'/g, "\\'");
        const linha = `
                      <tr>
                          <td>${grupo.name}</td>
                          <td class="text-end">
                              <input type="file" id="pdf-upload-${grupo.id}" class="d-none" accept=".pdf">

                              <div class="btn-group" role="group" style="display: inline-flex; gap: 1rem;">
                                  
                                  <button class="btn btn-sm btn-secondary" title="Ver Participantes" onclick="verParticipantes('${grupo.id}', '${escapedName}')">
                                    👥 Ver
                                  </button>

                                  <button class="btn btn-sm btn-primary" title="Enviar PDF" onclick="document.getElementById('pdf-upload-${grupo.id}').click()">
                                      📤 PDF
                                  </button>
                                  <button class="btn btn-sm btn-info" title="Testar Mensagem" onclick="testarMensagem('${grupo.id}', '${escapedName}')">
                                      🧪 Testar
                                  </button>
                                  <button class="btn btn-sm btn-danger" title="Desincronizar Grupo" onclick="desincronizarGrupo('${grupo.id}', '${escapedName}')">
                                      ➖ Desincronizar
                                  </button>
                              </div>
                          </td>
                      </tr>`;
        tbody.insertAdjacentHTML("beforeend", linha);

        // Adiciona o listener para o input de arquivo recém-criado
        document.getElementById(`pdf-upload-${grupo.id}`).addEventListener("change", (event) => {
          const file = event.target.files[0];
          if (file) {
            uploadPDF(grupo.id, grupo.name, file);
          }
        });
      });
    }
  } catch (error) {
    console.error("Falha ao carregar grupos sincronizados:", error);
    syncGroupCount = 0;
  } finally {
    atualizarControlesBot();
  }
}

async function desincronizarGrupo(id, name) {
  if (!(await showConfirm(`Deseja realmente DESINCRONIZAR o grupo "${name}"?`))) return;

  const res = await fetch("/api/desincronizar-grupo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  });

  if (res.ok) {
    showToast(`➖ Grupo "${name}" foi desincronizado!`, "info");
    // atualiza as duas tabelas para garantir a mudança
    carregarGruposSync();
    carregarGruposNaoSync();
  } else {
    showToast(`❌ Erro ao desincronizar.`, "danger");
  }
}

async function sincronizarGrupo(id, name) {
  if (!(await showConfirm(`Deseja realmente sincronizar o grupo "${name}"?`))) return;
  const res = await fetch("/api/sincronizar-grupo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  if (res.ok) {
    showToast(`✅ Grupo "${name}" sincronizado!`, "success");
    carregarGruposSync();
    carregarGruposNaoSync();
  } else {
    showToast(`❌ Erro ao sincronizar.`, "danger");
  }
}

async function verParticipantes(grupoId, grupoNome) {
  const modalElement = document.getElementById("modalParticipantes");
  const modal = new bootstrap.Modal(modalElement);
  const containerParticipantes = document.getElementById("listaParticipantes");
  const tituloModal = document.getElementById("tituloModalParticipantes");
  const btnEnviar = document.getElementById("btn-enviar-selecionados");

  tituloModal.textContent = `Carregando participantes de "${grupoNome}"...`;
  containerParticipantes.innerHTML = "<p>Buscando em tempo real...</p>";
  modal.show();

  try {
    // MODIFICAÇÃO: Aponta para a nova rota da API
    const res = await fetch(`/api/grupo/${grupoId}/participantes`);

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error || `Erro ${res.status}`);
    }

    const participantes = await res.json();
    tituloModal.textContent = `Participantes de "${grupoNome}" (${participantes.length})`;
    containerParticipantes.innerHTML = "";

    if (participantes.length === 0) {
      containerParticipantes.innerHTML = "<p>Nenhum participante encontrado.</p>";
      return;
    }

    // O restante da lógica para exibir os checkboxes permanece igual
    participantes.forEach((p) => {
      const numero = p.id.split("@")[0];
      const div = document.createElement("div");
      div.className = "form-check";
      div.innerHTML = `
        <input class="form-check-input" type="checkbox" value="${p.id}" id="check-${p.id}">
        <label class="form-check-label" for="check-${p.id}">
          <strong>${p.name}</strong> (${numero})
        </label>
      `;
      containerParticipantes.appendChild(div);
    });

    btnEnviar.onclick = () => enviarMensagemParaSelecionados(modal);
  } catch (error) {
    console.error("Erro ao buscar participantes:", error);
    tituloModal.textContent = "Erro ao carregar";
    // Exibe o erro de forma mais clara no modal
    containerParticipantes.innerHTML = `<div class="alert alert-danger">${error.message}</div>`;
  }
}

async function enviarMensagemParaSelecionados(modal) {
  const mensagem = document.getElementById("mensagem-individual").value;
  const checkboxes = document.querySelectorAll('#listaParticipantes input[type="checkbox"]:checked');
  const userIds = Array.from(checkboxes).map((cb) => cb.value);

  if (!mensagem) {
    return showToast("⚠️ Escreva uma mensagem para enviar.", "warning");
  }
  if (userIds.length === 0) {
    return showToast("⚠️ Selecione pelo menos um participante.", "warning");
  }

  modal.hide();

  const confirmou = await showConfirm(`Deseja mesmo enviar a mensagem para ${userIds.length} pessoa(s)?`);
  if (!confirmou) {
    modal.show();
    return;
  }
  showToast(`🚀 Enviando mensagem para ${userIds.length} contatos...`, "info");
  modal.hide();

  try {
    const res = await fetch("/api/enviar-mensagem-individual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds, mensagem }),
    });

    if (res.ok) {
      showToast("✅ Mensagens enviadas com sucesso!", "success");
    } else {
      const errorData = await res.json();
      showToast(`❌ Erro: ${errorData.error}`, "danger");
    }
  } catch (error) {
    showToast("❌ Erro de rede ao tentar enviar.", "danger");
  }

  document.getElementById("mensagem-individual").value = "";
  checkboxes.forEach((cb) => (cb.checked = false));
}

// FUNÇÃO PARA UPLOAD DE PDF
async function uploadPDF(groupId, groupName, file) {
  if (!(await showConfirm(`Enviar o arquivo "${file.name}" para o grupo "${groupName}"? O PDF antigo será substituído.`))) {
    // Limpa o input se o usuário cancelar, para que ele possa selecionar o mesmo arquivo novamente
    document.getElementById(`pdf-upload-${groupId}`).value = "";
    return;
  }

  const formData = new FormData();
  formData.append("pdfFile", file);

  showToast(`Enviando PDF para "${groupName}"...`, "info");

  try {
    const res = await fetch(`/api/upload-pdf/${groupId}`, {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      showToast(`✅ PDF para "${groupName}" foi enviado com sucesso!`, "success");
    } else {
      const errorData = await res.json();
      showToast(`❌ Erro ao enviar PDF: ${errorData.error}`, "danger");
    }
  } catch (error) {
    showToast(`❌ Erro de rede ao enviar o PDF.`, "danger");
  } finally {
    // Limpa o input após o envio
    document.getElementById(`pdf-upload-${groupId}`).value = "";
  }
}

// --- NOVA FUNÇÃO PARA TESTAR MENSAGEM ---
async function testarMensagem(id, name) {
  document.getElementById("conteudo-teste").innerHTML = "Gerando mensagem, aguarde...";
  const btnDescartar = document.getElementById("btn-descartar-teste");

  const novoBtnDescartar = btnDescartar.cloneNode(true);
  btnDescartar.parentNode.replaceChild(novoBtnDescartar, btnDescartar);

  novoBtnDescartar.onclick = async () => {
    const res = await fetch("/api/descartar-mensagem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id }), // Usa o ID do grupo que está sendo testado
    });

    if (res.ok) {
      showToast(`🗑️ Mensagem de teste para "${name}" foi descartada.`, "info");
      modalTeste.hide();
    } else {
      showToast("❌ Erro ao descartar a mensagem.", "danger");
    }
  };

  modalTeste.show();

  const res = await fetch("/api/testar-mensagem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: id, name: name }),
  });

  if (res.ok) {
    const data = await res.json();
    document.getElementById("conteudo-teste").innerText = data.mensagem;
  } else {
    document.getElementById("conteudo-teste").innerText = "Falha ao gerar a mensagem de teste.";
  }
}

async function carregarHealthStatus() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) {
      atualizarStatusCheck("whatsapp", "error", "APIde health indisponivel");
      atualizarStatusCheck("ai_api", "error", "API de health indisponível");
      atualizarStatusCheck("filesystem", "error", "API de health indisponível");
      return;
    }

    const healthData = await res.json();
    for (const checkName in healthData.checks) {
      const check = healthData.checks[checkName];
      atualizarStatusCheck(checkName, check.status, check.message);
    }
  } catch (error) {
    console.error("Falha ao carregar status de saúde:", error);
    showToast("Falha ao carregar status de saúde:", "danger");
  }
}

function atualizarStatusCheck(checkName, status, message) {
  const statusBadge = document.getElementById(`health-${checkName}-status`);
  const messageText = document.getElementById(`health-${checkName}-message`);

  if (statusBadge && messageText) {
    messageText.textContent = message;
    if (status === "ok") {
      statusBadge.textContent = "OK";
      statusBadge.className = "badge rounded-pill bg-success";
    } else if (status === "warning") {
      statusBadge.textContent = "AVISO";
      statusBadge.className = "badge rounded-pill bg-warning text-dark";
    } else {
      statusBadge.textContent = "ERRO";
      statusBadge.className = "badge rounded-pill bg-danger";
    }
  }
}

// Lógica para salvar a aba ativa
document.querySelectorAll("#tabs a").forEach((tab) => {
  tab.addEventListener("shown.bs.tab", (e) => localStorage.setItem("activeTab", e.target.getAttribute("href")));
});
const activeTab = localStorage.getItem("activeTab");
if (activeTab) {
  const tabTrigger = document.querySelector(`#tabs a[href="${activeTab}"]`);
  if (tabTrigger) new bootstrap.Tab(tabTrigger).show();
}

// 🏁 Inicialização
verificarStatus();
carregarConfig();
carregarMensagens();
carregarDadosGraficos();
carregarGruposSync();
carregarGruposNaoSync();
carregarHealthStatus();
setInterval(() => {
  verificarStatus();
  carregarHealthStatus();
}, 10000);
