// routes/api.js

const express = require("express");
const fs = require("fs").promises;
const multer = require("multer");

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Esta função cria e configura o roteador.
// Ela recebe as dependências (funções e variáveis) do arquivo principal.
function createApiRouter(dependencies) {
  const {
    logDashboard,
    logTerminal,
    clientAtivo,
    sincronizarGrupos,
    iniciarAgendamento,
    pararAgendamento,
    initializeClient,
    destroyClient,
    salvarJSONSeDiferente,
    carregarConfig,
    salvarConfig,
    delay,
    gerarMensagemIA,
    path,
    fs,
    gruposSyncPath,
    gruposNaoSyncPath,
    mensagensEnviadasPath,
    configPath,
    state,
  } = dependencies;

  const router = express.Router();

  // --- ROTAS DO DASHBOARD ---
  router.post("/conectar", (req, res) => {
    try {
      initializeClient();
      res.json({ message: "Comando de conexão recebido. Aguardando QR Code..." });
    } catch (e) {
      res.status(500).json({ error: "Falha ao iniciar cliente." });
    }
  });

  router.post("/sincronizar-grupo", async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: "ID e nome do grupo sao obrigatorios" });

    try {
      const gruposSyncRaw = await fs.readFile(gruposSyncPath, "utf-8").catch(() => "[]");
      const gruposNaoSyncRaw = await fs.readFile(gruposNaoSyncPath, "utf-8").catch(() => "[]");

      let gruposSync = JSON.parse(gruposSyncRaw);
      let gruposNaoSync = JSON.parse(gruposNaoSyncRaw);

      if (!gruposSync.find((g) => g.id === id)) {
        gruposSync.push({ id, name });
      }

      const novosNaoSync = gruposNaoSync.filter((g) => g.id !== id);

      await salvarJSONSeDiferente(gruposSyncPath, gruposSync);
      await salvarJSONSeDiferente(gruposNaoSyncPath, novosNaoSync);

      dependencies.state.gruposValidos = gruposSync.map((g) => g); // Atualiza a variável de estado
      logDashboard(`✅ Grupo "${name}" sincronizado`);

      await sincronizarGrupos();

      const config = await carregarConfig();
      if (config.habilitado) {
        await iniciarAgendamento();
      }

      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/desincronizar-grupo", async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: "ID e nome do grupo são obrigatórios" });
    }

    try {
      const gruposSyncRaw = await fs.readFile(gruposSyncPath, "utf-8").catch(() => "[]");
      const gruposNaoSyncRaw = await fs.readFile(gruposNaoSyncPath, "utf-8").catch(() => "[]");
      let gruposSync = JSON.parse(gruposSyncRaw);
      let gruposNaoSync = JSON.parse(gruposNaoSyncRaw);

      const novosGruposSync = gruposSync.filter((g) => g.id !== id);

      if (!gruposNaoSync.find((g) => g.id === id)) {
        gruposNaoSync.push({ id, name });
      }

      await salvarJSONSeDiferente(gruposSyncPath, novosGruposSync);
      await salvarJSONSeDiferente(gruposNaoSyncPath, gruposNaoSync);

      dependencies.state.gruposValidos = novosGruposSync.map((g) => g); // Atualiza a variável de estado
      logDashboard(`➖ Grupo "${name}" foi desincronizado`);
      logDashboard(`✅ ${novosGruposSync.length} grupos válidos e configurados para envio.`);
      res.json({ ok: true });
    } catch (err) {
      logDashboard(`❌ Erro ao desincronizar o grupo "${name}": ${err.message}`);
      res.status(500).json({ error: "Falha ao desincronizar grupo." });
    }
  });

  router.post("/testar-mensagem", async (req, res) => {
    const { id, name } = req.body;

    if (!id || !name) {
      return res.status(400).json({ error: "ID e Nome do grupo são obrigatórios." });
    }

    try {
      logDashboard(`🧪 Gerando mensagem de teste para "${name}"...`);

      // --- INÍCIO DA CORREÇÃO ---
      // Carrega a configuração atual para ter acesso aos prompts
      const config = await carregarConfig();
      // Passa a 'config' como terceiro argumento para a função
      const mensagem = await gerarMensagemIA(name, id, config);
      // --- FIM DA CORREÇÃO ---

      dependencies.state.mensagensPreGeradas.set(id, mensagem);
      logDashboard(`👍 Mensagem para "${name}" foi pré-aprovada e salva no cache.`);

      logDashboard(`✨ Mensagem de teste gerada.`);
      res.json({ mensagem });
    } catch (error) {
      logDashboard(`❌ Erro ao gerar mensagem de teste: ${error.message}`);
      res.status(500).json({ error: "Falha ao gerar mensagem da IA" });
    }
  });

  router.get("/grupos-sincronizados", async (req, res) => {
    try {
      const data = await fs.readFile(gruposSyncPath, "utf-8");
      res.json(JSON.parse(data));
    } catch {
      res.json([]);
    }
  });

  router.get("/mensagens", async (req, res) => {
    try {
      const data = await fs.readFile(mensagensEnviadasPath, "utf-8");
      const historico = JSON.parse(data);
      const pagina = parseInt(req.query.page) || 1;
      const limite = parseInt(req.query.limit) || 10;
      const todasMsgs = Object.values(historico)
        .flat()
        .sort((a, b) => new Date(b.horario) - new Date(a.horario));
      const totalMensagens = todasMsgs.length;
      const totalPaginas = Math.ceil(totalMensagens / limite);
      const inicio = (pagina - 1) * limite;
      const fim = inicio + limite;
      const msgsPaginadas = todasMsgs.slice(inicio, fim);
      res.json({
        mensagens: msgsPaginadas,
        paginaAtual: pagina,
        totalPaginas: totalPaginas,
        totalMensagens: totalMensagens,
      });
    } catch {
      res.json({ mensagens: [], paginaAtual: 1, totalPaginas: 1, totalMensagens: 0 });
    }
  });

  router.post("/descartar-mensagem", (req, res) => {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: "ID do grupo é obrigatório." });
    }

    if (dependencies.state.mensagensPreGeradas.has(id)) {
      dependencies.state.mensagensPreGeradas.delete(id);
      logDashboard(`🗑️ Mensagem de teste em cache para o grupo ${id} foi descartada.`);
      res.json({ ok: true, message: "Mensagem descartada com sucesso." });
    } else {
      // Isso pode acontecer se o usuário clicar em descartar duas vezes
      logDashboard(`⚠️ Tentativa de descartar mensagem para o grupo ${id}, mas não havia nada no cache.`);
      res.status(404).json({ error: "Nenhuma mensagem de teste encontrada no cache para este grupo." });
    }
  });

  router.get("/mensagens/all", async (req, res) => {
    try {
      const data = await fs.readFile(mensagensEnviadasPath, "utf-8");
      res.json(JSON.parse(data));
    } catch {
      res.json({});
    }
  });

  router.post("/iniciar", async (req, res) => {
    try {
      // Validação para impedir início sem grupos
      const gruposSyncRaw = await fs.readFile(gruposSyncPath, "utf-8").catch(() => "[]");
      const gruposSync = JSON.parse(gruposSyncRaw);

      if (gruposSync.length === 0) {
        logDashboard("⚠️ Tentativa de iniciar o agendamento sem grupos sincronizados.");
        return res.status(400).json({ error: "Nenhum grupo sincronizado. Não é possível iniciar o agendamento." });
      }

      // Lógica original para iniciar
      const config = await carregarConfig();
      config.habilitado = true;
      await salvarConfig(config);
      await iniciarAgendamento();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Falha ao iniciar o agendamento." });
    }
  });

  router.post("/parar", async (req, res) => {
    const config = await carregarConfig();
    config.habilitado = false;
    await salvarConfig(config);
    await pararAgendamento();
    logTerminal("⏹️ Agendamento parado");
    res.json({ ok: true });
  });

  router.post("/config", async (req, res) => {
    const config = await carregarConfig();
    const novoIntervalo = parseInt(req.body.intervaloMinutos);
    if (isNaN(novoIntervalo) || novoIntervalo < 1) {
      return res.status(400).json({ error: "Intervalo inválido. Deve ser >= 1 minuto." });
    }
    config.intervaloMinutos = novoIntervalo;
    if (req.body.delayEnvioMs !== undefined) {
      const novoDelay = parseInt(req.body.delayEnvioMs);
      if (isNaN(novoDelay) || novoDelay < 1000) {
        return res.status(400).json({ error: "Delay inválido. Deve ser >= 1000 ms." });
      }
      config.delayEnvioMs = novoDelay;
    }
    await salvarConfig(config);
    if (config.habilitado) {
      await iniciarAgendamento({ silent: true });
    }
    logDashboard(`💾 Configuração atualizada: intervalo ${config.intervaloMinutos} minutos, delay ${config.delayEnvioMs} ms.`);
    res.json({ ok: true, config });
  });

  router.post("/desconectar", async (req, res) => {
    if (!clientAtivo()) {
      logDashboard("⚠️ Cliente não está pronto para desconectar.");
      return res.status(400).json({ error: "cliente nao esta conectado." });
    }
    try {
      logDashboard("🔌 Bot desconectado");
      await pararAgendamento();
      await destroyClient();
      res.json({ ok: true });
    } catch (err) {
      logDashboard("❌ Erro ao desconectar: " + err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/upload-pdf/:groupId", upload.single("pdfFile"), async (req, res) => {
    const { groupId } = req.params;
    const file = req.file;

    if (!groupId || !file) {
      return res.status(400).json({ error: "ID do grupo e arquivo PDF são obrigatórios." });
    }

    // Garante que o caminho para a pasta 'PDFs' está correto
    const pdfsPath = path.join(__dirname, "..", "PDFs");
    const newFileName = `${groupId}.pdf`;
    const filePath = path.join(pdfsPath, newFileName);

    try {
      await fs.mkdir(pdfsPath, { recursive: true });
      await fs.writeFile(filePath, file.buffer); // Salva o arquivo recebido
      logDashboard(`📄 PDF para o grupo ${groupId} foi atualizado via dashboard.`);
      res.json({ ok: true, message: "PDF enviado com sucesso." });
    } catch (error) {
      logDashboard(`❌ Erro ao salvar o PDF para o grupo ${groupId}: ${error.message}`);
      res.status(500).json({ error: "Falha ao salvar o PDF no servidor." });
    }
  });

  router.post("/config/prompts", async (req, res) => {
    const { promptComPdf, promptSemPdf } = req.body;
    if (!promptComPdf || !promptSemPdf) {
      return res.status(400).json({ error: "Ambos os prompts são obrigatórios." });
    }

    try {
      const config = await carregarConfig();
      config.promptComPdf = promptComPdf;
      config.promptSemPdf = promptSemPdf;
      await salvarConfig(config);
      logDashboard("✍️ Prompts da IA foram atualizados pelo dashboard.");
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Falha ao salvar os prompts." });
    }
  });

  router.get("/status", (req, res) => {
    res.json({ status: clientAtivo() ? "conectado" : "desconectado" });
  });

  router.get("/grupos-nao-sincronizados", async (req, res) => {
    try {
      const data = await fs.readFile(gruposNaoSyncPath, "utf-8");
      res.json(JSON.parse(data));
    } catch {
      res.json([]);
    }
  });

  router.get("/health", async (req, res) => {
    const health = {
      status: "ok",
      timestamp: new Date().toISOString(),
      checks: {},
    };
    //  checagem do whatsapp
    const isWhatsAppConnected = clientAtivo();
    health.checks.whatsapp = {
      status: isWhatsAppConnected ? "ok" : "warning",
      message: isWhatsAppConnected ? "conectado" : "Aguardando conexão",
    };

    // checagem da api IA
    const hasApiKey = !!process.env.OPENAI_API_KEY;
    health.checks.ai_api = {
      status: hasApiKey ? "ok" : "error",
      message: hasApiKey ? "Chave da API encontrada" : "ERRO CRITICO",
    };

    // checagem do sistema de arquivos
    let canAccessFs = false;
    try {
      await fs.access(configPath);
      canAccessFs = true;
      health.checks.filesystem = { status: "ok", message: "OK" };
    } catch (error) {
      health.checks.filesystem = { status: "error", message: "ERRO CRITICO: nao foi possivel acessar o arquivo config.json" };
    }

    const checkStatus = Object.values(health.checks).map((check) => check.status);

    if (checkStatus.includes("error")) {
      health.status = "error";
    } else if (checkStatus.includes("warning")) {
      health.status = "warning";
    }

    const hasCriticalError = !hasApiKey || !canAccessFs;

    res.status(hasCriticalError ? 503 : 200).json(health);
  });

  router.get("/config", async (req, res) => {
    try {
      const config = await carregarConfig();
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Falha ao carregar a configuração." });
    }
  });

  return router;
}

module.exports = createApiRouter;
