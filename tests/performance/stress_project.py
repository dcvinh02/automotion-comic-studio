"""Phase 09.2 — Deterministic large-project generator for performance tests and benchmarks.

Builds a realistic stress project inside a *temporary* workspace (never a real user project):
40 scenes × (3 rigged characters + 4 props + 2 shots), 200 library images, ~7–8k keyframes,
animation clips, 4 audio tracks with ~160 clips, ~200 Vietnamese subtitle cues.
"""

from __future__ import annotations

import io
import random

from PIL import Image

from conftest import make_test_wav
from schemas.character import CharacterCreateRequest, CharacterPartSlot
from schemas.common import CameraState, Transform2D
from schemas.project import ProjectCreateRequest
from schemas.scene import Scene, SceneCharacterInstance, SceneShot, ScenePropInstance, ShotCharacterState
from schemas.sound import SoundLicense
from schemas.subtitle import SubtitleSegment
from schemas.timeline import CharacterAnimationClip, Keyframe, ProceduralAnimationConfig, SoundEffectEvent, TimelineTrack

PART_ROLES = [("body", None), ("head", "body"), ("left_arm", "body"), ("right_arm", "body"),
              ("left_leg", "body"), ("right_leg", "body"), ("eyes", "head"), ("mouth", "head")]


def _png(w: int, h: int, seed: int) -> bytes:
    rnd = random.Random(seed)
    img = Image.new("RGBA", (w, h), (rnd.randint(0, 255), rnd.randint(0, 255), rnd.randint(0, 255), 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def build_stress_project(services, *, scenes: int = 40, scene_ms: int = 10_000, chars_per_scene: int = 3,
                         props_per_scene: int = 4, kf_per_property: int = 10, assets: int = 200, seed: int = 7):
    rnd = random.Random(seed)
    A = services.asset_service
    asset_ids = [
        A.import_image_bytes(data=_png(256 if i % 10 else 1024, 256 if i % 10 else 576, i), original_filename=f"a{i}.png",
                             name=f"Tài nguyên {i}", asset_type="prop", folder="stress").asset_id
        for i in range(assets)
    ]
    characters = []
    for c in range(4):
        parts = [
            CharacterPartSlot(slot_id=role, name=role, part_role=role, parent_slot_id=parent, default_asset_id=asset_ids[(c * 8 + j) % assets],
                              variants=({"open": asset_ids[1], "closed": asset_ids[2]} if role == "eyes" else
                                        {"closed": asset_ids[3], "open": asset_ids[4]} if role == "mouth" else {}),
                              z_index=j, default_transform=Transform2D(x=0, y=-40 * (j % 3)))
            for j, (role, parent) in enumerate(PART_ROLES)
        ]
        characters.append(A.create_character(CharacterCreateRequest(name=f"Nhân vật {c}", identity_confirmed=True, parts=parts)))

    st = services.project_repo.create_project(ProjectCreateRequest(name="Stress 09.2", width=1920, height=1080, fps=30, duration_ms=scenes * scene_ms))
    pid = st.meta.project_id
    tracks = [TimelineTrack(track_id=f"trk_audio_{t}", project_id=pid, track_type=tt, name=f"{tt} {t}")
              for t, tt in enumerate(("voice", "sfx", "bgm", "ambient"))]
    st.timeline.tracks.extend(tracks)
    kfs: list[Keyframe] = []
    clips: list[CharacterAnimationClip] = []
    scenes_out: list[Scene] = []
    for s in range(scenes):
        sid = f"sc_{s:03d}"
        start = s * scene_ms
        chars = [SceneCharacterInstance(instance_id=f"{sid}_ch{c}", scene_id=sid, character_id=characters[(s + c) % 4].character_id,
                                        display_name=f"NV {c}", z_index=10 + c, initial_transform=Transform2D(x=300 + c * 500, y=700))
                 for c in range(chars_per_scene)]
        props = [ScenePropInstance(prop_instance_id=f"{sid}_pr{p}", asset_id=asset_ids[(s * 4 + p) % assets], name=f"Đạo cụ {p}",
                                   z_index=5 + p, transform=Transform2D(x=200 + p * 400, y=400))
                 for p in range(props_per_scene)]
        shots = [SceneShot(shot_id=f"{sid}_sh{h}", scene_id=sid, shot_order=h + 1, title=f"Cú {h + 1}", start_ms=h * scene_ms // 2,
                           duration_ms=scene_ms // 2, camera_default=CameraState(zoom=1.0 + 0.1 * h),
                           character_states=[ShotCharacterState(instance_id=ch.instance_id, character_id=ch.character_id, display_name=ch.display_name,
                                                                transform=Transform2D(x=ch.initial_transform.x + 40 * h, y=700)) for ch in chars])
                 for h in range(2)]
        scenes_out.append(Scene(scene_id=sid, project_id=pid, order_index=s, name=f"Cảnh {s + 1}", start_ms=start, duration_ms=scene_ms,
                                background_asset_id=asset_ids[(s * 7) % assets], characters=chars, props=props, shots=shots,
                                transition_in="fade" if s % 3 == 0 else "cut"))
        for ch in chars:
            for prop in ("x", "y", "rotation_deg", "scale_x"):
                for k in range(kf_per_property):
                    kfs.append(Keyframe(keyframe_id=f"kf_{ch.instance_id}_{prop}_{k}", track_id="trk_x", target_type="character_instance",
                                        target_id=ch.instance_id, property=prop, time_ms=start + k * scene_ms // kf_per_property,
                                        value=rnd.uniform(0.8, 1.2) if prop == "scale_x" else rnd.uniform(-200, 1600)))
            for part in ("head", "right_arm"):
                for k in range(kf_per_property // 2):
                    kfs.append(Keyframe(keyframe_id=f"kf_{ch.instance_id}_{part}_{k}", track_id="trk_x", target_type="character_part",
                                        target_id=f"{ch.instance_id}:{part}", property="rotation_deg", time_ms=start + k * scene_ms * 2 // kf_per_property,
                                        value=rnd.uniform(-30, 30)))
            clips.append(CharacterAnimationClip(clip_id=f"clip_{ch.instance_id}", track_id="trk_x", instance_id=ch.instance_id, start_ms=start,
                                                end_ms=start + scene_ms, animation_state=rnd.choice(["IDLE", "WALKING", "SPEAKING", "RUNNING"]),
                                                procedural=ProceduralAnimationConfig()))
        for pr in props:
            for k in range(kf_per_property // 2):
                kfs.append(Keyframe(keyframe_id=f"kf_{pr.prop_instance_id}_{k}", track_id="trk_x", target_type="prop", target_id=pr.prop_instance_id,
                                    property="x", time_ms=start + k * scene_ms * 2 // kf_per_property, value=rnd.uniform(0, 1900)))
        for k in range(4):
            kfs.append(Keyframe(keyframe_id=f"kf_cam_{s}_{k}", track_id="trk_x", target_type="camera", target_id="camera", property="zoom",
                                time_ms=start + k * scene_ms // 4, value=1.0 + rnd.uniform(0, 0.5)))
    st.scenes = scenes_out
    st.timeline.keyframes = kfs
    st.timeline.animation_clips = clips
    st.timeline.total_duration_ms = scenes * scene_ms
    sounds = [services.sound_service.import_sound_bytes(data=make_test_wav(0.4, 300 + 50 * i), original_filename=f"s{i}.wav", name=f"Âm {i}",
                                                       category="ui", license_info=SoundLicense(source="user_imported", usage="verified")) for i in range(8)]
    st.timeline.sound_events = [
        SoundEffectEvent(event_id=f"ev_{s}_{t}", track_id=tracks[t].track_id, sound_id=sounds[(s + t) % 8].sound_id,
                         start_ms=s * scene_ms + t * 1500, end_ms=s * scene_ms + t * 1500 + 400, source_scene_id=f"sc_{s:03d}")
        for s in range(scenes) for t in range(4)
    ]
    st.subtitles.segments = [
        SubtitleSegment(subtitle_id=f"sub_{s}_{i}", text=f"Lời thoại {i + 1} của cảnh {s + 1} — tiếng Việt có dấu.", start_ms=s * scene_ms + i * 2000,
                        end_ms=s * scene_ms + i * 2000 + 1800, scene_id=f"sc_{s:03d}")
        for s in range(scenes) for i in range(5)
    ]
    return services.project_repo.save_project_state(st), characters
