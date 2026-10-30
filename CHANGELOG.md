# Changelog

## 0.2.24 — Initiative dice recovery and whisper header cleanup

- Rehydrate Foundry 14's serialized `ChatMessage.rolls` JSON with the native Roll API before attempting to capture initiative details. This restores the evaluated d20 faces and term breakdown instead of silently falling back to the stored Combatant score whenever `rolls` is serialized as strings.
- Remove the DEX / 100 tiebreaker term from expanded initiative details as well as the visible formula and total; the native Roll and stored Combatant initiative remain unchanged for turn ordering.
- Rework Roll Director summary header cleanup to hide the complete recipient metadata row even when the `TO:` label and username spans are nested separately or rendered as adjacent metadata by a chat theme. Only display elements are hidden; actual whisper recipients and privacy settings are not modified.

## 0.2.23 — Initiative dice details and recipient header cleanup

- Improved capture of evaluated native initiative rolls when Foundry/D&D 5e serialization omits custom Roll Director options from the embedded Roll. When the message contains exactly one Roll, the actor is resolved from the matching active/recent Roll Director marker; multi-roll messages still require explicit per-roll markers. Evaluated term results are read from both live Roll instances and serialized source data, keeping the actual d20 face(s) available in the expanded summary when the native message contains them.
- Extended the initiative tiebreaker display cleanup to the expanded detail: the visible formula and total omit the DEX / 100 fraction, while the actual Roll and stored Combatant initiative remain unchanged.
- Fixed whisper recipient cleanup to inspect the outer chat-message container as well as the rendered message body, and recognize recipient-specific markup outside the message header. The actual recipients and privacy settings remain unchanged.

## 0.2.22 — Initiative score display and cleaner chat summaries

- Kept D&D 5e's actual initiative values unchanged for sorting, but removed the ability-score / 100 tiebreaker fraction from Roll Director's visible initiative summary when that system setting is enabled.
- Hid the sender portrait and the `TO: ...` / `WHISPER` header labels on Roll Director summary messages only. Message recipients and visibility permissions are not changed.
- Preserved actor portraits inside result rows according to the existing **Show portraits in chat** setting.


## 0.2.21 — Initiative result accuracy and combatant automation

- Fixed initiative summaries reading the cached D&D 5e pre-roll object before evaluation, which could report `0` for every actor. Roll Director now captures the evaluated internal initiative Roll when available and falls back to the final Combatant initiative score without fabricating a natural d20 or dice breakdown.
- Added **Automatically start initiative after adding combatants** (world setting, default Off). When enabled, newly added combatants are batched into a single initial Roll Director initiative request once the additions settle.
- Added **Automatically request initiative for actors added during combat** (world setting, default On). Late arrivals are sent through the existing initiative flow; player-controlled actors receive the Roll Director GUI, and uncontrolled NPCs follow the existing automatic NPC initiative setting.
- Initiative rolls for late arrivals pass `updateTurn: false` so their addition does not intentionally advance the current turn. Diagnostics now includes both new settings.
- Preserved native D&D 5e initiative updates, Roll Director's summary-only display, and the existing no-group-average initiative behavior.

## 0.2.20 — Combat Tracker initiative handling

- Intercepts Combat Tracker initiative requests (`Roll All`, `Roll NPCs`, and individual tracker rolls) when automatic D20 interception is enabled, so initiative rolls use the Roll Director prompt and summary flow.
- Player-controlled actors—including player-owned NPCs and Primary Party minions—receive the existing player-side Roll Director prompt and still require Owner permission.
- Added the world setting **Automatically roll initiative for non-player-controlled actors** (enabled by default). When enabled, uncontrolled NPC initiative rolls start automatically; when disabled, those NPCs remain in the GM prompt for manual rolling.
- Intermediate initiative roll cards are handled through the existing private internal-message path; the final Roll Director summary remains the user-facing result. Initiative does not calculate a group average or other group check result.
- Added Combat Tracker initiative interceptor status and the NPC initiative setting to Diagnostics. Custom formula initiative requests are passed through to Foundry unchanged.
- Preserved the 0.2.18 request recovery/diagnostics and token naming behavior while retaining 0.2.19 Primary Party NPC minion behavior.

## 0.2.19 — Primary Party NPC minions as player actors

- Added NPCs in D&D 5e's Primary Party to the Players roster and removed them from the NPC roster to avoid duplicate entries.
- Treats Primary Party minions as player-style roll participants for summary grouping and roll visibility, while sending their prompt only to users with Owner permission.
- Kept ordinary NPCs outside the Primary Party on the existing NPC/private-roll path.

## 0.2.18 — Request recovery, diagnostics, and token-based names

- Added a GM-only **Cancel Request** action. Cancelling retains completed results, clears active request state and recovery timers, releases paused native rolls, and advances the automatic request queue.
- Added a 60-second grace period for player disconnects. Reconnecting owners receive a refreshed request with fresh item IDs; if the disconnected owner had started the roll, the other active owners can take over. If an actor remains unresolved with no connected owner, the entry is released/skipped. An automatic request whose initiating player stays disconnected is cancelled after the grace period, retaining already completed results.
- Added **Configure Settings → Module Settings → Roll Director → Diagnostics** with Foundry/system/module versions, interceptor/integration status, active request counts, queue/waiter counts, and a copyable report that omits actor/token names and player IDs.
- Player character labels now use prototype token names. NPC labels and result summaries use the placed token's name on the current canvas instead of the shared Actor/Profile name.
- Preserved the Midi-QoL-owned roll path and actual roll result summaries. Recovery state remains in memory; a full GM client/world reload does not restore an active request.

## 0.2.17 — Secure intermediate workflow card visibility

- Identify synthetic manual-workflow cards through Midi-QoL's embedded item metadata (`flags.midi-qol.itemData`) before the Activity title is rendered.
- Force the intermediate card to GM + originating-user recipients regardless of the Foundry chat-bar roll mode, preventing public leakage when the global mode is Public.
- Persist the `manualWorkflowCard` marker before creation and use it for optional display hiding. Expanded the hidden wrapper lookup for Foundry chat-message containers.
- The intermediate ChatMessage is still created for Midi-QoL bookkeeping; roll results and Roll Director summaries are unchanged.

## 0.2.16 — Reliable intermediate workflow card hiding

- Fixed the intermediate manual Activity card detection: the D&D 5e card title may render outside `.message-content`, so detection now checks the available message/DOM representations independently.
- Tags matching synthetic Activity ChatMessages at creation time and hides the complete chat-message wrapper when the setting is off.
- Keeps the underlying ChatMessage intact for Midi-QoL workflow bookkeeping; roll results, summaries, and GM roll handling are unchanged.

## 0.2.15 — Configurable intermediate workflow card

- Added the world setting **Show intermediate manual roll card**. It defaults to off, hiding the temporary synthetic Activity card generated when manual Ability Checks, Skill Checks, and Saving Throws start a Midi-QoL workflow.
- The underlying ChatMessage is still created because Midi-QoL may rely on it for workflow bookkeeping; only the rendered chat card is hidden. Enabling the setting restores its display.
- No roll execution, Midi-QoL adapter, or roll-result visibility logic was changed.

## 0.2.14 — Compact player completion state

- Made the player-side post-roll confirmation more compact so it fits in the existing dynamically sized popup without manual resizing.
- Replaced the longer completed-state copy with “Roll submitted” and a short group-waiting message.
- Preserved the current player roll-window dimensions and all GM prompt styling/behavior.


## 0.2.13

- Increased the dynamically calculated default height of the player Roll Request popup so a single actor's portrait, advantage controls, roll button, and footer fit without requiring manual resizing.
- Kept actor-count-based sizing and the GM popup's existing dimensions unchanged.

## 0.2.12

- Player Roll Request popups now include only characters for which the current player has Owner permission; observer-only characters are no longer sent to or displayed in that popup.
- Player-side roll and advantage-mode requests are validated against Owner permission. The GM prompt and roll-result visibility behavior are unchanged.
- Player popup dimensions now adapt to the number of remaining eligible actors, reducing unused space for one-character requests. GM prompt sizing remains unchanged.

## [0.2.11] - 2026-10-25
- Added a Favorites column at the far left of the full-width Tool Check picker; existing tool categories shift right into the remaining columns.
- Added a GM-only “Configure Favorite Tools” settings menu with searchable, categorized checkboxes for selecting multiple favorite tools.
- Favorites are stored as world settings, appear in the picker on the next open, and still submit the original D&D 5e tool identifiers.
- Preserved the roll execution and Midi-QoL workflow paths.

# Changelog

## [0.2.10] - 2026-10-25
- Replaced the separate Foundry dialog with a compact, full-width tool drawer inside the Roll Director manager.
- Styled the drawer with Roll Director's dark teal palette, category headings, selected-tool highlight, and a compact search field.
- Kept the picker short with independently scrollable category lists; selecting a tool closes the drawer. Clicking outside or pressing Escape also closes it.
- Kept the roll execution code and Midi-QoL workflow handling unchanged.

## [0.2.9] - 2026-10-25
- Fixed the missing `choose-tool` click action that prevented the tool picker from opening.
- Resolved tool display names from D&D 5e compendium UUIDs where available, with readable name fallbacks for custom tools.
- Preserved the underlying tool identifiers used to perform the roll.

## [0.2.8] - 2026-10-25
- Fixed the custom tool picker button so it opens the categorized selection dialog.
- Fixed tool labels when the D&D 5e configuration provides display names as plain strings, showing readable names instead of identifiers.
- Kept the selected tool's original system identifier for roll execution.

## 0.2.7 — Categorized tool picker

- Replaced the long Tool Check subtype dropdown with a searchable, categorized dialog laid out in columns.
- Tool labels use the localized D&D 5e system names while the original system identifiers remain the values passed into roll requests.
- Added category grouping for artisan tools, musical instruments, gaming sets, vehicles, and other tools.
- No roll execution or Midi-QoL workflow logic was changed. JavaScript syntax checks pass; live Foundry UI testing is still required.

## 0.2.6 — Midi-owned manual checks and concentration workflow queue

- Restored the Midi-QoL `preCheckSaves` / `postCheckSaves` adapter so real Midi item workflows use one Roll Director prompt for eligible targets while preserving Midi's Promise-based target roll queue and result processing.
- Routed manually requested Saving Throws, Ability Checks, and Skill Checks through synthetic D&D 5e Activities via `MidiQOL.completeItemUse`, making them Midi workflows visible to the existing External Reaction integration. External Reaction itself is unchanged.
- Added explicit per-request mode/DC settings to the synthetic Activity so the shared prompt retains the manager's DC, roll mode, group method, and actor-specific overrides.
- Queued independent synthetic concentration workflows serially rather than merging arrivals by a fixed time window; each keeps its own Midi workflow and DC.
- Retained v0.2.3's immediate started-actor UI update and player PASS/FAIL visibility settings.
- Kept a fallback to the prior actor-roll request route when a selected actor has no token on the current scene or Midi-QoL workflow support is unavailable.
- Static checks pass; live Foundry testing is still required.

## 0.2.3 — DC-aware results and player outcome settings

- Automatic requests track an actor as soon as the roll begins. The actor is removed from the GM and participating player prompts immediately, while the original roll continues and the result is still collected later.
- Player request payloads include the requested DC. Manual native rolls pass the DC through D&D 5e's process configuration, per-roll options, and Midi-QoL options so fail/success modifiers can evaluate the actual threshold.
- Added independent world settings to show or hide PASS/FAIL outcomes in player summaries for Saving Throws (including Death Saves and Concentration Checks) and for Ability/Skill/Tool Checks. The DC remains GM-only.
- Corrected the module manifest version to 0.2.3.

## 0.2.2 — Midi-QoL workflow adapter preview (historical implementation)

- Added a dedicated adapter at Midi-QoL's awaited `midi-qol.preCheckSaves` / `midi-qol.postCheckSaves` workflow boundaries for a single Roll Director prompt covering eligible player-controlled targets of the same save/check workflow.
- Wrapped Midi's per-workflow `queueTargetSaveRoll` dispatch for those targets, retaining `createStandardSaveRoll`, its socketlib/actor-roll path, the native Roll objects, and Midi's normal `processTargetSaveResult`, save adjudication, damage, and effects processing.
- The approved Roll Director Advantage/Normal/Disadvantage choice is applied to the same native target roll through the actor's existing libWrapper chain; raw cards remain internal, and Dice So Nice is routed to the authorized audience.
- Collects final per-target rolls at `midi-qol.postCheckSaves`, after External Reaction's existing workflow save integration has processed the rolls, then publishes Roll Director's permission-filtered summary.
- Registers workflow context on the initiator and target-owner clients, clears it on completion/cancel, and falls back to Midi's native request flow when the Roll Director adapter is unavailable or times out.
- Standalone ability and skill requests continue through native D&D 5e/Midi-QoL actor methods, allowing External Reaction's existing ability/skill wrappers to process them when the installed wrapper chain is intact.
- External Reaction's standalone saving-throw integration is not added in this build; its existing save reaction processing applies to Midi-QoL workflow-owned target saves.
- This is an in-world integration preview and must be tested with the exact Midi-QoL, DAE, External Reaction, socketlib, and Dice So Nice versions before live use.


## 0.2.0 — Phase 2 preview

- Added opt-out world setting for automatic interception of Ability Checks, Saving Throws, Skill Checks, Tool Checks, Death Saving Throws, Initiative, and Concentration Checks. Enabled by default.
- The original asynchronous native Actor roll invocation pauses for a Roll Director decision, then resumes the same invocation so its return value and downstream Midi-QoL/system workflow remain connected; no separate replacement roll is launched.
- Added automatic request dispatch from player clients to the GM and queueing while another Roll Director request is active.
- Added support for Death Save, Concentration, and Initiative roll execution in prompts.
- Added DC-aware summaries for automatic rolls; rolls without a known target no longer invent PASS/FAIL results.
- Added participant/GM visibility and privacy distinction for player-controlled NPCs versus GM-only NPCs.
- Removed the redundant custom manager close button; the native Foundry window close control remains available.
- Fixed cancelled/timed-out automatic requests so they do not leave stale per-actor interception locks, and guarded pending decisions against double resolution.
- Automatic D20 interception is a developer preview and requires live testing with Midi-QoL, DAE, and Dice So Nice.


## 0.1.10 — restore and theme the ApplicationV2 frame
- Re-enabled Foundry's native ApplicationV2 frame for the GM manager because `frame: false` prevented the manager and floating dice control from appearing in the user's v14 environment.
- Enabled a native D20 window icon and styled the Foundry window header with Roll Director's dark teal palette, plus a light-theme variant.
- Kept the custom in-panel D20 collapse/restore control and draggable behavior.


## 0.1.9 — compact group result, live mode sync, frameless manager
- Changed the GM-only group result to a single collapsed line: “Group roll” with a green Passed or red Failed state. The calculation method, DC, and success count are revealed in an expandable details section.
- Advantage/Normal/Disadvantage selections now synchronize live between player prompts, the GM prompt, and other participants' open prompts through permission-restricted transport messages.
- Moved the collapse-to-dice action to the brand dice icon beside the Roll Director title and removed the redundant top-right collapse control.
- Removed the outer Foundry window frame for the GM manager. Added an in-panel close button to preserve the ability to close the application, while retaining in-app dragging.


## 0.1.8 — Authorized roll details and cleaner chat headers
- Fixed the expandable roll details showing `?` instead of the actual d20 faces. Redaction is handled by per-user summary filtering; authorized summaries now render the die values, including the discarded Advantage/Disadvantage die.
- Hide Foundry's `TO: recipient names` and `WHISPER` header labels on Roll Director summary messages while preserving the real whisper recipient list and access permissions. This is a presentation-only change.


## 0.1.6
- Fixed Players/NPCs tab clicks by using `data-roster-tab`, avoiding ApplicationV2's native tab handler and its missing-tab-group error.
- Reworked scaled dragging to intercept the titlebar before Foundry's native drag handler, using the visible transformed bounds so downscaled windows can move closer to the top, bottom, and sides.
- Corrected NPC request visibility to Self / roller + GM; NPC names and prompts are not sent to players, and NPCs are excluded from player result summaries.
- Fixed visibility on every custom ChatMessage creation by passing Foundry v14 `messageMode` explicitly so current public chat mode cannot override custom whisper recipients.
- Force underlying D&D 5e/Midi-QoL roll cards into private hidden internal messages while preserving message creation for Midi-QoL bookkeeping; Dice So Nice's message-based animation is disabled on those cards.
- Route Dice So Nice animations to the allowed users only: GMs for NPC rolls; actor Observer users and GMs for public PC rolls; roller and GMs for Self rolls; GMs only for Blind rolls.
- Added speaker/recent-roll fallbacks for Dice So Nice and chat-message privacy when Midi-QoL clones a roll and omits custom Roll options.

## 0.1.4 — Scaled drag bounds and clearer summaries

- Reworked scale-aware positioning and dragging to measure the manager's actual rendered bounds, then clamp against the viewport's visible width and height.
- Automatically clamps the manager back into view when scale changes, while retaining the base dimensions used for resize/restore.
- Updated chat summary rows to use fixed grid columns for portraits, actor names, advantage/disadvantage tags, totals, and PASS/FAIL outcomes. Empty slots are reserved so missing tags do not shift the totals or statuses.
- Increased spacing and contrast for PASS/FAIL labels, with green for success and red for failure.
- Changed the GM-only group result wording from PASSED/FAILED to PASS/FAIL and added a distinctly colored result pill.

## 0.1.3 — v14 transport and scale-aware positioning

- Fixed hidden coordination and summary messages for Foundry v14 by using `CONST.CHAT_MESSAGE_STYLES.OTHER` via the `style` field, rather than the removed `CONST.CHAT_MESSAGE_TYPES` constant.
- Made panel positioning respect its configured visual scale when clamping to viewport boundaries, including dragging toward the bottom and right edges.
- Applied scale-aware bounds on initial open and when the scale setting changes; preserved the unscaled interface size when collapsing and restoring.
- Retained resized interface dimensions when possible.

## 0.1.2 — Floating dice and selection alignment

- Added a top-bar control to collapse Roll Director into a compact, draggable dice icon.
- Clicking the floating dice restores the full manager at its previous size and location.
- Dragging the collapsed icon repositions it and saves the GM's position without triggering expansion.
- Reworked Players/NPCs tab highlights to draw the rounded selection background directly within the tab bounds, preventing vertical offset caused by inherited button focus/appearance styling.
- Preserved the configured scale for the full interface while keeping the collapsed dice at a consistent size.

## 0.1.1 — UI rendering and window controls

- Fixed the Module Settings menu application by adding the Foundry v14 Handlebars Application mixin.
- Added a configurable GM interface scale (60%–140%, in 5% increments).
- Added a GM client setting to open Roll Director automatically on world load; enabled by default.
- Made the control deck draggable by its in-app top bar and saved its position per GM user.

## 0.1.0 — Initial developer preview

- Added GM-only Roll Director manager and player-facing roll prompt.
- Added Players and NPCs rosters using the D&D 5e Primary Party and current canvas tokens.
- Added manual ability, saving throw, skill, and tool roll requests.
- Added DC presets/custom DC, roll-visibility selection, group-roll selection, global advantage state, and per-actor overrides.
- Added GM and participant roll flows using D&D 5e native actor roll methods.
- Added compact permission-filtered chat summaries with GM-only DC and group-roll results.
- Added four group-roll evaluation methods and responsive light/dark styling.
- Automatic D20 interception is not included in this version.


## 0.1.5

- Removed the redundant Private (roller + GM) roll visibility option; legacy `gmroll` settings map to Self.
- Forced all NPC roll requests to Blind · GM only and locked NPC visibility selectors to that mode.
- Added a post-roll-configuration safeguard that applies the mode selected in the roll prompt to the native D&D 5e D20Roll, including its actual d20 die configuration.
- Detects native actor roll advantage/disadvantage modes for prompt preselection, including skill-, ability-, and tool-level roll mode fields.
- Replaced the main-screen Roll for NPCs action with compact Add all Players and Add all NPCs icon buttons; these select actors without initiating a roll.


## 0.1.7
- Fixed duplicate `hideInternalMessages` declaration which prevented v0.1.6 from loading.
- Avoided ApplicationV2 native tab action collision by renaming the Players/NPCs switch action.
- Replaced CSS transform-based scaling with Foundry v14 ApplicationV2 `position.scale`, including drag bounds derived from the same native position model.
- Added configurable `Start GM interface collapsed` setting (enabled by default).
- Made Add all Players / Add all NPCs buttons toggle their respective selection sets.
- Preserved explicit whisper recipients for transport and player summary messages so PC public results can be delivered to every eligible Observer, while Self/Blind results remain filtered.
- Added expandable per-character result rows showing native roll formula, term breakdown, active/discarded d20s, advantage mode, roll target, and totals.
- Improved separation and color contrast of GM-only group PASS/FAIL outcomes.


## 0.2.1

- Fixed a Midi-QoL compatibility regression found in the first Phase 2 test: native actor roll methods are now wrapped with libWrapper instead of being assigned directly, avoiding non-libWrapper overwrites.
- Rolls carrying Midi-QoL workflow context or a chat-card origin are delegated to Midi-QoL, so its target-save request/response path and downstream damage/effect handling can complete normally.
- Direct/manual supported D20 rolls remain eligible for Roll Director automatic interception.
- Known limitation: multi-target saving throws inside Midi-QoL workflows do not yet use the grouped Roll Director prompt. A dedicated Midi workflow adapter is still required to support that without breaking Midi's save lifecycle.
