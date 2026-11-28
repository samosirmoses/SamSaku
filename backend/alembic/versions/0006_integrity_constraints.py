"""Add database-level CHECK constraints for core monetary and relational invariants."""
from collections import defaultdict

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

CONSTRAINTS = [
    ("categories", "ck_categories_kind_valid", "kind IN ('income', 'expense')"),
    ("categories", "ck_categories_no_self_parent", "parent_id IS NULL OR parent_id <> id"),
    ("transactions", "ck_transactions_amount_positive", "amount > 0"),
    ("transactions", "ck_transactions_fee_nonnegative", "fee >= 0"),
    ("transactions", "ck_transactions_kind_valid", "kind IN ('income', 'expense', 'transfer', 'refund')"),
    (
        "transactions",
        "ck_transactions_transfer_accounts",
        "kind <> 'transfer' OR (to_account_id IS NOT NULL AND account_id <> to_account_id)",
    ),
    ("goals", "ck_goals_target_positive", "target > 0"),
    ("reserves", "ck_reserves_amount_positive", "amount > 0"),
    ("reserves", "ck_reserves_remaining_bounds", "remaining >= 0 AND remaining <= amount"),
    ("budgets", "ck_budgets_amount_positive", "amount > 0"),
]


def upgrade():
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        grouped: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for table, name, expr in CONSTRAINTS:
            grouped[table].append((name, expr))
        for table, items in grouped.items():
            with op.batch_alter_table(table) as batch_op:
                for name, expr in items:
                    batch_op.create_check_constraint(name, expr)
    else:
        for table, name, expr in CONSTRAINTS:
            op.create_check_constraint(name, table, expr)


def downgrade():
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        grouped: dict[str, list[str]] = defaultdict(list)
        for table, name, _expr in reversed(CONSTRAINTS):
            grouped[table].append(name)
        for table, names in grouped.items():
            with op.batch_alter_table(table) as batch_op:
                for name in names:
                    batch_op.drop_constraint(name, type_="check")
    else:
        for table, name, _expr in reversed(CONSTRAINTS):
            op.drop_constraint(name, table, type_="check")
