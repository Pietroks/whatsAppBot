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
const createApiRouter = require('./routes/api.js');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const { stat } = require('fs');

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
let agendamento;
let state = {
    gruposValidos: [],
    clientEmDesconexao: false,
    mensagensPreGeradas: new Map(),
    isQrCodeVisible: false
};

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
    state.isQrCodeVisible = false;

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
            io.emit('qr', qrImage);

            if (!state.isQrCodeVisible) {
                logDashboard('📲 QR Code gerado! Escaneie para conectar...');
                state.isQrCodeVisible = true;
            } else {
                logTerminal('ℹ️ Imagem do QR Code foi atualizada no dashboard.');
            } 
        } catch (err) {
            logDashboard('❌ Erro ao gerar/atualizar QR Code: ' + err.message);
        }
    });

    client.on('ready', async () => {
        logDashboard('✅ Bot conectado com sucesso!');
        state.isQrCodeVisible = false;

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
        state.isQrCodeVisible = false;

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

function logTerminal(msg) {
    console.log(msg);
}

// --- MELHORIA: Função de sincronização mais resiliente ---
async function sincronizarGrupos() {
    if (state.clientEmDesconexao || !clientAtivo()) {
        logDashboard('⚠️ WhatsApp não conectado. Sincronização cancelada.');
        return;
    }

    let todosGrupos = [];
    let sucessoBuscaChats = false;

    try {
        const chats = await client.getChats();
        todosGrupos = chats.filter(c => c.isGroup).map(g => ({ id: g.id._serialized, name: g.name }));
        logDashboard(`🔍 ${todosGrupos.length} grupos encontrados no WhatsApp.`);
        sucessoBuscaChats = true;
    } catch (error) {
        logTerminal(chalk.yellow(`⚠️ Aviso: Falha ao buscar a lista de grupos do WhatsApp (client.getChats). O erro foi ignorado. Causa: ${error.message}`));
    }

    let gruposSalvos = [];
    try {
        gruposSalvos = JSON.parse(await fs.readFile(gruposSyncPath, 'utf-8'));
    } catch {}

    state.gruposValidos = removerDuplicados(gruposSalvos);

    // SÓ atualiza a lista de não sincronizados se a busca no WhatsApp deu certo.
    if (sucessoBuscaChats) {
        const naoSincronizados = todosGrupos.filter(g => !state.gruposValidos.some(v => v.id === g.id));
        await salvarJSONSeDiferente(gruposNaoSyncPath, naoSincronizados);
    }
    
    logDashboard(`✅ ${state.gruposValidos.length} grupos válidos e configurados para envio.`);
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

    if (state.clientEmDesconexao || !clientAtivo()) {
        logDashboard('⚠️ WhatsApp não está conectado. Cancelando envio.');
        return;
    }

    logDashboard(`🤖 Iniciando envio em lote para ${gruposValidos.length} grupo(s).`);
    const config = await carregarConfig();
    const INTERVALO = config.delayEnvioMs || 15000;
    let historicoCompleto = {};
    try {
        historicoCompleto = JSON.parse(await fs.readFile(mensagensEnviadasPath, 'utf-8'));
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
            mensagem = await gerarMensagemIA(nomeGrupo, grupo.id);

            // 3. VERIFICA DUPLICIDADE (apenas para mensagens novas, não para as do cache)
            const ultimas = (historicoCompleto[grupo.id]?.map(m => m.mensagem.trim()) || []).slice(-10);
            let tentativas = 0;
            
            while (ultimas.includes(mensagem.trim()) && tentativas < 3) {
                logDashboard(`🔄 Mensagem para "${nomeGrupo}" é repetida. Tentando gerar outra...`);
                mensagem = await gerarMensagemIA(nomeGrupo, grupo.id);
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

// --- 📡 CONFIGURAÇAO DAS ROTAS do Dashboard ---
const dependencies = {
    logDashboard, logTerminal, clientAtivo, sincronizarGrupos, iniciarAgendamento, pararAgendamento, restartClient,
    salvarJSONSeDiferente, carregarConfig, salvarConfig, delay, gerarMensagemIA,
    path, fs,
    gruposSyncPath, gruposNaoSyncPath, mensagensEnviadasPath, configPath,
    get client() { return client }, 
    state
};

const apiRouter = createApiRouter(dependencies);
app.use('/api', apiRouter);


// --- Rota da Interface ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// --- Inicialização do Servidor ---
server.listen(PORT, () => {
    logDashboard(`🔧 Dashboard e API disponíveis em: http://localhost:${PORT}`);
});

restartClient();