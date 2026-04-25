"""FastAPI entrypoint for the verification service."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import router as api_router
from app.config import get_settings


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    yield


app = FastAPI(
    title="Civic Bounty Verification Service",
    version="0.1.0",
    description=(
        "Person 3B service. Receives /verify requests from the Node backend, "
        "runs Person 3A vision checks + fraud aggregation, scores the result, "
        "and POSTs back to /cleanups/:cleanup_id/verification-result."
    ),
    lifespan=lifespan,
)

app.include_router(api_router)
