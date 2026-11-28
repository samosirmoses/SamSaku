"""Evidence review queue, connector activity status, and external event ingestion routes."""
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..core.auth import configured_owner, owner, secret_matches
from ..core.db import get_db
from ..core.realtime import notify as realtime_notify
from ..schemas import EventIn, ResolveIn
from ..services.reviews import ingest_event, list_connections, list_reviews, resolve_review

router = APIRouter(prefix="/v1", tags=["reviews-events"])


@router.get("/reviews")
def reviews(db: Session = Depends(get_db), user: str = Depends(owner)):
    return list_reviews(db, user)


@router.get("/connections")
def connections(db: Session = Depends(get_db), user: str = Depends(owner)):
    return list_connections(db, user)


@router.post("/reviews/{key}/resolve")
def review(key: str, data: ResolveIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    payload, changed = resolve_review(db, user, key, data)
    db.commit()
    if changed:
        realtime_notify(user, "review:resolved")
    return payload


@router.post("/events/{source}")
def event(
    source: Literal["bca", "gopay", "telegram"],
    data: EventIn,
    authorization: str = Header(""),
    db: Session = Depends(get_db),
):
    if not authorization.startswith("Bearer ") or not secret_matches(authorization[7:], source.upper() + "_TOKEN"):
        raise HTTPException(401, "Kredensial konektor tidak valid.")
    owner_id = configured_owner()
    payload, created = ingest_event(db, owner_id, source, data)
    db.commit()
    if created:
        label = "myBCA" if source == "bca" else source.upper()
        realtime_notify(owner_id, f"event:{source}", f"Mutasi baru masuk dari {label}.")
    return payload
