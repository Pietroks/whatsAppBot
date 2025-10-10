const { Client } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const schedule = require("node-schedule");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config();
const axiosRetry = require("axios-retry").default;
const chalk = require("chalk");
const gerarMensagemIA = require("./gerarMensagemIA");
const createApiRouter = require("./routes/api.js");

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const { stat } = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;

// --- Configurações ---
const clientConfig = {
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
  },
};

// --- Caminhos de Arquivos ---
const gruposSyncPath = path.join(__dirname, "gruposIDs", "grupos_sincronizados.json");
const gruposNaoSyncPath = path.join(__dirname, "gruposIDs", "grupos_nao_sincronizados.json");
const mensagensEnviadasPath = path.join(__dirname, "historico", "mensagens_enviadas.json");
const configPath = path.join(__dirname, "config.json");

// --- Variáveis de Estado ---
let client;
let agendamento;
let logHistory = [];
let state = {
  gruposValidos: [],
  clientEmDesconexao: false,
  pararEnvioAtual: false,
  mensagensPreGeradas: new Map(),
  isQrCodeVisible: false,
};

// --- Middlewares do Express ---
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "views")));
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

// --- Funções Principais do Bot ---
function clientAtivo() {
  return client && client.info && client.info.wid;
}

function removerDuplicados(grupos) {
  const mapa = new Map();
  grupos.forEach((g) => mapa.set(g.id, g));
  return Array.from(mapa.values());
}

function initializeClient() {
  if (client) {
    return logDashboard("⚠️ Tentativa de inicializar um cliente que já existe ou está em processo.");
  }

  logDashboard("🚀 Inicializando cliente WhatsApp...");
  client = new Client(clientConfig);
  configurarEventosClient();
  client.initialize().catch((err) => {
    logDashboard(`❌ Erro fatal durante a inicialização do cliente: ${err.message}`);
    client = null;
  });
}

async function destroyClient() {
  if (!client) return;
  try {
    state.clientEmDesconexao = true;
    await client.destroy();
    logDashboard("🗑️ Cliente WhatsApp destruído.");
  } catch (err) {
    logTerminal(`❌ Erro ao destruir o cliente: ${err.message}`);
  } finally {
    client = null;
    state.clientEmDesconexao = false;
    state.isQrCodeVisible = false;
    io.emit("status", "desconhecido");
  }
}

function configurarEventosClient() {
  client.on("qr", async (qr) => {
    try {
      const qrImage = await qrcode.toDataURL(qr);
      io.emit("qr", qrImage);

      if (!state.isQrCodeVisible) {
        logDashboard("📲 QR Code gerado! Escaneie para conectar...");
        state.isQrCodeVisible = true;
      } else {
        logTerminal("ℹ️ Imagem do QR Code foi atualizada no dashboard.");
      }
    } catch (err) {
      logDashboard("❌ Erro ao gerar/atualizar QR Code: " + err.message);
    }
  });

  client.on("ready", async () => {
    logDashboard("✅ Bot conectado com sucesso!");
    state.isQrCodeVisible = false;

    io.emit("status", "conectado");
    try {
      logDashboard("🔄 Sincronizando grupos...");
      await sincronizarGrupos();
      const config = await carregarConfig();
      if (config.habilitado) await iniciarAgendamento();
    } catch (error) {
      logDashboard(`❌ Erro crítico durante a inicialização pós-ready: ${error.message}`);
    }
  });

  client.on("disconnected", (reason) => {
    logDashboard(`🔌 Desconectado: ${reason}`);
    state.isQrCodeVisible = false;

    io.emit("status", "desconectado");
  });

  client.on("auth_failure", (msg) => {
    logDashboard(`❌ Falha de autenticação: ${msg}`);
    io.emit("status", "desconectado");
  });
}

function logDashboard(msg) {
  const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const logCompleto = { hora, msg };

  logHistory.push(logCompleto);
  if (logHistory.length > 50) {
    logHistory = logHistory.slice(-50);
  }

  console.log(`[${hora}] ➤ ${msg}`);
  io.emit("log", logCompleto);
}

function logTerminal(msg) {
  console.log(msg);
}

async function sincronizarGrupos() {
  if (state.clientEmDesconexao || !clientAtivo()) {
    logDashboard("⚠️ WhatsApp não conectado. Sincronização cancelada.");
    return;
  }

  let todosGrupos = [];
  let sucessoBuscaChats = false;

  try {
    const chats = await client.getChats();
    // Apenas mapeia o ID e o NOME do grupo. Simples e rápido.
    todosGrupos = chats.filter((c) => c.isGroup && c.id && c.id._serialized).map((g) => ({ id: g.id._serialized, name: g.name }));

    if (todosGrupos.length > 0) {
      logTerminal(chalk.blue("ℹ️ Diagnóstico de ID do primeiro grupo encontrado:"), todosGrupos[0].id);
    }
    logDashboard(`🔍 ${todosGrupos.length} grupos encontrados no WhatsApp.`);
    sucessoBuscaChats = true;
  } catch (error) {
    logTerminal(
      chalk.yellow(
        `⚠️ Aviso: Falha ao buscar a lista de grupos do WhatsApp (client.getChats). O erro foi ignorado. Causa: ${error.message}`
      )
    );
  }

  let gruposSalvos = [];
  try {
    const data = await fs.readFile(gruposSyncPath, "utf-8");
    gruposSalvos = JSON.parse(data);
  } catch {}

  state.gruposValidos = removerDuplicados(gruposSalvos);

  if (sucessoBuscaChats) {
    const naoSincronizados = todosGrupos.filter((g) => !state.gruposValidos.some((v) => v.id === g.id));
    await salvarJSONSeDiferente(gruposNaoSyncPath, naoSincronizados);
  }

  logDashboard(`✅ ${state.gruposValidos.length} grupos válidos e configurados para envio.`);
}

async function iniciarAgendamento(options = {}) {
  try {
    const config = await carregarConfig();

    if (agendamento) {
      agendamento.cancel();
      if (!options.silent) {
        logDashboard("🔁 Reiniciando agendamento...");
      }
    }

    if (!config.habilitado) {
      if (!options.silent) {
        logDashboard("⏸️ Agendamento desativado.");
      }
      return;
    }

    // CORREÇÃO 2: Cálculo de milissegundos corrigido.
    const intervaloMs = config.intervaloMinutos * 60 * 1000;
    const proximaData = new Date(Date.now() + intervaloMs);

    agendamento = schedule.scheduleJob("envio-mensagens", proximaData, async () => {
      // CORREÇÃO 4: Adicionado try...catch para evitar que o bot trave.
      try {
        await enviarMensagensEmLote();
        await iniciarAgendamento({ silent: true });
      } catch (err) {
        logDashboard(`❌ Erro fatal na execução agendada: ${err.message}. O agendamento será interrompido.`);
        pararAgendamento(); // Interrompe para evitar loops de erro.
      }
    });

    // CORREÇÃO PRINCIPAL: 'pt_BR' para 'pt-BR'.
    const dataFormatada = proximaData.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    if (!options.silent) {
      logDashboard(`🕒 Agendamento definido. Próximo envio: ${dataFormatada}`);
    } else {
      logDashboard(`⏳ Próximo envio reagendado para: ${dataFormatada}`);
    }
  } catch (error) {
    logDashboard(`❌ Erro crítico ao configurar o agendamento: ${error.message}`);
  }
}

async function pararAgendamento() {
  if (agendamento) {
    agendamento.cancel();
    logDashboard("⏹️ Agendamento parado.");
  }
}

function pararEnvioAtual() {
  if (state.pararEnvioAtual) {
    logDashboard("⚠️ Comando para parar já recebido, a aguardar o fim do ciclo atual.");
    return;
  }
  logDashboard("🔴 Comando para parar o envio em massa recebido. O bot irá parar após a mensagem atual.");
  state.pararEnvioAtual = true;
}

async function enviarMensagensEmLote() {
  try {
    const gruposSalvos = JSON.parse(await fs.readFile(gruposSyncPath, "utf-8"));
    gruposValidos = removerDuplicados(gruposSalvos);
  } catch {
    logDashboard("⚠️ Nenhum grupo sincronizado para envio.");
    return;
  }

  if (state.clientEmDesconexao || !clientAtivo()) {
    logDashboard("⚠️ WhatsApp não está conectado. Cancelando envio.");
    return;
  }

  logDashboard(`🤖 Executando tarefa agendada para ${state.gruposValidos.length} grupo(s).`);
  const config = await carregarConfig();
  const INTERVALO = config.delayEnvioMs || 15000;
  let historicoCompleto = {};
  try {
    historicoCompleto = JSON.parse(await fs.readFile(mensagensEnviadasPath, "utf-8"));
  } catch {}

  for (let i = 0; i < state.gruposValidos.length; i++) {
    const grupo = state.gruposValidos[i];
    if (i > 0) await delay(INTERVALO);
    const enviado = await enviarMensagemParaGrupo(grupo, historicoCompleto);
    if (!enviado) logDashboard(`⏩ Nenhuma nova mensagem para "${grupo.name}".`);
  }
}

async function enviarMensagemParaGrupo(grupo, historicoCompleto) {
  try {
    const nomeGrupo = grupo.name;
    let mensagem; // Apenas declara a variável

    const config = await carregarConfig();

    // 1. VERIFICA O CACHE PRIMEIRO
    if (state.mensagensPreGeradas.has(grupo.id)) {
      // Se encontrou uma mensagem no cache, usa ela
      mensagem = state.mensagensPreGeradas.get(grupo.id);
      logDashboard(`✔️ Usando mensagem pré-aprovada do cache para "${nomeGrupo}".`);
      // Limpa o cache para este grupo, pois a mensagem será usada agora
      state.mensagensPreGeradas.delete(grupo.id);
    } else {
      // 2. SE NÃO HOUVER CACHE, GERA UMA NOVA MENSAGEM (lógica antiga)
      logDashboard(`🧠 Nenhuma mensagem em cache. Gerando nova mensagem para "${nomeGrupo}"...`);
      mensagem = await gerarMensagemIA(nomeGrupo, grupo.id, config);

      // 3. VERIFICA DUPLICIDADE (apenas para mensagens novas, não para as do cache)
      const ultimas = (historicoCompleto[grupo.id]?.map((m) => m.mensagem.trim()) || []).slice(-10);
      let tentativas = 0;

      while (ultimas.includes(mensagem.trim()) && tentativas < 3) {
        logDashboard(`🔄 Mensagem para "${nomeGrupo}" é repetida. Tentando gerar outra...`);
        mensagem = await gerarMensagemIA(nomeGrupo, grupo.id, config);
        tentativas++;
      }

      // Se mesmo após as tentativas a mensagem ainda for repetida, pula o envio
      if (ultimas.includes(mensagem.trim())) {
        logDashboard(`⏩ Mensagem para "${nomeGrupo}" ainda é repetida após tentativas. Pulando envio.`);
        return false;
      }
    }

    // 4. ENVIA A MENSAGEM (seja ela do cache ou recém-gerada)
    await client.sendMessage(grupo.id, mensagem);
    await salvarMensagemNoHistorico(grupo.id, mensagem, nomeGrupo);
    logDashboard(`📤 Mensagem enviada para "${nomeGrupo}"`);
    return true;
  } catch (err) {
    let mensagemErro = err.message;

    if (err.message && (err.message.toLowerCase().includes("closed group") || err.message.toLowerCase().includes("not an admin"))) {
      mensagemErro = "O bot não é admin ou o grupo está configurado para 'Somente Admins'.";
    }

    logDashboard(`❌ Erro ao enviar para "${grupo.name}": ${err.message}`);
    return false;
  }
}

function processarSpintax(texto) {
  // O loop continua enquanto houver um {bloco|de|opções} no texto
  while (texto.includes("{")) {
    const spintaxRegex = /\{([^{}]+?)\}/; // Pega o primeiro bloco que encontrar
    const match = texto.match(spintaxRegex);
    if (!match) break; // Se não encontrar mais, para o loop

    const opcoesString = match[1];
    const opcoes = opcoesString.split("|");
    // Escolhe uma opção aleatória e remove espaços extras
    const escolhaAleatoria = opcoes[Math.floor(Math.random() * opcoes.length)].trim();

    // Substitui o bloco {opções} pela escolha aleatória
    texto = texto.replace(match[0], escolhaAleatoria);
  }
  return texto;
}

async function enviarMensagensIndividuais(userIds, mensagem) {
  state.pararEnvioAtual = false;
  io.emit("envio_status", { inProgress: true });

  logDashboard(`📨 A iniciar envio individual para ${userIds.length} contactos.`);
  const config = await carregarConfig();

  const DELAY_MAX = config.delayEnvioMs || 60000;
  const DELAY_MIN = DELAY_MAX * 0.5;

  let sucessos = 0;
  let falhas = 0;
  let falhasConsecutivas = 0;
  const LIMITE_FALHAS = 5;

  for (let i = 0; i < userIds.length; i++) {
    if (state.pararEnvioAtual || falhasConsecutivas >= LIMITE_FALHAS) {
      if (falhasConsecutivas >= LIMITE_FALHAS) logDashboard(`🚨 PARAGEM AUTOMÁTICA: Detetadas ${LIMITE_FALHAS} falhas consecutivas.`);
      else logDashboard("🛑 Envio interrompido pelo utilizador.");
      break;
    }

    const userId = userIds[i];
    if (i > 0) {
      const tempoDeEspera = Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1) + DELAY_MIN);
      logDashboard(`...a aguardar ${Math.round(tempoDeEspera / 1000)} segundos...`);
      await delay(tempoDeEspera);
    }
    if (state.pararEnvioAtual) break;

    let nomeDisplay = userId.split("@")[0];

    try {
      const isRegistered = await client.isRegisteredUser(userId);
      if (!isRegistered) {
        logDashboard(`⚠️ (${i + 1}/${userIds.length}) Aviso: ${nomeDisplay} não tem WhatsApp. A pular.`);
        falhas++;
        continue;
      }

      let mensagemPersonalizada = mensagem;
      const contact = await client.getContactById(userId);
      const nomeCompleto = contact.pushname || contact.name;

      if (nomeCompleto) {
        const primeiroNome = nomeCompleto.split(" ")[0];
        const nomeFormatado = primeiroNome.charAt(0).toUpperCase() + primeiroNome.slice(1).toLowerCase();
        nomeDisplay = nomeFormatado;
        mensagemPersonalizada = mensagem.replace(/\[nome\]/gi, nomeFormatado);
      } else {
        mensagemPersonalizada = mensagem.replace(/ ?\[nome\],?/gi, "");
      }

      // --- CORREÇÃO FINAL APLICADA AQUI ---
      // Primeiro processamos o Spintax para obter o texto final
      const mensagemFinal = processarSpintax(mensagemPersonalizada);

      if (!mensagemFinal || mensagemFinal.trim() === "") {
        logDashboard(`⚠️ (${i + 1}/${userIds.length}) Mensagem para "${nomeDisplay}" resultou em texto vazio. A pular.`);
        falhas++;
        continue;
      }

      // Agora, com o texto final pronto, simulamos o comportamento humano
      const chat = await client.getChatById(userId);
      await chat.sendStateTyping();
      await delay(Math.random() * (2500 - 500) + 500); // Pausa aleatória curta

      // Finalmente, enviamos a mensagem
      await chat.sendMessage(mensagemFinal);
      await chat.clearState();
      // --- FIM DA CORREÇÃO ---

      logDashboard(`📤 (${i + 1}/${userIds.length}) Mensagem enviada para "${nomeDisplay}"`);
      sucessos++;
      falhasConsecutivas = 0;
    } catch (err) {
      logDashboard(`❌ (${i + 1}/${userIds.length}) Falha ao enviar para ${nomeDisplay}: ${err.message}`);
      falhas++;
      falhasConsecutivas++;
      if (err.message.includes("b") || err.message.includes("body")) {
        logDashboard(" A pausar por 10 segundos extra devido a instabilidade...");
        await delay(10000);
      }
    }
  }
  logDashboard(`✅ Envio concluído! Sucessos: ${sucessos}, Falhas: ${falhas}.`);
  state.pararEnvioAtual = false;
  io.emit("envio_status", { inProgress: false });
}

// ... Funções de utilidade (salvarJSONSeDiferente, salvarMensagemNoHistorico, etc.) ...
async function salvarJSONSeDiferente(caminho, conteudo) {
  const jsonNovo = JSON.stringify(conteudo, null, 2);
  try {
    const jsonAntigo = await fs.readFile(caminho, "utf-8");
    if (jsonAntigo !== jsonNovo) {
      await fs.mkdir(path.dirname(caminho), { recursive: true });
      await fs.writeFile(caminho, jsonNovo, "utf-8");
    }
  } catch {
    await fs.mkdir(path.dirname(caminho), { recursive: true });
    await fs.writeFile(caminho, jsonNovo, "utf-8");
  }
}

async function salvarMensagemNoHistorico(grupoId, mensagem, nomeGrupo) {
  try {
    let historico = {};
    try {
      historico = JSON.parse(await fs.readFile(mensagensEnviadasPath, "utf-8"));
    } catch {}

    if (!historico[grupoId]) historico[grupoId] = [];

    historico[grupoId].push({
      nomeGrupo,
      mensagem,
      horario: new Date().toISOString(),
    });
    historico[grupoId] = historico[grupoId].slice(-50);
    await salvarJSONSeDiferente(mensagensEnviadasPath, historico);
  } catch (err) {
    logDashboard("Erro ao salvar no histórico: " + err.message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function carregarConfig() {
  const defaultConfig = {
    intervaloMinutos: 30,
    habilitado: true,
    delayEnvioMs: 15000,
    promptComPdf:
      'Com base no material do curso chamado "{{nomeGrupo}}". E com base nesse trecho do material do curso:\n\n"{{conteudoPDF}}"\n\nEscreva uma mensagem de WhatsApp para um grupo de alunos. O tom deve ser de um colega, com tamanho médio e natural. Não utilize hashtags, listas, links ou mensagens muito longas. Não repita partes da ementa ou do tema do curso. Em vez disso, aborde o assunto da ementa de forma natural, trazendo algo interessante sobre ele (curiosidades, fatos ou notícias) e uma pergunta final de "sim ou não". A mensagem deve ser atemporal, sem mencionar datas.',
    promptSemPdf:
      'Escreva uma mensagem curta e natural para um grupo de WhatsApp do curso "{{nomeGrupo}}", como se fosse um colega animando os alunos. Pode dar uma dica, contar uma novidade ou só puxar conversa. Evite listas, hashtags, links ou parecer uma IA. Use uma linguagem simples e direta.',
  };

  try {
    const data = await fs.readFile(configPath, "utf-8");
    const userConfig = JSON.parse(data);
    return { ...defaultConfig, ...userConfig };
  } catch {
    return defaultConfig;
  }
}

async function salvarConfig(config) {
  await salvarJSONSeDiferente(configPath, config);
}

// --- 📡 CONFIGURAÇAO DAS ROTAS do Dashboard ---
const dependencies = {
  logDashboard,
  logTerminal,
  clientAtivo,
  sincronizarGrupos,
  iniciarAgendamento,
  pararAgendamento,
  pararEnvioAtual,
  initializeClient,
  destroyClient,
  salvarJSONSeDiferente,
  carregarConfig,
  salvarConfig,
  delay,
  gerarMensagemIA,
  enviarMensagensIndividuais,
  path,
  fs,
  gruposSyncPath,
  gruposNaoSyncPath,
  mensagensEnviadasPath,
  configPath,
  get client() {
    return client;
  },
  state,
};

const apiRouter = createApiRouter(dependencies);
app.use("/api", apiRouter);

// --- Rota da Interface ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

// --- Inicialização do Servidor ---
server.listen(PORT, () => {
  logTerminal(`🔧 Dashboard e API disponíveis em: http://localhost:${PORT}`);

  io.on("connection", (socket) => {
    logTerminal("Um usuário se conectou ao dashboard via Socket.IO");

    socket.emit("log_history", logHistory);

    socket.on("qr_scan_aborted", () => {
      logDashboard("🚫 Escaneamento de QR Code cancelado pelo usuário.");
      destroyClient();
    });
  });
});
