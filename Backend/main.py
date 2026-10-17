from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from logger import configure_logging
from apps.calculator.route import router as calculator_router
from constants import SERVER_URL, PORT, ENV, OPENROUTER_MODEL


configure_logging()
logger = logging.getLogger("calc-be.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "startup: env=%s host=%s port=%s vision_model=%s",
        ENV,
        SERVER_URL,
        PORT,
        OPENROUTER_MODEL,
    )
    yield
    logger.info("shutdown: calc-be stopping")

app = FastAPI(lifespan=lifespan)


app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get('/')
async def root():
    logger.debug("GET / health check")
    return {"message": "Server is running"}

app.include_router(calculator_router, prefix="/calculate", tags=["calculate"])


if __name__ == "__main__":
    try:
        port = int(PORT)
    except (TypeError, ValueError) as exc:
        logger.error("invalid PORT=%r, falling back to 8900: %s", PORT, exc)
        port = 8900
    logger.info("serving on %s:%d (reload=%s)", SERVER_URL, port, ENV == "dev")
    uvicorn.run("main:app", host=SERVER_URL, port=port, reload=(ENV == "dev"))
