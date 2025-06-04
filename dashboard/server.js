const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = 3001;

const mensagensPath = path.join(__dirname, '..', 'historico', 'mensagens_enviadas.json');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/mensagens', async (req, res) => {
    try {
        const data = await fs.readFile(mensagensPath, 'utf-8');
        res.json(JSON.parse(data));
    } catch (err) {
        console.log('Erro ao ler mensagens:', err.message);
        res.status(500).json({erro: 'Erro ao ler mensagens'});
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`📊 Dashboard rodando em: http://localhost:${PORT}`);
});
