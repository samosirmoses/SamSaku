"""Composite performance indexes for low-RAM VPS query efficiency."""
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_transactions_owner_date", "transactions", ["owner_id", "date"])
    op.create_index("ix_transactions_owner_account", "transactions", ["owner_id", "account_id"])
    op.create_index("ix_transactions_owner_to_account", "transactions", ["owner_id", "to_account_id"])
    op.create_index("ix_transactions_original_id", "transactions", ["original_id"])
    op.create_index("ix_account_entries_owner_account", "account_entries", ["owner_id", "account_id"])
    op.create_index(
        "ix_source_events_owner_status_occurred",
        "source_events",
        ["owner_id", "status", "occurred_at"],
    )
    op.create_index("ix_reserves_owner_account", "reserves", ["owner_id", "account_id"])


def downgrade():
    op.drop_index("ix_reserves_owner_account", table_name="reserves")
    op.drop_index("ix_source_events_owner_status_occurred", table_name="source_events")
    op.drop_index("ix_account_entries_owner_account", table_name="account_entries")
    op.drop_index("ix_transactions_original_id", table_name="transactions")
    op.drop_index("ix_transactions_owner_to_account", table_name="transactions")
    op.drop_index("ix_transactions_owner_account", table_name="transactions")
    op.drop_index("ix_transactions_owner_date", table_name="transactions")
