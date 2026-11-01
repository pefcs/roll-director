## Stealth Observer integration (0.2.25)

When Stealth Observer is active, Roll Director queries its public Perception-lighting API for Perception skill checks. If the actor's local exposure and vision modes require disadvantage, Roll Director includes it in the initial roll-mode selection and reapplies it after the Roll Director prompt. An explicitly selected Advantage and the lighting Disadvantage cancel normally; Normal or Disadvantage resolves to Disadvantage. The result summary reads the actual completed D20Roll mode.

# Roll Director

## Initiative handling (0.2.21)

- Combat Tracker initiative actions are routed through Roll Director when **Automatically intercept supported D20 rolls** is enabled.
- Player-controlled characters, player-owned NPCs, and Primary Party minions use the existing owner-validated player prompt flow.
- **Automatically roll initiative for non-player-controlled actors** is a world setting enabled by default. When enabled, uncontrolled NPCs roll automatically; when disabled, they remain in the GM prompt for manual initiative rolls.
- **Automatically start initiative after adding combatants** defaults to Off. When enabled, adding actors to a combat that has not started begins one batched Roll Director initiative request after the token/combatant additions settle.
- **Automatically request initiative for actors added during combat** defaults to On. New combatants added after combat has started are automatically routed into the initiative workflow. Player-controlled actors use the GUI; uncontrolled NPCs follow the NPC initiative setting. Late-arrival rolls do not intentionally advance the current turn.
- Initiative produces a per-actor summary without a group average or group-check calculation. Intermediate individual roll cards use Roll Director's private internal-message handling. Roll Director captures the evaluated initiative Roll for accurate summaries, falling back to the final Combatant initiative score when needed.
- Calls that specify a custom initiative formula are left to Foundry's native handling.

Temporary synthetic Activity cards for manually requested Ability Checks, Skill Checks, and Saving Throws are always restricted to the GM and originating user, regardless of the global chat-bar roll mode. The **Show intermediate manual roll card** setting controls only whether the GM sees those cards in chat; it does not make them public. The underlying messages are retained for Midi-QoL workflow bookkeeping.

Player Roll Request popups show only actors the current player owns (Owner permission); observer-only actors are not listed or rollable from the popup. Player popup dimensions adapt to the number of eligible actors. GM prompt layout is unchanged.

Actor labels use the player character's prototype token name and the placed NPC token's name on the current canvas, so results can distinguish different NPC Actor profiles that share a similar profile name. NPC entries still use the existing Actor-UUID-based request protocol.

## v0.2.6 — Restore Midi-owned roll workflow integration

- Manually requested Saving Throws, Ability Checks, and Skill Checks now start synthetic D&D 5e Activities through `MidiQOL.completeItemUse`. Midi-QoL creates the workflow, routes each target through its native roll request, and completes its save/check phase; Roll Director supplies the shared prompt through the same `midi-qol.preCheckSaves` adapter used for real item workflows.
- The existing Midi-QoL target-save adapter is restored: it replaces the per-target prompt dispatch for eligible actors while keeping Midi's real roll promises, actor roll wrappers, External Reaction workflow hooks, result adjudication, and downstream item workflow intact.
- Independent concentration-check workflows created by Midi-QoL are serialized through Roll Director's request queue. They are not grouped using an arbitrary time window, and they retain their own Midi workflow and DC.
- The v0.2.3 DC and player PASS/FAIL visibility settings are retained. Choosing advantage/normal/disadvantage still modifies the same roll Midi-QoL awaits.
- Tool Checks and Death Saving Throws use the existing actor-roll path; initiative from the Combat Tracker is routed through Roll Director, with a configurable NPC auto-roll option. If a manually requested save/check/skill includes an actor with no token on the current scene, Roll Director falls back to that existing path because Midi's target workflow requires current-scene tokens.

**Testing status:** syntax, manifest JSON, and ZIP layout are checked locally; the build has not been exercised in a live Foundry world. Test it with the installed Foundry V14.369, D&D 5e 6.0.6, Midi-QoL 14.6.4, DAE 14.6.3, and External Reaction 0.10.8 before using it in a live session. No External Reaction code or package is changed by this release.

## Previous v0.2.2 workflow adapter notes

- When a Midi-QoL workflow enters its target-save/check phase, Roll Director collects eligible player characters and player-controlled actors into one request. NPCs without player control remain in Midi's native path and are not sent to player prompts.
- Roll Director replaces only the per-target request UI dispatch for those eligible actors. Midi-QoL still requests the native actor roll through its standard socket/actor path, receives the real Roll object, performs `processTargetSaveResult`, adjudicates saves, and continues damage/effects.
- The selected mode is applied within the existing actor-roll call using the transmitted Midi workflow ID; no second or detached roll is launched.
- Final per-target results are collected at `midi-qol.postCheckSaves`, after the workflow's existing save processing—including External Reaction's current workflow save integration—and published through Roll Director's permission-filtered summary.
- The adapter targets the actual Midi-QoL 14.6.4 `Workflow.queueTargetSaveRoll`, `createStandardSaveRoll`, `targetSaveDetails`, and `midi-qol.preCheckSaves` / `postCheckSaves` flow. These are version-specific integration points and must be re-verified when Midi-QoL changes.

**External Reaction scope:** standalone Ability Checks and Skill Checks still use native D&D 5e actor methods, allowing External Reaction's existing `rollAbilityCheck` / `rollSkill` integration to run when the wrapper chain is intact. Save reactions in this build are handled inside Midi-QoL workflows, where External Reaction already hooks `midi-qol.preCheckSaves` and `processTargetSaveResult`. **A standalone Roll Director Saving Throw does not yet receive External Reaction save reactions by itself**; that requires an External Reaction-side adapter for non-workflow save rolls.

**Fallback behavior:** if Roll Director is disabled, a request cannot be created, or the required target-owner prompts are not ready, Roll Director leaves Midi-QoL's normal request UI path intact. A target-choice timeout releases the waiting actor method with its preselected mode rather than leaving Midi's save promise unresolved.


## v0.2.1 update notes

- Replaced direct actor-prototype overrides with `libWrapper` wrappers so Roll Director composes with Midi-QoL and other wrappers rather than overwriting the shared actor methods.
- Direct D&D 5e rolls continue to use the Roll Director prompt.
- Rolls associated with an active Midi-QoL workflow (including target save/check response rolls) are delegated to Midi-QoL. This avoids pausing its target-save handshake and hiding the roll response that Midi uses to determine saves and continue damage/effect processing.
- The dedicated integration for showing one grouped Roll Director prompt for all PC targets of a Midi-QoL multi-target save is still pending. This build prioritizes preserving Midi-QoL's native workflow over intercepting those internal rolls.


## v0.1.9 update notes
- GM-only group result is compact by default and expands for calculation details.
- Advantage/Normal/Disadvantage button states synchronize live between player and GM roll prompts.
- Click the dice logo beside the Roll Director title to collapse the manager; click the floating dice to expand it.
- The manager uses a frameless ApplicationV2 window. Use the in-panel X button to close it; the custom top bar remains draggable.


## v0.1.6 update notes
- Fixed the Players/NPCs tab click error by avoiding Foundry's native tab-navigation handler for custom roster tabs.
- Dragging now uses the visible scaled bounds and intercepts the window titlebar before Foundry applies its unscaled clamp.
- NPC prompts, raw result cards, dice animations, and summary entries are withheld from players; the GM can roll NPCs privately.
- All transport and summary messages explicitly use Foundry v14 `messageMode`, preserving custom whisper recipients instead of inheriting Public chat mode.
- Dice So Nice animations are targeted to the authorized audience, with GM-only animations for NPCs.

**Version:** 0.1.6 — developer preview  
**Target:** Foundry VTT 14.367+, D&D 5e 6.0.6+  
**Optional integration targets:** Midi-QoL and DAE

Roll Director is a GM-facing roll-request interface. It uses D&D 5e's native actor roll methods so the system remains responsible for building and evaluating the roll, including its normal roll modifiers and system hooks.

> **Preview warning:** This build is not production-ready. It has had static JavaScript/JSON validation, but it has not yet been run inside a live Foundry world. In particular, the complete Midi-QoL interaction and message-visibility behavior must be tested in the target world before relying on it in a live session.

## Current scope

This preview implements **Phase 1 — manual roll requests**:

- A GM-only control panel with Players and NPCs tabs.
- Players tab populated from D&D 5e Primary Party members, including NPC minions treated as player-style actors. Player prompts remain Owner-only.
- NPC tab populated from unique NPC actors represented by tokens on the current canvas.
- Portrait cards, single-click selection, double-click to open the actor sheet, and selection retained across tabs.
- Ability checks, saving throws, skill checks, and tool checks.
- DC presets (5, 10, 12, 13, 15, 18, 20, 25, 30) plus a custom DC field.
- Default DC, roll visibility, and group-roll method settings in Module Settings.
- Per-actor roll visibility and advantage/disadvantage overrides.
- Player prompts show only player characters for which that user has Owner permission. NPCs are never included in player prompts, even when the player can observe the NPC.
- Players can roll an actor for which they have Owner permission, provided they are a participant in the request.
- A GM-only Cancel Request action stops stuck/in-progress requests, preserves completed rolls, releases paused native roll promises, and advances the queued automatic request.
- Player disconnects receive a 60-second recovery grace period. Reconnecting owners receive a refreshed request; another active owner can take over if the disconnected player had started the roll. If an actor has no connected owner past the grace period, it is released/skipped. Automatic requests whose initiating player stays disconnected are cancelled after the grace period, preserving completed results.
- A GM-only Diagnostics menu reports system/module versions, integration-hook/interceptor status, active requests, and recovery queue/waiter counts. The copied report excludes actor/token names and player IDs.
- The GM can roll any requested actor, roll all remaining actors, or roll the remaining NPCs.
- Native D&D 5e actor roll methods are used. Any underlying D&D/Midi roll cards are forced into private internal messages and hidden; Roll Director publishes compact, permission-filtered summaries after resolution.
- Separate NPC and Player Character summary sections, NPCs first. The DC and group result are shown only in the GM summary.
- Per-user result filtering: public results are shown only to users with Observer permission for that actor; private/self results are limited to the roller and GM; blind results are GM-only.
- Standard Rule, Group Average, Leader with Help, and Weakest Link group evaluation.
- Light/dark theme styling and responsive layouts.
- Configurable GM interface scale (60%–140%).
- Optional automatic manager opening on world load (enabled by default).
- Drag the in-app top bar to move the manager on the canvas; its position is saved for the current GM user.
- Collapse the manager into a compact floating d20 icon with the top-bar control. Scaled positioning is clamped against the visible dimensions, including near the bottom and right edges. Drag the icon to move it; click it to restore the full manager at the previous size and position.
- The Players/NPCs active-tab highlight is aligned to the tab button bounds.

## Install

1. Extract the ZIP into `Data/modules/roll-director/`, so `module.json` is directly inside the `roll-director` folder.
2. Reload Foundry VTT.
3. Enable **Roll Director** in Manage Modules.
4. In D&D 5e settings, configure the Primary Party and add the player character actors to it.
5. As GM, Roll Director opens automatically by default. You can change **Open GM interface automatically** and **GM interface scale** under **Configure Settings → Module Settings → Roll Director**. You can also open it manually using **Open Roll Director → Open Manager**, or use the Roll Director button in the Chat Log if the current chat layout exposes the insertion point.

## Version 0.1.6 test notes

- Switch Players/NPCs tabs and confirm no ApplicationV2 tab-group error appears.
- At 85% scale, drag the panel using either its window titlebar or its in-panel header all the way toward the top and bottom edges.
- Test a GM-initiated NPC roll with a player connected. Confirm the player sees neither an NPC prompt nor an NPC portrait, die animation, raw roll card, total, or NPC summary row.
- Test public, Self (roller + GM), and Blind modes for PC rolls, checking that only authorized users receive the relevant summaries and Dice So Nice animations.
- Check Advantage/Disadvantage dice counts and feature-provided Advantage with Midi-QoL/DAE enabled.

## Basic test plan

Start in a test world or a backup of the live world. Use at least one GM, two player users, two player characters, and two NPCs; set one NPC to Observer for one player and leave another NPC without player Observer permissions.

1. Open the manager; verify the Primary Party and canvas NPCs appear in the correct tabs.
2. Select a PC, switch to NPCs, select an NPC, then switch back. Verify both stay selected.
3. Double-click an actor portrait and verify its sheet opens.
4. Request a skill check with a preset DC, then repeat with a custom DC.
5. Roll one PC from the player prompt. Verify the actor disappears from the player and GM prompts and that the prompt visibly marks Normal, Advantage, or Disadvantage.
6. Try all three roll modes. Confirm that users without Observer permission cannot see results for hidden actors.
7. Request several PCs and verify each group-roll method against hand-calculated examples.
8. Request one or more NPCs. Confirm players receive no NPC prompt, portrait, dice animation, raw card, name, or roll total, regardless of Observer permission.
9. With Midi-QoL and DAE enabled, confirm the expected modifiers and hooks apply to requested rolls and that no duplicate roll card or duplicate roll occurs.
10. Check both Foundry light and dark themes and resize the prompt to a small window.
11. Verify that a PC is labeled with its prototype token name and an NPC with its placed canvas token name; confirm the result summary uses the same display name.
12. Start a request, cancel it from the GM prompt, and verify completed results remain while pending request UI closes. Repeat with a Midi-QoL workflow to confirm the native workflow is released rather than left waiting.
13. In a test session, disconnect a player who has an outstanding roll and reconnect within 60 seconds. Confirm their outstanding prompt is refreshed. In a separate test, leave them disconnected beyond the grace period; verify an unresolved actor is released or the initiating automatic request is safely cancelled, and that the next queued request can proceed.
14. Open **Module Settings → Roll Director → Diagnostics**, refresh it, and copy the report. Confirm the version/integration counters are present and the report contains no actor names, token names, or player IDs.

## Important notes

- Only one Roll Director request can be active at a time. This avoids mixing responses from overlapping requests.
- Active requests and recovery timers live in client memory. Player disconnections are handled with a 60-second grace period and refreshed prompts on reconnect; an automatic request is cancelled if its initiator remains disconnected for that full period. A full GM client reload or world reload does not restore an in-progress request. Use Cancel Request if a request becomes stuck while the GM client is still running.
- The module intentionally avoids broadcasting a single public summary that could leak an NPC result to someone without Observer permission. The GM receives a separate full summary; each player receives a filtered summary.
- Chat visibility is set using Foundry v14 `messageMode` on transport and summary messages. Raw D&D/Midi cards are private and hidden; the summary is the user-facing result. NPC names, dice, and totals are withheld from all players.
- Compatibility is a target, not a certification: Midi-QoL and DAE behavior must be exercised in the actual world, with the exact module versions in use.

## Development sequence

1. Stabilize manual requests, privacy, group rolls, and responsive UI.
2. Add automatic interception using a separately testable interception layer, preserving native roll methods and Midi-QoL integration.
3. Test death saves, initiative, and concentration separately because their system workflows have additional side effects and require careful handling.
4. Extend compatibility tests to each installed Midi-QoL / DAE version and fix any real-world regressions before treating automatic interception as stable.


### v0.1.5 historical notes (NPC visibility corrected in v0.1.6)
- v0.1.5 initially configured NPC requests as Blind · GM only. In v0.1.6 this was corrected to Self · roller + GM, with NPC prompts/results withheld from all players because the GM is the roller for NPC requests.
- The old Private (roller + GM) option is removed; existing `gmroll` default settings are interpreted as Self.
- Advantage/Disadvantage buttons are applied to the configured D&D 5e D20Roll after roll configuration, and known actor roll modes are used for initial button states.
- The main manager now has icon-only Add all Players and Add all NPCs actions that add those actors to the current selection.


## Version 0.1.7 notes
- The GM manager now uses Foundry v14's native ApplicationV2 scaling so its draggable bounds match the on-screen size.
- `Start GM interface collapsed` defaults to enabled. The interface opens as a draggable D20; clicking it restores the manager.
- Add all Players and Add all NPCs toggle the relevant roster selection.
- Player result summaries are sent to explicit recipient cohorts without forcing GM-only message mode; public character results are shown only to users with Observer permission, while Self/Blind results remain private.
- Click a summary row to expand formula, roll terms, advantage/disadvantage dice, and total information.


## v0.1.8 notes
- Expandable roll details now show actual d20 values for authorized viewers rather than displaying `?` based on the internal `hidden` flag.
- Roll Director summary cards visually suppress Foundry's whisper recipient list and `WHISPER` label. Messages remain permission-filtered whispers; only the header presentation changes.


## Version 0.1.10 note
The GM manager retains Foundry's native ApplicationV2 frame for reliable rendering and positioning. Its outer window header is styled to match Roll Director's dark teal theme (with a light-theme variant), while the in-panel D20 remains the collapse/restore control.


## Phase 2: automatic D20 interception (0.2.x preview)

The world setting **Automatically intercept supported D20 rolls** is enabled by default. Direct/manual Ability Checks, Saving Throws, Skill Checks, Tool Checks, Death Saving Throws, Initiative, and Concentration Checks are eligible for the Roll Director prompt.

**Midi-QoL behavior in v0.2.2:** target saves/checks inside supported Midi workflows now use one Roll Director prompt for eligible player-controlled targets while Midi-QoL continues to own the actual rolls, per-target result promises, save adjudication, damage, and effects. Other Midi-managed roll calls are delegated unchanged.

For direct/manual rolls, Roll Director pauses the original native actor method while the player chooses a mode, then resumes that same invocation. It does not start a separate replacement roll. Automatic requests include player characters and actors owned by non-GM users; GM-only NPCs are not exposed to player prompts. If a separate request is already active, Midi's native UI path is used for a new workflow to avoid blocking it.

Automatic tests without a known DC omit PASS/FAIL outcomes. DCs are taken only from the native workflow configuration when present, with death and concentration saves using their native target of 10. Initiative, death saves, and concentration rolls do not produce group-roll evaluations.

**Testing notes:** this build has not been validated in your live world. Test a multi-target Midi-QoL spell first and confirm the prompt appears once, each eligible actor rolls once, final totals match Midi's save display, and damage/effects complete. Then test direct/manual Ability and Skill Checks to confirm External Reaction still triggers, and test direct/manual Saving Throws separately because External Reaction v0.10.8 does not yet process standalone save reactions.

## Phase 2 test report checklist

Please test in a backup/test world first. Automatic interception is enabled by default but can be disabled under Module Settings if a workflow becomes blocked. First cast a multi-target Midi-QoL spell (e.g. Fireball) and verify one shared Roll Director prompt, one actual roll per eligible target, External Reaction save processing, and continued damage/effects. Then test direct/manual Ability Check and Skill Check (External Reaction should be eligible to trigger), a direct/manual Saving Throw (standalone External Reaction save support is not included yet), Tool Check, Death Saving Throw (including success/failure state changes), Initiative (including combat tracker updates), and Concentration.


## Favorite Tools

Configure favorites from **Game Settings → Module Settings → Roll Director → Configure Favorite Tools**. The settings window includes a search field and categorized checkboxes so you can select multiple tools. Saved favorites appear in the leftmost column of the Tool Check picker; the other categories remain available to the right. Favorite entries use the readable D&D 5e tool name while retaining the original system identifier for rolling.


### Intermediate manual workflow card

The **Show intermediate manual roll card** setting controls whether the temporary synthetic D&D 5e Activity card used to initialize Midi-QoL for manual Ability Checks, Skill Checks, and Saving Throws appears in chat. It defaults off. The underlying message is still created for workflow bookkeeping; the setting only controls its rendered visibility.
