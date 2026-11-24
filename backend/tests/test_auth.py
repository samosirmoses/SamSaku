import pytest
from fastapi import HTTPException

from app.auth import owner, configured_owner


def test_dev_header_disabled_in_production(monkeypatch):
    monkeypatch.setenv("SAMSAKU_ENV","production")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN","test-token")
    monkeypatch.setenv("OWNER_ID","00000000-0000-4000-8000-000000000001")
    with pytest.raises(HTTPException) as err:
        owner("", "test-token")
    assert err.value.status_code == 401


def test_dev_header_requires_configured_key(monkeypatch):
    monkeypatch.setenv("SAMSAKU_ENV","development")
    monkeypatch.delenv("SAMSAKU_DEV_TOKEN",raising=False)
    with pytest.raises(HTTPException):
        owner("", "")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN","local")
    assert owner("", "local") == configured_owner()
