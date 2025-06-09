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
// A linha abaixo foi removida na etapa anterior para corrigir conflitos.
// Se você a removeu, pode manter assim. Se não, remova-a.
// const { executablePath } = require('puppeteer');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;

// --- Configurações ---
const clientConfig = {
    puppeteer: {
        headless: true,
        // Se a correção de remover o puppeteer do package.json funcionou,
        // você pode remover a linha 'executablePath' abaixo.
        // executablePath: executablePath(),
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
};

// --- Caminhos de Arquivos ---
const gruposSyncPath = path.join(__dirname, 'gruposIDs', 'grupos_sincronizados.json');
const gruposNaoSyncPath = path.join(__dirname, 'gruposIDs', 'grupos_nao_sincronizados.json');
const mensagensEnviadasPath = path.join(__dirname, 'historico', 'mensagens_enviadas.json');
const configPath = path.join(__dirname, 'config.json');

// --- Variáveis de Estado ---
let client;
let gruposValidos = [];
let agendamento;
let clientEmDesconexao = false;

// --- Middlewares do Express ---
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'views')));

axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

// --- Funções Principais do Bot ---

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

    client = new Client(clientConfig);
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
        try {
            logDashboard('🔄 Sincronizando grupos...');
            await sincronizarGrupos();
            const config = await carregarConfig();
            if (config.habilitado) await iniciarAgendamento();
        } catch (error) {
            logDashboard(`❌ Erro crítico durante a inicialização pós-ready: ${error.message}`);
        }
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

// --- MELHORIA: Função de sincronização mais resiliente ---
async function sincronizarGrupos() {
    if (clientEmDesconexao || !clientAtivo()) {
        logDashboard('⚠️ WhatsApp não está conectado. Cancelando sincronização.');
        return;
    }

    let todosGrupos = [];
    let sucessoBuscaChats = false;

    try {
        // Tenta buscar os chats, mas não quebra se falhar
        const chats = await client.getChats();
        todosGrupos = chats.filter(c => c.isGroup).map(g => ({ id: g.id._serialized, name: g.name }));
        logDashboard(`🔍 ${todosGrupos.length} grupos encontrados no WhatsApp.`);
        sucessoBuscaChats = true;
    } catch (error) {
        logDashboard(chalk.yellow(`⚠️ Aviso: Falha ao buscar a lista de grupos do WhatsApp (client.getChats). O erro foi ignorado. Causa: ${error.message}`));
        // Se a busca falhar, vamos trabalhar com os grupos que já temos salvos para não parar o bot.
    }
    let gruposSalvos = [];
    try {
        gruposSalvos = JSON.parse(await fs.readFile(gruposSyncPath, 'utf-8'));
    } catch {
        logDashboard('⚠️ Nenhum grupo sincronizado previamente.');
    }

    gruposValidos = removerDuplicados(gruposSalvos);

    if (sucessoBuscaChats) {
        const naoSincronizados = todosGrupos.filter(g => !gruposValidos.some(v => v.id === g.id));
        await salvarJSONSeDiferente(gruposNaoSyncPath, naoSincronizados);
    }

    logDashboard(`✅ ${gruposValidos.length} grupos válidos e configurados para envio.`);
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
        const dataHora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        logDashboard(`📅 Executando tarefa agendada: ${dataHora}`);
        await enviarMensagensEmLote();
        if (agendamento && agendamento.nextInvocation()) {
            logDashboard(`⏳ Próximo envio: ${agendamento.nextInvocation().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
        }
    });

    logDashboard(`🕒 Agendamento iniciado. Intervalo: ${config.intervaloMinutos} minutos.`);
}

async function pararAgendamento() {
    if (agendamento) {
        agendamento.cancel();
        logDashboard('⏹️ Agendamento parado.');
    }
}

async function enviarMensagensEmLote() {
    try {
        const gruposSalvos = JSON.parse(await fs.readFile(gruposSyncPath, 'utf-8'));
        gruposValidos = removerDuplicados(gruposSalvos);
    } catch {
        logDashboard('⚠️ Nenhum grupo sincronizado para envio.');
        return;
    }

    if (clientEmDesconexao || !clientAtivo()) {
        logDashboard('⚠️ WhatsApp não está conectado. Cancelando envio.');
        return;
    }

    logDashboard(`🤖 Iniciando envio em lote para ${gruposValidos.length} grupo(s).`);
    const config = await carregarConfig();
    const INTERVALO = config.delayEnvioMs || 15000;
    for (let i = 0; i < gruposValidos.length; i++) {
        const grupo = gruposValidos[i];
        if (i > 0) await delay(INTERVALO);
        const enviado = await enviarMensagemParaGrupo(grupo);
        if (!enviado) logDashboard(`⏩ Nenhuma nova mensagem para "${grupo.name}".`);
    }
}

async function enviarMensagemParaGrupo(grupo) {
    try {
        const nomeGrupo = grupo.name;
        let mensagem = await gerarMensagemIA(nomeGrupo, grupo.id);

        let historico = {};
        try {
            historico = JSON.parse(await fs.readFile(mensagensEnviadasPath, 'utf-8'));
        } catch { }

        const ultimas = (historico[grupo.id]?.map(m => m.mensagem.trim()) || []).slice(-10);
        let tentativas = 0;

        while (ultimas.includes(mensagem.trim()) && tentativas < 3) {
            logDashboard(`🔄 Mensagem para "${nomeGrupo}" é repetida. Tentando gerar outra...`);
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

// ... Funções de utilidade (salvarJSONSeDiferente, salvarMensagemNoHistorico, etc.) ...
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
        } catch { }

        if (!historico[grupoId]) historico[grupoId] = [];

        historico[grupoId].push({
            nomeGrupo,
            mensagem,
            horario: new Date().toISOString()
        });
        historico[grupoId] = historico[grupoId].slice(-50);
        await salvarJSONSeDiferente(mensagensEnviadasPath, historico);
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
        return JSON.parse(data);
    } catch {
        return { intervaloMinutos: 30, habilitado: true, delayEnvioMs: 15000 };
    }
}

async function salvarConfig(config) {
    await salvarJSONSeDiferente(configPath, config);
}

// --- 📡 API do Dashboard ---

app.post('/api/sincronizar-grupo', async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'ID e nome do grupo sao obrigatorios' });

    try {
        const gruposSyncRaw = await fs.readFile(gruposSyncPath, 'utf-8').catch(() => '[]');
        const gruposNaoSyncRaw = await fs.readFile(gruposNaoSyncPath, 'utf-8').catch(() => '[]');

        let gruposSync = JSON.parse(gruposSyncRaw);
        let gruposNaoSync = JSON.parse(gruposNaoSyncRaw);

        if (!gruposSync.find(g => g.id === id)) {
            gruposSync.push({ id, name });
        }

        const novosNaoSync = gruposNaoSync.filter(g => g.id !== id);

        await salvarJSONSeDiferente(gruposSyncPath, gruposSync);
        await salvarJSONSeDiferente(gruposNaoSyncPath, novosNaoSync);

        gruposValidos = removerDuplicados(gruposSync);
        logDashboard(`✅ Grupo "${name}" sincronizado manualmente via dashboard.`);
        
        // Chama a sincronização, mas não quebra o app se falhar
        await sincronizarGrupos();

        const config = await carregarConfig();
        if (config.habilitado) {
            await iniciarAgendamento();
        }

        res.json({ ok: true });
    } catch (err) {
        // A versão melhorada de sincronizarGrupos não deve mais lançar este erro,
        // mas o catch é mantido como segurança.
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- NOVA ROTA: Testar mensagem da IA ---
app.post('/api/testar-mensagem', async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) {
        return res.status(400).json({ error: 'ID e Nome do grupo são obrigatórios.' });
    }
    try {
        logDashboard(`🧪 Gerando mensagem de teste para "${name}"...`);
        const mensagem = await gerarMensagemIA(name, id);
        logDashboard(`✨ Mensagem de teste gerada.`);
        res.json({ mensagem });
    } catch (error) {
        logDashboard(`❌ Erro ao gerar mensagem de teste: ${error.message}`);
        res.status(500).json({ error: 'Falha ao gerar mensagem da IA.' });
    }
});

// --- NOVA ROTA: Obter grupos sincronizados ---
app.get('/api/grupos-sincronizados', async (req, res) => {
    try {
        const data = await fs.readFile(gruposSyncPath, 'utf-8');
        res.json(JSON.parse(data));
    } catch {
        res.json([]);
    }
});


// ... (outras rotas da API: /mensagens, /iniciar, /parar, /config, etc.)
// ... (O código das outras rotas permanece o mesmo)
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
        clientEmDesconexao = false;
        res.json({ ok: true });
    } catch (err) {
        clientEmDesconexao = false;
        logDashboard('❌ Erro ao desconectar: ' + err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({ status: clientAtivo() ? 'conectado' : 'desconectado' });
});

app.get('/api/grupos-nao-sincronizados', async (req, res) => {
    try {
        const data = await fs.readFile(gruposNaoSyncPath, 'utf-8');
        res.json(JSON.parse(data));
    } catch {
        res.json([]);
    }
});

app.get('/api/health', async (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        checks: {}
    };

    let isCriticalError = false;

    health.checks.whatsapp = {
        status: clientAtivo() ? 'ok' : 'error',
        message: clientAtivo() ? 'Conectado' : 'Desconectado do WhatsApp'
    };
    if (!clientAtivo()) isCriticalError = true;

    const apiKey = process.env.OPENAI_API_KEY;
    health.checks.ai_api = {
        status: apiKey ? 'ok' : 'error',
        message: apiKey ? 'Chave da API encontrada.' : 'Variável de ambiente OPENAI_API_KEY não configurada.'
    };
    if (!apiKey) isCriticalError = true;

    try {
        await fs.access(configPath);
        health.checks.filesystem = {
            status: 'ok',
            message: 'Acesso ao arquivo config.json está funcional.'
        };
    } catch (error) {
        health.checks.filesystem = {
            status: 'error',
            message: 'Não foi possível acessar o arquivo de configuração (config.json).'
        };
        isCriticalError = true;
    }

    if (isCriticalError) health.status = 'error';
    
    res.status(isCriticalError ? 503 : 200).json(health);
});

app.get('/api/config', async (req, res) => {
    const config = await carregarConfig();
    res.json(config);
});

// --- Rota da Interface ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// --- Inicialização do Servidor ---
server.listen(PORT, () => {
    logDashboard(`🔧 Dashboard e API disponíveis em: http://localhost:${PORT}`);
});

restartClient();