"""Per-owner monthly category budgets and period/wallet settings."""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def secure_table(name):
    if op.get_bind().dialect.name == "postgresql":
        op.execute(f'ALTER TABLE "{name}" ENABLE ROW LEVEL SECURITY')
        op.execute(f'REVOKE ALL ON TABLE "{name}" FROM PUBLIC')
        for role in ("anon", "authenticated"):
            if op.get_bind().scalar(sa.text("select 1 from pg_roles where rolname=:role"), {"role": role}):
                op.execute(f'REVOKE ALL ON TABLE "{name}" FROM "{role}"')


def upgrade():
    op.create_table(
        "user_settings",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), nullable=False),
        sa.Column("monthly_start_day", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("weekly_start_day", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("default_account_id", sa.String(36), sa.ForeignKey("accounts.id"), nullable=True),
        sa.UniqueConstraint("owner_id"),
    )
    op.create_index("ix_user_settings_owner_id", "user_settings", ["owner_id"])
    secure_table("user_settings")

    op.create_table(
        "budgets",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), nullable=False),
        sa.Column("category_id", sa.String(36), sa.ForeignKey("categories.id"), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("owner_id", "category_id"),
    )
    op.create_index("ix_budgets_owner_id", "budgets", ["owner_id"])
    op.create_index("ix_budgets_category_id", "budgets", ["category_id"])
    secure_table("budgets")


def downgrade():
    op.drop_table("budgets")
    op.drop_table("user_settings")
