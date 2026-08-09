/** @vitest-environment jsdom */
/** The shared splitter drag, including the ways a gesture can END.
 *
 * The Inspector's width handle and the graph dock's height handle had grown
 * identical copies of this wiring, and both cleared their "dragging" flag
 * only on `pointerup`. A gesture that ends any other way - `pointercancel`
 * from a system touch gesture, or a lost pointer capture when the window
 * changes - never reached that line, so the flag stayed set and from then
 * on merely MOVING the mouse across the handle went on resizing the panel
 * with no button held. The graph canvas ten lines below already handled
 * pointercancel, so the two halves of one panel disagreed about the same
 * gesture.
 *
 * jsdom has no pointer capture, so `setPointerCapture` is stubbed to throw
 * on demand: that is also a real case (the pointer can be gone by the time
 * the handler runs) and the wiring must survive it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { splitterDrag } from "../src/ui/dom";

function makeSplitter(opts: { captureThrows?: boolean } = {}) {
  const el = document.createElement("div");
  el.setPointerCapture = opts.captureThrows
    ? () => { throw new DOMException("gone", "NotFoundError"); }
    : () => {};
  el.releasePointerCapture = () => {};
  document.body.append(el);
  const moves: number[] = [];
  const commits: number[] = [];
  splitterDrag(el, (e) => moves.push(e.clientX), () => commits.push(moves.length));
  return { el, moves, commits };
}

/** A PointerEvent jsdom will dispatch (it has no PointerEvent of its own). */
function pointer(type: string, clientX: number): Event {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, "clientX", { value: clientX });
  Object.defineProperty(e, "pointerId", { value: 1 });
  return e;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("splitterDrag", () => {
  it("does nothing until a drag has started", () => {
    const { el, moves } = makeSplitter();
    el.dispatchEvent(pointer("pointermove", 400));
    expect(moves).toEqual([]);
  });

  it("reports each move while the drag is live", () => {
    const { el, moves } = makeSplitter();
    el.dispatchEvent(pointer("pointerdown", 900));
    el.dispatchEvent(pointer("pointermove", 800));
    el.dispatchEvent(pointer("pointermove", 700));
    expect(moves).toEqual([800, 700]);
  });

  it("commits once when the drag ends normally", () => {
    const { el, commits } = makeSplitter();
    el.dispatchEvent(pointer("pointerdown", 900));
    el.dispatchEvent(pointer("pointermove", 800));
    el.dispatchEvent(pointer("pointerup", 800));
    expect(commits).toEqual([1]);
  });

  it("stops resizing after a CANCELLED drag", () => {
    // the bug: pointercancel left the flag set, so the next hover resized
    const { el, moves } = makeSplitter();
    el.dispatchEvent(pointer("pointerdown", 900));
    el.dispatchEvent(pointer("pointermove", 800));
    el.dispatchEvent(pointer("pointercancel", 800));
    el.dispatchEvent(pointer("pointermove", 300)); // a plain hover afterwards
    expect(moves).toEqual([800]);
  });

  it("stops resizing after capture is lost", () => {
    const { el, moves } = makeSplitter();
    el.dispatchEvent(pointer("pointerdown", 900));
    el.dispatchEvent(pointer("pointermove", 800));
    el.dispatchEvent(pointer("lostpointercapture", 800));
    el.dispatchEvent(pointer("pointermove", 300));
    expect(moves).toEqual([800]);
  });

  it("commits exactly once however the gesture ends", () => {
    // pointerup is followed by lostpointercapture in a real browser, and
    // the end handler must be idempotent or the size is saved twice
    const { el, commits } = makeSplitter();
    el.dispatchEvent(pointer("pointerdown", 900));
    el.dispatchEvent(pointer("pointermove", 800));
    el.dispatchEvent(pointer("pointerup", 800));
    el.dispatchEvent(pointer("lostpointercapture", 800));
    expect(commits).toHaveLength(1);
  });

  it("never commits for a gesture that never started", () => {
    const { el, commits } = makeSplitter();
    el.dispatchEvent(pointer("pointerup", 800));
    el.dispatchEvent(pointer("pointercancel", 800));
    expect(commits).toEqual([]);
  });

  it("survives a pointer that is already gone at capture time", () => {
    // setPointerCapture throws if the pointer has been released between the
    // event firing and the handler running; uncaught, that aborted the
    // gesture's setup and left the flag set with no capture to release
    const { el, moves, commits } = makeSplitter({ captureThrows: true });
    expect(() => el.dispatchEvent(pointer("pointerdown", 900))).not.toThrow();
    el.dispatchEvent(pointer("pointermove", 800));
    el.dispatchEvent(pointer("pointerup", 800));
    expect(moves).toEqual([800]);
    expect(commits).toEqual([1]);
  });

  it("can drag again after a cancelled one", () => {
    const { el, moves } = makeSplitter();
    el.dispatchEvent(pointer("pointerdown", 900));
    el.dispatchEvent(pointer("pointercancel", 900));
    el.dispatchEvent(pointer("pointerdown", 500));
    el.dispatchEvent(pointer("pointermove", 450));
    expect(moves).toEqual([450]);
  });

  it("is an ARIA separator with bounded keyboard resizing", () => {
    const el = document.createElement("div");
    let value = 300;
    let commits = 0;
    const syncAria = splitterDrag(el, () => {}, () => { commits++; }, {
      orientation: "vertical",
      label: "Resize Inspector",
      getValue: () => value,
      setValue: (next) => { value = next; },
      min: 240,
      max: 620,
      increaseKeys: ["ArrowLeft"],
      decreaseKeys: ["ArrowRight"],
    });
    expect(el.getAttribute("role")).toBe("separator");
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.getAttribute("aria-valuenow")).toBe("300");

    // Owners can reveal a pane that was hidden during construction and
    // resynchronise the value against its real laid-out size.
    value = 360;
    syncAria();
    expect(el.getAttribute("aria-valuenow")).toBe("360");

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(value).toBe(370);
    el.dispatchEvent(new KeyboardEvent("keydown",
      { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    expect(value).toBe(402);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(value).toBe(240);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(value).toBe(620);
    expect(el.getAttribute("aria-valuenow")).toBe("620");
    expect(commits).toBe(4);
  });
});
