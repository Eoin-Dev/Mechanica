"""World snapshots: undo/redo history, reset-to-start, and JSON save/load."""
from __future__ import annotations

import json
import os

from mechanica.engine.world import World

SCENES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scenes")


def snapshot(world: World) -> str:
    return json.dumps(world.to_dict())


def restore(snap: str) -> World:
    return World.from_dict(json.loads(snap))


class UndoStack:
    """Snapshot-based undo/redo. Push after every committed edit."""

    LIMIT = 120

    def __init__(self, world: World) -> None:
        self._stack: list[str] = [snapshot(world)]
        self._index = 0

    def push(self, world: World) -> None:
        snap = snapshot(world)
        if snap == self._stack[self._index]:
            return
        del self._stack[self._index + 1:]
        self._stack.append(snap)
        if len(self._stack) > self.LIMIT:
            del self._stack[0]
        self._index = len(self._stack) - 1

    def reset(self, world: World) -> None:
        self._stack = [snapshot(world)]
        self._index = 0

    @property
    def can_undo(self) -> bool:
        return self._index > 0

    @property
    def can_redo(self) -> bool:
        return self._index < len(self._stack) - 1

    def undo(self) -> World | None:
        if not self.can_undo:
            return None
        self._index -= 1
        return restore(self._stack[self._index])

    def redo(self) -> World | None:
        if not self.can_redo:
            return None
        self._index += 1
        return restore(self._stack[self._index])


def save_scene(world: World, name: str) -> str:
    os.makedirs(SCENES_DIR, exist_ok=True)
    safe = "".join(ch for ch in name.strip() if ch.isalnum() or ch in " _-") or "scene"
    path = os.path.join(SCENES_DIR, f"{safe}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(world.to_dict(), fh, indent=1)
    return safe


def list_scenes() -> list[str]:
    if not os.path.isdir(SCENES_DIR):
        return []
    return sorted(os.path.splitext(f)[0] for f in os.listdir(SCENES_DIR)
                  if f.endswith(".json"))


def load_scene(name: str) -> World:
    path = os.path.join(SCENES_DIR, f"{name}.json")
    with open(path, encoding="utf-8") as fh:
        return World.from_dict(json.load(fh))
