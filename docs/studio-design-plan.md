# Studio redesign: research and implementation plan

Status: isolated prototype under review. The pre-redesign baseline passed its
complete local release checks before implementation. The redesigned workspace
is undergoing repeated critique and verification; final release acceptance is
still pending.

## Product direction

Studio becomes a focused workspace for building, running and understanding a
mechanical system. The simulation is the primary surface. Tools, playback and
the Inspector form distinct, quiet layers around it. Preserve scientific
readouts, precise editing and discoverability as well as visual polish.

Apple's guidance informs the design; Mechanica remains a browser application
that works on Windows, macOS, phones and tablets. Use the platform's system font
and existing vector icons, with no downloaded Apple assets or native-window
imitations.

## Research translated into decisions

| Primary source | Application to Mechanica |
| --- | --- |
| [Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles) | Prioritise clarity, reversible actions, familiar interactions and preserved context. A visual simplification must retain useful controls. |
| [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) | Establish a strong simulation/control hierarchy, align related settings and adapt without clipping. Keep the scene large. |
| [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos) | Support precise input, keyboard workflows and comfortable information density. Avoid unnecessary modal steps. |
| [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) | Group playback, editing and document actions by purpose. Make the primary action easy to locate. Keep commands reachable in compact windows. |
| [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) | Use concise labels, shallow grouping and familiar symbols. Reduce peripheral width as the workspace narrows. |
| [Panels](https://developer.apple.com/design/human-interface-guidelines/panels) | Keep the Inspector contextual and clearly titled. Retain direct adjustments and the existing precise numeric editors. |
| [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | Use quiet neutral chrome and restrained depth, with opaque, readable settings and scientific content. Avoid stacking glass effects everywhere. |
| [Color](https://developer.apple.com/design/human-interface-guidelines/color) | Reserve accent for actions and selection. Preserve user accent choices and semantic force colours; validate every base theme. |
| [Fonts](https://developer.apple.com/documentation/technologyoverviews/fonts) | Use system-ui with platform fallbacks, clear typographic hierarchy and tabular scientific numbers. Preserve the dyslexia-friendly option. |
| [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | Verify text enlargement, contrast, keyboard navigation and alternatives to colour-only status. |
| [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) | Use brief feedback that explains a change. Avoid movement during precise editing and honour reduced motion. |
| [UI design tips](https://developer.apple.com/design/tips/) | Maintain ample touch targets, aligned controls, readable text and no horizontal page scrolling. |

## Critique of the existing Studio

1. Two separate blocks of Studio overrides compete in the stylesheet. The
   resulting appearance is difficult to reason about and refine consistently.
2. Tiny uppercase group labels and repeated borders give equal emphasis to
   secondary chrome and important scientific information.
3. Playback, editing and document commands share one horizontally overflowing
   strip. Their hierarchy becomes particularly weak on narrow screens.
4. The scene, tool rail, analysis dock and Inspector read as adjoining boxes.
   Their visual relationships need a coherent workspace composition.
5. Changes must address focus, enlarged text, selection states and touch input;
   screenshots at a single desktop size cannot establish usability.

## Proposed workspace

- A quiet document header with a concise Studio identity and grouped scene
  actions. Separate the playback cluster visually, keeping the clock and speed
  associated with transport and every existing shortcut intact.
- A generous simulation stage, a compact tool shelf with recognisable symbols
  and clear active feedback, and a contextual Inspector with stronger title
  hierarchy and a restrained segmented section switcher.
- An analysis dock that belongs to the stage, with a clear graph title and
  legible mode selection. Keep the current graph data, resizing and history.
- Consistent spacing, subtle separators, rounded controls, restrained shadows
  and a shared neutral material vocabulary. Use accent only where meaningful.
- Light, Dark and Void remain independent of Studio. Preserve all settings,
  scene data, physics, undo, saved work and the ordinary interface.

## Implementation and critique gates

1. Repair startup, tutorial and pulley rendering; run full baseline verification.
   Preserve reports and an exact source/build manifest before design work.
2. Prototype in an isolated copy of the verified checkout. Consolidate Studio
   styling and update shared DOM only where necessary for the new composition.
3. Review actual screenshots and interactions across desktop, laptop, tablet,
   phone and short windows, all themes, enlarged text and dyslexia-friendly text.
   Critique hierarchy, density, alignment, contrast, collisions and control access.
4. Fix each major finding and repeat the affected review. Include menus, Settings,
   Library, graph dock, tour, collapsed Inspector, resize and theme switching.
5. Validate keyboard focus, reduced motion, reduced transparency, increased
   contrast and touch targets. Keep relevant behavioral regressions; replace
   tests that merely lock in superseded styling details.
6. Promote only the completed verified design after checking the source checkout
   has not changed. Run strict types, production build, units/tooling, documentation,
   dependency audit, workflows, serial Chromium/Firefox/WebKit acceptance and
   subdirectory hosting checks against the final files.

A major finding is lost or inaccessible functionality, unreadable information,
clipped content, overlapping controls, unintended state changes or a failed
release gate. Record each critique and repair with supporting evidence. Passing
local checks does not claim a GitHub-hosted Linux run or deployment occurred.

After stability and redesign acceptance, provide a prioritised improvements
list with user benefit, scope and regression risk. Suggested features remain
proposals until selected for implementation.


## Critique and repair record

| Review | Finding | Repair and verification |
| --- | --- | --- |
| Initial composition | Repeated selected-object identity weakened Inspector hierarchy. | Contextual type heading precedes section tabs; the actual editable object name stays in content. |
| Enlarged-text matrix | A flex minimum pushed the speed group outside a 320px window; the brand collided with commands. | Permit content-aware wrapping and shrink the speed group's container. Repeat matrix and explicit collision checks passed in Chromium. |
| Tutorial review | At 200% text a card covered its referenced Inspector control completely. | Anchor the exact force toggle and size cards to the space beside each control. Target/card separation and retained scrolling passed in the repeat Chromium review. |
| Responsive keyboard review | Changing inline/popup layout needed explicit focus ownership. | Retain original controls, restore focused actions or group context, isolate popup keys and test resizing. |
| Content review | An enlarged routine greeting obscured much of the stage. | Studio omits that greeting; recovery, refresh and action feedback remain. Compact display diagnostics stay accessible in Scene actions. |
| Short-window scroll review | Repositioning briefly expanded the actions popup and reset its scroll position. | Keep the final height cap stable while scrolling; reopen at the first action. The 260px-high-window regression passed in Chromium, Firefox and WebKit. |
| Broad release review | The speed track shrank below its minimum at 320px with doubled text. | Scale its desktop reservation with text and place the track on a separate row on the smallest screens. |
| Broad interaction review | Reading `activeElement` during a focus gap dismissed the popup before an internal click completed. | Use the real focus destination. A live event trace and regression checks retain the action through the gap. |
| Verification review | Older flows clicked compact commands without opening their menu and read a deliberately culled offscreen readout. | Follow the visible menu and bring readouts into view, retaining their original model and numerical assertions. |
| Enlarged-choice review | A fixed 180px popup wrapped options unnecessarily and could cover the Inspector tabs. | Scale preferred width with application text within the viewport; complete contact-choice workflows pass in all three engines. |
| Short Inspector review | Secondary headings consumed scarce editing space in short phone windows. | Compact the secondary chrome and retain the actual editable content and tabs. Short-window native workflows pass in all three engines. |
| Extended verification review | Old fills and a full-control clipping assertion no longer represented the reviewed design and existing visible-anchor policy. A scroll fixture also raced native resize delivery. | Check the opaque panel palette, actual anchor visibility and settled overflow; preserve model, keyboard and viewport assertions. |

The design and repair reviews include 42-case, 24-case and 39-case cross-browser
passes without retries. Final release gates use a frozen source manifest and
are recorded separately from this design critique.

## 28 October refinement

Requested refinement: keep playback in the top toolbar row wherever space
allows, reduce header height and Settings panel/card spacing, and preserve
responsive wrapping, coarse-pointer targets and enlarged/dyslexic text. Force
owner number badges are now an optional View aid rather than default ink.
