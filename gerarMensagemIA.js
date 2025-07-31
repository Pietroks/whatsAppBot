const fs = require("fs/promises");
const path = require("path");
const chalk = require("chalk");
const axios = require("axios");
const pdfParse = require("pdf-parse");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- ALTERAÇÃO 1: A função agora recebe um terceiro parâmetro: 'config' ---
// Este objeto 'config' conterá os prompts que vêm do dashboard.
async function gerarMensagemIA(nomeGrupoOuCurso, grupoId, config) {
  try {
    const pdfPath = path.join(__dirname, "PDFs", `${grupoId}.pdf`);

    let pdfText = "";
    try {
      const dataBuffer = await fs.readFile(pdfPath);
      const pdfData = await pdfParse(dataBuffer);
      pdfText = pdfData.text.trim().slice(0, 10000);
    } catch (e) {
      console.warn(chalk.yellow(`⚠️ PDF não encontrado ou erro ao ler para o grupo ${grupoId}. Gerando mensagem genérica.`));
    }

    // --- ALTERAÇÃO 2: A lógica do prompt foi completamente modificada ---
    // 1. Escolhe o modelo do prompt (template) com base na existência do PDF.
    //    Ele pega o texto de 'config.promptComPdf' ou 'config.promptSemPdf'.
    const promptTemplate = pdfText ? config.promptComPdf : config.promptSemPdf;

    // 2. Substitui as variáveis no modelo do prompt pelos valores reais.
    //    '{{nomeGrupo}}' é trocado pelo nome do grupo.
    //    '{{conteudoPDF}}' é trocado pelo texto extraído do PDF.
    const prompt = promptTemplate.replace("{{nomeGrupo}}", nomeGrupoOuCurso).replace("{{conteudoPDF}}", pdfText);
    // --- FIM DA ALTERAÇÃO 2 ---

    const { data } = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [{ role: "user", content: prompt }], // A variável 'prompt' já contém o texto final.
        temperature: 0.7,
        max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS) || 3900,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const respostaIA = data?.choices?.[0]?.message?.content;
    if (!respostaIA) {
      throw new Error("Resposta da IA vazia ou inválida.");
    }

    return respostaIA.trim();
  } catch (err) {
    console.error(chalk.red(`❌ Erro ao gerar mensagem para grupo ${grupoId}:`, err.message));

    // A lógica de fallback para mensagens genéricas continua a mesma.
    const mensagensGenericas = [
      `Pessoal, passando para lembrar de dar uma olhada no material do curso "${nomeGrupoOuCurso}". Bons estudos!`,
      `E aí, turma! Tudo certo com os estudos em "${nomeGrupoOuCurso}"? Qualquer dúvida, mandem aqui!`,
      `Uma ótima semana de estudos para todos do curso "${nomeGrupoOuCurso}"! Vamos com tudo! ✨`,
      `Só para dar um alô e desejar foco total nos estudos do curso "${nomeGrupoOuCurso}"!`,
      `Lembrete amigável: que tal separar um tempinho hoje para o nosso curso "${nomeGrupoOuCurso}"? 😉`,
      `Olá! Hoje é um bom momento para revisar os conteúdos do curso "${nomeGrupoOuCurso}". Em breve enviaremos novidades!`,
    ];

    const indiceAleatorio = Math.floor(Math.random() * mensagensGenericas.length);

    return mensagensGenericas[indiceAleatorio];
  }
}

module.exports = gerarMensagemIA;
