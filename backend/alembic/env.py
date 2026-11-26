import os
from alembic import context
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

from app.core.db import Base, normalize_url, url
from app import models  # noqa: F401 - register all ORM tables on Base.metadata

engine = create_engine(normalize_url(os.getenv("MIGRATION_DATABASE_URL") or url), poolclass=NullPool)
with engine.connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata)
    with context.begin_transaction():
        context.run_migrations()
