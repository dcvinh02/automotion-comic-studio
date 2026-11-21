"""Phase 09.1 — Preview (frontend evaluator.ts) vs Final Render (SoftwareCompositor) parity.

The editor preview evaluates scenes with `frontend/src/engine/evaluator.ts`; the software render
path evaluates them with `SoftwareCompositor.evaluate_stage()`. This test bundles the *real*
TypeScript evaluator with the project's esbuild, runs it in Node on the same project state, and
requires both evaluations to agree field-by-field (transforms, procedural animation, blinking,
expressions/poses, variants, shot isolation, camera, props, fades) at many timestamps.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app.config import AppConfig
from app.dependencies import build_services
from conftest import make_test_png
from core.render_engine.software_compositor import SoftwareCompositor
from schemas.character import CharacterCreateRequest, CharacterPartSlot, ExpressionPreset, PartialTransform2D, PosePreset
from schemas.common import CameraState, Transform2D
from schemas.project import ProjectCreateRequest
from schemas.scene import Scene, SceneCharacterInstance, SceneExecutionMeta, SceneShot, ScenePropInstance, ShotCharacterState, ShotPropState
from schemas.timeline import CharacterAnimationClip, Keyframe, ProceduralAnimationConfig

REPO = Path(__file__).resolve().parents[2]
FRONTEND = REPO / "frontend"
ESBUILD = FRONTEND / "node_modules" / ".bin" / "esbuild"

ENTRY = """
import { readFileSync } from 'node:fs';
import { evaluateStageAtFrame } from '@/engine/evaluator';
const input = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const chars = Object.fromEntries(input.characters.map((c) => [c.character_id, c]));
const out = input.times.map((t) => {
  const ev = evaluateStageAtFrame(input.state, chars, (t * input.fps) / 1000, input.fps);
  return {
    timeMs: ev.timeMs,
    scene_id: ev.scene ? ev.scene.scene_id : null,
    shot_id: ev.activeShot ? ev.activeShot.shot_id : null,
    effectiveBackgroundAssetId: ev.effectiveBackgroundAssetId ?? null,
    effectiveBackgroundColor: ev.effectiveBackgroundColor,
    fadeAlpha: ev.fadeAlpha,
    camera: ev.camera,
    props: ev.props,
    characters: ev.characters,
  };
});
process.stdout.write(JSON.stringify(out));
"""


def _close(a, b, path: str, errors: list[str]) -> None:
    if isinstance(a, dict) and isinstance(b, dict):
        for k in a.keys() & b.keys():
            _close(a[k], b[k], f"{path}.{k}", errors)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            errors.append(f"{path}: length {len(a)} != {len(b)}")
            return
        for i, (x, y) in enumerate(zip(a, b)):
            _close(x, y, f"{path}[{i}]", errors)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        if abs(float(a) - float(b)) > 1e-6:
            errors.append(f"{path}: preview={a} render={b}")
    elif a != b:
        errors.append(f"{path}: preview={a!r} render={b!r}")


@pytest.mark.skipif(not ESBUILD.exists() or shutil.which("node") is None, reason="node/esbuild not available")
def test_preview_and_render_evaluate_identical_scene_state(tmp_path: Path):
    services = build_services(AppConfig(workspace_dir=tmp_path / "ws"))
    A = services.asset_service
    img = lambda name: A.import_image_bytes(data=make_test_png(32, 32), original_filename=f"{name}.png", name=name, asset_type="character_part", folder="t").asset_id  # noqa: E731
    ids = {n: img(n) for n in ("body", "head", "arm_l", "arm_r", "leg_l", "leg_r", "eyes_open", "eyes_closed", "mouth_closed", "mouth_open", "mouth_smile", "prop_a", "prop_b", "bg1", "bg2")}
    slot = lambda sid, role, asset, parent=None, z=0, variants=None, tf=None: CharacterPartSlot(  # noqa: E731
        slot_id=sid, name=sid, part_role=role, parent_slot_id=parent, default_asset_id=asset, variants=variants or {}, z_index=z,
        default_transform=tf or Transform2D(x=0, y=0),
    )
    hero = A.create_character(CharacterCreateRequest(
        name="Minh", identity_confirmed=True,
        parts=[
            slot("body", "body", ids["body"], z=10),
            slot("head", "head", ids["head"], "body", 20, tf=Transform2D(x=0, y=-120)),
            slot("arm_l", "left_arm", ids["arm_l"], "body", 5, tf=Transform2D(x=-40, y=-60, rotation_deg=8)),
            slot("arm_r", "right_arm", ids["arm_r"], "body", 15, tf=Transform2D(x=40, y=-60)),
            slot("leg_l", "left_leg", ids["leg_l"], "body", 4, tf=Transform2D(x=-20, y=60)),
            slot("leg_r", "right_leg", ids["leg_r"], "body", 4, tf=Transform2D(x=20, y=60)),
            slot("eyes", "eyes", ids["eyes_open"], "head", 30, {"open": ids["eyes_open"], "closed": ids["eyes_closed"]}),
            slot("mouth", "mouth", ids["mouth_closed"], "head", 31, {"closed": ids["mouth_closed"], "open": ids["mouth_open"], "smile": ids["mouth_smile"]}),
        ],
        expressions=[ExpressionPreset(
            expression_id="happy", name="Happy", slot_variant_overrides={"mouth": "smile"},
            slot_transform_overrides={"head": PartialTransform2D(rotation_deg=6.0, opacity=0.8)},
        )],
        poses=[PosePreset(pose_id="point", name="Point", slot_transforms={"arm_r": PartialTransform2D(rotation_deg=-70.0, opacity=0.9)})],
    ))

    st = services.project_repo.create_project(ProjectCreateRequest(name="Parity", width=1280, height=720, fps=30, duration_ms=6000))
    pid = st.meta.project_id
    st.scenes = [
        Scene(
            scene_id="sc1", project_id=pid, order_index=0, name="One", start_ms=0, duration_ms=3000,
            background_asset_id=ids["bg1"], camera_default=CameraState(x=10, y=-5, zoom=1.2),
            characters=[
                SceneCharacterInstance(instance_id="inst_minh", scene_id="sc1", character_id=hero.character_id, display_name="Minh",
                                       initial_transform=Transform2D(x=400, y=500, scale_x=0.9, scale_y=0.9), default_expression_id="happy"),
                SceneCharacterInstance(instance_id="inst_extra", scene_id="sc1", character_id=hero.character_id, display_name="Extra",
                                       initial_transform=Transform2D(x=900, y=500), z_index=12),
            ],
            props=[
                ScenePropInstance(prop_instance_id="p_parent", asset_id=ids["prop_a"], name="Table", transform=Transform2D(x=600, y=600, rotation_deg=15, scale_x=1.5, scale_y=1.5)),
                ScenePropInstance(prop_instance_id="p_child", asset_id=ids["prop_a"], name="Cup", parent_id="p_parent", transform=Transform2D(x=20, y=-30, opacity=0.5)),
                ScenePropInstance(prop_instance_id="p_owned", asset_id=ids["prop_a"], name="Sign", transform=Transform2D(x=100, y=100)),
            ],
            shots=[
                SceneShot(shot_id="sh_a", scene_id="sc1", shot_order=1, start_ms=0, duration_ms=1500, camera_default=CameraState(x=0, y=0, zoom=1.0),
                          character_states=[ShotCharacterState(instance_id="inst_minh", character_id=hero.character_id, display_name="Minh",
                                                               transform=Transform2D(x=420, y=510), animation_state="WALKING", expression_id=None)],
                          prop_states=[ShotPropState(prop_instance_id="p_owned", asset_id=ids["prop_b"], name="Sign", visible=True, transform=Transform2D(x=150, y=120))]),
                SceneShot(shot_id="sh_b", scene_id="sc1", shot_order=2, start_ms=1500, duration_ms=1500, background_color="#223344",
                          character_states=[ShotCharacterState(instance_id="inst_minh", character_id=hero.character_id, display_name="Minh",
                                                               transform=Transform2D(x=700, y=510), pose_id="point", visible=True)],
                          prop_states=[ShotPropState(prop_instance_id="p_owned", name="Sign", visible=False)]),
            ],
            execution_meta=SceneExecutionMeta(executed=True, owned_character_instance_ids=["inst_minh"], owned_prop_instance_ids=["p_owned"]),
        ),
        Scene(scene_id="sc2", project_id=pid, order_index=1, name="Two", start_ms=3000, duration_ms=3000, background_asset_id=ids["bg2"],
              transition_in="fade", transition_duration_ms=600,
              characters=[SceneCharacterInstance(instance_id="inst_b", scene_id="sc2", character_id=hero.character_id, display_name="B",
                                                 initial_transform=Transform2D(x=640, y=480))]),
    ]
    trk = st.timeline.tracks[0].track_id
    proc = ProceduralAnimationConfig(auto_blink=True, blink_interval_ms=700, blink_duration_ms=150, breathing=True)
    st.timeline.animation_clips = [
        CharacterAnimationClip(clip_id="c1", track_id=trk, instance_id="inst_extra", start_ms=0, end_ms=1600, animation_state="RUNNING", procedural=proc),
        CharacterAnimationClip(clip_id="c2", track_id=trk, instance_id="inst_extra", start_ms=1600, end_ms=3000, animation_state="SURPRISED", procedural=proc),
        CharacterAnimationClip(clip_id="c3", track_id=trk, instance_id="inst_minh", start_ms=0, end_ms=3000, animation_state="IDLE", procedural=proc),
        CharacterAnimationClip(clip_id="c4", track_id=trk, instance_id="inst_b", start_ms=3000, end_ms=6000, animation_state="WALKING", procedural=proc),
    ]
    k = lambda kid, tt, tid, prop, t, v, e="ease_in_out": Keyframe(keyframe_id=kid, track_id=trk, target_type=tt, target_id=tid, property=prop, time_ms=t, value=v, easing=e)  # noqa: E731
    st.timeline.keyframes = [
        k("k1", "character_instance", "inst_extra", "x", 0, 900.0), k("k2", "character_instance", "inst_extra", "x", 2000, 300.0, "linear"),
        k("k3", "camera", "camera", "zoom", 3000, 1.0), k("k4", "camera", "camera", "zoom", 6000, 1.6, "ease_out"),
        k("k5", "character_part", "inst_b:arm_r", "rotation_deg", 3000, 0.0), k("k6", "character_part", "inst_b:arm_r", "rotation_deg", 5000, 45.0),
        k("k7", "character_instance", "inst_b", "mouth_state", 4000, "open", "step"),
        k("k8", "prop", "p_parent", "rotation_deg", 0, 15.0), k("k9", "prop", "p_parent", "rotation_deg", 3000, 75.0, "cubic_bezier"),
        k("k10", "character_instance", "inst_b", "opacity", 3000, 0.2), k("k11", "character_instance", "inst_b", "opacity", 4000, 1.0),
    ]
    st.timeline.keyframes[8] = st.timeline.keyframes[8].model_copy(update={"bezier_handles": (0.2, 0.9, 0.3, 0.1)})
    st.scenes[0].shots[0].animation_refs = ["k1"]  # owned by shot A → must not leak into shot B
    services.project_repo.save_project_state(st)
    st = services.project_repo.get_project_state(pid)

    times = [0, 33.3, 250, 400, 700, 1000, 1499, 1500, 1520, 1650, 1700, 1900, 2333, 2999, 3000, 3100, 3300, 3599, 3999, 4000, 4500, 5000, 5999]
    fps = 30
    work = tmp_path / "parity"
    work.mkdir()
    (work / "entry.ts").write_text(ENTRY, encoding="utf-8")
    (work / "input.json").write_text(json.dumps({
        "state": json.loads(st.model_dump_json()),
        "characters": [json.loads(services.library_repo.get_character(hero.character_id).model_dump_json())],
        "times": times,
        "fps": fps,
    }), encoding="utf-8")
    bundle = work / "entry.cjs"
    b = subprocess.run(
        [str(ESBUILD), str(work / "entry.ts"), "--bundle", "--platform=node", "--format=cjs", f"--outfile={bundle}",
         f"--alias:@={FRONTEND / 'src'}", "--log-level=error"],
        capture_output=True, text=True, cwd=FRONTEND,
    )
    assert b.returncode == 0, b.stderr
    r = subprocess.run(["node", str(bundle), str(work / "input.json")], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    preview = json.loads(r.stdout)

    comp = SoftwareCompositor(library_repo=services.library_repo, asset_service=services.asset_service, state=st, width=1280, height=720, fps=fps)
    errors: list[str] = []
    blinks = {"preview": 0, "render": 0}
    for t, pv in zip(times, preview):
        rv = comp.evaluate_stage(pv["timeMs"])
        _close(pv, rv, f"t={t}", errors)
        blinks["preview"] += sum(c["auto_blink_closed"] for c in pv["characters"])
        blinks["render"] += sum(c["auto_blink_closed"] for c in rv["characters"])
    assert not errors, "Preview/render divergence:\n" + "\n".join(errors[:40])
    # Sanity: the fixture really exercised the dynamic behaviours
    assert blinks["preview"] > 0
    flat = json.dumps(preview)
    assert '"animation_state": "RUNNING"' in flat.replace('":"', '": "') or "RUNNING" in flat
    assert any(c["parts"] and abs(c["parts"][2]["transform"]["rotation_deg"] - 8) > 1 for f in preview for c in f["characters"] if c["instance_id"] == "inst_extra")
