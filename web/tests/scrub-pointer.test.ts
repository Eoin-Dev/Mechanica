/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrubPointer } from "../src/ui/scrub-pointer";
let lock: Element | null = null;
function setup() {
  const handle = document.createElement("span"); document.body.append(handle);
  Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => lock });
  document.exitPointerLock = vi.fn(() => { lock = null; document.dispatchEvent(new Event("pointerlockchange")); });
  handle.requestPointerLock = vi.fn();
  const exit = vi.fn(), pointer = new ScrubPointer(handle, window.innerWidth - 3, 5, exit);
  return { handle, pointer, exit, grant: () => { lock = handle; document.dispatchEvent(new Event("pointerlockchange")); } };
}
afterEach(() => { lock = null; document.dispatchEvent(new Event("pointerlockchange")); document.body.replaceChildren(); vi.restoreAllMocks(); });
describe("continuous numeric scrubbing pointer ownership", () => {
  it("wraps only its display cursor, retains one cursor on repeated events and exits on finish", () => {
    const { handle, pointer, exit, grant } = setup();
    pointer.request(); pointer.request(); expect(handle.requestPointerLock).toHaveBeenCalledOnce();
    expect(pointer.acquiring).toBe(true); grant(); grant();
    expect(document.querySelectorAll(".numeric-scrub-cursor")).toHaveLength(1);
    pointer.move(10, -10);
    expect(document.querySelector<HTMLElement>(".numeric-scrub-cursor")!.style.transform)
      .toBe(`translate(7px, ${window.innerHeight - 5}px)`);
    pointer.finish(); expect(document.exitPointerLock).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled(); expect(document.querySelector(".numeric-scrub-cursor")).toBeNull();
  });
  it("releases a late grant after the gesture has ended", () => {
    const { pointer, grant, exit } = setup(); pointer.request(); pointer.finish(); grant();
    expect(document.exitPointerLock).toHaveBeenCalledOnce(); expect(exit).not.toHaveBeenCalled();
    expect(document.querySelector(".numeric-scrub-cursor")).toBeNull();
  });
  it("cancels the scrub once if the browser releases an owned lock", () => {
    const { pointer, grant, exit } = setup(); pointer.request(); grant();
    lock = null; document.dispatchEvent(new Event("pointerlockchange"));
    document.dispatchEvent(new Event("pointerlockchange"));
    expect(exit).toHaveBeenCalledOnce(); pointer.finish();
  });
  it("falls back cleanly after rejection and never removes another control's lock", () => {
    const { pointer, handle, exit } = setup();
    handle.requestPointerLock = vi.fn(() => { throw Error("Unsupported"); });
    pointer.request(); expect(pointer.active).toBe(false); expect(pointer.acquiring).toBe(false);
    expect(exit).not.toHaveBeenCalled(); lock = document.body; pointer.finish();
    expect(document.exitPointerLock).not.toHaveBeenCalled();
  });
});
