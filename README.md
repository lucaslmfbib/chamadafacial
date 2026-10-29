# Chamada Facial — Totem (MVP)

```
chamada-facial/
├── main.py              # FastAPI + SQLAlchemy (SQLite) + seed
├── download_models.py   # baixa os pesos do face-api.js
├── requirements.txt
└── static/
    ├── index.html
    ├── script.js
    ├── style.css
    └── models/          # pesos (gerados pelo download_models.py)
```

## Executar

```bash
cd chamada-facial
python3 -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python download_models.py        # opcional: sem isso, os pesos vêm da CDN

# Certificado autoassinado (o navegador só libera a câmera em HTTPS ou localhost)
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout key.pem -out cert.pem -subj "/CN=chamada.local"

uvicorn main:app --host 0.0.0.0 --port 8000 --ssl-keyfile key.pem --ssl-certfile cert.pem
```

Descubra o IP do computador (`ipconfig getifaddr en0` no macOS, `ipconfig` no Windows, `hostname -I` no Linux)
e abra no tablet, na mesma rede Wi-Fi: **https://SEU_IP:8000**. Aceite o aviso do certificado
("Avançado → Continuar") e toque em **Iniciar**.

> Para testar no próprio computador: `uvicorn main:app --port 8000` e abra http://localhost:8000.

## Uso
1. **Cadastro**: informe nome e matrícula, olhe para a câmera e toque em *Capturar* (5 amostras com a média salva).
2. **Chamada**: o rosto reconhecido ganha borda verde, toca um bipe e o aluno é registrado (1x por dia).
   Os 3 alunos "demo" têm embeddings aleatórios só para testar a API. Eles não reconhecem ninguém.

## API
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/alunos/embeddings` | id, nome, matrícula, embedding[128] |
| POST | `/api/presenca` | `{"aluno_id": 1}` → `registrada` ou `ja_registrada` |
| POST | `/api/alunos` | `{"nome","matricula","embedding"}` cria/atualiza |
| GET | `/api/presencas/hoje` | presenças do dia |

Docs interativas: `/docs`. Ajustes finos (threshold, cooldown, frames) ficam em `CONFIG` no `script.js`.

## Modo quiosque
- **iPad**: Ajustes → Acessibilidade → Acesso Guiado. Use "Adicionar à Tela de Início" para tela cheia.
- **Android**: Fixar app (Screen pinning) ou um app de kiosk browser.
