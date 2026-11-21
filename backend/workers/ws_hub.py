"""WebSocket Hub for real-time job updates and Electron PixiJS render streaming."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any
from fastapi import WebSocket

from app.logging_config import get_logger

logger = get_logger("ws_hub")


@dataclass
class ChunkStreamSession:
    job_id: str
    chunk_id: str
    expected_frames: int
    frame_queue: asyncio.Queue[bytes | None] = field(default_factory=lambda: asyncio.Queue(maxsize=4))
    connected: asyncio.Event = field(default_factory=asyncio.Event)
    failed_error: str | None = None


class WebSocketHub:
    def __init__(self) -> None:
        self._event_clients: set[WebSocket] = set()
        self._render_worker_ws: WebSocket | None = None
        self._chunk_sessions: dict[str, ChunkStreamSession] = {}

    # --- Event Broadcast Clients ---

    async def register_event_client(self, ws: WebSocket) -> None:
        await ws.accept()
        self._event_clients.add(ws)
        logger.debug("WS event client connected (total=%d)", len(self._event_clients))

    def unregister_event_client(self, ws: WebSocket) -> None:
        self._event_clients.discard(ws)

    async def broadcast_event(self, event_type: str, payload: dict[str, Any]) -> None:
        message = {"type": event_type, "payload": payload}
        dead: list[WebSocket] = []
        for ws in list(self._event_clients):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._event_clients.discard(ws)

    # --- Electron Offscreen PixiJS Render Worker ---

    @property
    def has_pixi_render_worker(self) -> bool:
        return self._render_worker_ws is not None

    async def register_render_worker(self, ws: WebSocket) -> None:
        await ws.accept()
        self._render_worker_ws = ws
        logger.info("Electron PixiJS offscreen render worker connected")
        await self.broadcast_event("render_worker_status", {"connected": True})

    async def unregister_render_worker(self, ws: WebSocket) -> None:
        if self._render_worker_ws is ws:
            self._render_worker_ws = None
            logger.info("Electron PixiJS offscreen render worker disconnected")
            await self.broadcast_event("render_worker_status", {"connected": False})

    async def dispatch_render_chunk(self, payload: dict[str, Any]) -> bool:
        if self._render_worker_ws is None:
            return False
        try:
            await self._render_worker_ws.send_json({"type": "render_chunk", "payload": payload})
            return True
        except Exception as exc:
            logger.error("Failed to dispatch chunk to PixiJS worker: %s", exc)
            self._render_worker_ws = None
            return False

    async def send_cancel_render(self, job_id: str) -> None:
        if self._render_worker_ws is not None:
            try:
                await self._render_worker_ws.send_json({"type": "cancel_render", "payload": {"job_id": job_id}})
            except Exception:
                pass

    # --- Binary Chunk Frame Stream Sessions ---

    def open_chunk_session(self, job_id: str, chunk_id: str, expected_frames: int) -> ChunkStreamSession:
        key = f"{job_id}:{chunk_id}"
        session = ChunkStreamSession(job_id=job_id, chunk_id=chunk_id, expected_frames=expected_frames)
        self._chunk_sessions[key] = session
        return session

    def get_chunk_session(self, job_id: str, chunk_id: str) -> ChunkStreamSession | None:
        return self._chunk_sessions.get(f"{job_id}:{chunk_id}")

    def close_chunk_session(self, job_id: str, chunk_id: str) -> None:
        self._chunk_sessions.pop(f"{job_id}:{chunk_id}", None)
