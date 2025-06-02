const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const schedule = require('node-schedule');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const axiosRetry = require('axios-retry').default;
const chalk = require('chalk');
const gerarMensagemIA = require('./gerarMensagemIA');
const http = require('http');
const { executablePath } = require('puppeteer');

// cria um servidor web simples so para manter uma porta aberta
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('bot rodando...');
});

server.listen(process.env.PORT || 3000, () => {
  console.log(chalk.yellowBright(`Servidor web iniciado na porta ${process.env.PORT || 3000}`));
});

axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY não encontrada no .env. Abortando...');
  process.exit(1);
}

const gruposSyncPath = path.join(__dirname, 'gruposIDs', 'grupos_sincronizados.json');
const gruposNaoSyncPath = path.join(__dirname, 'gruposIDs', 'grupos_nao_sincronizados.json');
const mensagensEnviadasPath = path.join(__dirname, 'historico', 'mensagens_enviadas.json');

const client = new Client({
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
let gruposValidos = [];

client.on('qr', qr => {
  console.clear();
  console.log(chalk.green('📲 Escaneie este QR Code com o WhatsApp Web:'));
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log(chalk.green('✅ Bot conectado com sucesso!'));
  console.log(chalk.gray('🔄 Sincronizando grupos do WhatsApp...'));

  const chats = await client.getChats();
  const todosGrupos = chats
    .filter(chat => chat.isGroup)
    .map(group => ({ id: group.id._serialized, name: group.name }));

  console.log(chalk.green(`🔍 ${todosGrupos.length} grupos encontrados.`));

  let gruposSalvos = [];
  try {
    const dados = await fs.readFile(gruposSyncPath, 'utf-8');
    gruposSalvos = JSON.parse(dados);
    if (!Array.isArray(gruposSalvos)) throw new Error('Não é um array');
  } catch {
    console.warn(chalk.yellow('⚠️ Usando lista vazia para grupos sincronizados.'));
  }

  gruposValidos = gruposSalvos.filter(g => todosGrupos.some(t => t.id === g.id));
  console.log(chalk.green(`✅ ${gruposValidos.length} grupos sincronizados:`));
  gruposValidos.forEach(g => {
    console.log(chalk.bgBlue(`• ${g.curso || g.name} (${g.id})`));
  });

  await salvarJSONSeDiferente(gruposSyncPath, gruposValidos);

  const naoSincronizados = todosGrupos.filter(
    g => !gruposValidos.some(v => v.id === g.id)
  );
  await salvarJSONSeDiferente(gruposNaoSyncPath, naoSincronizados);

  const jobRule = '*/30 * * * *'; // A cada 3 minutos
  const agendamento = schedule.scheduleJob('mensagem-a-cada-3-minutos', jobRule, async () => {
    console.log(chalk.cyan(`📅 Enviando mensagens em: ${new Date().toLocaleString()}`));
    await enviarMensagensEmLote(gruposValidos);

    const proxima = agendamento.nextInvocation();
    console.log(chalk.blue(`⏳ Próximo envio: ${proxima.toLocaleString()}`));
  });

  console.log(chalk.blackBright(`🕒 Aguardando até ${agendamento.nextInvocation().toLocaleString()} para envio das mensagens...`));

  setInterval(() => {
    const diff = agendamento.nextInvocation() - new Date();
    if (diff > 0) {
      const h = Math.floor(diff / 1000 / 60 / 60);
      const m = Math.floor((diff / 1000 / 60) % 60);
      const s = Math.floor((diff / 1000) % 60);
      process.stdout.write(`⌛ Tempo restante: ${h}h ${m}m ${s}s   \r`);
    }
  }, 1000);
});

client.on('message', msg => {
  if (msg.from.endsWith('@g.us')) {
    console.log(chalk.gray(`📥 Mensagem recebida do grupo: ${msg.from}`));
  }
});

client.on('disconnected', reason => {
  console.warn(chalk.yellow(`🔌 Desconectado: ${reason}`));
});

client.on('auth_failure', msg => {
  console.error(chalk.red('❌ Falha de autenticação:', msg));
});

client.initialize();

// ==== Funções Auxiliares ====

async function salvarJSONSeDiferente(caminho, conteudo) {
  const jsonNovo = JSON.stringify(conteudo, null, 2);
  try {
    const jsonAntigo = await fs.readFile(caminho, 'utf-8');
    if (jsonAntigo !== jsonNovo) {
      await fs.mkdir(path.dirname(caminho), { recursive: true });
      await fs.writeFile(caminho, jsonNovo, 'utf-8');
      console.log(`💾 Arquivo atualizado: ${caminho}`);
    } else {
      console.log(chalk.gray(`📁 Nenhuma mudança em: ${caminho}`));
    }
  } catch {
    await fs.mkdir(path.dirname(caminho), { recursive: true });
    await fs.writeFile(caminho, jsonNovo, 'utf-8');
    console.log(`📁 Arquivo criado: ${caminho}`);
  }
}

async function salvarMensagemNoHistorico(grupoId, mensagem, nomeGrupo) {
  try {
    let historico = {};
    try {
      const dados = await fs.readFile(mensagensEnviadasPath, 'utf-8');
      historico = JSON.parse(dados);
    } catch {
      await fs.mkdir(path.dirname(mensagensEnviadasPath), { recursive: true });
    }

    if (!historico[grupoId]) historico[grupoId] = [];

    historico[grupoId].push({
      nomeGrupo,
      mensagem,
      horario: new Date().toLocaleString()
    });

    await fs.writeFile(mensagensEnviadasPath, JSON.stringify(historico, null, 2), 'utf-8');
  } catch (err) {
    console.error(chalk.red('❌ Erro ao salvar no histórico:', err.message));
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enviarMensagensEmLote(grupos) {
  const INTERVALO = 15000; // 15 segundos
  for (let i = 0; i < grupos.length; i++) {
    const grupo = grupos[i];
    const nomeGrupo = grupo.curso || grupo.name;

    if (i > 0) {
      console.log(chalk.gray(`⏳ Aguardando 15s antes de enviar para "${nomeGrupo}"...`));
      await delay(INTERVALO);
    } else {
      console.log(chalk.gray(`⏩ Enviando imediatamente para "${nomeGrupo}".`));
    }

    const enviado = await enviarMensagemParaGrupo(grupo);

    if (!enviado) {
      console.log(chalk.gray(`⏩ Nenhuma nova mensagem enviada para "${nomeGrupo}".`));
    }
  }
}

async function enviarMensagemParaGrupo(grupo) {
  try {
    const nomeGrupo = grupo.curso || grupo.name || 'Grupo desconhecido';
    let mensagem = await gerarMensagemIA(nomeGrupo, grupo.id);

    let historico = {};
    try {
      const data = await fs.readFile(mensagensEnviadasPath, 'utf-8');
      historico = JSON.parse(data);
    } catch {}

    const ultimasMensagens = historico[grupo.id]?.map(m => m.mensagem.trim()) || [];
    const ultimas = ultimasMensagens.slice(-10);

    let tentativas = 0;
    const MAX = 3;

    while (ultimas.includes(mensagem.trim()) && tentativas < MAX) {
      console.log(chalk.yellow(`🔁 Mensagem repetida para "${nomeGrupo}". Gerando nova...`));
      mensagem = await gerarMensagemIA(nomeGrupo, grupo.id);
      tentativas++;
    }

    if (!ultimas.includes(mensagem.trim())) {
      await client.sendMessage(grupo.id, mensagem);
      await salvarMensagemNoHistorico(grupo.id, mensagem, nomeGrupo);
      console.log(chalk.green(`📤 Mensagem enviada para "${nomeGrupo}"`));
      return true;
    }

    return false;
  } catch (err) {
    console.error(chalk.red(`❌ Erro ao enviar mensagem para "${grupo.name}": ${err.message}`));
    return false;
  }
}
