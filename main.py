"""
Chamada Escolar por Reconhecimento Facial — Backend mínimo (FastAPI + SQLite).

O reconhecimento roda 100% no navegador (face-api.js). Este backend apenas:
  * serve os arquivos estáticos (frontend + pesos dos modelos);
  * fornece os embeddings cadastrados;
  * registra presenças (1 por aluno por dia);
  * permite cadastrar/atualizar o embedding de um aluno (modo Cadastro do totem).
"""
from __future__ import annotations

import csv
import io
import json
import os
import random
from datetime import date, datetime
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import (Date, DateTime, ForeignKey, Integer, String, Text,
                        UniqueConstraint, create_engine, select)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import (DeclarativeBase, Mapped, Session, mapped_column,
                            relationship, sessionmaker)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
# Fuso horário do Brasil (servidores na nuvem rodam em UTC).
from zoneinfo import ZoneInfo

TZ_BR = ZoneInfo("America/Sao_Paulo")


def agora() -> datetime:
    """Hora de Brasília (sem tzinfo, para gravar no banco)."""
    return datetime.now(TZ_BR).replace(tzinfo=None)


def hoje_br() -> date:
    return agora().date()

# Em produção (Vercel + Neon) use DATABASE_URL; localmente cai no SQLite.
_db_env = os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL")
if _db_env:
    DB_URL = _db_env.replace("postgres://", "postgresql://", 1)
    if DB_URL.startswith("postgresql://"):
        DB_URL = DB_URL.replace("postgresql://", "postgresql+psycopg://", 1)
    engine = create_engine(DB_URL, pool_pre_ping=True, pool_size=1, max_overflow=2)
else:
    _db_path = Path("/tmp/chamada.db") if os.getenv("VERCEL") else BASE_DIR / "chamada.db"
    DB_URL = f"sqlite:///{_db_path}"
    engine = create_engine(DB_URL, connect_args={"check_same_thread": False})
EMBEDDING_SIZE = 128  # faceRecognitionNet gera descritores de 128 floats
ADMIN_PIN = os.getenv("ADMIN_PIN", "1234")  # troque em produção!

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


# ----------------------------------------------------------------- Modelos ---
class Base(DeclarativeBase):
    pass


class Aluno(Base):
    __tablename__ = "alunos"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    nome: Mapped[str] = mapped_column(String(120), nullable=False)
    matricula: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    embedding_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    presencas: Mapped[List["Presenca"]] = relationship(back_populates="aluno")


class Presenca(Base):
    __tablename__ = "presencas"
    # A constraint garante a regra "1 presença por dia" mesmo com requisições concorrentes.
    __table_args__ = (UniqueConstraint("aluno_id", "data", name="uq_presenca_dia"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    aluno_id: Mapped[int] = mapped_column(ForeignKey("alunos.id"), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=agora)
    data: Mapped[date] = mapped_column(Date, default=hoje_br, index=True)
    aluno: Mapped[Aluno] = relationship(back_populates="presencas")


# ----------------------------------------------------------------- Schemas ---
class PresencaIn(BaseModel):
    aluno_id: int


class AlunoIn(BaseModel):
    nome: str = Field(min_length=2, max_length=120)
    matricula: str = Field(min_length=1, max_length=30)
    embedding: List[float]

    @field_validator("embedding")
    @classmethod
    def _tamanho(cls, v: List[float]) -> List[float]:
        if len(v) != EMBEDDING_SIZE:
            raise ValueError(f"embedding deve ter {EMBEDDING_SIZE} valores")
        return v


# -------------------------------------------------------------------- Seed ---
def seed() -> None:
    """Popula alunos fictícios. Os embeddings são aleatórios (não casam com
    nenhum rosto real) — use o modo Cadastro do totem para gravar rostos reais."""
    with SessionLocal() as db:
        if db.scalar(select(Aluno).limit(1)):
            return
        rnd = random.Random(42)
        for nome, mat in [("Ana Souza (demo)", "2026001"),
                          ("Bruno Lima (demo)", "2026002"),
                          ("Carla Mendes (demo)", "2026003")]:
            emb = [round(rnd.gauss(0, 0.09), 6) for _ in range(EMBEDDING_SIZE)]
            db.add(Aluno(nome=nome, matricula=mat, embedding_json=json.dumps(emb)))
        db.commit()


Base.metadata.create_all(engine)
seed()

# --------------------------------------------------------------------- API ---
app = FastAPI(title="Chamada Facial", version="1.0.0")


@app.get("/api/status")
def status():
    return {"banco": engine.dialect.name,
            "env": sorted(k for k in os.environ if "DATABASE" in k or "POSTGRES" in k or k.endswith("_URL"))}


@app.get("/api/alunos/embeddings")
def listar_embeddings():
    with SessionLocal() as db:
        alunos = db.scalars(select(Aluno).where(Aluno.embedding_json.is_not(None))).all()
        return [{"id": a.id, "nome": a.nome, "matricula": a.matricula,
                 "embedding": json.loads(a.embedding_json)} for a in alunos]


@app.post("/api/alunos", status_code=201)
def cadastrar_aluno(payload: AlunoIn):
    """Cria o aluno ou atualiza o embedding se a matrícula já existir."""
    with SessionLocal() as db:
        aluno = db.scalar(select(Aluno).where(Aluno.matricula == payload.matricula))
        if aluno:
            aluno.nome = payload.nome
            aluno.embedding_json = json.dumps(payload.embedding)
            acao = "atualizado"
        else:
            aluno = Aluno(nome=payload.nome, matricula=payload.matricula,
                          embedding_json=json.dumps(payload.embedding))
            db.add(aluno)
            acao = "criado"
        db.commit()
        return {"status": acao, "id": aluno.id, "nome": aluno.nome}


@app.post("/api/presenca")
def registrar_presenca(payload: PresencaIn):
    hoje = hoje_br()
    with SessionLocal() as db:
        aluno = db.get(Aluno, payload.aluno_id)
        if not aluno:
            raise HTTPException(404, "Aluno não encontrado")

        existente = db.scalar(select(Presenca).where(
            Presenca.aluno_id == aluno.id, Presenca.data == hoje))
        if existente:
            return {"status": "ja_registrada", "nome": aluno.nome,
                    "mensagem": f"{aluno.nome} já registrou presença hoje às "
                                f"{existente.timestamp:%H:%M}.",
                    "timestamp": existente.timestamp.isoformat()}

        p = Presenca(aluno_id=aluno.id, data=hoje, timestamp=agora())
        db.add(p)
        try:
            db.commit()
        except IntegrityError:  # corrida entre duas requisições simultâneas
            db.rollback()
            return {"status": "ja_registrada", "nome": aluno.nome,
                    "mensagem": f"{aluno.nome} já registrou presença hoje."}
        return {"status": "registrada", "nome": aluno.nome,
                "matricula": aluno.matricula,
                "mensagem": f"Presença confirmada: {aluno.nome}",
                "timestamp": p.timestamp.isoformat()}


@app.get("/api/presencas/hoje")
def presencas_hoje():
    with SessionLocal() as db:
        rows = db.execute(
            select(Presenca, Aluno).join(Aluno)
            .where(Presenca.data == hoje_br()).order_by(Presenca.timestamp.desc())
        ).all()
        return [{"aluno_id": a.id, "nome": a.nome, "matricula": a.matricula,
                 "timestamp": p.timestamp.isoformat()} for p, a in rows]


# ------------------------------------------------------------------- Admin ---
def _auth(pin: Optional[str]) -> None:
    if pin != ADMIN_PIN:
        raise HTTPException(401, "PIN inválido")


def _query_presencas(db: Session, inicio: Optional[date], fim: Optional[date]):
    q = select(Presenca, Aluno).join(Aluno).order_by(Presenca.timestamp.desc())
    if inicio:
        q = q.where(Presenca.data >= inicio)
    if fim:
        q = q.where(Presenca.data <= fim)
    return db.execute(q).all()


@app.get("/api/admin/presencas")
def admin_presencas(inicio: Optional[date] = None, fim: Optional[date] = None,
                    x_admin_pin: Optional[str] = Header(None)):
    _auth(x_admin_pin)
    with SessionLocal() as db:
        return [{"id": p.id, "data": p.data.isoformat(), "hora": f"{p.timestamp:%H:%M:%S}",
                 "aluno_id": a.id, "nome": a.nome, "matricula": a.matricula}
                for p, a in _query_presencas(db, inicio, fim)]


@app.get("/api/admin/presencas.csv")
def admin_csv(pin: str, inicio: Optional[date] = None, fim: Optional[date] = None):
    _auth(pin)
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")  # ';' abre direto no Excel em pt-BR
    w.writerow(["Data", "Hora", "Matrícula", "Nome"])
    with SessionLocal() as db:
        for p, a in _query_presencas(db, inicio, fim):
            w.writerow([f"{p.data:%d/%m/%Y}", f"{p.timestamp:%H:%M:%S}", a.matricula, a.nome])
    nome = f"presencas_{inicio or 'inicio'}_{fim or 'hoje'}.csv"
    return Response("\ufeff" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{nome}"'})


@app.delete("/api/admin/presencas")
def admin_zerar(inicio: Optional[date] = None, fim: Optional[date] = None,
                x_admin_pin: Optional[str] = Header(None)):
    """Apaga presenças do período (sem datas = apaga TODAS)."""
    _auth(x_admin_pin)
    with SessionLocal() as db:
        rows = _query_presencas(db, inicio, fim)
        for p, _ in rows:
            db.delete(p)
        db.commit()
        return {"apagadas": len(rows)}


@app.delete("/api/admin/presencas/{presenca_id}")
def admin_apagar_presenca(presenca_id: int, x_admin_pin: Optional[str] = Header(None)):
    _auth(x_admin_pin)
    with SessionLocal() as db:
        p = db.get(Presenca, presenca_id)
        if p:
            db.delete(p); db.commit()
        return {"ok": True}


@app.get("/api/admin/alunos")
def admin_alunos(x_admin_pin: Optional[str] = Header(None)):
    _auth(x_admin_pin)
    with SessionLocal() as db:
        return [{"id": a.id, "nome": a.nome, "matricula": a.matricula,
                 "tem_rosto": a.embedding_json is not None,
                 "total_presencas": len(a.presencas)}
                for a in db.scalars(select(Aluno).order_by(Aluno.nome)).all()]


@app.delete("/api/admin/alunos/{aluno_id}")
def admin_apagar_aluno(aluno_id: int, x_admin_pin: Optional[str] = Header(None)):
    _auth(x_admin_pin)
    with SessionLocal() as db:
        a = db.get(Aluno, aluno_id)
        if not a:
            raise HTTPException(404, "Aluno não encontrado")
        for p in list(a.presencas):
            db.delete(p)
        db.delete(a); db.commit()
        return {"ok": True}


# Estáticos por último (as rotas /api têm prioridade). Pesos em /models/...
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
