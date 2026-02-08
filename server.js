// server.js
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const stream = require('stream');

const app = express();

/**
 * Gerar ID sequencial único com retry para evitar colisões em requisições simultâneas
 */
async function gerarIdUnico(aba, dadosExistentes, maxRetries = 3) {
  let ultimoId = Math.max(...dadosExistentes.map(item => Number(item.id) || 0), 0);
  let novoId = ultimoId + 1;
  let tentativas = 0;

  while (tentativas < maxRetries) {
    const idJaExiste = dadosExistentes.some(item => Number(item.id) === novoId);
    
    if (!idJaExiste) {
      return novoId;
    }

    novoId++;
    tentativas++;
    
    const novosDados = await lerAba(aba, `${aba}!A:G`);
    if (novosDados.some(item => Number(item.id) === novoId)) {
      novoId = Math.max(...novosDados.map(item => Number(item.id) || 0), 0) + 1;
    }
  }

  return ultimoId + 1000 + Date.now() % 1000;
}

// Middleware
app.use(express.json());
app.use(cors());

// Configuração Google Sheets
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1dDPSxxFa6B3ZLJugXbNmtGlszzaP2ugD6zx_vrc2qDE';

// Lê o service account de variável de ambiente (Render) ou do arquivo local (para desenvolvimento)
let credentials;
if (process.env.SERVICE_ACCOUNT_JSON) {
  credentials = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
  // fallback para desenvolvimento local
  const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'service-account.json');
  credentials = require(SERVICE_ACCOUNT_FILE);
}

// Autenticação
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Middleware para autenticar JWT
function autenticar(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Token não fornecido' });

  const token = authHeader.split(' ')[1]; // Bearer <token>
  if (!token) return res.status(401).json({ error: 'Token inválido' });

  jwt.verify(token, 'SEGREDO_SUPERSECRETO', (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token expirado ou inválido' });
    req.user = decoded; // dados do usuário disponíveis em req.user
    next();
  });
}

/**
 * Ler aba do Google Sheets e transformar em array de objetos
 * range: 'A:O' para incluir todas as colunas, inclusive fórmulas
 */
async function lerAba(sheetName, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = response.data.values;
  if (!rows || rows.length === 0) return [];

  const headers = rows[0];
  const dados = rows.slice(1).map(row => {
    let obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index] || '';
    });
    return obj;
  });

  return dados;
}

/**
 * Metas filtrando ult_tres_meses = 1 e retornando até N
 */
app.get('/api/metas', autenticar, async (req, res) => {
  try {
    // Lê toda a aba, até P, para manter as fórmulas intactas
    const metas = await lerAba('metas', 'metas!A:P'); 

    // Filtra apenas as metas dos últimos 3 meses
    const filtradas = metas.filter(meta => meta.ult_tres_meses === '1');

    // Mapeia para retornar apenas colunas até P
    const resultado = filtradas.map(meta => {
      const keys = Object.keys(meta).slice(0, 15); // A:P = 19 colunas (0-index)
      const obj = {};
      keys.forEach(k => obj[k] = meta[k]);
      return obj;
    });

    res.json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar metas' });
  }
});

/**
 * Atualizar uma meta
 * Só permite edição de A:L
 */
app.put('/api/metas/:id', autenticar, async (req, res) => {
  const { id } = req.params;
  const dadosAtualizados = req.body;

  try {
    const metas = await lerAba('metas', 'metas!A:P');
    const linha = metas.findIndex(meta => meta.id === id.toString());
    if (linha === -1) return res.status(404).json({ error: 'Meta não encontrada' });

    const linhaPlanilha = linha + 2; // +1 header +1 1-indexed

    const colunasEditaveis = Object.keys(metas[0]).slice(0, 12); // A:L
    const values = colunasEditaveis.map(col => {
      let val = dadosAtualizados[col] ?? metas[linha][col] ?? '';

      // Datas já vêm como dd/MM/yyyy do front, mantemos string
      if (['data_condominio', 'data_envio', 'data_limite'].includes(col) && val) {
        if (typeof val !== 'string') val = String(val);
      }

      return val;
    });

    const range = `metas!A${linhaPlanilha}:L${linhaPlanilha}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED', // interpreta a string
      requestBody: { values: [values] },
    });

    res.json({ message: 'Meta atualizada com sucesso!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar meta' });
  }
});

/**
 * EXCLUIR UMA META
 */
app.delete('/api/excluirmeta/:id', autenticar, async (req, res) => {
  const { id } = req.params;

  try {
    const metas = await lerAba('metas', 'metas!A:P');
    const linha = metas.findIndex(meta => meta.id === id.toString());
    if (linha === -1) return res.status(404).json({ error: 'Meta não encontrada' });

    const linhaPlanilha = linha + 2; // +1 cabeçalho +1 base 1

    // Executa a exclusão da linha
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: 466807243, // <-- ID fixo da aba 'metas'
                dimension: 'ROWS',
                startIndex: linhaPlanilha - 1, // zero-based, inclusive
                endIndex: linhaPlanilha,       // exclusive
              },
            },
          },
        ],
      },
    });

    res.json({ message: 'Meta excluída com sucesso!' });
  } catch (err) {
    console.error('Erro ao excluir meta:', err);
    res.status(500).json({ error: 'Erro ao excluir meta' });
  }
});

/**
 * Usuários
 */
app.get('/api/usuarios', autenticar, async (req, res) => {
  try {
    const usuarios = await lerAba('usuarios', 'usuarios!A:F');
    res.json(usuarios);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar usuários' });
  }
});

/**
 * Criar novo usuário (A:F)
 */
app.post('/api/novoUsuario', autenticar, async (req, res) => {
  const { login, nome, email, cargo } = req.body;

  if (!login || !nome || !email || !cargo) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    const aba = 'usuarios';
    const rangeLeitura = `${aba}!A:G`;

    const dadosExistentes = await lerAba(aba, rangeLeitura);
    const novoId = await gerarIdUnico(aba, dadosExistentes);
    
    const senhaPadrao = "$2b$12$SafcGB.Y7vBzr1FB/KzVs.Ytm91/1IrUSQ0wp4..syc/fLZlb4dSS"

    const novoUsuario = [
      novoId,                  // A - id
      login,                   // B - login
      nome,                    // C - nome
      email,                   // D - email
      cargo,                   // E - cargo
      new Date().toISOString().split('T')[0], // F - data_criacao (yyyy-mm-dd)
      senhaPadrao
    ];

    // Escrever na planilha
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${aba}!A:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [novoUsuario] },
    });

    res.json({ message: 'Usuário criado com sucesso!', usuario: novoUsuario });
  } catch (err) {
    console.error('Erro ao criar usuário:', err);
    res.status(500).json({ error: 'Erro ao criar usuário.' });
  }
});


/**
 * Dados - retornar valores únicos de cada coluna
 */
app.get('/api/dados', autenticar, async (req, res) => {
  try {
    const dados = await lerAba('dados', 'dados!A:H'); // A:H cobre todas as colunas

    const colunas = {};
    if (dados.length > 0) {
      Object.keys(dados[0]).forEach(col => {
        colunas[col] = [...new Set(dados.map(row => row[col]).filter(v => v))]; // remove vazios
      });
    }

    res.json(colunas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

/**
 * Metas filtrando por mes_apuracao
 */
app.get('/api/metasCompleta', autenticar, async (req, res) => {
  try {
    const { mes_apuracao } = req.query;
    if (!mes_apuracao) {
      return res.status(400).json({ error: 'Parâmetro mes_apuracao é obrigatório' });
    }

    // Lê toda a aba para manter as fórmulas intactas
    const metas = await lerAba('metas', 'metas!A:O'); 

    // Filtra pelo mes_apuracao
    const filtradas = metas.filter(meta => meta.mes_apuracao === mes_apuracao);

    res.json(filtradas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar metas' });
  }
});

/**
 * Atualiza várias metas pelo ID
 */
app.put('/api/metasAtualizarPorIds', autenticar, async (req, res) => {
  const { ids = [], coluna, valor } = req.body;

  if (!coluna || !ids.length) {
    return res.status(400).json({ error: 'Coluna e IDs são obrigatórios' });
  }

  try {
    const metas = await lerAba('metas', 'metas!A:P');
    const colunas = Object.keys(metas[0]);
    const indexColuna = colunas.indexOf(coluna);

    if (indexColuna === -1) return res.status(400).json({ error: 'Coluna inválida' });

    const requests = [];

    ids.forEach(id => {
      const linha = metas.findIndex(m => String(m.id) === String(id));
      if (linha !== -1) {
        const linhaPlanilha = linha + 2; // 1 header + 1 index
        let valorFinal = valor;

        // Se for coluna de data, garante formato DD/MM/YYYY
        if (['data_condominio', 'data_limite', 'data_envio'].includes(coluna) && valor) {
          // Se veio no formato yyyy-mm-dd do input date, converte
          const partes = valor.split('-');
          if (partes.length === 3) {
            valorFinal = `${partes[2]}/${partes[1]}/${partes[0]}`;
          }
        }

        requests.push({
          range: `metas!${String.fromCharCode(65 + indexColuna)}${linhaPlanilha}`,
          values: [[valorFinal]]
        });
      }
    });

    if (!requests.length) return res.status(404).json({ error: 'Nenhum ID encontrado' });

    // Batch update de todas as células com USER_ENTERED
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: requests
      }
    });

    res.json({ message: `${requests.length} metas atualizadas com sucesso!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar metas' });
  }
});

/**
 * Criar novas metas (A:P)
 * formulas: array de fórmulas para as colunas extras (I:P)
 */
app.post('/api/novoCondominio', autenticar, async (req, res) => {
  const { nomeCondominio, metas, formulas = [] } = req.body;

  if (!nomeCondominio || !Array.isArray(metas) || metas.length === 0) {
    return res.status(400).json({ error: 'Nome do condomínio e lista de metas são obrigatórios.' });
  }

  try {
    const aba = 'metas';
    const rangeLeitura = `${aba}!A:P`;

    // Ler planilha existente
    const dadosExistentes = await lerAba(aba, rangeLeitura);

    let proximoId = Math.max(...dadosExistentes.map(m => Number(m.id) || 0), 0) + 1;
    const novasLinhas = metas.map((meta, i) => {
      const novoId = proximoId + i;

      // Tratamento da data
      let dataCondominio = meta.data_condominio || '';
      if (dataCondominio && dataCondominio.includes('-')) {
        const partes = dataCondominio.split('-'); // yyyy-mm-dd
        dataCondominio = `${partes[2]}/${partes[1]}/${partes[0]}`; // dd/mm/yyyy
      }

      // Valores padrões para colunas extras
      const particularidade = 0;
      const observacao = '';
      const data_envio = '';
      const nao_gerar = 0;

      // Últimas 4 colunas podem ser fórmulas
      const colExtras = formulas.length ? formulas : ['=RIGHTB(N:N;7)', '=SE(B:B="balancete";DIATRABALHO.INTL(H:H;-5;1;dados!$A$2:$A);SE(B:B="taxa";H:H-12;H:H))', '=SE(ÉCÉL.VAZIA(K:K);"Pendente";SE(K:K>N:N;"Atrasado";"No prazo"))', '=SE(E(MÊS(H:H)>(MÊS(HOJE())-3);ANO(HOJE())=ANO(H:H));1;0)'];

      return [
        novoId,                     // A - id
        meta.meta || '',            // B - meta
        nomeCondominio,             // C - condominio
        meta.gerente || '',         // D - gerente
        meta.coordenador || '',     // E - coordenador
        meta.financeiro || '',      // F - financeiro
        meta.contabil || '',        // G - contabil
        dataCondominio,             // H - data_condominio
        particularidade,            // I - particularidade
        observacao,                 // J - observacao
        data_envio,                 // K - data_envio
        nao_gerar,                  // L - nao_gerar
        ...colExtras                // M-P - fórmulas ou valores
      ];
    });

    // Escrever na planilha com USER_ENTERED
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${aba}!A:P`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: novasLinhas },
    });

    res.json({ message: 'Metas adicionadas com sucesso!', inseridas: novasLinhas.length });
  } catch (err) {
    console.error('Erro ao criar novas metas:', err);
    res.status(500).json({ error: 'Erro ao criar novas metas.' });
  }
});

// rota de login ----------------------------
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const usuarios = await lerAba('usuarios', 'usuarios!A:G'); // sua planilha
    const user = usuarios.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

    const senhaValida = await bcrypt.compare(password, user.senhaHash);
    if (!senhaValida) return res.status(401).json({ error: 'Senha inválida' });

    const token = jwt.sign({ id: user.id, email: user.email, login: user.login, cargo: user.cargo }, 'SEGREDO_SUPERSECRETO', { expiresIn: '12h' });
    // Retorna o token e os dados do usuário
      res.json({
        token,
        usuario: {
          id: user.id,
          login: user.login,
          nome: user.nome,      // adiciona o nome
          email: user.email,    // adiciona o email
          cargo: user.cargo
        }
      });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro no login' });
  }
});

app.put('/api/usuarios/:id/redefinir-senha', autenticar, async (req, res) => {
  const { id } = req.params;
  const { novaSenha } = req.body;

  console.log('ID param:', id);
  console.log('Nova senha:', novaSenha);
  console.log('Usuario logado:', req.user);

  try {
    const usuarios = await lerAba('usuarios', 'usuarios!A:G');
    console.log('Usuarios da planilha:', usuarios);

    const index = usuarios.findIndex(u => u.id == id);
    if (index === -1) return res.status(404).json({ error: 'Usuário não encontrado' });

    if (String(req.user.id) !== String(id)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const senhaParaSalvar = await bcrypt.hash(novaSenha, 12);

    const linhaPlanilha = index + 2;
    console.log('Atualizando planilha na linha:', linhaPlanilha);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `usuarios!G${linhaPlanilha}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[senhaParaSalvar]] }
    });

    res.json({ message: 'Senha redefinida com sucesso!' });

  } catch (err) {
    console.error('Erro ao redefinir senha:', err);
    res.status(500).json({ error: 'Erro ao redefinir senha' });
  }
});


app.put('/api/usuarios/:id/senha-padrao', autenticar, async (req, res) => {
  const { id } = req.params;

  console.log('Requisição para redefinir senha padrão do usuário ID:', id);
  console.log('Usuário logado:', req.user);

  try {
    // Apenas coordenador ou admin podem redefinir senhas de outros
    if (req.user.cargo !== 'coordenador' && req.user.cargo !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado. Apenas coordenadores ou administradores podem redefinir senhas.' });
    }

    // Lê todos os usuários da planilha
    const usuarios = await lerAba('usuarios', 'usuarios!A:G');
    const index = usuarios.findIndex(u => u.id == id);
    if (index === -1) return res.status(404).json({ error: 'Usuário não encontrado' });

    // Define a senha padrão (você pode mudar o texto aqui se quiser)
    const senhaPadrao = '123456';
    const senhaCriptografada = await bcrypt.hash(senhaPadrao, 12);

    // Atualiza na planilha (coluna G)
    const linhaPlanilha = index + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `usuarios!G${linhaPlanilha}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[senhaCriptografada]] }
    });

    console.log(`Senha do usuário ${id} redefinida para o padrão com sucesso.`);
    res.json({ message: 'Senha redefinida para o padrão com sucesso!' });

  } catch (err) {
    console.error('Erro ao redefinir senha padrão:', err);
    res.status(500).json({ error: 'Erro ao redefinir senha padrão' });
  }
});

// Rota para editar dados de um usuário
app.put('/api/usuarios/:id', autenticar, async (req, res) => {
  const { id } = req.params;
  const { nome, email, cargo } = req.body;

  try {
    const usuarios = await lerAba('usuarios', 'usuarios!A:G');
    const index = usuarios.findIndex(u => u.id == id);
    if (index === -1) return res.status(404).json({ error: 'Usuário não encontrado' });

    // Permitir que apenas gerente ou coordenador edite
    if (req.user.cargo !== 'gerente' && req.user.cargo !== 'coordenador' && req.user.cargo !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const linhaPlanilha = index + 2; // linha real na planilha (pula cabeçalho)

    // Atualiza as colunas C, D e E (nome, email, cargo)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `usuarios!C${linhaPlanilha}:E${linhaPlanilha}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[nome, email, cargo]] }
    });

    res.json({ message: 'Usuário atualizado com sucesso!' });
  } catch (err) {
    console.error('Erro ao atualizar usuário:', err);
    res.status(500).json({ error: 'Erro ao atualizar usuário' });
  }
});

// Inicialização do servidor
const PORT = process.env.PORT || 3000;

// Servir arquivos HTML, CSS e JS da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Rota padrão para abrir login.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
  console.log(`Server rodando na porta ${PORT}`);
});