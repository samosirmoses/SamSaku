"""Core ledger and per-owner allocation records. Frozen initial schema."""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def id_col(name, fk=None, nullable=False):
    args = [sa.ForeignKey(f"{fk}.id")] if fk else []
    return sa.Column(name, sa.String(36), *args, nullable=nullable)


def s(name, size, optional=False):
    return sa.Column(name, sa.String(size), nullable=optional)


def number(name, optional=False):
    return sa.Column(name, sa.BigInteger(), nullable=optional)


def day(name, optional=False):
    return sa.Column(name, sa.Date(), nullable=optional)


def create(name, *cols, unique=(), indexed=()):
    constraint = [sa.UniqueConstraint(*unique)] if unique else []
    op.create_table(name, sa.Column("id", sa.String(36), primary_key=True),
                    id_col("owner_id"), *cols, *constraint)
    for col in ("owner_id", *indexed):
        op.create_index(f"ix_{name}_{col}", name, [col])
    if op.get_bind().dialect.name == "postgresql":
        # Application's direct DB role owns the tables. The public Data API cannot read ledger data.
        op.execute(f'ALTER TABLE "{name}" ENABLE ROW LEVEL SECURITY')
        op.execute(f'REVOKE ALL ON TABLE "{name}" FROM PUBLIC')
        for role in ("anon", "authenticated"):
            if op.get_bind().scalar(sa.text("select 1 from pg_roles where rolname=:role"), {"role": role}):
                op.execute(f'REVOKE ALL ON TABLE "{name}" FROM "{role}"')


def upgrade():
    create("accounts", s("code",80), s("name",160), s("kind",32), s("currency",3),
           day("opening_date",True), number("opening_balance",True), unique=("owner_id","code"))
    create("categories", s("code",80), s("name",160), s("kind",12), id_col("parent_id","categories",True),
           sa.Column("archived",sa.Boolean(),nullable=False), unique=("owner_id","code"))
    create("merchants", s("code",80), s("name",160), unique=("owner_id","code"))
    create("merchant_aliases", id_col("merchant_id","merchants"), s("name",200), unique=("owner_id","name"))
    create("transactions", day("date"), s("kind",16), id_col("account_id","accounts"),
           id_col("to_account_id","accounts",True), number("amount"), number("fee"),
           id_col("category_id","categories",True), id_col("merchant_id","merchants",True),
           id_col("original_id","transactions",True), s("description",500), s("source",60), s("source_ref",512,True),
           sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
           unique=("owner_id","source","source_ref"), indexed=("date",))
    create("account_entries", id_col("transaction_id","transactions"), id_col("account_id","accounts"), number("delta"),
           indexed=("transaction_id","account_id"))
    create("transaction_allocations", id_col("transaction_id","transactions"), id_col("category_id","categories",True),
           number("amount"), s("role",16), indexed=("transaction_id",))
    create("source_events", s("source",30), s("external_id",512), s("digest",64), sa.Column("text",sa.Text(),nullable=False),
           sa.Column("occurred_at",sa.DateTime(timezone=True),nullable=False),
           sa.Column("received_at",sa.DateTime(timezone=True),nullable=False), s("status",16),
           sa.Column("parsed",sa.JSON(),nullable=False), id_col("transaction_id","transactions",True),
           unique=("owner_id","source","external_id","digest"))
    create("goals", s("name",160), number("target"))
    create("schemes", s("code",80), s("name",160), sa.Column("cycle_day",sa.Integer(),nullable=False),
           sa.Column("rules",sa.JSON(),nullable=False), unique=("owner_id","code"))
    create("scheme_applications", id_col("scheme_id","schemes"), s("request_id",100), day("date"), day("cycle_start"),
           sa.Column("snapshot",sa.JSON(),nullable=False), unique=("owner_id","request_id"))
    create("reserves", id_col("application_id","scheme_applications"), id_col("scheme_id","schemes"),
           id_col("income_id","transactions"), id_col("account_id","accounts"), id_col("goal_id","goals",True),
           s("pot_name",160), number("amount"), number("remaining"), sa.Column("category_ids",sa.JSON(),nullable=False),
           day("expires",True), indexed=("income_id",))
    create("reserve_movements", id_col("reserve_id","reserves"), id_col("transaction_id","transactions"),
           id_col("category_id","categories"), number("amount"), indexed=("reserve_id","transaction_id"))


def downgrade():
    for name in ("reserve_movements", "reserves", "scheme_applications", "schemes", "goals", "source_events", "transaction_allocations",
                 "account_entries", "transactions", "merchant_aliases", "merchants", "categories", "accounts"):
        op.drop_table(name)
