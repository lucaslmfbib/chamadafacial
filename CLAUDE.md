# Chamada Facial (MVP)

Totem de chamada escolar por reconhecimento facial. O reconhecimento roda no navegador (face-api.js); o backend FastAPI guarda alunos, embeddings e presenças.

## Estrutura
- `main.py`: FastAPI + SQLAlchemy. Usa `DATABASE_URL`/`POSTGRES_URL` (Postgres/Neon em produção, na Vercel) e cai no SQLite localmente. Cria dados de seed (3 alunos demo com embeddings aleatórios que não reconhecem ninguém).
- `static/index.html`, `static/script.js`, `static/style.css`: totem (cadastro e chamada). Ajustes de threshold, cooldown e frames ficam no objeto `CONFIG` em `script.js`.
- `static/admin.html`: tela administrativa.
- `static/models/`: pesos do face-api.js. `download_models.py` baixa os pesos; sem eles, vêm da CDN.

## API
- `GET /api/alunos/embeddings`: id, nome, matrícula, embedding[128]
- `POST /api/alunos`: cria/atualiza `{nome, matricula, embedding}`
- `POST /api/presenca`: `{aluno_id}` → `registrada` ou `ja_registrada` (1 vez por dia)
- `GET /api/presencas/hoje`
- Documentação interativa em `/docs`.

## Como rodar
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8000      # teste local em http://localhost:8000
```
Para usar num tablet na rede local, a câmera exige HTTPS: gerar certificado autoassinado e rodar uvicorn com `--ssl-keyfile`/`--ssl-certfile` (ver README).

## Convenções
- Embeddings faciais são dados pessoais sensíveis (LGPD): não logar, não expor em endpoints públicos novos sem necessidade.
- Não commitar `key.pem`, `cert.pem` nem o banco SQLite.
- Não há testes automatizados; validar pelo `/docs` e pelo fluxo cadastro → chamada.
