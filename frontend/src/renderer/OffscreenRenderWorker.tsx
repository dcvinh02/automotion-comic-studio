import { useEffect, useState } from 'react';
import { Application } from 'pixi.js';
import { evaluateStageAtFrame } from '@/engine/evaluator';
import { apiClient } from '@/services/apiClient';
import type { Asset, Character, ProjectState } from '@/types/models';
import { PixiSceneGraph } from './PixiSceneGraph';
import { AssetTextureCache } from './textureCache';

interface RenderChunkRequest {
  job_id: string;
  chunk_id: string;
  start_frame: number;
  end_frame: number;
  width: number;
  height: number;
  fps: number;
  /** Phase 08 Batch 3: exact source-timeline time (ms) for each frame of this chunk. */
  frame_times_ms?: number[];
  burn_in_subtitles?: boolean;
  project_state: ProjectState;
  characters: Character[];
  assets: Asset[];
}

/**
 * Hidden Electron BrowserWindow entrypoint (?mode=render-worker).
 * Renders deterministic PixiJS v8 WebGL frames chunk-by-chunk and streams raw RGBA
 * buffers directly to the Python FFmpeg encoder over localhost binary WebSocket.
 */
export function OffscreenRenderWorker() {
  const [status, setStatus] = useState('Initializing offscreen PixiJS render worker...');

  useEffect(() => {
    let controlWs: WebSocket | null = null;
    let cancelledJobId: string | null = null;
    let closed = false;

    async function renderChunk(req: RenderChunkRequest): Promise<void> {
      const conn = apiClient.getConnection();
      const tokenQ = conn.token ? `?token=${encodeURIComponent(conn.token)}` : '';
      const streamUrl = `${conn.wsUrl}/ws/render-stream/${encodeURIComponent(req.job_id)}/${encodeURIComponent(req.chunk_id)}${tokenQ}`;

      await window.electronAPI?.setRenderActive(true);
      const textureCache = new AssetTextureCache();
      const app = new Application();

      try {
        await app.init({
          width: req.width,
          height: req.height,
          backgroundColor: 0x14161a,
          antialias: true,
          autoDensity: false,
          resolution: 1,
          preserveDrawingBuffer: true,
          preference: 'webgl',
        });

        // Preload all referenced asset textures before stepping frames
        const neededAssetIds = new Set<string>();
        for (const sc of req.project_state.scenes) {
          if (sc.background_asset_id) neededAssetIds.add(sc.background_asset_id);
          for (const p of sc.props) {
            if (p.asset_id) neededAssetIds.add(p.asset_id);
          }
        }
        for (const ch of req.characters) {
          for (const part of ch.parts) {
            if (part.default_asset_id) neededAssetIds.add(part.default_asset_id);
            for (const vid of Object.values(part.variants)) {
              neededAssetIds.add(vid);
            }
          }
        }

        await Promise.all(
          [...neededAssetIds].map((aid) => textureCache.load(aid, apiClient.getAssetFileUrl(aid))),
        );

        const charMap: Record<string, Character> = {};
        for (const c of req.characters) {
          charMap[c.character_id] = c;
        }

        const sceneGraph = new PixiSceneGraph(
          textureCache,
          req.project_state.meta.width,
          req.project_state.meta.height,
        );
        sceneGraph.root.scale.set(
          req.width / req.project_state.meta.width,
          req.height / req.project_state.meta.height,
        );
        app.stage.addChild(sceneGraph.root);

        // Connect binary stream socket
        const streamWs = await new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(streamUrl);
          ws.binaryType = 'arraybuffer';
          ws.onopen = () => resolve(ws);
          ws.onerror = () => reject(new Error('Failed to open binary render stream WebSocket'));
        });

        let ackResolve: (() => void) | null = null;
        let doneResolve: (() => void) | null = null;
        streamWs.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as { type: string };
            if (msg.type === 'ack' && ackResolve) {
              const fn = ackResolve;
              ackResolve = null;
              fn();
            } else if (msg.type === 'done_ack' && doneResolve) {
              const fn = doneResolve;
              doneResolve = null;
              fn();
            }
          } catch {
            // Ignore
          }
        };

        let sentFrames = 0;
        for (let frame = req.start_frame; frame <= req.end_frame; frame++) {
          if (cancelledJobId === req.job_id) {
            break;
          }
          // Scoped exports (scene / shot / range) map output frames to arbitrary source times.
          const srcMs = req.frame_times_ms?.[frame - req.start_frame];
          const evalFrame = srcMs !== undefined ? (srcMs * req.fps) / 1000 : frame;
          const evaluated = evaluateStageAtFrame(req.project_state, charMap, evalFrame, req.fps);
          sceneGraph.renderEvaluatedStage(evaluated, (aid) => apiClient.getAssetFileUrl(aid));
          if (req.burn_in_subtitles) {
            const subTrack = req.project_state.timeline.tracks.find((t) => t.track_type === 'subtitle');
            sceneGraph.renderSubtitles(
              req.project_state.subtitles,
              evaluated.timeMs,
              subTrack ? subTrack.visible !== false : true,
            );
          }
          app.renderer.render(app.stage);

          const extracted = app.renderer.extract.pixels(app.stage);
          const pixels = extracted.pixels;

          // Ensure exact W*H*4 RGBA buffer size
          const expectedBytes = req.width * req.height * 4;
          const payload =
            pixels.byteLength === expectedBytes
              ? pixels
              : pixels.subarray(0, expectedBytes);

          streamWs.send(payload);
          sentFrames += 1;

          if (sentFrames % 2 === 0) {
            await new Promise<void>((resolve) => {
              ackResolve = resolve;
              setTimeout(() => {
                if (ackResolve === resolve) {
                  ackResolve = null;
                  resolve();
                }
              }, 10000);
            });
          }
        }

        if (streamWs.readyState === WebSocket.OPEN) {
          streamWs.send(JSON.stringify({ type: 'chunk_done', frames: sentFrames }));
          await new Promise<void>((resolve) => {
            doneResolve = resolve;
            setTimeout(resolve, 3000);
          });
          streamWs.close();
        }
        setStatus(`Completed chunk ${req.chunk_id} (${sentFrames} frames)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`Chunk error: ${msg}`);
        if (controlWs && controlWs.readyState === WebSocket.OPEN) {
          controlWs.send(
            JSON.stringify({
              type: 'chunk_error',
              payload: { job_id: req.job_id, chunk_id: req.chunk_id, error: msg },
            }),
          );
        }
      } finally {
        textureCache.destroyAll();
        app.destroy(true, { children: true });
        await window.electronAPI?.setRenderActive(false);
      }
    }

    async function connectControl() {
      const conn = await apiClient.init();
      const tokenQ = conn.token ? `?token=${encodeURIComponent(conn.token)}` : '';
      const ws = new WebSocket(`${conn.wsUrl}/ws/render-worker${tokenQ}`);
      controlWs = ws;

      ws.onopen = () => {
        setStatus('Connected to backend — ready for PixiJS WebGL chunk renders.');
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            type: string;
            payload: Record<string, unknown>;
          };
          if (msg.type === 'render_chunk') {
            cancelledJobId = null;
            void renderChunk(msg.payload as unknown as RenderChunkRequest);
          } else if (msg.type === 'cancel_render') {
            cancelledJobId = String(msg.payload.job_id ?? '');
          }
        } catch {
          // Ignore
        }
      };

      ws.onclose = () => {
        if (!closed) {
          setStatus('Disconnected — retrying...');
          setTimeout(() => {
            void connectControl();
          }, 2000);
        }
      };
    }

    void connectControl();
    return () => {
      closed = true;
      controlWs?.close();
    };
  }, []);

  return (
    <div style={{ background: '#111215', color: '#949AA8', padding: 16, fontFamily: 'monospace', fontSize: 12 }}>
      <strong>AMCS PixiJS WebGL Offscreen Worker</strong>
      <p>{status}</p>
    </div>
  );
}
