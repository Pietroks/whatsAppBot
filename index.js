const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const schedule = require('node-schedule');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const axiosRetry = require('axios-retry').default;
const chalk = require('chalk');
const gerarMensagemIA = require('./gerarMensagemIA');
const { executablePath } = require('puppeteer');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const { error } = require('console');
const { config } = require('dotenv');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'views')));

axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

const gruposSyncPath = path.join(__dirname, 'gruposIDs', 'grupos_sincronizados.json');
const gruposNaoSyncPath = path.join(__dirname, 'gruposIDs', 'grupos_nao_sincronizados.json');
const mensagensEnviadasPath = path.join(__dirname, 'historico', 'mensagens_enviadas.json');
const configPath = path.join(__dirname, 'config.json');

let client;
let gruposValidos = [];
let agendamento;
let clientEmDesconexao = false;

function clientAtivo() {
  return client && client.info && client.info.wid;
}

function removerDuplicados(grupos) {
  const mapa = new Map();
  grupos.forEach(g => mapa.set(g.id, g));
  return Array.from(mapa.values());
}

async function restartClient() {
  try {
    if (client) {
      await client.destroy();
      logDashboard('🗑️ Cliente WhatsApp destruído.');
    }
  } catch (err) {
    console.error('Erro ao destruir o client:', err.message);
  }

  client = new Client({
    puppeteer: {
      headless: true,
      executablePath: executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  configurarEventosClient();
  client.initialize();
}

function configurarEventosClient() {
  client.on('qr', async qr => {
    try {
      const qrImage = await qrcode.toDataURL(qr);
      logDashboard('📲 QR Code gerado! Escaneie para conectar...');
      io.emit('qr', qrImage);
    } catch (err) {
      logDashboard('❌ Erro ao gerar QR Code: ' + err.message);
    }
  });

  client.on('ready', async () => {
    logDashboard('✅ Bot conectado com sucesso!');
    io.emit('status', 'conectado');
    logDashboard('🔄 Sincronizando grupos...');
    await sincronizarGrupos();
    const config = await carregarConfig();
    if (config.habilitado) iniciarAgendamento();
  });

  client.on('disconnected', reason => {
    logDashboard(`🔌 Desconectado: ${reason}`);
    io.emit('status', 'desconectado');
  });

  client.on('auth_failure', msg => {
    logDashboard(`❌ Falha de autenticação: ${msg}`);
    io.emit('status', 'desconectado');
  });
}

function logDashboard(msg) {
  console.log(msg);
  io.emit('log', msg);
}

async function sincronizarGrupos() {
  if (clientEmDesconexao || !clientAtivo()) {
    logDashboard('⚠️ WhatsApp não está conectado. Cancelando sincronização.');
    return;
  }

  const chats = await client.getChats();
  const todosGrupos = chats.filter(c => c.isGroup).map(g => ({ id: g.id._serialized, name: g.name }));
  logDashboard(`🔍 ${todosGrupos.length} grupos encontrados.`);

  let gruposSalvos = [];
  try {
    gruposSalvos = JSON.parse(await fs.readFile(gruposSyncPath, 'utf-8'));
  } catch {
    logDashboard('⚠️ Nenhum grupo sincronizado previamente.');
  }

  const gruposNoWhatsApp = todosGrupos.map(g => g.id);
  const gruposNaoEncontrados = gruposSalvos.filter(g => !gruposNoWhatsApp.includes(g.id));

  if (gruposNaoEncontrados.length) {
    logDashboard(`⚠️ Atenção! ${gruposNaoEncontrados.length} grupos sincronizados não foram encontrados no WhatsApp.`);
    gruposNaoEncontrados.forEach(g => logDashboard(`• ${g.name} (${g.id})`));
  }

  gruposValidos = removerDuplicados(gruposSalvos.filter(g => gruposNoWhatsApp.includes(g.id)));
  await salvarJSONSeDiferente(gruposSyncPath, gruposValidos);

  const naoSincronizados = todosGrupos.filter(g => !gruposValidos.some(v => v.id === g.id));
  await salvarJSONSeDiferente(gruposNaoSyncPath, naoSincronizados);

  logDashboard(`✅ ${gruposValidos.length} grupos sincronizados:`);
  gruposValidos.forEach(g => logDashboard(`• ${g.name} (${g.id})`));
}

async function iniciarAgendamento() {
  const config = await carregarConfig();
  const regra = `*/${config.intervaloMinutos} * * * *`;

  if (!config.habilitado) {
    logDashboard('⏸️ Envio de mensagens desativado.');
    return;
  }

  if (agendamento) {
    agendamento.cancel();
    logDashboard('🔁 Reiniciando agendamento...');
  }

  agendamento = schedule.scheduleJob('envio-mensagens', regra, async () => {
    logDashboard(`📅 Enviando mensagens em: ${new Date().toLocaleString()}`);
    await enviarMensagensEmLote(gruposValidos);
    logDashboard(`⏳ Próximo envio: ${agendamento.nextInvocation().toLocaleString()}`);
  });

  logDashboard(`🕒 Intervalo definido: ${config.intervaloMinutos} minutos.`);
}

async function pararAgendamento() {
  if (agendamento) {
    agendamento.cancel();
    logDashboard('⏹️ Agendamento parado.');
  }
}

async function enviarMensagensEmLote(grupos) {
  try {
    const gruposSalvos = JSON.parse(await fs.readFile(gruposSyncPath, 'utf-8'));
    gruposValidos = removerDuplicados(gruposSalvos);
  } catch {
    logDashboard('⚠️ Erro ao carregar grupos sincronizados antes do envio.');
    return
  }

  if (clientEmDesconexao || !clientAtivo()) {
    logDashboard('⚠️ WhatsApp não está conectado. Cancelando envio.');
    return;
  }

  const config = await carregarConfig();
  const INTERVALO = config.delayEnvioMs || 15000
  for (let i = 0; i < grupos.length; i++) {
    const grupo = grupos[i];
    const nomeGrupo = grupo.name;

    if (i > 0) await delay(INTERVALO);
    const enviado = await enviarMensagemParaGrupo(grupo);
    if (!enviado) logDashboard(`⏩ Nenhuma nova mensagem para "${nomeGrupo}".`);
  }
}

async function enviarMensagemParaGrupo(grupo) {
  try {
    const nomeGrupo = grupo.name;
    let mensagem = await gerarMensagemIA(nomeGrupo, grupo.id);

    let historico = {};
    try {
      historico = JSON.parse(await fs.readFile(mensagensEnviadasPath, 'utf-8'));
    } catch {}

    const ultimas = (historico[grupo.id]?.map(m => m.mensagem.trim()) || []).slice(-10);
    let tentativas = 0;

    while (ultimas.includes(mensagem.trim()) && tentativas < 3) {
      mensagem = await gerarMensagemIA(nomeGrupo, grupo.id);
      tentativas++;
    }

    if (!ultimas.includes(mensagem.trim())) {
      await client.sendMessage(grupo.id, mensagem);
      await salvarMensagemNoHistorico(grupo.id, mensagem, nomeGrupo);
      logDashboard(`📤 Mensagem enviada para "${nomeGrupo}"`);
      return true;
    }

    return false;
  } catch (err) {
    logDashboard(`❌ Erro ao enviar para "${grupo.name}": ${err.message}`);
    return false;
  }
}

async function salvarJSONSeDiferente(caminho, conteudo) {
  const jsonNovo = JSON.stringify(conteudo, null, 2);
  try {
    const jsonAntigo = await fs.readFile(caminho, 'utf-8');
    if (jsonAntigo !== jsonNovo) {
      await fs.mkdir(path.dirname(caminho), { recursive: true });
      await fs.writeFile(caminho, jsonNovo, 'utf-8');
    }
  } catch {
    await fs.mkdir(path.dirname(caminho), { recursive: true });
    await fs.writeFile(caminho, jsonNovo, 'utf-8');
  }
}

async function salvarMensagemNoHistorico(grupoId, mensagem, nomeGrupo) {
  try {
    let historico = {};
    try {
      historico = JSON.parse(await fs.readFile(mensagensEnviadasPath, 'utf-8'));
    } catch {}

    if (!historico[grupoId]) historico[grupoId] = [];

    historico[grupoId].push({
      nomeGrupo,
      mensagem,
      horario: new Date().toISOString()
    });

    // limitar para as ultimas 50 mensagens
    historico[grupoId] = historico[grupoId].slice(-50);

    await fs.mkdir(path.dirname(mensagensEnviadasPath), { recursive: true });
    await fs.writeFile(mensagensEnviadasPath, JSON.stringify(historico, null, 2), 'utf-8');
  } catch (err) {
    logDashboard('Erro ao salvar no histórico: ' + err.message);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function carregarConfig() {
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(data);

    // Garantir valores padrões se não existirem
    if (typeof config.intervaloMinutos !== 'number' || config.intervaloMinutos < 1) {
      config.intervaloMinutos = 30;
    }
    if (typeof config.delayEnvioMs !== 'number' || config.delayEnvioMs < 1000) {
      config.delayEnvioMs = 15000;
    }
    if (typeof config.habilitado !== 'boolean') {
      config.habilitado = true;
    }

    return config;
  } catch {
    return { intervaloMinutos: 30, habilitado: true, delayEnvioMs: 15000 };
  }
}

async function salvarConfig(config) {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// 📡 API do Dashboard
app.get('/api/mensagens', async (req, res) => {
  try {
    const data = await fs.readFile(mensagensEnviadasPath, 'utf-8');
    res.json(JSON.parse(data));
  } catch {
    res.json({});
  }
});

app.post('/api/iniciar', async (req, res) => {
  const config = await carregarConfig();
  config.habilitado = true;
  await salvarConfig(config);
  await iniciarAgendamento();
  logDashboard('▶️ Agendamento iniciado via dashboard.');
  res.json({ ok: true });
});

app.post('/api/parar', async (req, res) => {
  const config = await carregarConfig();
  config.habilitado = false;
  await salvarConfig(config);
  await pararAgendamento();
  logDashboard('⏹️ Agendamento parado via dashboard.');
  res.json({ ok: true });
});


app.post('/api/config', async (req, res) => {
  const config = await carregarConfig();

  const novoIntervalo = parseInt(req.body.intervaloMinutos);
  if (isNaN(novoIntervalo) || novoIntervalo < 1) {
    return res.status(400).json({ error: 'Intervalo inválido. Deve ser >= 1 minuto.' });
  }
  config.intervaloMinutos = novoIntervalo;

  if (req.body.delayEnvioMs !== undefined) {
    const novoDelay = parseInt(req.body.delayEnvioMs);
    if (isNaN(novoDelay) || novoDelay < 1000) {
      return res.status(400).json({ error: 'Delay inválido. Deve ser >= 1000 ms.' });
    }
    config.delayEnvioMs = novoDelay;
  }

  await salvarConfig(config);

  if (config.habilitado) {
    await pararAgendamento();
    await iniciarAgendamento();
  }

  logDashboard(`💾 Configuração atualizada: intervalo ${config.intervaloMinutos} minutos, delay ${config.delayEnvioMs} ms.`);
  res.json({ ok: true, config });
});

app.post('/api/desconectar', async (req, res) => {
  if (!clientAtivo()) {
    logDashboard('⚠️ Cliente não está pronto para desconectar.');
    return res.status(400).json({ error: 'cliente nao esta pronto.' });
  }

  try {
    logDashboard('🔌 Bot desconectado via dashboard.');
    clientEmDesconexao = true;

    await pararAgendamento();
    
    await client.logout();

    await delay(1000);

    await client.destroy();

    await restartClient();
    logDashboard('✅ WhatsApp desconectado com sucesso!');
    clientEmDesconexao = false;

    res.json({ ok: true });
  } catch (err) {
    clientEmDesconexao = false;
    logDashboard('❌ Erro ao desconectar: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  const status = clientAtivo() ? 'conectado' : 'desconectado';
  res.json({ status });
});

app.get('/api/grupos-nao-sincronizados', async (req, res) => {
  try {
    const data = await fs.readFile(gruposNaoSyncPath, 'utf-8');
    res.json(JSON.parse(data));
  } catch {
    res.json([]);
  }
});

app.post('/api/sincronizar-grupo', async (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({error: 'ID e nome do grupo sao obrigatorios'});
  
  try {
    const gruposSyncRaw = await fs.readFile(gruposSyncPath, 'utf-8').catch(() => '[]');
    const gruposNaoSyncRaw = await fs.readFile(gruposNaoSyncPath, 'utf-8').catch(() => '[]');

    const gruposSync = JSON.parse(gruposSyncRaw);
    const gruposNaoSync = JSON.parse(gruposNaoSyncRaw);

    // adiciona ao sincronizado se nao tive
    if (!gruposSync.find(g => g.id === id)) {
      gruposSync.push({ id, name })
    }

    // remove do nao sincronizado
    const novosNaoSync = gruposNaoSync.filter(g => g.id !== id);

    await salvarJSONSeDiferente(gruposSyncPath, gruposSync);
    await salvarJSONSeDiferente(gruposNaoSyncPath, novosNaoSync);

    gruposValidos = removerDuplicados([...gruposSync]);

    logDashboard(`✅ Grupo "${name}" sincronizado manualmente via dashboard.`);
    await sincronizarGrupos();

    const config = await carregarConfig();
    if (config.habilitado) {
      await pararAgendamento();
      await iniciarAgendamento();
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({error: err.message});
  }
});


app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', client: clientAtivo() ? 'conectado' : 'desconectado'});
});


app.get('/api/config', async (req, res) => {
  const config = await carregarConfig();
  res.json(config);
});


// 🌐 Serve a interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// 🚀 Start servidor
server.listen(PORT, () => {
  logDashboard(`🔧 Dashboard e API disponíveis em: http://localhost:${PORT}`);
});

restartClient();
