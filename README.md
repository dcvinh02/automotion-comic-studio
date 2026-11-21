# AutoMotion Comic Studio

**AI-Powered 2D Motion Comic Production Desktop Application** (Version 0.1 — Core Animation Engine).

Built strictly according to Master Technical Specification v2.0 (`Kiến trúc nền tảng.rtf`):
- **Frontend:** Electron + React + TypeScript + PixiJS v8 (WebGL) + Zustand
- **Backend:** Python 3.12 + FastAPI + Pydantic v2 + SQLite (WAL) + WebSocket + Background Job Queue
- **Media:** FFmpeg / FFprobe chunked hardware-accelerated H.264 + AAC SFX mixing pipeline

## Quick Start

### 1. Backend Setup (Python 3.12 via `uv`)
```bash
cd backend
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e ".[dev]"
```

### 2. Frontend Setup (Node.js + Electron)
```bash
cd frontend
npm install
npm run build
```

### 3. Run Desktop Application
```bash
cd frontend
npm run dev
```

### 4. Run Test Suites
```bash
# Backend Unit + Integration + End-to-End 30s MP4 Render Tests
cd backend && .venv/bin/pytest -c pyproject.toml -v

# Frontend Deterministic Evaluator Unit Tests
cd frontend && npm test
```

See [docs/USER_GUIDE_v0.1.md](docs/USER_GUIDE_v0.1.md) for the complete user guide.
