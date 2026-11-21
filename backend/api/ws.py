"""WebSocket endpoints for real-time events and PixiJS binary frame streaming."""

from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.dependencies import ServiceContainer
from app.logging_config import get_logger

logger = get_logger("api.ws")

router = APIRouter(tags=["websocket"])


def _verify_ws_token(ws: WebSocket, expected_token: str) -> bool:
    if not expected_token:
        return True
    token = ws.query_params.get("token") or ws.headers.get("x-amcs-token")
    return token == expected_token


@router.websocket("/ws/events")
async def ws_events(ws: WebSocket) -> None:
    services: ServiceContainer = ws.app.state.services
    if not _verify_ws_token(ws, services.config.auth_token):
        await ws.close(code=4401, reason="Unauthorized")
        return

    await services.ws_hub.register_event_client(ws)
    try:
        await ws.send_json(
            {
                "type": "connected",
                "payload": {
                    "pixi_render_worker_connected": services.ws_hub.has_pixi_render_worker,
                },
            }
        )
        while True:
            # Keep-alive ping/pong or client acks
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        services.ws_hub.unregister_event_client(ws)


@router.websocket("/ws/render-worker")
async def ws_render_worker(ws: WebSocket) -> None:
    services: ServiceContainer = ws.app.state.services
    if not _verify_ws_token(ws, services.config.auth_token):
        await ws.close(code=4401, reason="Unauthorized")
        return

    await services.ws_hub.register_render_worker(ws)
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "chunk_error":
                payload = msg.get("payload", {})
                session = services.ws_hub.get_chunk_session(
                    payload.get("job_id", ""), payload.get("chunk_id", "")
                )
                if session:
                    session.failed_error = payload.get("error", "Unknown PixiJS render error")
                    session.connected.set()
                    await session.frame_queue.put(None)
    except WebSocketDisconnect:
        pass
    finally:
        await services.ws_hub.unregister_render_worker(ws)


@router.websocket("/ws/render-stream/{job_id}/{chunk_id}")
async def ws_render_stream(ws: WebSocket, job_id: str, chunk_id: str) -> None:
    services: ServiceContainer = ws.app.state.services
    if not _verify_ws_token(ws, services.config.auth_token):
        await ws.close(code=4401, reason="Unauthorized")
        return

    session = services.ws_hub.get_chunk_session(job_id, chunk_id)
    if not session:
        await ws.close(code=4404, reason="Chunk session not found")
        return

    await ws.accept()
    session.connected.set()
    frames_count = 0
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if "bytes" in message and message["bytes"] is not None:
                await session.frame_queue.put(message["bytes"])
                frames_count += 1
                # Backpressure acknowledgment every 2 frames so renderer never outpaces FFmpeg
                if frames_count % 2 == 0:
                    await ws.send_json({"type": "ack", "frames": frames_count})
            elif "text" in message and message["text"]:
                import json

                data = json.loads(message["text"])
                if data.get("type") == "chunk_done":
                    await session.frame_queue.put(None)
                    await ws.send_json({"type": "done_ack", "frames": frames_count})
                    break
                if data.get("type") == "chunk_error":
                    session.failed_error = data.get("error", "Renderer error")
                    await session.frame_queue.put(None)
                    break
    except WebSocketDisconnect:
        if frames_count < session.expected_frames and not session.failed_error:
            session.failed_error = "PixiJS render stream disconnected unexpectedly"
        await session.frame_queue.put(None)
    except Exception as exc:
        logger.exception("Error on render stream %s/%s", job_id, chunk_id)
        session.failed_error = str(exc)
        await session.frame_queue.put(None)
