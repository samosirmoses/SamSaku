"""Database engine, session lifecycle, and per-owner advisory locking."""
import os
from collections.abc import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def normalize_url(url: str) -> str:
    if url.startswith(("postgres://", "postgresql://")):
        return "postgresql+psycopg://" + url.split("://", 1)[1]
    return url


url = normalize_url(os.getenv("DATABASE_URL", "sqlite:///./samsaku.db"))
if url.startswith("sqlite") and os.getenv("SAMSAKU_ENV") not in {"development", "test"}:
    raise RuntimeError("Production requires a PostgreSQL DATABASE_URL.")

if url.startswith("sqlite"):
    engine = create_engine(url, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _sqlite_foreign_keys(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")
else:
    engine = create_engine(
        url,
        pool_size=4,
        max_overflow=2,
        pool_pre_ping=True,
        pool_recycle=1800,
        connect_args={"prepare_threshold": None},
    )

SessionLocal = sessionmaker(engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    with SessionLocal() as db:
        yield db


def lock_owner(db: Session, owner_id: str) -> None:
    """Serialize write operations affecting a single owner's derived balances and evidence."""
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("select pg_advisory_xact_lock(hashtextextended(:owner, 0))"), {"owner": owner_id})
    elif not db.connection().connection.driver_connection.in_transaction:
        db.execute(text("BEGIN IMMEDIATE"))
