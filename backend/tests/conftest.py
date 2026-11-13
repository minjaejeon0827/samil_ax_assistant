import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("API_KEYS", "test-key")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost:5173")
os.environ.setdefault("LLM_PROVIDER", "offline")


@pytest.fixture
def desk():
    from app.repo.memory import MemoryRepository
    from app.workflow.service import OpsDesk
    return OpsDesk(MemoryRepository())


@pytest.fixture(scope="session")
def engine():
    from app.domain.data import get_dataroom
    from app.domain.decision import DecisionEngine
    return DecisionEngine(get_dataroom())
