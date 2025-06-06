const fs = require('fs/promises');
const path = require('path');
const chalk = require('chalk');
const axios = require('axios');
const pdfParse = require('pdf-parse');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
console.log(chalk.cyanBright("Verificando a chave da API no 'gerarMensagemIA':", OPENAI_API_KEY ? `Chave encontrada começando com: ${OPENAI_API_KEY.substring(0, 5)}...` : "CHAVE NÃO ENCONTRADA OU VAZIA"));

async function gerarMensagemIA(nomeGrupoOuCurso, grupoId) {
  try {
    const pdfPath = path.join(__dirname, 'PDFs', `${grupoId}.pdf`);

    let pdfText = '';
    try {
      const dataBuffer = await fs.readFile(pdfPath);
      const pdfData = await pdfParse(dataBuffer);
      pdfText = pdfData.text.trim().slice(0, 10000);
    } catch (e) {
      console.warn(chalk.yellow(`⚠️ PDF não encontrado ou erro ao ler para o grupo ${grupoId}. Gerando mensagem genérica.`));
    }

    const prompt = pdfText
      ? `Você é uma pessoa que cuida de um grupo no WhatsApp de um curso chamado "${nomeGrupoOuCurso}". Com base nesse trecho do material do curso:\n\n"${pdfText}"\n\nEscreva uma mensagem de tamanho média e natural para o grupo, como se fosse um colega falando com os alunos. Evite parecer uma IA ou uma mensagem de marketing. Pode comentar algo que achou interessante do conteúdo, fazer uma pergunta para o grupo ou dar um toque simples, como um lembrete ou novidade. Nada de hashtags, listas, links ou mensagens muito longas.`
      : `Escreva uma mensagem curta e natural para um grupo de WhatsApp do curso "${nomeGrupoOuCurso}", como se fosse um colega animando os alunos. Pode dar uma dica, contar uma novidade ou só puxar conversa. Evite listas, hashtags, links ou parecer uma IA. Use uma linguagem simples e direta.`;

    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS) || 3900
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const respostaIA = data?.choices?.[0]?.message?.content;
    if (!respostaIA) {
      throw new Error('Resposta da IA vazia ou inválida.');
    }

    return respostaIA.trim();
  } catch (err) {
    console.error(chalk.red(`❌ Erro ao gerar mensagem para grupo ${grupoId}:`, err.message));
    
    const mensagensGenericas = [
      `Pessoal, passando para lembrar de dar uma olhada no material do curso "${nomeGrupoOuCurso}". Bons estudos!`,
      `E aí, turma! Tudo certo com os estudos em "${nomeGrupoOuCurso}"? Qualquer dúvida, mandem aqui!`,
      `Uma ótima semana de estudos para todos do curso "${nomeGrupoOuCurso}"! Vamos com tudo! ✨`,
      `Só para dar um alô e desejar foco total nos estudos do curso "${nomeGrupoOuCurso}"!`,
      `Lembrete amigável: que tal separar um tempinho hoje para o nosso curso "${nomeGrupoOuCurso}"? 😉`,
      `Olá! Hoje é um bom momento para revisar os conteúdos do curso "${nomeGrupoOuCurso}". Em breve enviaremos novidades!`
    ];

    const indiceAleatorio = Math.floor(Math.random() * mensagensGenericas.length);

    return mensagensGenericas[indiceAleatorio];
  }
}

module.exports = gerarMensagemIA;
