"""FastAPI router exports."""
from .accounts import router as accounts_router
from .bootstrap import router as bootstrap_router
from .budgets import router as budgets_router
from .categories import router as categories_router
from .planning import router as planning_router
from .reviews import router as reviews_router
from .summary import router as summary_router
from .telegram import router as telegram_router, start_telegram_poller_if_enabled
from .tools import router as tools_router
from .transactions import router as transactions_router

__all__ = [
    "accounts_router",
    "bootstrap_router",
    "budgets_router",
    "categories_router",
    "planning_router",
    "reviews_router",
    "start_telegram_poller_if_enabled",
    "summary_router",
    "telegram_router",
    "tools_router",
    "transactions_router",
]
