"""Persistent import/receipt jobs and row provenance."""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("file_jobs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(64), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("filename", sa.String(180), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("data", sa.LargeBinary()),
        sa.Column("object_key", sa.String(160)),
        sa.Column("config", sa.JSON()),
        sa.Column("result", sa.JSON()))
    op.create_index("ix_file_jobs_owner_id","file_jobs", ["owner_id"])
    op.create_table("import_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.String(64), nullable=False),
        sa.Column("job_id", sa.String(36), nullable=False),
        sa.Column("sheet", sa.String(80), nullable=False),
        sa.Column("row", sa.Integer(), nullable=False),
        sa.Column("entity", sa.String(32), nullable=False),
        sa.Column("record_id", sa.String(40)),
        sa.UniqueConstraint("job_id","sheet","row"))
    op.create_index("ix_import_entries_owner_id","import_entries", ["owner_id"])
    op.create_index("ix_import_entries_job_id","import_entries", ["job_id"])
    if op.get_bind().dialect.name == "postgresql":
        for table in ("file_jobs", "import_entries", "alembic_version"):
            op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
            op.execute(f'REVOKE ALL ON TABLE "{table}" FROM PUBLIC')
            for role in ("anon", "authenticated"):
                exists = op.get_bind().scalar(sa.text("select 1 from pg_roles where rolname=:role"), {"role": role})
                if exists:
                    op.execute(f'REVOKE ALL ON TABLE "{table}" FROM "{role}"')


def downgrade():
    op.drop_table("import_entries")
    op.drop_table("file_jobs")
