"""Structured Script Engine helpers (duration estimation & non-destructive document helpers)."""

from __future__ import annotations

from schemas.script import ScriptDocument, ScriptEntry, ScriptScene


def estimate_entry_duration_ms(entry: ScriptEntry) -> int:
    """Estimate line duration cleanly from text length + pauses (uses real audio duration when available)."""
    if entry.audio_duration_ms and entry.audio_duration_ms > 0:
        return entry.pause_before_ms + entry.audio_duration_ms + entry.pause_after_ms
    words = len(entry.text.strip().split())
    if entry.entry_type == "action":
        speech_ms = max(1000, words * 220)
    else:
        # ~155 words/minute (~385ms per word), minimum 1.0s
        speech_ms = max(1000, int(words * 385)) if words > 0 else 1000
    return entry.pause_before_ms + speech_ms + entry.pause_after_ms


def recalculate_script_durations(doc: ScriptDocument) -> ScriptDocument:
    """Recompute estimated_duration_ms on scenes and entries without modifying user text."""
    for s_idx, scene in enumerate(doc.scenes):
        scene.order_index = s_idx
        total = 0
        for e_idx, entry in enumerate(scene.entries):
            entry.order_index = e_idx
            entry.estimated_duration_ms = estimate_entry_duration_ms(entry)
            total += entry.estimated_duration_ms
        scene.estimated_duration_ms = total
    return doc
