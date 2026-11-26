"""Add optional account_number to accounts for receipt & transfer wallet matching."""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("accounts", sa.Column("account_number", sa.String(length=32), nullable=True))


def downgrade():
    op.drop_column("accounts", "account_number")
