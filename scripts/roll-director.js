const MODULE_ID = "roll-director";
const TRANSPORT_FLAG = "transport";
const SUMMARY_FLAG = "playerSummary";
const GM_SUMMARY_FLAG = "gmSummary";

const ROLL_MODES = [
  { value: "publicroll", label: "Public" },
  { value: "blindroll", label: "Blind · GM only" },
  { value: "selfroll", label: "Self · roller + GM" }
];

const LEGACY_ROLL_MODE_MAP = { gmroll: "selfroll" };
const activeRollModeOverrides = new Map();
// Short-lived fallback for Midi-QoL chat/dice operations that are created after the native actor roll resolves.
const recentRollSecurityMarkers = new Map();
const handledDiceAnimationKeys = new Set();
const pendingInterceptRolls = new Map();
const midiWorkflowBypassNotices = new Set();
// Midi-QoL workflow requests are coordinated before its target-save queue begins. The
// same native target roll remains responsible for producing the Roll object Midi awaits.
const midiWorkflowContexts = new Map();
const midiWorkflowModeValues = new Map();
const midiWorkflowModeWaiters = new Map();
const midiWorkflowOriginRequests = new Map();
const midiWorkflowStartWaiters = new Map();
const midiPromptReadiness = new Map();
const midiWorkflowReadyTimeoutMs = 12000;
const midiWorkflowDecisionTimeoutMs = 180000;
const automaticRequestBuckets = new Map();
const automaticRequestQueue = [];
const disconnectedActorTimers = new Map();
const disconnectedInitiatorTimers = new Map();
const disconnectRecoveryGraceMs = 60000;
const initiativeRollsByActor = new Map();
// The D&D 5e pre-roll hook exposes the cached, unevaluated roll. Capture the evaluated
// Roll from the internal Combat message when available, and retain final combatant scores
// as a fallback so summaries never mistake an unevaluated Roll.total (often 0) for a result.
const initiativeScoresByActor = new Map();
const pendingCombatantInitiativeBatches = new Map();
const combatantInitiativeBatchDelayMs = 500;
let diceSoNicePrivacyWrapped = false;
const runtimeStatus = {
  midiHooksRegistered: false,
  nativeRollInterceptors: new Set(),
  nativeRollInterceptorAttempts: new Set(),
  combatInitiativeInterceptorAttempted: false,
  combatInitiativeInterceptorRegistered: false,
  diceSoNicePrivacyWrapped: false
};

function normalizeRollMode(mode) {
  const normalized = LEGACY_ROLL_MODE_MAP[mode] ?? mode;
  return ROLL_MODES.some(option => option.value === normalized) ? normalized : "publicroll";
}

const GROUP_METHODS = [
  { value: "standard", label: "Standard Rule · half must succeed" },
  { value: "average", label: "Group Average · rounded up" },
  { value: "leader", label: "Leader with Help" },
  { value: "weakest", label: "Weakest Link" }
];

const DC_PRESETS = [5, 10, 12, 13, 15, 18, 20, 25, 30];
const activeRequests = new Map();
let managerApp;
let playerPromptApp;
let gmPromptApp;
let currentPromptRequestId = null;

function isGM() {
  return !!game.user?.isGM;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function documentImage(actor) {
  return actor?.img || actor?.prototypeToken?.texture?.src || "icons/svg/mystery-man.svg";
}

function isCharacter(actor) {
  return actor?.type === "character" || actor?.system?.isCharacter === true;
}

function isNPC(actor) {
  return actor?.type === "npc" || actor?.system?.isNPC === true;
}

function testPermission(actor, user, level) {
  if (!actor || !user) return false;
  try {
    return actor.testUserPermission(user, level);
  } catch (err) {
    return false;
  }
}

function hasObserver(actor, user) {
  return testPermission(actor, user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER ?? "OBSERVER");
}

function hasOwner(actor, user) {
  return testPermission(actor, user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER ?? "OWNER");
}

function hasPlayerOwner(actor) {
  return !!actor && getPlayerUsers().some(user => hasOwner(actor, user));
}

function getPrimaryPartyMemberActors() {
  const party = game.actors?.party;
  if (!party) return [];
  const members = party.system?.members ?? party.members ?? [];
  return [...members]
    .map(member => member?.actor ?? member)
    .filter(actor => actor && (isCharacter(actor) || isNPC(actor)));
}

function isPrimaryPartyMember(actor) {
  if (!actor) return false;
  return getPrimaryPartyMemberActors().some(member => member.uuid === actor.uuid);
}

function isPartyMinion(actor) {
  return isNPC(actor) && isPrimaryPartyMember(actor);
}

function isPlayerControlledActor(actor) {
  // Primary Party NPC minions follow player-actor roll semantics even when no User.character
  // is assigned. Player prompts still require Owner permission per recipient.
  return isCharacter(actor) || isPartyMinion(actor) || hasPlayerOwner(actor);
}

function isAutomaticallyEligibleActor(actor) {
  return !!actor && isPlayerControlledActor(actor);
}

function isPrivateNPC(actor) {
  return isNPC(actor) && !isPlayerControlledActor(actor);
}

function getPlayerUsers() {
  return game.users?.filter(user => !user.isGM) ?? [];
}

function actorLabel(actor) {
  const partyMinion = isPartyMinion(actor);
  const type = isCharacter(actor) ? "Player Character" : (partyMinion ? "Party Minion" : "NPC");
  return {
    type,
    isNPC: isNPC(actor),
    isPC: isCharacter(actor) || partyMinion || hasPlayerOwner(actor),
    isPartyMinion: partyMinion
  };
}

function getPartyActors() {
  return getPrimaryPartyMemberActors().map(actor => {
    const token = isNPC(actor)
      ? (canvas?.tokens?.placeables?.find(entry => entry.actor?.uuid === actor.uuid) ?? null)
      : null;
    return actorCard(actor, token);
  });
}

function findCanvasToken(tokenUuid) {
  if (!tokenUuid || !canvas?.tokens?.placeables) return null;
  return canvas.tokens.placeables.find(token =>
    token?.document?.uuid === tokenUuid || token?.uuid === tokenUuid || token?.document?.id === tokenUuid
  ) ?? null;
}

function actorDisplayName(actor, token = null) {
  if (!actor) return "Unknown Actor";
  const clean = value => typeof value === "string" ? value.trim() : "";
  // Character names in Roll Director should match the name configured on the character's
  // prototype token, which is the name players see on the canvas.
  if (isCharacter(actor)) {
    return clean(actor.prototypeToken?.name ?? actor._source?.prototypeToken?.name) || clean(actor.name) || "Unknown Actor";
  }
  // NPC names are scene-specific: use the placed Token's name rather than the shared
  // Actor/Profile name so two differently named tokens using the same profile are clear.
  const tokenName = clean(token?.name) || clean(token?.document?.name) || clean(token?._source?.name);
  return tokenName || clean(actor.name) || "Unknown Actor";
}

function getCanvasNPCs() {
  if (!canvas?.ready || !canvas.tokens?.placeables) return [];
  const seen = new Set();
  const actors = [];
  for (const token of canvas.tokens.placeables) {
    const actor = token.actor;
    // Primary Party minions are already represented in the Players roster.
    if (!actor || !isNPC(actor) || isPartyMinion(actor)) continue;
    const uuid = actor.uuid;
    // Keep actor-based de-duplication: the current request protocol addresses roll
    // participants by Actor UUID. Unlinked token instances have distinct synthetic actors.
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    actors.push(actorCard(actor, token));
  }
  return actors.sort((a, b) => a.name.localeCompare(b.name));
}

function actorCard(actor, token = null) {
  const { type, isNPC: npc, isPC, isPartyMinion: partyMinion } = actorLabel(actor);
  return {
    uuid: actor.uuid,
    id: actor.id,
    tokenUuid: token?.document?.uuid ?? token?.uuid ?? null,
    name: actorDisplayName(actor, token),
    img: documentImage(actor),
    type,
    isNPC: npc,
    isPC,
    isPartyMinion: partyMinion,
    permission: actor.ownership ?? {},
    actor
  };
}

function configEntryLabel(data, value) {
  // D&D 5e config entries can be either a localization key/object or a plain display string.
  const label = typeof data === "string" ? data : (data?.label ?? data?.name ?? value);
  return game.i18n.localize(label);
}

// D&D 5e tool config entries commonly store an ability and compendium UUID rather than
// a label. Prefer the actual compendium Item name, then fall back to familiar display names.
const TOOL_LABEL_CACHE = new Map();
const TOOL_LABEL_FALLBACKS = {
  alchemist: "Alchemist's Supplies", bagpipes: "Bagpipes", bandore: "Bandore",
  birdpipes: "Birdpipes", brewer: "Brewer's Supplies", calligrapher: "Calligrapher's Supplies",
  card: "Playing Card Set", carpenter: "Carpenter's Tools", cartographer: "Cartographer's Tools",
  chess: "Chess Set", cittern: "Cittern", clarinet: "Clarinet", cobbler: "Cobbler's Tools",
  cook: "Cook's Utensils", dice: "Dice Set", disg: "Disguise Kit", drum: "Drum",
  dulcimer: "Dulcimer", excavator: "Excavator's Tools", fiddle: "Fiddle", flute: "Flute",
  forg: "Forgery Kit", glassblower: "Glassblower's Tools", glaur: "Glaur", herb: "Herbalism Kit",
  handdrum: "Hand Drum", harp: "Harp", horn: "Horn", jeweler: "Jeweler's Tools",
  leatherworker: "Leatherworker's Tools", longhorn: "Longhorn", lute: "Lute", lyre: "Lyre",
  mason: "Mason's Tools", navg: "Navigator's Tools", painter: "Painter's Supplies",
  panflute: "Pan Flute", pipe: "Pipe", pois: "Poisoner's Kit", potter: "Potter's Tools",
  research: "Research Scrolls", shawm: "Shawm", smith: "Smith's Tools", songhorn: "Songhorn",
  surgeon: "Surgeon's Tools", tantan: "Tantan", thelarr: "Thelarr", thellarr: "Thellarr",
  thief: "Thieves' Tools", tinker: "Tinker's Tools", token: "Token", trumpet: "Trumpet",
  viol: "Viol", wargong: "Wargong", weaver: "Weaver's Tools", woodcarver: "Woodcarver's Tools",
  yarting: "Yarting", zulkoon: "Zulkoon", analysis: "Analysis Tools",
  fingerprint: "Fingerprint Kit", monsterharvesting: "Monster Harvesting Tools"
};

function humanizeToolIdentifier(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (TOOL_LABEL_FALLBACKS[normalized]) return TOOL_LABEL_FALLBACKS[normalized];
  const words = String(value ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").trim();
  if (!words) return "Unknown Tool";
  return words.replace(/\b\w/g, letter => letter.toUpperCase());
}

function toolDisplayLabel(value, data = CONFIG.DND5E?.tools?.[value]) {
  if (TOOL_LABEL_CACHE.has(value)) return TOOL_LABEL_CACHE.get(value);
  if (data && (typeof data === "string" || data.label || data.name)) {
    const label = configEntryLabel(data, value);
    if (label && label !== value) return label;
  }
  return humanizeToolIdentifier(value);
}

async function resolveToolDisplayLabel(value, data) {
  if (data && (typeof data === "string" || data.label || data.name)) {
    const directLabel = configEntryLabel(data, value);
    if (directLabel && directLabel !== value) {
      TOOL_LABEL_CACHE.set(value, directLabel);
      return directLabel;
    }
  }
  if (data?.id && typeof fromUuid === "function") {
    try {
      const item = await fromUuid(data.id);
      const itemName = item?.name ? game.i18n.localize(item.name) : "";
      if (itemName && itemName !== data.id) {
        TOOL_LABEL_CACHE.set(value, itemName);
        return itemName;
      }
    } catch (error) {
      // Custom tools may point to unavailable items; use a readable fallback.
    }
  }
  const label = toolDisplayLabel(value, data);
  TOOL_LABEL_CACHE.set(value, label);
  return label;
}

function getAbilityOptions() {
  return Object.entries(CONFIG.DND5E?.abilities ?? {}).map(([value, data]) => ({
    value, label: configEntryLabel(data, value), selected: false
  }));
}

function getSkillOptions() {
  return Object.entries(CONFIG.DND5E?.skills ?? {}).map(([value, data]) => ({
    value, label: configEntryLabel(data, value), selected: false
  }));
}

function getToolOptions() {
  return Object.entries(CONFIG.DND5E?.tools ?? {}).map(([value, data]) => {
    const label = toolDisplayLabel(value, data);
    return { value, label, selected: false, category: toolCategory(label, value) };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
}

function toolCategory(label, identifier = "") {
  const key = String(identifier).toLowerCase();
  const text = `${label} ${identifier}`.toLowerCase();
  const instruments = new Set(["bagpipes", "bandore", "birdpipes", "cittern", "clarinet", "drum", "dulcimer", "fiddle", "flute", "glaur", "handdrum", "harp", "horn", "longhorn", "lute", "lyre", "panflute", "pipe", "shawm", "songhorn", "tantan", "thelarr", "thellarr", "trumpet", "viol", "wargong", "yarting", "zulkoon"]);
  const gamingSets = new Set(["card", "chess", "dice", "three-dragon-ante", "token", "bowls", "darts", "quoits", "whistle-stick"]);
  const vehicles = new Set(["airvehicle", "landvehicle", "spacevehicle", "watervehicle", "air-vehicle", "land-vehicle", "space-vehicle", "water-vehicle"]);
  if (instruments.has(key) || /musical instrument|bagpipe|bandore|birdpipe|cittern|clarinet|dulcimer|fiddle|flute|glaur|hand drum|harp|horn|lute|lyre|shawm|songhorn|tantan|thellarr|viol|wargong|yarting|zulkoon|drum|trumpet|pan flute/.test(text)) return "Musical Instruments";
  if (gamingSets.has(key) || /gaming|chess set|dice set|playing card|three dragon|whistle.stick|bowls|quoits|darts|token/.test(text)) return "Gaming Sets";
  if (vehicles.has(key) || /vehicle/.test(text)) return "Vehicles";
  if (/kit|tools|supplies|artisan|carpenter|cartographer|cobbler|cook|glassblower|jeweler|leatherworker|mason|painter|potter|smith|tinker|weaver|woodcarver|alchemist|brewer|calligrapher/.test(text)) return "Artisan's Tools";
  return "Other Tools";
}

function getSubtypeOptions(rollType, selectedValue) {
  let items = [];
  if (["ability", "save"].includes(rollType)) items = getAbilityOptions();
  else if (rollType === "skill") items = getSkillOptions();
  else if (rollType === "tool") items = getToolOptions();
  if (!items.some(item => item.value === selectedValue) && items.length) selectedValue = items[0].value;
  return items.map(item => ({ ...item, selected: item.value === selectedValue }));
}

function rollTypeLabel(rollType) {
  return ({
    ability: "Ability Check",
    save: "Saving Throw",
    skill: "Skill Check",
    tool: "Tool Check",
    death: "Death Saving Throw",
    initiative: "Initiative",
    concentration: "Concentration Check"
  })[rollType] ?? "D20 Roll";
}

function subtypeLabel(rollType, subtype) {
  let lookup = {};
  if (["ability", "save", "concentration"].includes(rollType)) lookup = CONFIG.DND5E?.abilities ?? {};
  else if (rollType === "skill") lookup = CONFIG.DND5E?.skills ?? {};
  else if (rollType === "tool") lookup = CONFIG.DND5E?.tools ?? {};
  if (!subtype || rollType === "death" || rollType === "initiative") return "";
  const entry = lookup?.[subtype];
  if (rollType === "tool") return toolDisplayLabel(subtype, entry);
  return entry ? configEntryLabel(entry, subtype) : subtype;
}

function getRelevantModifier(actor, request) {
  const key = request.subtype;
  if (["ability", "save"].includes(request.rollType)) {
    const ability = actor.system?.abilities?.[key];
    if (request.rollType === "save") {
      const save = ability?.save;
      if (Number.isFinite(save?.total)) return save.total;
      if (Number.isFinite(save?.mod)) return save.mod;
    }
    if (Number.isFinite(ability?.mod)) return ability.mod;
  }
  if (request.rollType === "skill") {
    const skill = actor.system?.skills?.[key];
    if (Number.isFinite(skill?.total)) return skill.total;
    if (Number.isFinite(skill?.mod)) return skill.mod;
    if (Number.isFinite(skill?.value)) return skill.value;
  }
  if (request.rollType === "tool") {
    const tool = actor.system?.tools?.[key];
    if (Number.isFinite(tool?.total)) return tool.total;
    if (Number.isFinite(tool?.mod)) return tool.mod;
    if (Number.isFinite(tool?.value)) return tool.value;
  }
  return null;
}

function getRollNatural(roll) {
  const terms = roll?.terms ?? roll?.data?.terms ?? [];
  const die = roll?.d20 ?? terms.find(term => Number(term?.faces) === 20 && Array.isArray(term?.results));
  const result = die?.results?.find(entry => entry.active !== false && !entry.discarded) ?? die?.results?.[0];
  return Number.isFinite(result?.result) ? result.result : null;
}

function hasEvaluatedRollData(roll) {
  if (!roll) return false;
  if (roll._evaluated === true || roll.evaluated === true) return true;
  const terms = roll.terms ?? roll.data?.terms ?? roll._source?.terms ?? [];
  return terms.some(term => Array.isArray(term?.results ?? term?._source?.results)
    && (term.results ?? term._source.results).some(result => Number.isFinite(Number(result?.result))));
}

function restoreChatRoll(rawRoll) {
  if (!rawRoll) return null;
  if (typeof rawRoll !== "string") return rawRoll;
  // Foundry 14 stores ChatMessage rolls as JSON strings. Reading `.total` and `.terms`
  // directly from that string silently fails, which was why the initiative summary fell
  // back to the stored score and had no d20 faces. Rehydrate it using Foundry's Roll API.
  try {
    if (globalThis.Roll?.fromJSON) return globalThis.Roll.fromJSON(rawRoll);
  } catch (_) { /* try the unpacked data path below */ }
  try {
    const data = JSON.parse(rawRoll);
    if (globalThis.Roll?.fromData) return globalThis.Roll.fromData(data);
  } catch (_) { /* the source may be a legacy/unsupported roll serialization */ }
  return null;
}

function captureEvaluatedInitiativeRolls(document, data) {
  const rawValue = data?.rolls ?? document?.rolls ?? [];
  const rawRolls = Array.isArray(rawValue) ? rawValue : (rawValue?.contents ?? []);
  // Custom Roll options may be omitted during serialization. Only use the active/recent
  // actor marker when this message contains exactly one Roll; never guess the actor for a
  // multi-roll message whose individual rolls have no marker.
  const fallbackMarker = rawRolls.length === 1 ? getRollDirectorMarkerFromMessage(document, data) : null;
  for (const rawRoll of rawRolls) {
    const roll = restoreChatRoll(rawRoll);
    if (!roll) continue;
    const options = roll?.options ?? roll?.data?.options ?? roll?._source?.options ?? {};
    const marker = options.rollDirector?.actorUuid ? options.rollDirector : fallbackMarker;
    if (!marker?.actorUuid || !initiativeRollsByActor.has(marker.actorUuid)) continue;
    if (roll.total === null || roll.total === undefined || !Number.isFinite(Number(roll.total))
        || !hasEvaluatedRollData(roll)) continue;
    initiativeRollsByActor.set(marker.actorUuid, roll);
  }
}

function recordInitiativeScores(actor, combatants) {
  if (!actor?.uuid || !combatants) return;

  // Some system builds retain the evaluated roll on the actor cache at this point. D&D 5e
  // commonly clones that cached roll before evaluation, so the serialized ChatMessage roll
  // capture above is the primary path for recovering the actual d20 terms. This is a safe
  // supplemental path only when the cache itself is evaluated and marked by our request.
  const evaluatedRoll = actor._cachedInitiativeRoll ?? null;
  const marker = evaluatedRoll?.options?.rollDirector;
  if (marker?.actorUuid === actor.uuid
      && hasEvaluatedRollData(evaluatedRoll)
      && Number.isFinite(evaluatedRoll.total)) {
    initiativeRollsByActor.set(actor.uuid, evaluatedRoll);
  }

  const entries = Array.isArray(combatants) ? combatants : [...combatants];
  const scores = new Map();
  for (const combatant of entries) {
    if (!combatant?.id || !Number.isFinite(combatant.initiative)) continue;
    scores.set(combatant.id, Number(combatant.initiative));
  }
  if (scores.size) initiativeScoresByActor.set(actor.uuid, scores);
}

function resolveInitiativeRollForActor(actor, actorRequestData, combatResult = null) {
  const cached = initiativeRollsByActor.get(actor.uuid) ?? null;
  initiativeRollsByActor.delete(actor.uuid);
  if (hasEvaluatedRollData(cached) && Number.isFinite(Number(cached.total))) {
    initiativeScoresByActor.delete(actor.uuid);
    return cached;
  }

  const combat = (actorRequestData?.combatUuid ? fromUuidSync(actorRequestData.combatUuid) : null)
    ?? combatResult ?? game.combat ?? null;
  let combatant = actorRequestData?.combatantId
    ? combat?.combatants?.get?.(actorRequestData.combatantId)
    : null;
  if (!combatant && actorRequestData?.targetTokenUuid) {
    combatant = [...(combat?.combatants ?? [])].find(entry => combatantTokenUuid(entry) === actorRequestData.targetTokenUuid) ?? null;
  }
  if (!combatant) {
    combatant = [...(combat?.combatants ?? [])].find(entry => entry.actor?.uuid === actor.uuid) ?? null;
  }
  const recordedScores = initiativeScoresByActor.get(actor.uuid);
  const score = (actorRequestData?.combatantId && recordedScores?.has(actorRequestData.combatantId))
    ? recordedScores.get(actorRequestData.combatantId)
    : combatant?.initiative;
  initiativeScoresByActor.delete(actor.uuid);
  if (!Number.isFinite(Number(score)) || score === null || score === undefined) return null;

  // Fallback only for summary data; the native Combat workflow remains responsible for
  // updating the Combatant initiative. Don't invent a natural d20 or breakdown when only
  // the final stored initiative score is available.
  return {
    formula: cached?.formula ?? "Initiative",
    total: Number(score),
    options: cached?.options ?? {},
    terms: [],
    _evaluated: true
  };
}

function getInitiativeDexTiebreaker(actor) {
  if (!actor) return null;
  try {
    if (!game.settings.get("dnd5e", "initiativeDexTiebreaker")) return null;
  } catch (_) { return null; }
  const abilityId = actor.system?.attributes?.init?.ability
    || CONFIG.DND5E?.defaultAbilities?.initiative
    || "dex";
  const abilityScore = Number(actor.system?.abilities?.[abilityId]?.value);
  return Number.isFinite(abilityScore) && abilityScore > 0 ? abilityScore / 100 : null;
}

function isRollOperatorTerm(term) {
  const typeName = String(term?.constructor?.name ?? term?.class ?? "");
  if (/OperatorTerm/i.test(typeName)) return true;
  const operator = String(term?.operator ?? term?.formula ?? term?.toString?.() ?? "").trim();
  return ["+", "-", "*", "/", "%", "**"].includes(operator);
}

function isInitiativeTiebreakerTerm(term, tiebreaker) {
  if (!term || !Number.isFinite(tiebreaker) || isRollOperatorTerm(term)) return false;
  const candidates = [term.total, term.number, term.value, term.formula, term.expression, term.toString?.()];
  return candidates.some(value => value !== null && value !== undefined && value !== ""
    && Number.isFinite(Number(value)) && Math.abs(Number(value) - tiebreaker) < 1e-5);
}

function serializeRollDetail(roll, request = null, actor = null) {
  if (!roll) return null;
  let rawTerms = [...(roll.terms ?? roll.data?.terms ?? roll._source?.terms ?? [])];

  // The system's DEX / 100 tiebreaker must remain in the actual Combatant initiative, but
  // it is not part of the human-facing roll detail. Remove only an exact matching final
  // numeric term (and its preceding + operator, when represented as a separate RollTerm).
  if (request?.rollType === "initiative") {
    const tiebreaker = getInitiativeDexTiebreaker(actor);
    let lastIndex = rawTerms.length - 1;
    while (lastIndex >= 0 && isRollOperatorTerm(rawTerms[lastIndex])) {
      const operator = String(rawTerms[lastIndex]?.operator ?? rawTerms[lastIndex]?.formula ?? rawTerms[lastIndex]?.toString?.() ?? "").trim();
      if (operator !== "+") break;
      lastIndex--;
    }
    if (lastIndex >= 0 && isInitiativeTiebreakerTerm(rawTerms[lastIndex], tiebreaker)) {
      rawTerms.splice(lastIndex, 1);
      const previous = rawTerms[lastIndex - 1];
      if (isRollOperatorTerm(previous)) {
        const operator = String(previous?.operator ?? previous?.formula ?? previous?.toString?.() ?? "").trim();
        if (operator === "+") rawTerms.splice(lastIndex - 1, 1);
      }
    }
  }

  const terms = rawTerms.slice(0, 50).map(term => {
    const rawResults = term.results ?? term._source?.results;
    const results = Array.isArray(rawResults) ? rawResults.slice(0, 100).map(result => ({
      result: Number.isFinite(result?.result) ? Number(result.result) : null,
      active: result?.active !== false,
      discarded: !!result?.discarded,
      // Summary rows are only generated for users authorized to see this roll.
      // Do not treat Foundry's internal result.hidden marker as a redaction rule here;
      // it was rendering both valid d20 faces as "?" in the authorized detail view.
      hidden: false
    })) : [];
    return {
      type: String(term?.constructor?.name ?? "Term"),
      formula: String(term?.formula ?? term?.toString?.() ?? ""),
      flavor: String(term?.options?.flavor ?? term?.flavor ?? ""),
      total: Number.isFinite(term?.total) ? Number(term.total) : null,
      modifiers: Array.isArray(term?.modifiers) ? term.modifiers.slice(0, 30).map(String) : [],
      results
    };
  });
  return {
    formula: String(roll.formula ?? "1d20"),
    total: Number.isFinite(roll.total) ? Number(roll.total) : null,
    advantageMode: Number.isFinite(roll.options?.advantageMode) ? Number(roll.options.advantageMode) : null,
    options: {
      elvenAccuracy: !!roll.options?.elvenAccuracy,
      reliableTalent: !!roll.options?.reliableTalent,
      target: Number.isFinite(roll.options?.target) ? Number(roll.options.target) : null
    },
    terms
  };
}

function getSummaryDisplayFormula(request, result, formula) {
  const rawFormula = String(formula ?? result?.formula ?? "1d20");
  if (request?.rollType !== "initiative" || getSummaryDisplayTotal(request, result) === Number(result?.total)) return rawFormula;

  // The DEX tiebreaker is a sorting fraction, not a visible d20 result. Remove only the
  // final additive term when it exactly matches the configured initiative ability / 100.
  try {
    if (!game.settings.get("dnd5e", "initiativeDexTiebreaker")) return rawFormula;
  } catch (_) { return rawFormula; }
  const actor = result?.actorUuid ? fromUuidSync(result.actorUuid) : null;
  const abilityId = actor?.system?.attributes?.init?.ability
    || CONFIG.DND5E?.defaultAbilities?.initiative
    || "dex";
  const abilityScore = Number(actor?.system?.abilities?.[abilityId]?.value);
  if (!Number.isFinite(abilityScore) || abilityScore <= 0) return rawFormula;
  const tiebreaker = abilityScore / 100;
  const parts = rawFormula.split(/\s+\+\s+/);
  if (parts.length < 2 || !Number.isFinite(Number(parts.at(-1)))
      || Math.abs(Number(parts.at(-1)) - tiebreaker) > 1e-5) return rawFormula;
  return parts.slice(0, -1).join(" + ");
}

function renderRollDetailHTML(result, showTarget = true, request = null) {
  const detail = result.rollDetail;
  const displayFormula = getSummaryDisplayFormula(request, result, detail?.formula ?? result.formula ?? "1d20");
  const summaryTotal = getSummaryDisplayTotal(request, result);
  if (!detail) {
    return `<div class="rd-roll-detail"><div class="rd-detail-formula"><span>Formula</span><code>${escapeHTML(displayFormula)}</code></div></div>`;
  }
  const terms = (detail.terms ?? []).map(term => {
    const label = term.flavor ? `${term.flavor} · ${term.formula}` : (term.formula || term.type || "Roll term");
    const dice = (term.results ?? []).filter(die => die.result !== null).map(die => {
      const state = die.discarded ? "discarded" : (die.active ? "kept" : "inactive");
      const title = die.discarded ? "Discarded die" : (die.active ? "Kept die" : "Inactive die");
      return `<span class="rd-detail-die ${state}" title="${title}">${die.hidden ? "?" : escapeHTML(die.result)}</span>`;
    }).join("");
    const modifiers = (term.modifiers ?? []).length
      ? `<span class="rd-detail-modifiers">${escapeHTML(term.modifiers.join(" · "))}</span>` : "";
    const termTotal = Number.isFinite(term.total) ? `<strong>${Number(term.total)}</strong>` : "";
    return `<div class="rd-detail-term"><div class="rd-detail-term-copy"><span>${escapeHTML(label)}</span>${modifiers}</div><div class="rd-detail-term-end">${dice}${termTotal}</div></div>`;
  }).join("");
  const mode = detail.advantageMode === 1 ? "Advantage" : detail.advantageMode === -1 ? "Disadvantage" : "Normal";
  const target = showTarget && Number.isFinite(detail.options?.target) ? `<span>Target ${Number(detail.options.target)}</span>` : "";
  const displayDetailTotal = request?.rollType === "initiative"
    ? summaryTotal
    : (Number.isFinite(detail.total) ? Number(detail.total) : Number(result.total));
  return `<div class="rd-roll-detail"><div class="rd-detail-formula"><span>Formula</span><code>${escapeHTML(displayFormula)}</code></div><div class="rd-detail-terms">${terms}</div><div class="rd-detail-footer"><span>${escapeHTML(mode)}</span>${target}<strong>Total ${displayDetailTotal}</strong></div></div>`;
}

function rollResultPayload(rolls, actor, request, mode, userId) {
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  if (!roll || !Number.isFinite(roll.total)) return null;
  const natural = getRollNatural(roll);
  const calculatedModifier = getRelevantModifier(actor, request);
  return {
    total: Number(roll.total),
    natural,
    modifier: Number.isFinite(calculatedModifier) ? calculatedModifier : (natural == null ? 0 : Number(roll.total) - natural),
    mode,
    formula: String(roll.formula ?? "1d20"),
    rollDetail: serializeRollDetail(roll, request, actor),
    rollerUserId: userId,
    isCritical: !!roll.isCritical,
    isFumble: !!roll.isFumble
  };
}

function getRollModeLabel(mode) {
  return ({
    publicroll: "Public",
    blindroll: "Blind · GM only",
    selfroll: "Self · roller + GM",
    // Backward compatibility for any in-memory request started before updating.
    gmroll: "Self · roller + GM"
  })[mode] ?? mode;
}

function resolveDefaultMode(actor, requestedMode, fallbackMode = null) {
  // Ordinary NPC checks are always Self (roller + GM). Primary Party minions use
  // player-actor visibility semantics, while prompts still require Owner permission.
  if (isNPC(actor) && !isPlayerControlledActor(actor)) return "selfroll";
  if (requestedMode && requestedMode !== "auto") return normalizeRollMode(requestedMode);
  return normalizeRollMode(fallbackMode ?? game.settings.get(MODULE_ID, "defaultRollMode") ?? "publicroll");
}

function getNativeAdvantageMode(actor, rollType, subtype) {
  const system = actor?.system;
  if (!system || (!subtype && !["death", "initiative"].includes(rollType))) return "normal";
  let paths = [];
  if (rollType === "death") {
    paths = ["attributes.death.roll", "rolls.ability.save"];
  } else if (rollType === "concentration") {
    const ability = subtype || system.attributes?.concentration?.ability || CONFIG.DND5E?.defaultAbilities?.concentration || "con";
    paths = [`abilities.${ability}.save.roll`, "rolls.ability.save", "attributes.concentration.roll"];
  } else if (rollType === "initiative") {
    const ability = system.attributes?.init?.ability || CONFIG.DND5E?.defaultAbilities?.initiative || "dex";
    paths = [`abilities.${ability}.check.roll`, "attributes.init.roll", "rolls.ability.check"];
  } else if (rollType === "ability") {
    paths = [`abilities.${subtype}.check.roll`, "rolls.ability.check"];
  } else if (rollType === "save") {
    paths = [`abilities.${subtype}.save.roll`, "rolls.ability.save"];
  } else if (rollType === "skill" || rollType === "tool") {
    const collection = rollType === "skill" ? system.skills : system.tools;
    const config = rollType === "skill" ? CONFIG.DND5E?.skills?.[subtype] : CONFIG.DND5E?.tools?.[subtype];
    const ability = collection?.[subtype]?.ability ?? config?.ability ?? "int";
    paths = [
      `abilities.${ability}.check.roll`,
      "rolls.ability.check",
      `rolls.ability.${rollType}`,
      `${rollType === "skill" ? "skills" : "tools"}.${subtype}.roll`
    ];
  }
  let hasAdvantage = false;
  let hasDisadvantage = false;
  for (const path of paths) {
    const field = foundry.utils.getProperty(system, path);
    // Read the resolved value of each field, not its raw source counts. A single field
    // can contain both advantage and disadvantage sources that already cancel each other.
    const value = Number(field?.mode);
    if (value === 1) hasAdvantage = true;
    else if (value === -1) hasDisadvantage = true;
  }
  if (hasAdvantage === hasDisadvantage) return "normal";
  return hasAdvantage ? "advantage" : "disadvantage";
}

function resolvePromptAdvantage(actor, rollType, subtype, actorOverride, globalMode) {
  if (actorOverride && actorOverride !== "auto") return actorOverride;
  if (globalMode && globalMode !== "normal") return globalMode;
  return getNativeAdvantageMode(actor, rollType, subtype);
}

function applyRequestedRollMode(rolls, config) {
  const actor = config?.subject;
  const request = actor && activeRollModeOverrides.get(actor.uuid);
  if (!request || Date.now() - request.createdAt > 30000) return;
  const hooks = (config?.hookNames ?? []).map(name => String(name).toLowerCase());
  const expectedHooks = ({
    ability: ["abilitycheck"],
    save: ["savingthrow"],
    skill: ["skill"],
    tool: ["tool"]
  })[request.rollType] ?? [];
  if (expectedHooks.length && !expectedHooks.some(name => hooks.includes(name))) return;
  const advantageMode = request.mode === "advantage" ? 1 : request.mode === "disadvantage" ? -1 : 0;
  for (const roll of rolls ?? []) {
    if (!roll?.d20 || typeof roll.configureModifiers !== "function") continue;
    // The prompt choice is the final displayed mode. Reconfigure the native D20Roll
    // after D&D 5e/Midi-QoL have prepared it, so the selected mode changes actual dice.
    roll.options.configured = false;
    roll.options.advantage = advantageMode === 1;
    roll.options.disadvantage = advantageMode === -1;
    roll.options.advantageMode = advantageMode;
    roll.options.rollMode = (request.privateNPC ?? request.isNPC ?? isNPC(actor)) ? "selfroll" : normalizeRollMode(request.rollMode);
    roll.options.rollDirector = {
      requestId: request.requestId,
      actorUuid: actor.uuid,
      actorId: actor.id,
      isNPC: request.isNPC ?? isNPC(actor),
      privateNPC: request.privateNPC ?? request.isNPC ?? isNPC(actor),
      isPC: request.isPC ?? isCharacter(actor),
      rollMode: (request.privateNPC ?? request.isNPC ?? isNPC(actor)) ? "selfroll" : normalizeRollMode(request.rollMode),
      rollerUserId: request.rollerUserId ?? game.user.id
    };
    roll.configureModifiers();
  }
}

function canUserSeeResult(result, actor, user) {
  if (user.isGM) return true;
  // GM-only NPC participation is never player-visible. Player-controlled NPCs may be visible
  // to users with Observer rights, according to the configured roll mode.
  if (result.privateNPC ?? result.isNPC ?? isNPC(actor)) return false;
  const mode = result.rollMode ?? "publicroll";
  if (mode === "blindroll") return false;
  if (mode === "publicroll") return hasObserver(actor, user);
  if (mode === "gmroll") return hasOwner(actor, user) || user.id === result.rollerUserId;
  if (mode === "selfroll") return user.id === result.rollerUserId;
  return false;
}

function getSummaryDisplayTotal(request, result) {
  const total = Number(result?.total);
  if (!Number.isFinite(total) || request?.rollType !== "initiative") return total;

  // D&D 5e can add the selected initiative ability score / 100 as a sorting
  // tiebreaker. Keep that fractional value on the actual Combatant, but don't
  // expose it in the human-facing Roll Director summary.
  try {
    if (!game.settings.get("dnd5e", "initiativeDexTiebreaker")) return total;
  } catch (_) {
    return total;
  }

  const actor = result?.actorUuid ? fromUuidSync(result.actorUuid) : null;
  const abilityId = actor?.system?.attributes?.init?.ability
    || CONFIG.DND5E?.defaultAbilities?.initiative
    || "dex";
  const abilityScore = Number(actor?.system?.abilities?.[abilityId]?.value);
  if (!Number.isFinite(abilityScore) || abilityScore <= 0) return total;

  const tiebreaker = abilityScore / 100;
  // Normalize negative totals as well: -0.84 has a fractional component of 0.16.
  const fraction = total - Math.floor(total + 1e-8);
  if (Math.abs(fraction - tiebreaker) > 1e-5) return total;
  return Math.round(total - tiebreaker);
}

function makeRequestSummaryHTML(request, results, user, includeDC, groupResult = null, showOutcomes = includeDC) {
  const visible = results.filter(result => {
    const actor = fromUuidSync(result.actorUuid);
    return actor && canUserSeeResult(result, actor, user);
  });
  const npcs = visible.filter(result => !result.isPC);
  const pcs = visible.filter(result => result.isPC);
  const oneSection = (items, label) => {
    if (!items.length) return "";
    return `<section class="rd-summary-section"><h4>${label}</h4><div class="rd-summary-rows">${items.map(result => {
      const modeText = result.mode === "advantage" ? "<span class='rd-roll-tag rd-adv'>ADV</span>" : result.mode === "disadvantage" ? "<span class='rd-roll-tag rd-dis'>DIS</span>" : "";
      const hasDC = request.dc !== null && request.dc !== undefined && request.dc !== "" && Number.isFinite(Number(request.dc));
      const outcome = hasDC ? (Number(result.total) >= Number(request.dc) ? "success" : "failure") : "";
      const status = showOutcomes && hasDC
        ? `<span class="rd-result-state ${outcome}">${outcome === "success" ? "PASS" : "FAIL"}</span>`
        : `<span class="rd-result-state rd-result-state-empty" aria-hidden="true"></span>`;
      const summaryTotal = getSummaryDisplayTotal(request, result);
      const total = `<strong class="rd-result-total">${summaryTotal}</strong>`;
      const portrait = game.settings.get(MODULE_ID, "showPortraitsInChat")
        ? `<img src="${escapeHTML(result.img)}" alt="">`
        : `<span class="rd-result-portrait-placeholder" aria-hidden="true"></span>`;
      const modeSlot = `<span class="rd-roll-tag-slot">${modeText || `<span class="rd-roll-tag rd-roll-tag-empty" aria-hidden="true"></span>`}</span>`;
      return `<details class="rd-roll-entry"><summary class="rd-summary-row" title="Click to expand roll details">${portrait}<span class="rd-result-name">${escapeHTML(result.name)}</span>${modeSlot}${total}${status}<i class="rd-row-chevron fa-solid fa-chevron-down" aria-hidden="true"></i></summary>${renderRollDetailHTML(result, !!user.isGM, request)}</details>`;
    }).join("")}</div></section>`;
  };
  const resultModes = [...new Set(results.map(result => result.rollMode).filter(Boolean))];
  const modeLabel = resultModes.length === 1 ? getRollModeLabel(resultModes[0]) : resultModes.length > 1 ? "Mixed visibility" : getRollModeLabel(request.rollMode);
  const hasDC = request.dc !== null && request.dc !== undefined && request.dc !== "" && Number.isFinite(Number(request.dc));
  const metaParts = [
    hasDC ? `DC ${Number(request.dc)}` : "",
    request.subtypeLabel ?? "",
    modeLabel ?? ""
  ].filter(value => String(value).trim());
  const dc = includeDC && metaParts.length
    ? `<div class="rd-summary-meta">${metaParts.map(escapeHTML).join(" · ")}</div>` : "";
  return `<div class="roll-director-chat"><header><strong>${escapeHTML(request.typeLabel)}${request.subtypeLabel ? ` · ${escapeHTML(request.subtypeLabel)}` : ""}</strong>${dc}</header>${oneSection(npcs, "NPCs")}${oneSection(pcs, "Player Characters")}${includeDC ? renderGroupResult(groupResult) : ""}</div>`;
}

function createHiddenTransport(targetUserIds, transport) {
  const whisper = [...new Set(targetUserIds)].filter(Boolean);
  if (!whisper.length) return Promise.resolve(null);
  // Foundry v14 uses ChatMessage style values; CHAT_MESSAGE_TYPES is no longer exposed.
  return ChatMessage.create({
    content: "\u200b",
    style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
    whisper,
    blind: false,
    flags: {
      [MODULE_ID]: {
        [TRANSPORT_FLAG]: transport
      }
    }
  });
}

function getTransport(message) {
  return message?.getFlag?.(MODULE_ID, TRANSPORT_FLAG) ?? message?.flags?.[MODULE_ID]?.[TRANSPORT_FLAG] ?? null;
}

function hasManualWorkflowCardSignature(value) {
  // Check the distinctive synthetic Item title only. The D&D 5e card's title and
  // Activity body can be placed in different DOM subtrees, so requiring both strings
  // to occur in one .message-content node is too restrictive.
  const text = String(value ?? "")
    .replace(/&mdash;|&#8212;|&#x2014;/gi, "—")
    .replace(/&ndash;|&#8211;|&#x2013;/gi, "–")
    .replace(/\s+/g, " ");
  return /Roll Director\s*(?:—|–|-|\u2014|\u2013)\s*(?:Ability Check|Skill Check|Saving Throw)\b/i.test(text);
}

function getManualWorkflowItemData(document, data) {
  const flags = data?.flags ?? document?.flags ?? {};
  // Midi-QoL copies the source item into flags.midi-qol.itemData for synthetic
  // Activities. That is the reliable identifier: the rendered card title may not yet
  // exist in ChatMessage.content when preCreateChatMessage fires.
  const candidates = [
    flags?.["midi-qol"]?.itemData,
    flags?.["dnd5e"]?.itemData,
    flags?.[MODULE_ID]?.itemData
  ].filter(Boolean);
  return candidates.find(itemData =>
    itemData?.flags?.[MODULE_ID]?.manualRequest
    || itemData?.system?.identifier === "roll-director-manual-request"
    || hasManualWorkflowCardSignature(itemData?.name)
  ) ?? null;
}

function isManualWorkflowChatMessageData(document, data) {
  const flags = data?.flags ?? document?.flags ?? {};
  if (flags?.[MODULE_ID]?.manualWorkflowCard || flags?.[MODULE_ID]?.manualRequest) return true;
  if (getManualWorkflowItemData(document, data)) return true;
  return hasManualWorkflowCardSignature(data?.content ?? document?.content ?? "");
}

function isManualMidiWorkflowCard(message, element) {
  // The temporary synthetic Activity card starts a Midi-QoL workflow for manual
  // Ability Checks, Skill Checks, and Saving Throws. Keep the ChatMessage itself:
  // Midi-QoL may rely on it for workflow bookkeeping. Only its display is optional.
  const flagged = message?.getFlag?.(MODULE_ID, "manualWorkflowCard")
    ?? message?.flags?.[MODULE_ID]?.manualWorkflowCard
    ?? false;
  if (flagged || getManualWorkflowItemData(message, message?._source)) return true;

  // Do not stop at .message-content: in the D&D 5e item card the matching title may
  // be outside that node. Test every available representation independently.
  const candidates = [
    element?.querySelector?.(".message-content")?.textContent,
    element?.textContent,
    message?.content
  ];
  return candidates.some(hasManualWorkflowCardSignature);
}

function markManualWorkflowCard(document, data) {
  // Mark the message using Midi-QoL's embedded synthetic item metadata when available;
  // fall back to the source HTML signature. The metadata path works before the card's
  // title is rendered and is also used by the privacy hook below.
  if (!isManualWorkflowChatMessageData(document, data)) return;

  const flags = foundry.utils.deepClone(data?.flags ?? document?.flags ?? {});
  flags[MODULE_ID] = { ...(flags[MODULE_ID] ?? {}), manualWorkflowCard: true };
  try { document?.updateSource?.({ flags }); } catch (err) { /* mutable data payload below is the fallback */ }
  if (data && typeof data === "object") data.flags = flags;
}

function hideInternalMessages(message, html) {
  const transport = getTransport(message);
  const isInternalRoll = message?.getFlag?.(MODULE_ID, "internalRoll") ?? false;
  const isSummaryCopy = message?.getFlag?.(MODULE_ID, SUMMARY_FLAG) ?? false;
  const isGMCard = message?.getFlag?.(MODULE_ID, GM_SUMMARY_FLAG) ?? false;
  const element = html instanceof HTMLElement ? html : html?.[0];
  const showManualWorkflowCard = game.settings.get(MODULE_ID, "showManualWorkflowCard");
  if (!showManualWorkflowCard && isManualMidiWorkflowCard(message, element)) {
    const targets = new Set([
      element,
      element?.closest?.(".chat-message"),
      element?.closest?.("li.chat-message"),
      element?.closest?.("[data-message-id]")
    ].filter(Boolean));
    for (const target of targets) {
      target.classList?.add("rd-hidden-manual-workflow-card");
      target.style?.setProperty("display", "none", "important");
      target.setAttribute?.("aria-hidden", "true");
    }
    return;
  }
  if (transport || isInternalRoll || (isGM() && isSummaryCopy) || (!isGM() && isGMCard)) {
    if (element) element.style.display = "none";
    return;
  }
  if (!(isSummaryCopy || isGMCard) || !element) return;

  const messageId = message?.id ?? message?._id;
  const escapedId = String(messageId ?? "").replace(/["\\]/g, "\\$&");
  const localRoot = element.matches?.(".chat-message, li.chat-message, [data-message-id]")
    ? element
    : (element.closest?.(".chat-message, li.chat-message, [data-message-id]") ?? null);
  const foundRoot = escapedId
    ? document.querySelector(`.chat-message[data-message-id="${escapedId}"], li.chat-message[data-message-id="${escapedId}"], [data-message-id="${escapedId}"]`)
    : null;
  // Prefer the element belonging to this render event (important for pop-out chat), and
  // fall back to the message id only when Foundry supplied a nested body element.
  const messageRoot = localRoot ?? foundRoot ?? element;
  messageRoot.classList?.add("rd-roll-director-summary-message");
  element.classList?.add("rd-roll-director-summary-message");

  const normalizedText = node => String(node?.innerText ?? node?.textContent ?? "")
    .replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const isChatMessageContainer = node => node?.matches?.(".chat-message, li.chat-message, [data-message-id]");
  const hideNode = (node, className) => {
    if (!(node instanceof HTMLElement) || node === messageRoot || node === element) return;
    // Do not hide the complete sender header, sender name, or Roll Director summary body.
    if (node.matches?.(".message-header, .message-sender, .message-content, .roll-director-chat")) return;
    node.classList.add(className);
    node.style.setProperty("display", "none", "important");
    node.setAttribute("aria-hidden", "true");
  };
  const scanRecipientScope = scope => {
    if (!(scope instanceof HTMLElement)) return;
    // Many chat themes split `TO:` and the recipient names into nested spans. Evaluate each
    // node itself and hide recipient rows as a unit; hiding just the tiny `TO:` label leaves
    // the names visible, which is the failure seen in the previous release.
    const nodes = [scope, ...scope.querySelectorAll("*")].reverse();
    for (const node of nodes) {
      const className = typeof node.className === "string" ? node.className : "";
      const text = normalizedText(node);
      const beginsToLine = /^TO\s*:/i.test(text) && text.length < 1600;
      const recipientClass = /whisper|recipient/i.test(className);
      const whisperIndicatorClass = /(?:^|[\s_-])(?:message[-_ ]?)?whisper(?:$|[\s_-])/i.test(className);
      const exactWhisperIndicator = /^WHISPER$/i.test(text);
      if (beginsToLine || recipientClass) hideNode(node, "rd-hide-whisper-recipient-line");
      else if (whisperIndicatorClass || exactWhisperIndicator) hideNode(node, "rd-hide-whisper-indicator");
    }
  };

  scanRecipientScope(messageRoot);

  // Some styling modules render recipient metadata as a sibling of the message card rather
  // than a child. Scan only non-message siblings adjacent to this exact card; other chat
  // messages are explicitly excluded so their recipient labels remain untouched.
  const scanAdjacentMetadata = () => {
    const parent = messageRoot.parentElement;
    if (!parent) return;
    for (const sibling of parent.children) {
      if (sibling === messageRoot || sibling === element || sibling.contains?.(messageRoot)) continue;
      if (isChatMessageContainer(sibling) || sibling.querySelector?.(".chat-message, li.chat-message, [data-message-id]")) continue;
      scanRecipientScope(sibling);
    }
  };
  scanAdjacentMetadata();

  // Recheck after the next paint in case another chat renderer appends metadata after the
  // Foundry render hook. This is display-only; message.whisper and actual permissions stay intact.
  const rescan = () => {
    scanRecipientScope(messageRoot);
    scanAdjacentMetadata();
  };
  if (!messageRoot.dataset.rdRecipientRescanScheduled) {
    messageRoot.dataset.rdRecipientRescanScheduled = "true";
    requestAnimationFrame(rescan);
    setTimeout(() => { delete messageRoot.dataset.rdRecipientRescanScheduled; rescan(); }, 150);
  }
}

function getRollDirectorMarkerFromMessage(document, data) {
  const rawRolls = data?.rolls ?? document?.rolls ?? [];
  const rolls = Array.isArray(rawRolls) ? rawRolls : (rawRolls?.contents ?? []);
  const marker = rolls.map(roll => roll?.options?.rollDirector).find(value => value?.actorUuid);
  if (marker) return marker;

  // Some Midi-QoL versions clone/normalize the roll and omit custom Roll options from the
  // resulting ChatMessage. Use the active/recent actor marker only when this is actually a
  // roll message and its speaker matches the actor that Roll Director just rolled.
  if (!rolls.length) return null;
  const speaker = data?.speaker ?? document?.speaker ?? {};
  const speakerActorId = speaker.actor;
  if (!speakerActorId) return null;
  for (const source of [activeRollModeOverrides, recentRollSecurityMarkers]) {
    for (const [uuid, request] of source.entries()) {
      if (request.expiresAt && request.expiresAt < Date.now()) {
        source.delete(uuid);
        continue;
      }
      const actor = fromUuidSync(uuid);
      if (!actor || (actor.id !== speakerActorId && actor.uuid !== speakerActorId)) continue;
      return {
        requestId: request.requestId,
        actorUuid: actor.uuid,
        actorId: actor.id,
        isNPC: request.isNPC ?? isNPC(actor),
        privateNPC: request.privateNPC ?? request.isNPC ?? isNPC(actor),
        rollMode: (request.privateNPC ?? request.isNPC ?? isNPC(actor)) ? "selfroll" : normalizeRollMode(request.rollMode),
        rollerUserId: request.rollerUserId ?? game.user.id
      };
    }
  }
  return null;
}

function secureRollDirectorChatMessage(document, data, options, userId) {
  captureEvaluatedInitiativeRolls(document, data);
  const gms = game.users.filter(user => user.isGM).map(user => user.id);
  const authorId = userId ?? game.user.id;

  // The intermediate synthetic Activity card is not a roll result. Keep it private
  // regardless of the user's global chat-bar roll mode or the request's public mode.
  // Midi-QoL relies on this message for workflow bookkeeping, so restrict recipients
  // rather than cancelling creation. The optional setting controls only GM-side display.
  if (isManualWorkflowChatMessageData(document, data)) {
    const whisper = [...new Set([...gms, authorId])];
    const flags = foundry.utils.deepClone(data?.flags ?? document?.flags ?? {});
    flags[MODULE_ID] = { ...(flags[MODULE_ID] ?? {}), manualWorkflowCard: true };
    const patch = { whisper, blind: false, flags };
    try { document?.updateSource?.(patch); } catch (err) { /* mutable data payload below is the fallback */ }
    if (data && typeof data === "object") Object.assign(data, patch);
    if (options && typeof options === "object") {
      options.messageMode = "gm";
      options.rollMode = "gmroll"; // Do not let the global chat-bar roll mode make this card public.
    }
    return;
  }

  const marker = getRollDirectorMarkerFromMessage(document, data);
  if (!marker) return;

  const whisper = [...new Set([...gms, authorId])];
  const flags = foundry.utils.deepClone(data?.flags ?? document?.flags ?? {});
  flags[MODULE_ID] = { ...(flags[MODULE_ID] ?? {}), internalRoll: true, actorUuid: marker.actorUuid };
  flags["dice-so-nice"] = { ...(flags["dice-so-nice"] ?? {}), skip: true };
  const patch = { whisper, blind: false, flags };
  try { document?.updateSource?.(patch); } catch (err) { /* mutable data payload below is the fallback */ }
  if (data && typeof data === "object") Object.assign(data, patch);
  if (options && typeof options === "object") {
    options.messageMode = "gm";
    options.rollMode = "gmroll"; // backward-compatibility for modules that still inspect the legacy option.
  }

  // Keep the underlying card private and hide it from the chat log. Do not cancel it:
  // Midi-QoL may still rely on the created ChatMessage for post-roll bookkeeping. The
  // only player-facing result is Roll Director's separately filtered summary.
}

function diceAudienceForMarker(marker) {
  const gmIds = game.users.filter(user => user.isGM).map(user => user.id);
  const rollerId = marker?.rollerUserId ?? game.user.id;
  const actor = marker?.actorUuid ? fromUuidSync(marker.actorUuid) : null;
  if (marker?.privateNPC ?? marker?.isNPC ?? (actor && isNPC(actor))) return { users: gmIds, blind: false };

  const mode = normalizeRollMode(marker?.rollMode ?? "publicroll");
  if (mode === "publicroll") {
    const observerIds = game.users.filter(user => user.isGM || (actor && hasObserver(actor, user))).map(user => user.id);
    return { users: [...new Set([...gmIds, ...observerIds])], blind: false };
  }
  if (mode === "blindroll") return { users: gmIds, blind: true };
  return { users: [...new Set([...gmIds, rollerId])], blind: false };
}

function diceAudienceKey(marker) {
  return marker?.requestId && marker?.actorUuid ? `${marker.requestId}:${marker.actorUuid}` : null;
}

function markerForSpeaker(speaker) {
  const speakerActorId = speaker?.actor ?? speaker?.actorId;
  if (!speakerActorId) return null;
  for (const source of [activeRollModeOverrides, recentRollSecurityMarkers]) {
    for (const [uuid, request] of source.entries()) {
      if (request.expiresAt && request.expiresAt < Date.now()) {
        source.delete(uuid);
        continue;
      }
      const actor = fromUuidSync(uuid);
      if (!actor || (actor.id !== speakerActorId && actor.uuid !== speakerActorId)) continue;
      return {
        requestId: request.requestId,
        actorUuid: actor.uuid,
        actorId: actor.id,
        isNPC: request.isNPC ?? isNPC(actor),
        privateNPC: request.privateNPC ?? request.isNPC ?? isNPC(actor),
        rollMode: (request.privateNPC ?? request.isNPC ?? isNPC(actor)) ? "selfroll" : normalizeRollMode(request.rollMode),
        rollerUserId: request.rollerUserId ?? game.user.id
      };
    }
  }
  // Some direct Midi-QoL Dice So Nice calls omit the speaker argument entirely. If
  // exactly one Roll Director roll is active on this client, use that one-shot context.
  if (activeRollModeOverrides.size === 1) {
    const [uuid, request] = activeRollModeOverrides.entries().next().value;
    const actor = fromUuidSync(uuid);
    if (actor && Date.now() - request.createdAt <= 30000) {
      return {
        requestId: request.requestId,
        actorUuid: actor.uuid,
        actorId: actor.id,
        isNPC: request.isNPC ?? isNPC(actor),
        privateNPC: request.privateNPC ?? request.isNPC ?? isNPC(actor),
        rollMode: (request.privateNPC ?? request.isNPC ?? isNPC(actor)) ? "selfroll" : normalizeRollMode(request.rollMode),
        rollerUserId: request.rollerUserId ?? game.user.id
      };
    }
  }
  return null;
}

function markerForDiceRoll(roll, speaker) {
  const marker = roll?.options?.rollDirector;
  if (marker?.actorUuid) return marker;
  return markerForSpeaker(speaker);
}

function installDiceSoNicePrivacyWrapper() {
  const dice3d = game.dice3d;
  if (!dice3d || diceSoNicePrivacyWrapped) return;
  diceSoNicePrivacyWrapped = true;
  let wrappedAnyMethod = false;

  if (typeof dice3d.showForRoll === "function") {
    const original = dice3d.showForRoll.bind(dice3d);
    wrappedAnyMethod = true;
    dice3d.showForRoll = function (roll, user, synchronize, whisper, blind, chatMessageId, speaker, options) {
      const marker = markerForDiceRoll(roll, speaker);
      if (!marker?.actorUuid) return original(roll, user, synchronize, whisper, blind, chatMessageId, speaker, options);
      roll.options ??= {};
      roll.options.rollDirector ??= marker;
      const key = diceAudienceKey(marker);
      if (key) handledDiceAnimationKeys.add(key);
      const audience = diceAudienceForMarker(marker);
      const actor = fromUuidSync(marker.actorUuid);
      const safeSpeaker = speaker ?? (actor ? ChatMessage.getSpeaker({ actor }) : undefined);
      // NPC rolls animate only for GMs. No public or ghost dice leak from an NPC roll.
      return original(roll, user ?? game.user, true, audience.users, audience.blind, null, safeSpeaker, { ...(options ?? {}), ghost: false });
    };
  }

  if (typeof dice3d.animateRoll === "function") {
    const original = dice3d.animateRoll.bind(dice3d);
    wrappedAnyMethod = true;
    dice3d.animateRoll = function (roll, messageData = {}, options = {}) {
      const marker = markerForDiceRoll(roll, messageData?.speaker);
      if (!marker?.actorUuid) return original(roll, messageData, options);
      roll.options ??= {};
      roll.options.rollDirector ??= marker;
      const key = diceAudienceKey(marker);
      if (key) handledDiceAnimationKeys.add(key);
      const audience = diceAudienceForMarker(marker);
      const actor = fromUuidSync(marker.actorUuid);
      const safeData = {
        ...(messageData ?? {}),
        author: marker.rollerUserId ?? game.user.id,
        speaker: messageData?.speaker ?? (actor ? ChatMessage.getSpeaker({ actor }) : undefined),
        whisper: audience.users,
        blind: audience.blind
      };
      return original(roll, safeData, {});
    };
  }
  runtimeStatus.diceSoNicePrivacyWrapped = wrappedAnyMethod;
}

async function ensureDiceAnimation(rolls, actor, marker) {
  const dice3d = game.dice3d;
  if (!dice3d || typeof dice3d.showForRoll !== "function") return;
  const key = diceAudienceKey(marker);
  if (key && handledDiceAnimationKeys.has(key)) {
    handledDiceAnimationKeys.delete(key);
    return;
  }
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  if (!roll || !roll._evaluated) return;
  roll.options ??= {};
  roll.options.rollDirector = marker;
  const audience = diceAudienceForMarker(marker);
  try {
    await dice3d.showForRoll(roll, game.user, true, audience.users, audience.blind,
      null, ChatMessage.getSpeaker({ actor }), { ghost: false });
  } catch (err) {
    console.warn(`${MODULE_ID} | Dice So Nice animation could not be shown for a Roll Director request.`, err);
  } finally {
    if (key) handledDiceAnimationKeys.delete(key);
  }
}

function registerSettings() {
  game.settings.register(MODULE_ID, "defaultDC", {
    name: "Default DC",
    hint: "The DC initially selected for manual roll requests.",
    scope: "world",
    config: true,
    type: Number,
    default: 15,
    range: { min: 1, max: 40, step: 1 }
  });
  game.settings.register(MODULE_ID, "defaultRollMode", {
    name: "Default roll visibility",
    hint: "Fallback mode for requests without an actor-specific automatic default.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      publicroll: "Public",
      blindroll: "Blind · GM only",
      selfroll: "Self · roller + GM"
    },
    default: "publicroll"
  });
  game.settings.register(MODULE_ID, "defaultGroupRollType", {
    name: "Default group roll method",
    hint: "The method used to evaluate multi-character group rolls.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      standard: "Standard Rule · half must succeed",
      average: "Group Average · rounded up",
      leader: "Leader with Help",
      weakest: "Weakest Link"
    },
    default: "standard"
  });
  game.settings.register(MODULE_ID, "showPortraitsInChat", {
    name: "Show portraits in roll summaries",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "showManualWorkflowCard", {
    name: "Show intermediate manual roll card",
    hint: "Show the temporary D&D 5e Activity card created to start Midi-QoL for manual Ability Checks, Skill Checks, and Saving Throws. Hiding it only changes chat display; the underlying message is still created for workflow bookkeeping.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "showSaveOutcomesToPlayers", {
    name: "Show saving throw outcomes to players",
    hint: "Show PASS/FAIL in player summaries for saving throws without revealing the DC. Also applies to Death Saves and Concentration Checks when a target is known.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "showCheckOutcomesToPlayers", {
    name: "Show check outcomes to players",
    hint: "Show PASS/FAIL in player summaries for Ability, Skill, and Tool Checks without revealing the DC.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "managerScale", {
    name: "GM interface scale",
    hint: "Scale the Roll Director GM control deck from 60% to 140%.",
    scope: "world",
    config: true,
    type: Number,
    default: 100,
    range: { min: 60, max: 140, step: 5 },
    onChange: () => managerApp?._applyScale()
  });
  game.settings.register(MODULE_ID, "autoOpenManager", {
    name: "Open GM interface automatically",
    hint: "When enabled, open Roll Director automatically when the GM enters the world. The manager can still be closed and reopened manually.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "startCollapsed", {
    name: "Start GM interface collapsed",
    hint: "Open Roll Director as a small draggable D20 icon instead of the full control deck.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "autoInterceptRolls", {
    name: "Automatically intercept supported D20 rolls",
    hint: "Route supported direct D&D 5e D20 rolls through Roll Director. Midi-QoL remains responsible for item-workflow target rolls, save/check adjudication, damage, and effects; Roll Director replaces only the eligible target prompt UI.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "autoRollNPCInitiative", {
    name: "Automatically roll initiative for non-player-controlled actors",
    hint: "When initiative is started from the Combat Tracker, roll initiative automatically for NPCs that are not player-controlled. Disable this to leave those NPCs in the GM Roll Director prompt for manual rolls.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "autoStartInitiativeAfterCombatantsAdded", {
    name: "Automatically start initiative after adding combatants",
    hint: "When enabled, adding actors to a combat that has not started automatically begins one Roll Director initiative request after the additions settle. Disabled by default.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "autoRequestInitiativeForNewCombatants", {
    name: "Automatically request initiative for actors added during combat",
    hint: "When enabled, actors added after combat has started are automatically sent through the initiative workflow. Player-controlled actors receive the Roll Director prompt; uncontrolled NPCs follow the automatic NPC initiative setting.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "favoriteTools", {
    name: "Favorite tools",
    hint: "Tool identifiers shown in the Favorites column of the Tool Check picker.",
    scope: "world",
    config: false,
    type: Array,
    default: []
  });
}

class RollDirectorFavoriteToolsConfig extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "roll-director-favorite-tools-config",
    classes: ["roll-director", "rd-favorite-tools-app"],
    window: { frame: true, title: "Roll Director — Favorite Tools", icon: "fa-solid fa-star", resizable: true },
    position: { width: 820, height: 680, scale: 1 }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/favorite-tools.hbs` }
  };

  constructor(options = {}) {
    super(options);
    const stored = game.settings.get(MODULE_ID, "favoriteTools");
    this.favoriteDraft = new Set(Array.isArray(stored) ? stored : []);
  }

  async _prepareContext() {
    const entries = Object.entries(CONFIG.DND5E?.tools ?? {});
    const tools = await Promise.all(entries.map(async ([value, data]) => {
      const label = await resolveToolDisplayLabel(value, data);
      return { value, label, category: toolCategory(label, value), selected: this.favoriteDraft.has(value) };
    }));
    tools.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
    const categoryNames = [...new Set(tools.map(tool => tool.category))];
    const categories = categoryNames.map(name => ({
      name,
      tools: tools.filter(tool => tool.category === name)
    }));
    const selectedCount = tools.filter(tool => tool.selected).length;
    return {
      categories,
      selectedCount,
      selectedSummary: `${selectedCount} favorite${selectedCount === 1 ? "" : "s"} selected`,
      toolCount: tools.length
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root || this._favoritesEventsRoot === root) return;
    this._favoritesEventsRoot = root;

    root.addEventListener("input", event => {
      const target = event.target;
      if (target?.matches?.(".rd-favorites-search")) this._filterOptions(target.value);
      if (target?.matches?.("input[name='favoriteTool']")) this._updateCount();
    });
    root.addEventListener("change", event => {
      if (event.target?.matches?.("input[name='favoriteTool']")) this._updateCount();
    });
    root.addEventListener("click", event => {
      const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
      if (!button) return;
      if (button.dataset.action === "save-favorites") void this._saveFavorites();
      else if (button.dataset.action === "cancel-favorites") this.close();
      else if (button.dataset.action === "clear-favorites") {
        for (const input of root.querySelectorAll("input[name='favoriteTool']")) input.checked = false;
        this._updateCount();
      }
    });
  }

  _filterOptions(value) {
    const root = this.element;
    if (!root) return;
    const query = String(value ?? "").trim().toLocaleLowerCase();
    for (const option of root.querySelectorAll(".rd-favorite-setting-option")) {
      const haystack = `${option.dataset.toolLabel ?? ""} ${option.dataset.toolValue ?? ""}`.toLocaleLowerCase();
      option.hidden = !haystack.includes(query);
    }
    for (const category of root.querySelectorAll(".rd-favorite-setting-category")) {
      category.hidden = ![...category.querySelectorAll(".rd-favorite-setting-option")].some(option => !option.hidden);
    }
    const noResults = root.querySelector(".rd-favorites-no-results");
    if (noResults) noResults.hidden = [...root.querySelectorAll(".rd-favorite-setting-option")].some(option => !option.hidden);
  }

  _updateCount() {
    const root = this.element;
    if (!root) return;
    const count = root.querySelectorAll("input[name='favoriteTool']:checked").length;
    const output = root.querySelector("[data-favorites-count]");
    if (output) output.textContent = `${count} favorite${count === 1 ? "" : "s"} selected`;
  }

  async _saveFavorites() {
    const root = this.element;
    if (!root) return;
    const selected = [...root.querySelectorAll("input[name='favoriteTool']:checked")].map(input => input.value);
    await game.settings.set(MODULE_ID, "favoriteTools", selected);
    ui.notifications.info(`Roll Director: saved ${selected.length} favorite tool${selected.length === 1 ? "" : "s"}.`);
    this.close();
  }
}


function clearDisconnectedActorTimers(requestId, actorUuid = null) {
  for (const [key, entry] of disconnectedActorTimers.entries()) {
    if (entry.requestId !== requestId || (actorUuid && entry.actorUuid !== actorUuid)) continue;
    clearTimeout(entry.timer);
    disconnectedActorTimers.delete(key);
  }
}

function clearDisconnectedInitiatorTimer(requestId) {
  const entry = disconnectedInitiatorTimers.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  disconnectedInitiatorTimers.delete(requestId);
}

function countWaiters(waiterMap) {
  let count = 0;
  for (const entries of waiterMap.values()) count += Array.isArray(entries) ? entries.length : 1;
  return count;
}

function diagnosticsSnapshot() {
  const moduleInfo = id => {
    const module = game.modules?.get(id);
    return { installed: !!module, active: !!module?.active, version: module?.version ?? "—" };
  };
  const requestRows = [...activeRequests.values()].map(request => ({
    type: `${request.typeLabel ?? rollTypeLabel(request.rollType)}${request.subtypeLabel ? ` · ${request.subtypeLabel}` : ""}`,
    age: `${Math.max(0, Math.round((Date.now() - request.createdAt) / 1000))}s`,
    actors: request.actors?.length ?? 0,
    completed: request.completed?.size ?? 0,
    waiting: Math.max(0, (request.actors?.length ?? 0) - (request.completed?.size ?? 0)),
    workflow: request.isMidiWorkflow ? "Midi-QoL" : (request.isAutomatic ? "Automatic" : "Manual")
  }));
  const rows = [];
  const row = (label, value, state = "info") => rows.push({ label, value: String(value ?? "—"), state });
  const self = moduleInfo(MODULE_ID);
  let autoInterceptEnabled = false;
  try { autoInterceptEnabled = !!game.settings.get(MODULE_ID, "autoInterceptRolls"); } catch (_) { /* Settings may not be registered yet during early initialization. */ }
  row("Roll Director", self.version, self.version !== "—" ? "ok" : "warn");
  row("Foundry VTT", game.version ?? game.release?.version ?? "Unknown");
  row("D&D 5e", game.system?.version ?? "Not detected", game.system?.id === "dnd5e" ? "ok" : "warn");
  row("Automatic D20 interception", autoInterceptEnabled ? "Enabled" : "Disabled", autoInterceptEnabled ? "ok" : "info");
  let autoRollNPCInitiative = true;
  try { autoRollNPCInitiative = !!game.settings.get(MODULE_ID, "autoRollNPCInitiative"); } catch (_) { /* Settings may not be registered yet during early initialization. */ }
  row("Automatic NPC initiative", autoRollNPCInitiative ? "Enabled" : "Disabled", autoRollNPCInitiative ? "ok" : "info");
  let autoStartInitiativeAfterCombatantsAdded = false;
  let autoRequestInitiativeForNewCombatants = true;
  try {
    autoStartInitiativeAfterCombatantsAdded = !!game.settings.get(MODULE_ID, "autoStartInitiativeAfterCombatantsAdded");
    autoRequestInitiativeForNewCombatants = !!game.settings.get(MODULE_ID, "autoRequestInitiativeForNewCombatants");
  } catch (_) { /* Settings may not be registered yet during early initialization. */ }
  row("Auto-start initiative after adding combatants", autoStartInitiativeAfterCombatantsAdded ? "Enabled" : "Disabled", autoStartInitiativeAfterCombatantsAdded ? "ok" : "info");
  row("Auto-request initiative for combatants added during combat", autoRequestInitiativeForNewCombatants ? "Enabled" : "Disabled", autoRequestInitiativeForNewCombatants ? "ok" : "info");
  const midi = moduleInfo("midi-qol");
  row("Midi-QoL", `${midi.installed ? midi.version : "Not installed"}${midi.active ? " · active" : " · inactive"}`, midi.active ? "ok" : "warn");
  const dae = moduleInfo("dae");
  row("DAE", `${dae.installed ? dae.version : "Not installed"}${dae.active ? " · active" : ""}`, dae.installed && dae.active ? "ok" : "info");
  const libWrapper = moduleInfo("lib-wrapper");
  row("libWrapper", `${libWrapper.installed ? libWrapper.version : "Not installed"}${globalThis.libWrapper?.register ? " · API available" : " · API unavailable"}`, globalThis.libWrapper?.register ? "ok" : "warn");
  row("Midi workflow hooks", runtimeStatus.midiHooksRegistered ? "Registered" : (midi.active ? "Not registered" : "Not applicable"), runtimeStatus.midiHooksRegistered || !midi.active ? "ok" : "warn");
  row("Native roll interceptors", `${runtimeStatus.nativeRollInterceptors.size} registered / ${runtimeStatus.nativeRollInterceptorAttempts.size} attempted`, runtimeStatus.nativeRollInterceptors.size ? "ok" : "warn");
  row("Combat Tracker initiative interception", runtimeStatus.combatInitiativeInterceptorRegistered ? "Registered" : (runtimeStatus.combatInitiativeInterceptorAttempted ? "Not registered" : "Not attempted"), runtimeStatus.combatInitiativeInterceptorRegistered ? "ok" : "warn");
  row("Dice So Nice privacy adapter", runtimeStatus.diceSoNicePrivacyWrapped ? "Installed" : (game.dice3d ? "Available, not installed" : "Not present"), runtimeStatus.diceSoNicePrivacyWrapped ? "ok" : "info");
  const runtimeRows = [
    { label: "Active requests", value: activeRequests.size },
    { label: "Queued automatic requests", value: automaticRequestQueue.length },
    { label: "Local paused native rolls", value: pendingInterceptRolls.size },
    { label: "Midi workflow contexts", value: midiWorkflowContexts.size },
    { label: "Midi decision waiters", value: countWaiters(midiWorkflowModeWaiters) },
    { label: "Midi start waiters", value: midiWorkflowStartWaiters.size },
    { label: "Prompt readiness checks", value: midiPromptReadiness.size },
    { label: "Disconnected actor recovery timers", value: disconnectedActorTimers.size },
    { label: "Disconnected initiator recovery timers", value: disconnectedInitiatorTimers.size }
  ];
  return {
    rows,
    runtimeRows,
    requestRows,
    generatedAt: new Date().toLocaleString(),
    report: JSON.stringify({
      generatedAt: new Date().toISOString(),
      versions: {
        rollDirector: self.version,
        foundry: game.version ?? game.release?.version ?? null,
        system: { id: game.system?.id ?? null, version: game.system?.version ?? null },
        midiQol: { installed: midi.installed, active: midi.active, version: midi.version },
        dae: { installed: dae.installed, active: dae.active, version: dae.version },
        libWrapper: { installed: libWrapper.installed, version: libWrapper.version, apiAvailable: !!globalThis.libWrapper?.register }
      },
      settings: {
        autoInterceptRolls: autoInterceptEnabled,
        autoRollNPCInitiative,
        autoStartInitiativeAfterCombatantsAdded,
        autoRequestInitiativeForNewCombatants
      },
      integrations: {
        midiWorkflowHooksRegistered: runtimeStatus.midiHooksRegistered,
        combatInitiativeInterceptorAttempted: runtimeStatus.combatInitiativeInterceptorAttempted,
        combatInitiativeInterceptorRegistered: runtimeStatus.combatInitiativeInterceptorRegistered,
        nativeRollInterceptorsAttempted: [...runtimeStatus.nativeRollInterceptorAttempts],
        nativeRollInterceptorsRegistered: [...runtimeStatus.nativeRollInterceptors],
        diceSoNicePrivacyWrapped: runtimeStatus.diceSoNicePrivacyWrapped
      },
      runtime: Object.fromEntries(runtimeRows.map(entry => [entry.label, entry.value])),
      activeRequests: requestRows
    }, null, 2)
  };
}

class RollDirectorDiagnostics extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "roll-director-diagnostics",
    classes: ["roll-director", "rd-diagnostics-app"],
    window: { frame: true, title: "Roll Director — Diagnostics", icon: "fa-solid fa-stethoscope", resizable: true },
    position: { width: 640, height: 650 }
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/diagnostics.hbs` } };

  async _prepareContext() { return diagnosticsSnapshot(); }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root || this._boundDiagnosticsRoot === root) return;
    this._boundDiagnosticsRoot = root;
    root.addEventListener("click", event => {
      const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
      if (!button) return;
      if (button.dataset.action === "refresh-diagnostics") this.render();
      else if (button.dataset.action === "copy-diagnostics") void this._copyReport();
    });
  }

  async _copyReport() {
    const report = diagnosticsSnapshot().report;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = report;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        const success = document.execCommand("copy");
        textarea.remove();
        if (!success) throw new Error("Clipboard copy was not available.");
      }
      ui.notifications.info("Roll Director diagnostics copied. The report contains version and status data, not actor names.");
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not copy diagnostics report.`, error);
      ui.notifications.warn("Could not copy automatically. Refresh diagnostics and copy the report from the console if needed.");
      console.info(`${MODULE_ID} diagnostics report:\n${report}`);
    }
  }
}

class RollDirectorManager extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor(options = {}) {
    const viewportWidth = globalThis.innerWidth ?? 1280;
    const viewportHeight = globalThis.innerHeight ?? 800;
    const width = Math.min(1120, Math.max(300, viewportWidth - 24));
    const height = Math.min(475, Math.max(340, viewportHeight - 70));
    const configuredScale = Math.max(60, Math.min(140, Number(game.settings.get(MODULE_ID, "managerScale")) || 100)) / 100;
    const savedPosition = game.user?.getFlag?.(MODULE_ID, "managerPosition");
    const visibleWidth = width * configuredScale;
    const visibleHeight = height * configuredScale;
    const fallbackPosition = {
      width,
      height,
      scale: configuredScale,
      left: Math.max(8, Math.round((viewportWidth - visibleWidth) / 2)),
      top: Math.max(35, Math.round(viewportHeight - visibleHeight - 28))
    };
    if (Number.isFinite(savedPosition?.left)) fallbackPosition.left = Math.min(viewportWidth - visibleWidth - 8, Math.max(8, savedPosition.left));
    if (Number.isFinite(savedPosition?.top)) fallbackPosition.top = Math.min(viewportHeight - visibleHeight - 8, Math.max(8, savedPosition.top));
    super({ ...options, position: options.position ?? fallbackPosition });
    this._basePositionSize = {
      width: Number(options.position?.width) || width,
      height: Number(options.position?.height) || height
    };
    this.tab = "players";
    this.selected = new Set();
    this.rosterCards = new Map();
    this.actorModes = new Map();
    this.actorAdvantages = new Map();
    this._midiRequestPending = false;
    this.rollType = "skill";
    this.subtype = "per";
    this.dc = Number(game.settings.get(MODULE_ID, "defaultDC")) || 15;
    this.rollMode = normalizeRollMode(game.settings.get(MODULE_ID, "defaultRollMode") ?? "publicroll");
    this.groupMethod = game.settings.get(MODULE_ID, "defaultGroupRollType") ?? "standard";
    this.defaultAdvantage = "normal";
    this.clickTimers = new Map();
    this.isCollapsed = false;
    this.expandedPosition = null;
    this._dragMoved = false;
    this._initialCollapseHandled = false;
  }

  static DEFAULT_OPTIONS = {
    id: "roll-director-manager",
    tag: "section",
    classes: ["roll-director", "rd-manager-app"],
    // Keep Foundry's ApplicationV2 frame enabled for reliable mounting and positioning.
    // The frame header is styled to match Roll Director's theme in roll-director.css.
    window: { frame: true, title: "Roll Director", icon: "fa-solid fa-dice-d20", resizable: false },
    position: { width: 1080, height: 420, scale: 1 },
    actions: {}
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/manager.hbs` }
  };

  async _prepareContext() {
    const playerCards = getPartyActors();
    const npcCards = getCanvasNPCs();
    this.rosterCards = new Map([...playerCards, ...npcCards].map(card => [card.uuid, card]));
    const players = playerCards.map(card => this._decorateCard(card));
    const npcs = npcCards.map(card => this._decorateCard(card));
    const rollTypeOptions = [
      { value: "ability", label: "Ability Check" },
      { value: "save", label: "Saving Throw" },
      { value: "skill", label: "Skill Check" },
      { value: "tool", label: "Tool Check" }
    ].map(option => ({ ...option, selected: option.value === this.rollType }));
    const subtypeOptions = getSubtypeOptions(this.rollType, this.subtype);
    this.subtype = subtypeOptions.find(option => option.selected)?.value ?? this.subtype;
    const rollModeOptions = ROLL_MODES.map(option => ({ ...option, selected: option.value === this.rollMode }));
    const groupMethodOptions = GROUP_METHODS.map(option => ({ ...option, selected: option.value === this.groupMethod }));
    const dcOptions = [{ value: "custom", label: "Custom DC", selected: !DC_PRESETS.includes(this.dc) }]
      .concat(DC_PRESETS.map(value => ({ value: String(value), label: `DC ${value}`, selected: this.dc === value })));
    return {
      players,
      npcs,
      activeTab: this.tab,
      playerTabActive: this.tab === "players",
      npcTabActive: this.tab === "npcs",
      rollTypeOptions,
      subtypeOptions,
      toolRollSelected: this.rollType === "tool",
      selectedSubtypeLabel: subtypeLabel(this.rollType, this.subtype) || "Choose a tool…",
      rollModeOptions,
      groupMethodOptions,
      dcOptions,
      dc: this.dc,
      selectedCount: this.selected.size,
      playerCount: players.length,
      npcCount: npcs.length,
      rollMode: this.rollMode,
      defaultAdvantage: this.defaultAdvantage,
      defaultDisadvantageSelected: this.defaultAdvantage === "disadvantage",
      defaultNormalSelected: this.defaultAdvantage === "normal",
      defaultAdvantageSelected: this.defaultAdvantage === "advantage",
      groupMethodLabel: GROUP_METHODS.find(option => option.value === this.groupMethod)?.label ?? "Standard Rule",
      activeTabLabel: this.tab === "players" ? "Players" : "NPCs"
    };
  }

  _decorateCard(card) {
    const modeLocked = card.isNPC && !isPlayerControlledActor(card.actor);
    const mode = modeLocked ? "selfroll" : (this.actorModes.get(card.uuid) ?? "auto");
    const modes = (modeLocked
      ? [{ value: "selfroll", label: "Self · roller + GM" }]
      : [{ value: "auto", label: "Auto" }, ...ROLL_MODES]
    ).map(option => ({ ...option, selected: option.value === mode }));
    const advantageMode = this.actorAdvantages.get(card.uuid) ?? "auto";
    const advantageModes = [
      { value: "auto", label: "Use default" },
      { value: "normal", label: "Normal" },
      { value: "advantage", label: "Advantage" },
      { value: "disadvantage", label: "Disadvantage" }
    ].map(option => ({ ...option, selected: option.value === advantageMode }));
    return { ...card, selected: this.selected.has(card.uuid), modes, mode, modeLocked, advantageModes, advantageMode };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._applyScale();
    // Keep the in-panel drawer state in sync with ApplicationV2 body re-renders.
    this._toolPickerOpen = Boolean(root.querySelector(".rd-tool-drawer:not([hidden])"));
    if (this._boundRoot !== root) {
      this._boundRoot = root;
      root.addEventListener("click", event => {
        const target = event.target instanceof Element ? event.target : null;
        if (this._toolPickerOpen && target && !target.closest(".rd-tool-drawer") && !target.closest(".rd-tool-picker-trigger")) {
          this._closeToolPicker();
        }
        const button = target?.closest("button[data-action]");
        if (button) {
          const action = button.dataset.action;
          if (action === "roster-tab") { this.tab = button.dataset.rosterTab; this.render(); }
          else if (action === "advantage-mode") { this.defaultAdvantage = button.dataset.mode; this.render(); }
          else if (action === "request-all") this.startRequest("all");
          else if (action === "select-all-players") {
            this._toggleRosterSelection(getPartyActors());
          } else if (action === "select-all-npcs") {
            this._toggleRosterSelection(getCanvasNPCs());
          } else if (action === "refresh") this.render();
          else if (action === "collapse") this.collapseToOrb();
          else if (action === "choose-tool") void this._openToolPicker();
          else if (action === "close-tool-picker") this._closeToolPicker();
          else if (action === "select-tool") {
            this.subtype = button.dataset.toolValue;
            this._closeToolPicker();
            this.render();
          }
          return;
        }
        this._handleCardClick(event);
      });
      root.addEventListener("input", event => {
        const target = event.target;
        if (target?.matches?.(".rd-tool-search")) this._filterToolPicker(target.value);
      });
      root.addEventListener("keydown", event => {
        if (event.key === "Escape" && this._toolPickerOpen) {
          event.preventDefault();
          this._closeToolPicker();
        }
      });
      root.addEventListener("change", event => this._handleChange(event));
      // Capture before ApplicationV2's own Draggable handler, so its unscaled bounds cannot
      // clamp the panel before the scale-aware custom drag handler runs.
      root.addEventListener("pointerdown", event => this._beginCanvasDrag(event), true);
    }
    if (!this._initialCollapseHandled) {
      this._initialCollapseHandled = true;
      if (game.settings.get(MODULE_ID, "startCollapsed")) this.collapseToOrb();
    }
  }

  _applyScale() {
    if (!this.element) return;
    const configuredScale = Number(game.settings.get(MODULE_ID, "managerScale")) || 100;
    const factor = Math.max(60, Math.min(140, configuredScale)) / 100;
    if (this.isCollapsed) {
      this.setPosition({ scale: 1, width: 62, height: 62 });
      return;
    }

    // ApplicationV2 natively supports position.scale. Width/height stay in unscaled
    // pixels, and its built-in drag bounds then match the visible scaled dimensions.
    const currentPosition = this.position ?? {};
    const styleWidth = Number.parseFloat(this.element.style.width);
    const styleHeight = Number.parseFloat(this.element.style.height);
    const positionWidth = Number(currentPosition.width);
    const positionHeight = Number(currentPosition.height);
    if (Number.isFinite(positionWidth) && positionWidth > 0) this._basePositionSize.width = positionWidth;
    else if (Number.isFinite(styleWidth) && styleWidth > 0) this._basePositionSize.width = styleWidth;
    if (Number.isFinite(positionHeight) && positionHeight > 0) this._basePositionSize.height = positionHeight;
    else if (Number.isFinite(styleHeight) && styleHeight > 0) this._basePositionSize.height = styleHeight;

    const { width, height } = this._basePositionSize;
    const viewportWidth = document.documentElement?.clientWidth || globalThis.innerWidth || 1280;
    const viewportHeight = document.documentElement?.clientHeight || globalThis.innerHeight || 800;
    const visibleWidth = width * factor;
    const visibleHeight = height * factor;
    const leftNow = Number.isFinite(currentPosition.left) ? currentPosition.left : 8;
    const topNow = Number.isFinite(currentPosition.top) ? currentPosition.top : 35;
    const left = Math.max(8, Math.min(Math.max(8, viewportWidth - visibleWidth - 8), leftNow));
    const top = Math.max(8, Math.min(Math.max(8, viewportHeight - visibleHeight - 8), topNow));
    this.setPosition({ left, top, width, height, scale: factor });
  }

  collapseToOrb() {
    const root = this.element;
    if (!root || this.isCollapsed) return;
    this.expandedPosition = {
      width: this._basePositionSize?.width ?? 1080,
      height: this._basePositionSize?.height ?? 420
    };
    this.isCollapsed = true;
    root.classList.add("rd-collapsed");

    const orb = document.createElement("button");
    orb.type = "button";
    orb.className = "rd-collapse-orb";
    orb.title = "Expand Roll Director";
    orb.setAttribute("aria-label", "Expand Roll Director");
    orb.innerHTML = '<i class="fa-solid fa-dice-d20" aria-hidden="true"></i>';
    orb.addEventListener("click", () => {
      // Pointer dragging dispatches a click on release; never expand from a completed drag.
      if (this._dragMoved) return;
      this.expandFromOrb();
    });
    root.append(orb);
    this.setPosition({ width: 62, height: 62, scale: 1 });
  }

  expandFromOrb() {
    const root = this.element;
    if (!root || !this.isCollapsed) return;
    this.isCollapsed = false;
    root.classList.remove("rd-collapsed");
    root.querySelector(".rd-collapse-orb")?.remove();
    const size = this.expandedPosition ?? { width: 1080, height: 420 };
    this._basePositionSize = { width: size.width, height: size.height };
    this.setPosition({ width: size.width, height: size.height, scale: 1 });
    this.render();
  }

  _beginCanvasDrag(event) {
    if (event.button !== 0) return;
    const root = this.element;
    if (!root) return;
    const collapsedDrag = this.isCollapsed && event.target.closest(".rd-collapse-orb");
    const moduleHeader = !this.isCollapsed && event.target.closest(".rd-topbar");
    const foundryHeader = !this.isCollapsed && event.target.closest(".window-header");
    const expandedDrag = moduleHeader || foundryHeader;
    const handle = collapsedDrag || expandedDrag;
    if (!handle || !root.contains(handle)) return;
    // Leave actual header controls clickable. Capture-phase handling stops Foundry's
    // native draggable from applying its unscaled bounds to this scaled application.
    if (!this.isCollapsed && event.target.closest("button, a, input, select, textarea")) return;

    if (!this.isCollapsed) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    } else {
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
    const bounds = root.getBoundingClientRect();
    const start = {
      x: event.clientX,
      y: event.clientY,
      left: Number.isFinite(bounds.left) ? bounds.left : (Number.isFinite(this.position?.left) ? this.position.left : 0),
      top: Number.isFinite(bounds.top) ? bounds.top : (Number.isFinite(this.position?.top) ? this.position.top : 35),
      pointerId: event.pointerId
    };
    const visibleWidth = bounds.width || (this.isCollapsed ? 62 : (this._basePositionSize?.width ?? 1080) * (Number(this.position?.scale) || 1));
    const visibleHeight = bounds.height || (this.isCollapsed ? 62 : (this._basePositionSize?.height ?? 420) * (Number(this.position?.scale) || 1));
    let moved = false;
    const onMove = moveEvent => {
      if (moveEvent.pointerId !== start.pointerId) return;
      const dx = moveEvent.clientX - start.x;
      const dy = moveEvent.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        moved = true;
        this._dragMoved = true;
        moveEvent.preventDefault?.();
      }
      const viewportWidth = document.documentElement?.clientWidth || globalThis.innerWidth || 1280;
      const viewportHeight = document.documentElement?.clientHeight || globalThis.innerHeight || 800;
      const left = Math.max(8, Math.min(viewportWidth - visibleWidth - 8, start.left + dx));
      const top = Math.max(8, Math.min(Math.max(8, viewportHeight - visibleHeight - 8), start.top + dy));
      if (this.isCollapsed) this.setPosition({ left, top, width: 62, height: 62, scale: 1 });
      else this.setPosition({ left, top });
    };
    const onEnd = async endEvent => {
      if (endEvent.pointerId !== start.pointerId) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      try {
        await game.user?.setFlag?.(MODULE_ID, "managerPosition", {
          left: this.position.left ?? start.left,
          top: this.position.top ?? start.top
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Could not save the manager position.`, err);
      }
      if (moved) setTimeout(() => { this._dragMoved = false; }, 250);
    };
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }

  _toggleRosterSelection(cards) {
    const uuids = [...new Set((cards ?? []).map(card => card.uuid).filter(Boolean))];
    if (!uuids.length) return;
    const allSelected = uuids.every(uuid => this.selected.has(uuid));
    if (allSelected) uuids.forEach(uuid => this.selected.delete(uuid));
    else uuids.forEach(uuid => this.selected.add(uuid));
    this.render();
  }

  _handleCardClick(event) {
    const card = event.target.closest("[data-actor-uuid]");
    if (!card || event.target.closest("select, button, input, label")) return;
    const uuid = card.dataset.actorUuid;
    if (!uuid) return;
    if (event.detail > 1) {
      const timer = this.clickTimers.get(uuid);
      if (timer) clearTimeout(timer);
      this.clickTimers.delete(uuid);
      const actor = fromUuidSync(uuid);
      actor?.sheet?.render(true);
      return;
    }
    const timer = setTimeout(() => {
      if (this.selected.has(uuid)) this.selected.delete(uuid);
      else this.selected.add(uuid);
      this.clickTimers.delete(uuid);
      this.render();
    }, 230);
    const existing = this.clickTimers.get(uuid);
    if (existing) clearTimeout(existing);
    this.clickTimers.set(uuid, timer);
  }

  async _openToolPicker() {
    if (this._toolPickerOpen) {
      this._closeToolPicker();
      return;
    }
    const entries = Object.entries(CONFIG.DND5E?.tools ?? {});
    if (!entries.length) return ui.notifications.warn("No D&D 5e tools were found in the system configuration.");
    const tools = await Promise.all(entries.map(async ([value, data]) => {
      const label = await resolveToolDisplayLabel(value, data);
      return { value, label, selected: value === this.subtype, category: toolCategory(label, value) };
    }));
    tools.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
    const categories = [...new Set(tools.map(tool => tool.category))];
    const storedFavorites = game.settings.get(MODULE_ID, "favoriteTools");
    const favoriteValues = new Set(Array.isArray(storedFavorites) ? storedFavorites : []);
    const favoriteTools = tools.filter(tool => favoriteValues.has(tool.value)).sort((a, b) => a.label.localeCompare(b.label));
    const panels = [
      { name: "Favorites", favorites: true, tools: favoriteTools },
      ...categories.map(category => ({ name: category, favorites: false, tools: tools.filter(tool => tool.category === category) }))
    ];
    const drawer = this.element?.querySelector("[data-tool-drawer]");
    const categoriesRoot = drawer?.querySelector(".rd-tool-categories");
    if (!drawer || !categoriesRoot) return ui.notifications.warn("The Roll Director tool picker could not be mounted.");

    categoriesRoot.innerHTML = panels.map(panel => {
      const toolButtons = panel.tools.map(tool => `<button type="button" class="rd-tool-option ${tool.value === this.subtype ? "is-selected" : ""}" data-action="select-tool" data-tool-value="${escapeHTML(tool.value)}" data-tool-label="${escapeHTML(tool.label)}" title="${escapeHTML(tool.label)}">${escapeHTML(tool.label)}</button>`).join("");
      const emptyMessage = panel.favorites && !panel.tools.length
        ? '<p class="rd-tool-favorite-empty">Choose favorites in Module Settings.</p>'
        : "";
      const heading = panel.favorites ? '<i class="fa-solid fa-star" aria-hidden="true"></i> Favorites' : escapeHTML(panel.name);
      return `<section class="rd-tool-category ${panel.favorites ? "rd-tool-favorites" : ""}"><h3>${heading}</h3><div class="rd-tool-options">${toolButtons}${emptyMessage}</div></section>`;
    }).join("");
    const search = drawer.querySelector(".rd-tool-search");
    if (search) search.value = "";
    this._filterToolPicker("");
    drawer.hidden = false;
    this._toolPickerOpen = true;
    search?.focus();
  }

  _closeToolPicker() {
    const drawer = this.element?.querySelector("[data-tool-drawer]");
    if (drawer) drawer.hidden = true;
    this._toolPickerOpen = false;
  }

  _filterToolPicker(value) {
    const drawer = this.element?.querySelector("[data-tool-drawer]");
    if (!drawer) return;
    const query = String(value ?? "").trim().toLocaleLowerCase();
    let visible = 0;
    for (const button of drawer.querySelectorAll(".rd-tool-option")) {
      const label = button.dataset.toolLabel ?? button.textContent ?? "";
      const identifier = button.dataset.toolValue ?? "";
      const show = label.toLocaleLowerCase().includes(query) || identifier.toLocaleLowerCase().includes(query);
      button.hidden = !show;
      if (show) visible++;
    }
    for (const section of drawer.querySelectorAll(".rd-tool-category")) {
      const hasVisibleOption = [...section.querySelectorAll(".rd-tool-option")].some(button => !button.hidden);
      const isFavorites = section.classList.contains("rd-tool-favorites");
      section.hidden = query ? !hasVisibleOption : (!isFavorites && !hasVisibleOption);
    }
    const noResults = drawer.querySelector(".rd-tool-no-results");
    if (noResults) noResults.hidden = visible > 0;
  }

  _handleChange(event) {
    const target = event.target;
    if (target.name === "rollType") {
      this.rollType = target.value;
      this.subtype = getSubtypeOptions(this.rollType)[0]?.value ?? "";
      this.render();
    } else if (target.name === "subtype") {
      this.subtype = target.value;
    } else if (target.name === "dcPreset") {
      if (target.value !== "custom") this.dc = Number(target.value);
      this.render();
    } else if (target.name === "dc") {
      const value = Number.parseInt(target.value, 10);
      if (Number.isFinite(value)) this.dc = Math.max(1, Math.min(40, value));
    } else if (target.name === "rollMode") {
      this.rollMode = target.value;
    } else if (target.name === "groupMethod") {
      this.groupMethod = target.value;
    } else if (target.matches("[data-actor-mode]")) {
      this.actorModes.set(target.dataset.actorMode, target.value);
    } else if (target.matches("[data-actor-advantage]")) {
      this.actorAdvantages.set(target.dataset.actorAdvantage, target.value);
    }
  }

  async startRequest(kind) {
    if (!isGM()) return;
    if (activeRequests.size || this._midiRequestPending) {
      ui.notifications.warn("A Roll Director request is already in progress. Finish or close it before starting another.");
      return;
    }
    const requestedCards = [...this.selected]
      .map(uuid => this.rosterCards.get(uuid) ?? (fromUuidSync(uuid) ? actorCard(fromUuidSync(uuid)) : null))
      .filter(card => card?.actor);
    if (!requestedCards.length) {
      ui.notifications.warn("Select at least one actor first, or use Add all Players / Add all NPCs.");
      return;
    }
    const dcInput = this.element?.querySelector("input[name='dc']");
    const typedDC = Number.parseInt(dcInput?.value ?? String(this.dc), 10);
    if (Number.isFinite(typedDC)) this.dc = Math.max(1, Math.min(40, typedDC));

    // For saves, ability checks, and skill checks, start a small synthetic D&D 5e
    // Activity through Midi-QoL. Midi then owns the workflow and its target roll promises;
    // the existing preCheckSaves adapter opens the shared Roll Director window. This is
    // what lets External Reaction's existing Midi workflow hook see these manually
    // requested rolls without changing External Reaction itself.
    const midi = game.modules.get("midi-qol")?.api;
    const completeItemUse = midi?.completeItemUse ?? globalThis.MidiQOL?.completeItemUse;
    if (["save", "ability", "skill"].includes(this.rollType)
        && game.modules.get("midi-qol")?.active
        && typeof completeItemUse === "function") {
      const targets = requestedCards.map(card => {
        const token = findCanvasToken(card.tokenUuid)
          ?? canvas?.tokens?.placeables?.find(entry => entry.actor?.uuid === card.uuid);
        return token ? { card, token } : null;
      });
      if (targets.every(Boolean)) {
        const manualSettings = {
          dc: this.dc,
          rollMode: this.rollMode,
          groupMethod: this.groupMethod,
          defaultAdvantage: this.defaultAdvantage,
          actorModes: Object.fromEntries(this.actorModes),
          actorAdvantages: Object.fromEntries(this.actorAdvantages)
        };
        this._midiRequestPending = true;
        this.render();
        try {
          const itemData = {
            name: `Roll Director — ${rollTypeLabel(this.rollType)}${this.subtype ? ` (${subtypeLabelForRequest(this.rollType, this.subtype)})` : ""}`,
            type: "feat",
            img: "icons/svg/dice-target.svg",
            system: {
              identifier: "roll-director-manual-request",
              activities: {
                rollDirectorActivity: {
                  type: this.rollType === "save" ? "save" : "check",
                  name: `Roll Director ${rollTypeLabel(this.rollType)}`,
                  activation: { type: "special" },
                  target: {
                    affects: { choice: false, count: "", type: "creature" },
                    override: true,
                    prompt: false
                  },
                  ...(this.rollType === "save" ? {
                    damage: { parts: [], onSave: "half" },
                    save: { ability: this.subtype, dc: { calculation: "", formula: String(this.dc) } }
                  } : {
                    check: {
                      ability: this.rollType === "ability"
                        ? this.subtype
                        : (CONFIG.DND5E?.skills?.[this.subtype]?.ability ?? "int"),
                      associated: this.rollType === "skill" ? [this.subtype] : [],
                      dc: { calculation: "", formula: String(this.dc) },
                      visible: false,
                      bonus: ""
                    }
                  }),
                  useConditionText: "",
                  forceDialog: false,
                  effectConditionText: ""
                }
              }
            },
            flags: {
              "midi-qol": { syntheticItem: true, noProvokeReaction: true },
              [MODULE_ID]: { manualRequest: manualSettings }
            }
          };
          const sourceActor = targets[0].card.actor;
          const syntheticItem = new CONFIG.Item.documentClass(itemData, { parent: sourceActor });
          syntheticItem.prepareData();
          syntheticItem.prepareFinalAttributes();
          const activityCollection = syntheticItem.system?.activities;
          const activity = activityCollection?.get?.("rollDirectorActivity")
            ?? activityCollection?.contents?.find(entry => entry?.name === `Roll Director ${rollTypeLabel(this.rollType)}`)
            ?? Array.from(activityCollection ?? []).find(entry => entry?.name === `Roll Director ${rollTypeLabel(this.rollType)}`);
          if (!activity?.id) throw new Error("The synthetic Midi-QoL Activity was not prepared correctly.");
          const activityId = activity.id;
          const targetUuids = targets.map(entry => entry.token.document?.uuid ?? entry.token.uuid).filter(Boolean);
          if (!targetUuids.length) throw new Error("No usable target token UUIDs were found for the Midi-QoL workflow.");
          this.selected.clear();
          this.render();
          await completeItemUse.call(midi ?? globalThis.MidiQOL, syntheticItem, {
            midiOptions: {
              activityId,
              targetUuids,
              checkGMStatus: true,
              createWorkflow: true,
              workflowOptions: { targetConfirmation: "none", noProvokeReaction: true }
            }
          }, { configure: false }, { systemCard: false });
          return;
        } catch (error) {
          console.error(`${MODULE_ID} | Midi-QoL manual request workflow failed.`, error);
          ui.notifications.error("Roll Director could not start the Midi-QoL roll workflow. See the console for details.");
          return;
        } finally {
          this._midiRequestPending = false;
          this.render();
        }
      }
      console.warn(`${MODULE_ID} | At least one manually requested actor has no token on the current scene; using the native roll request path for this request.`);
      ui.notifications.info("One or more selected actors have no token on the current scene. This request will use the standard actor-roll path.");
    }

    const subtypeLabel = subtypeLabelForRequest(this.rollType, this.subtype);
    const requestId = foundry.utils.randomID();
    const request = {
      id: requestId,
      createdAt: Date.now(),
      rollType: this.rollType,
      subtype: this.subtype,
      subtypeLabel,
      typeLabel: rollTypeLabel(this.rollType),
      dc: this.dc,
      rollMode: this.rollMode,
      groupMethod: this.groupMethod,
      defaultAdvantage: this.defaultAdvantage,
      enableGroupRoll: true,
      isAutomatic: false,
      actors: requestedCards.map(card => {
        const actor = card.actor;
        const privateNPC = isNPC(actor) && !isPlayerControlledActor(actor);
        const requestedMode = privateNPC ? "selfroll" : (this.actorModes.get(card.uuid) ?? "auto");
        const rollMode = privateNPC ? "selfroll" : resolveDefaultMode(actor, requestedMode, this.rollMode);
        const actorAdvantageOverride = this.actorAdvantages.get(card.uuid) ?? "auto";
        const defaultMode = resolvePromptAdvantage(
          actor, this.rollType, this.subtype, actorAdvantageOverride, this.defaultAdvantage
        );
        return {
          uuid: actor.uuid,
          targetTokenUuid: card.tokenUuid ?? null,
          name: card.name ?? actorDisplayName(actor),
          img: documentImage(actor),
          type: actorLabel(actor).type,
          isNPC: isNPC(actor),
          isPC: isPlayerControlledActor(actor),
          isPartyMinion: isPartyMinion(actor),
          privateNPC,
          rollVisibilityLocked: privateNPC,
          isPlayerControlled: isPlayerControlledActor(actor),
          rollMode,
          defaultMode,
          relevantModifier: getRelevantModifier(actor, { rollType: this.rollType, subtype: this.subtype })
        };
      }),
      results: {},
      started: new Set(),
      completed: new Set(),
      itemMaps: new Map(),
      finalized: false
    };
    request.modeSelections = new Map(request.actors.map(actor => [actor.uuid, actor.defaultMode ?? "normal"]));
    activeRequests.set(requestId, request);
    this.selected.clear();
    this.render();
    // Open the GM view before sending invitations so an exceptionally fast player response
    // cannot arrive before the GM's prompt has been initialized.
    gmPromptApp = new RollDirectorPrompt({ requestId, isGMView: true });
    await gmPromptApp.render(true);
    await this._sendPlayerRequests(request);
  }

  async startAutomaticRequest(payload, initiatorId) {
    if (!isGM()) return;
    const initiator = game.users.get(initiatorId);
    if (!initiator || !payload) return;
    const triggerList = Array.isArray(payload.triggerActors) && payload.triggerActors.length
      ? payload.triggerActors
      : [{ actorUuid: payload.triggerActorUuid, initialMode: payload.initialMode, dc: payload.dc }];
    const manualSettings = payload.manualRequest ?? null;
    const combatTrackerInitiative = payload.combatTrackerInitiative === true && initiator.isGM;
    const validatedTriggers = [];
    for (const trigger of triggerList) {
      const actor = trigger?.actorUuid ? await fromUuid(trigger.actorUuid) : null;
      if (!actor || (!manualSettings && !isAutomaticallyEligibleActor(actor) && !combatTrackerInitiative)) continue;
      if (!payload.midiWorkflow && !initiator.isGM && !hasOwner(actor, initiator)) continue;
      if (validatedTriggers.some(entry => entry.actor.uuid === actor.uuid)) continue;
      validatedTriggers.push({ actor, trigger });
    }
    if (!validatedTriggers.length) {
      // Direct-roll intercepts are paused and need releasing. A Midi workflow adapter has
      // not patched the target queue yet, so it can safely fall back to native Midi rolls.
      if (!payload.midiWorkflow) {
        for (const trigger of triggerList) {
          if (trigger?.actorUuid) await createHiddenTransport([initiatorId], {
            kind: "auto-cancel", actorUuid: trigger.actorUuid
          });
        }
      }
      return null;
    }
    const triggerActor = validatedTriggers[0].actor;

    if (activeRequests.size) {
      // Keep the Midi hook paused until this workflow's request is actually active. This
      // serializes independent synthetic concentration workflows without dropping any of
      // their target rolls or switching them to a competing per-actor prompt path.
      return new Promise(resolve => {
        automaticRequestQueue.push({ payload, initiatorId, resolve });
        void createHiddenTransport([initiatorId], { kind: "auto-queued", triggerActorUuid: triggerActor.uuid })
          .catch(error => console.warn(`${MODULE_ID} | Could not notify initiator about queued request.`, error));
      });
    }

    // Only actors that actually triggered this intercepted roll are included. This matters
    // for initiative and targeted saves: a single PC check must not invite the whole party
    // or add unrelated characters to combat.
    const candidateActors = validatedTriggers.map(entry => entry.actor);
    const triggerMetadata = new Map(validatedTriggers.map(entry => [entry.actor.uuid, entry.trigger]));

    const defaultRollMode = normalizeRollMode(manualSettings?.rollMode ?? game.settings.get(MODULE_ID, "defaultRollMode") ?? "publicroll");
    const groupMethod = manualSettings?.groupMethod ?? game.settings.get(MODULE_ID, "defaultGroupRollType") ?? "standard";
    const rollType = payload.rollType;
    const subtype = payload.subtype ?? "";
    const targetCandidate = payload.dc ?? validatedTriggers.find(entry => entry.trigger?.dc !== null && entry.trigger?.dc !== undefined)?.trigger?.dc;
    const dc = targetCandidate !== null && targetCandidate !== undefined && targetCandidate !== "" && Number.isFinite(Number(targetCandidate))
      ? Number(targetCandidate) : null;
    const id = foundry.utils.randomID();
    const actors = candidateActors.map(actor => {
      const trigger = triggerMetadata.get(actor.uuid) ?? {};
      const controlled = isPlayerControlledActor(actor);
      const privateNPC = isNPC(actor) && !controlled;
      const modeSetting = manualSettings?.actorModes?.[actor.uuid] ?? managerApp?.actorModes.get(actor.uuid) ?? "auto";
      const resolvedRollMode = privateNPC ? "selfroll"
        : (modeSetting && modeSetting !== "auto" ? normalizeRollMode(modeSetting) : defaultRollMode);
      const advantageSetting = manualSettings?.actorAdvantages?.[actor.uuid] ?? managerApp?.actorAdvantages.get(actor.uuid) ?? "auto";
      const calculatedMode = resolvePromptAdvantage(actor, rollType, subtype, advantageSetting, manualSettings?.defaultAdvantage ?? "normal");
      const defaultMode = manualSettings
        ? calculatedMode
        : (["advantage", "disadvantage", "normal"].includes(trigger.initialMode) ? trigger.initialMode : calculatedMode);
      return {
        uuid: actor.uuid,
        targetTokenUuid: trigger.targetTokenUuid ?? null,
        combatantId: trigger.combatantId ?? null,
        combatUuid: trigger.combatUuid ?? null,
        updateTurn: typeof trigger.updateTurn === "boolean" ? trigger.updateTurn : undefined,
        name: actorDisplayName(actor, findCanvasToken(trigger.targetTokenUuid)),
        img: documentImage(actor),
        type: isCharacter(actor) ? "Player Character" : (isPartyMinion(actor) ? "Party Minion" : (controlled ? "Player-controlled Actor" : "NPC")),
        isNPC: isNPC(actor),
        isPC: isCharacter(actor) || controlled,
        isPlayerControlled: controlled,
        isPartyMinion: isPartyMinion(actor),
        autoRollInitiative: combatTrackerInitiative && rollType === "initiative"
          && isNPC(actor) && !controlled && game.settings.get(MODULE_ID, "autoRollNPCInitiative"),
        privateNPC,
        rollVisibilityLocked: privateNPC,
        rollMode: resolvedRollMode,
        defaultMode,
        // Combat Tracker requests do not have a paused native actor call to resume.
        // Leave originUserId empty for GM-started initiative so player prompts roll locally
        // through the GUI instead of trying to resolve a non-existent paused native roll.
        originUserId: trigger.originUserId ?? (combatTrackerInitiative ? null : initiatorId),
        relevantModifier: getRelevantModifier(actor, { rollType, subtype })
      };
    });

    const hasDC = dc !== null;
    const enableGroupRoll = hasDC && actors.filter(actor => actor.isPC).length > 1
      && !["death", "concentration", "initiative"].includes(rollType);
    const request = {
      id,
      createdAt: Date.now(),
      rollType,
      subtype,
      subtypeLabel: payload.subtypeLabel ?? subtypeLabelForRequest(rollType, subtype),
      typeLabel: payload.typeLabel ?? rollTypeLabel(rollType),
      dc,
      rollMode: defaultRollMode,
      groupMethod,
      defaultAdvantage: manualSettings?.defaultAdvantage ?? "normal",
      isAutomatic: true,
      isCombatTrackerInitiative: combatTrackerInitiative && rollType === "initiative",
      isMidiWorkflow: !!payload.midiWorkflow,
      workflowId: payload.workflowId ?? null,
      initiatorId,
      enableGroupRoll,
      triggerActorUuid: triggerActor.uuid,
      actors,
      results: {},
      completed: new Set(),
      pendingRolls: new Set(),
      itemMaps: new Map(),
      finalized: false
    };
    request.modeSelections = new Map(request.actors.map(actor => [actor.uuid, actor.defaultMode ?? "normal"]));
    for (const actorEntry of request.actors) {
      const pending = pendingInterceptRolls.get(actorEntry.uuid);
      if (pending && pending.originUserId === game.user.id) {
        pending.requestId = id;
        pending.requestData = actorEntry;
      }
    }
    activeRequests.set(id, request);
    if (request.isMidiWorkflow) {
      for (const actorEntry of request.actors) {
        registerMidiWorkflowContext({
          requestId: request.id, workflowId: request.workflowId, actorUuid: actorEntry.uuid,
          rollType: request.rollType, subtype: request.subtype, dc: request.dc,
          rollMode: actorEntry.rollMode, defaultMode: actorEntry.defaultMode,
          targetTokenUuid: actorEntry.targetTokenUuid, privateNPC: actorEntry.privateNPC,
          isNPC: actorEntry.isNPC, isPC: actorEntry.isPC
        });
      }
    }
    gmPromptApp?.close();
    gmPromptApp = new RollDirectorPrompt({ requestId: id, isGMView: true });
    await gmPromptApp.render(true);
    if (request.isMidiWorkflow) {
      const expectedUsers = this._getPlayerRequestUserIds(request);
      const readiness = createMidiPromptReadiness(request.id, expectedUsers);
      await this._sendPlayerRequests(request);
      const ready = await readiness;
      if (!ready) {
        await this._cancelMidiWorkflowRequest(request);
        return null;
      }
      return request;
    }
    await this._sendPlayerRequests(request);
    if (request.isCombatTrackerInitiative) void this._autoRollNPCInitiativeActors(request);
    return request;
  }

  async _autoRollNPCInitiativeActors(request) {
    if (!isGM() || !request?.isCombatTrackerInitiative || request.finalized) return;
    for (const entry of request.actors.filter(actor => actor.autoRollInitiative)) {
      if (request.finalized || activeRequests.get(request.id) !== request || request.completed.has(entry.uuid)) continue;
      const actor = await fromUuid(entry.uuid);
      if (!actor) {
        await this.skipActor(request.id, entry.uuid);
        continue;
      }
      const mode = ["advantage", "disadvantage", "normal"].includes(entry.defaultMode)
        ? entry.defaultMode : getNativeAdvantageMode(actor, "initiative", "");
      const advantageMode = mode === "advantage" ? CONFIG.Dice.D20Roll.ADV_MODE.ADVANTAGE
        : mode === "disadvantage" ? CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE
        : CONFIG.Dice.D20Roll.ADV_MODE.NORMAL;
      const override = {
        mode,
        rollType: "initiative",
        rollMode: "selfroll",
        createdAt: Date.now(),
        requestId: request.id,
        actorUuid: actor.uuid,
        actorId: actor.id,
        targetTokenUuid: entry.targetTokenUuid ?? null,
        isNPC: true,
        privateNPC: true,
        isPC: false,
        rollerUserId: game.user.id
      };
      activeRollModeOverrides.set(actor.uuid, override);
      const securityMarker = setRecentRollSecurityMarker(actor, override);
      initiativeRollsByActor.delete(actor.uuid);
      try {
        await this.markActorStarted(request.id, actor.uuid, game.user.id);
        if (request.finalized || activeRequests.get(request.id) !== request) return;
        const combatResult = await actor.rollInitiative({
          createCombatants: true,
          initiativeOptions: {
            messageMode: "gm",
            ...(typeof entry.updateTurn === "boolean" ? { updateTurn: entry.updateTurn } : {})
          }
        }, { advantageMode });
        const roll = resolveInitiativeRollForActor(actor, entry, combatResult);
        const result = rollResultPayload(roll, actor, request, mode, game.user.id);
        if (!result) {
          console.warn(`${MODULE_ID} | Automatic NPC initiative did not produce a roll for ${entry.name}.`);
          await this.skipActor(request.id, actor.uuid);
          continue;
        }
        await ensureDiceAnimation(roll, actor, securityMarker);
        await this.handleGMResult(request.id, actor.uuid, {
          ...result,
          actorUuid: actor.uuid,
          name: entry.name,
          img: entry.img,
          isNPC: true,
          isPC: false,
          privateNPC: true,
          mode,
          rollMode: "selfroll",
          rollerUserId: game.user.id
        });
      } catch (error) {
        console.error(`${MODULE_ID} | Automatic NPC initiative failed for ${entry.name}.`, error);
        await this.skipActor(request.id, actor.uuid);
      } finally {
        initiativeRollsByActor.delete(actor.uuid);
        initiativeScoresByActor.delete(actor.uuid);
        if (activeRollModeOverrides.get(actor.uuid) === override) activeRollModeOverrides.delete(actor.uuid);
      }
    }
  }

  _getPlayerRequestUserIds(request) {
    const expected = new Set();
    for (const user of getPlayerUsers().filter(user => user.active)) {
      // The player prompt is strictly owner-only. Observer permission is enough to
      // view many documents, but must not expose another character in this roll UI.
      const visibleActors = request.actors.filter(entry => {
        if (!entry.isPC || entry.rollVisibilityLocked || entry.privateNPC) return false;
        const actor = fromUuidSync(entry.uuid);
        return actor && hasOwner(actor, user);
      });
      if (!visibleActors.length) continue;
      expected.add(user.id);
    }
    return expected;
  }

  async _cancelMidiWorkflowRequest(request) {
    if (!request || request.finalized) return null;
    await this.cancelRequest(request.id, "readiness-timeout");
    return null;
  }

  async cancelRequest(requestId, reason = "gm") {
    if (!isGM()) return false;
    const request = activeRequests.get(requestId);
    if (!request || request.finalized || request.cancelling) return false;
    request.cancelling = true;
    // Mark it final before any network awaits so late player results cannot race with
    // cancellation and finalize the same request a second time.
    request.finalized = true;

    // Release any paused native roll on this client immediately and ask other originating
    // clients to release theirs. A cancelled direct-roll intercept returns null to the
    // native call site; Midi-QoL workflow contexts are cleared to fail open to Midi's own roll.
    for (const entry of request.actors ?? []) {
      if (request.completed.has(entry.uuid)) continue;
      resolvePendingInterceptRoll(entry.uuid, request.id, null);
      if (request.isAutomatic && !request.isMidiWorkflow && entry.originUserId && entry.originUserId !== game.user.id) {
        await createHiddenTransport([entry.originUserId], { kind: "auto-cancel", requestId: request.id, actorUuid: entry.uuid });
      }
    }

    const readiness = midiPromptReadiness.get(request.id);
    if (readiness) {
      midiPromptReadiness.delete(request.id);
      if (readiness.timer) clearTimeout(readiness.timer);
      readiness.resolve(false);
    }

    request.cancelled = true;
    const finishRecipients = new Set([...request.itemMaps.values()].map(entry => entry.userId));
    for (const entry of request.actors ?? []) if (entry.originUserId) finishRecipients.add(entry.originUserId);
    game.users.filter(user => user.isGM && user.active).forEach(user => finishRecipients.add(user.id));
    for (const userId of finishRecipients) {
      await createHiddenTransport([userId], { kind: "finished", requestId: request.id, workflowId: request.workflowId ?? null });
    }
    if (request.isMidiWorkflow) clearMidiWorkflowContextsForRequest(request.id, request.workflowId);

    // Keep already completed rolls visible, but do not calculate a group outcome from a
    // deliberately incomplete sample.
    const results = Object.values(request.results ?? {}).filter(result => !result.skipped && Number.isFinite(Number(result.total)));
    if (results.length) await createSummaryMessages(request, results, null);

    activeRequests.delete(request.id);
    clearDisconnectedActorTimers(request.id);
    clearDisconnectedInitiatorTimer(request.id);
    if (gmPromptApp?.requestId === request.id) gmPromptApp.close();
    if (playerPromptApp?.requestId === request.id) playerPromptApp.close();
    if (currentPromptRequestId === request.id) currentPromptRequestId = null;
    if (reason === "readiness-timeout") {
      ui.notifications.info("Roll Director cancelled a request because not all required player prompts became ready. Midi-QoL was released to its native roll path.");
    } else if (reason === "initiator-disconnected") {
      ui.notifications.warn("Roll Director cancelled an automatic request because its initiating player disconnected. Completed rolls were retained.");
    } else {
      ui.notifications.info("Roll Director request cancelled. Completed rolls were retained.");
    }
    this._startNextQueuedAutomaticRequest();
    return true;
  }

  async handleUserDisconnected(user) {
    if (!isGM()) return;
    const disconnected = typeof user === "string" ? game.users.get(user) : user;
    const userId = disconnected?.id;
    if (!userId || disconnected?.isGM) return;

    // Keep an automatic workflow alive briefly in case the initiator is experiencing a
    // transient connection loss. If they remain offline for the full grace period, cancel
    // the request safely instead of allowing the originating workflow to hang forever.
    for (const request of activeRequests.values()) {
      if (!request.isAutomatic || request.initiatorId !== userId || request.finalized) continue;
      clearDisconnectedInitiatorTimer(request.id);
      const timer = setTimeout(async () => {
        disconnectedInitiatorTimers.delete(request.id);
        const current = activeRequests.get(request.id);
        if (current !== request || request.finalized || game.users.get(userId)?.active) return;
        console.warn(`${MODULE_ID} | Cancelling an automatic request after its initiating player stayed disconnected for ${disconnectRecoveryGraceMs / 1000}s.`);
        await this.cancelRequest(request.id, "initiator-disconnected");
      }, disconnectRecoveryGraceMs);
      disconnectedInitiatorTimers.set(request.id, { requestId: request.id, userId, timer });
    }

    // Remove the disconnected user from prompt readiness requirements so a pending Midi
    // adapter cannot hold the workflow until its full readiness timeout.
    for (const [requestId, state] of midiPromptReadiness.entries()) {
      state.expected.delete(userId);
      if ([...state.expected].every(id => state.ready.has(id))) {
        midiPromptReadiness.delete(requestId);
        if (state.timer) clearTimeout(state.timer);
        state.resolve(true);
      }
    }

    for (const request of [...activeRequests.values()]) {
      const affected = new Set();
      for (const [itemId, mapEntry] of request.itemMaps.entries()) {
        if (mapEntry.userId !== userId) continue;
        affected.add(mapEntry.actorUuid);
        request.itemMaps.delete(itemId);
      }
      // The request may not have sent its player prompts yet when the disconnect hook
      // fires. Include unresolved characters this user owns, even when no item map exists.
      for (const entry of request.actors ?? []) {
        if (request.completed.has(entry.uuid) || !entry.isPC) continue;
        const actor = fromUuidSync(entry.uuid);
        if (actor && hasOwner(actor, disconnected)) affected.add(entry.uuid);
      }

      for (const actorUuid of affected) {
        if (request.completed.has(actorUuid)) continue;
        const actor = fromUuidSync(actorUuid);
        const startedByUser = request.startedByUser?.get(actorUuid);
        const disconnectedWasRolling = startedByUser === userId;
        if (disconnectedWasRolling) {
          request.pendingRolls?.delete(actorUuid);
          request.started?.delete(actorUuid);
          request.startedByUser?.delete(actorUuid);
        } else if (request.started?.has(actorUuid) || request.pendingRolls?.has(actorUuid)) {
          // Another player or the GM is already handling this roll; don't interrupt it.
          continue;
        }

        const activeOwnerIds = actor
          ? game.users.filter(entry => !entry.isGM && entry.active && entry.id !== userId && hasOwner(actor, entry)).map(entry => entry.id)
          : [];
        if (activeOwnerIds.length) {
          // If the disconnected user had started the roll, the remaining owners were sent
          // a started/pending state. Reissue the outstanding item with fresh item IDs.
          if (disconnectedWasRolling) await this._sendPlayerRequests(request, activeOwnerIds, new Set([actorUuid]));
          continue;
        }

        const timerKey = `${request.id}:${actorUuid}`;
        const previousTimer = disconnectedActorTimers.get(timerKey);
        if (previousTimer) clearTimeout(previousTimer.timer);
        const timer = setTimeout(async () => {
          disconnectedActorTimers.delete(timerKey);
          const current = activeRequests.get(request.id);
          if (current !== request || request.finalized || request.completed.has(actorUuid)) return;
          const starterId = request.startedByUser?.get(actorUuid);
          const starterActive = starterId ? !!game.users.get(starterId)?.active : false;
          if ((request.started?.has(actorUuid) || request.pendingRolls?.has(actorUuid)) && starterActive) return;
          // The actor's original roller was disconnected while the request was pending.
          // Clear that stale state before issuing a fresh prompt to a connected owner.
          request.started?.delete(actorUuid);
          request.pendingRolls?.delete(actorUuid);
          request.startedByUser?.delete(actorUuid);
          const latestActor = fromUuidSync(actorUuid);
          const latestOwnerIds = latestActor
            ? game.users.filter(entry => !entry.isGM && entry.active && hasOwner(latestActor, entry)).map(entry => entry.id)
            : [];
          if (latestOwnerIds.length) {
            await this._sendPlayerRequests(request, latestOwnerIds, new Set([actorUuid]));
            return;
          }
          const otherActiveOwnerMap = [...request.itemMaps.values()].some(entry =>
            entry.actorUuid === actorUuid && game.users.get(entry.userId)?.active
          );
          if (otherActiveOwnerMap) return;
          if (request.isMidiWorkflow) {
            clearMidiWorkflowContextForActor(request.id, request.workflowId, actorUuid);
            const actorEntry = actorRequest(request, actorUuid);
            const recipients = game.users.filter(entry => entry.active && (
              entry.isGM || entry.id === actorEntry?.originUserId || (latestActor && hasOwner(latestActor, entry))
            )).map(entry => entry.id);
            await createHiddenTransport(recipients, { kind: "midi-cancel-actor", requestId: request.id, workflowId: request.workflowId, actorUuid });
          } else if (request.isAutomatic) {
            const origin = actorRequest(request, actorUuid)?.originUserId;
            if (origin && origin !== game.user.id) {
              await createHiddenTransport([origin], { kind: "auto-cancel", requestId: request.id, actorUuid });
            } else {
              resolvePendingInterceptRoll(actorUuid, request.id, null);
            }
          }
          console.warn(`${MODULE_ID} | Skipping an unresolved actor after its owner stayed disconnected for ${disconnectRecoveryGraceMs / 1000}s.`);
          await this.skipActor(request.id, actorUuid);
        }, disconnectRecoveryGraceMs);
        disconnectedActorTimers.set(timerKey, { requestId: request.id, actorUuid, userId, timer });
      }
    }
  }

  async handleUserConnected(user) {
    if (!isGM()) return;
    const connected = typeof user === "string" ? game.users.get(user) : user;
    if (!connected || connected.isGM || !connected.active) return;
    for (const request of activeRequests.values()) {
      if (request.initiatorId === connected.id) clearDisconnectedInitiatorTimer(request.id);
    }
    // Re-send outstanding requests to a reconnecting user who owns an unresolved PC.
    for (const request of [...activeRequests.values()]) {
      for (const entry of request.actors) {
        const timerKey = `${request.id}:${entry.uuid}`;
        if (request.completed.has(entry.uuid) || !disconnectedActorTimers.has(timerKey)) continue;
        if (request.startedByUser?.get(entry.uuid) !== connected.id) continue;
        request.started?.delete(entry.uuid);
        request.pendingRolls?.delete(entry.uuid);
        request.startedByUser?.delete(entry.uuid);
      }
      const ownedOutstanding = request.actors.filter(entry => {
        if (request.completed.has(entry.uuid) || request.started?.has(entry.uuid) || request.pendingRolls?.has(entry.uuid)) return false;
        if (!entry.isPC || entry.privateNPC || entry.rollVisibilityLocked) return false;
        const actor = fromUuidSync(entry.uuid);
        return actor && hasOwner(actor, connected);
      });
      if (!ownedOutstanding.length) continue;
      for (const entry of ownedOutstanding) clearDisconnectedActorTimers(request.id, entry.uuid);
      await this._sendPlayerRequests(request, [connected.id]);
    }
  }

  _startNextQueuedAutomaticRequest() {
    const queued = automaticRequestQueue.shift();
    if (!queued) return;
    setTimeout(async () => {
      if (queued.initiatorId && !game.users.get(queued.initiatorId)?.active) {
        queued.resolve?.(null);
        return;
      }
      managerApp ??= new RollDirectorManager();
      try {
        const startedRequest = await managerApp.startAutomaticRequest(queued.payload, queued.initiatorId);
        queued.resolve?.(startedRequest ?? null);
      } catch (error) {
        console.error(`${MODULE_ID} | Could not start queued automatic request.`, error);
        queued.resolve?.(null);
      }
    }, 0);
  }

  async _sendPlayerRequests(request, targetUserIds = null, onlyActorUuids = null) {
    const targetIds = targetUserIds ? new Set(targetUserIds) : null;
    const actorFilter = onlyActorUuids ? new Set(onlyActorUuids) : null;
    const recipients = getPlayerUsers().filter(user => user.active && (!targetIds || targetIds.has(user.id)));
    for (const user of recipients) {
      // On reconnect, replace stale item-map entries before issuing the refreshed roster.
      // If recovering one disconnected roller, only replace that actor's entry so other
      // in-flight rolls for this player retain their completion routing.
      if (targetIds) {
        for (const [itemId, entry] of request.itemMaps.entries()) {
          if (entry.userId === user.id && (!actorFilter || actorFilter.has(entry.actorUuid))) request.itemMaps.delete(itemId);
        }
      }
      // Player clients receive PC entries only. NPC participation must remain entirely GM-only.
      // Do not even send observer-only actors to the player's client. The popup is
      // both the visible roster and the set of actors the user may roll for.
      const visibleActors = request.actors.filter(entry => {
        if (actorFilter && !actorFilter.has(entry.uuid)) return false;
        if (request.completed.has(entry.uuid) || request.started?.has(entry.uuid) || request.pendingRolls?.has(entry.uuid)) return false;
        if (!entry.isPC || entry.rollVisibilityLocked || entry.privateNPC) return false;
        const actor = fromUuidSync(entry.uuid);
        return actor && hasOwner(actor, user);
      });
      if (!visibleActors.length) {
        if (targetIds && !actorFilter) await createHiddenTransport([user.id], { kind: "finished", requestId: request.id, workflowId: request.workflowId ?? null });
        continue;
      }
      const items = visibleActors.map(entry => {
        const itemId = foundry.utils.randomID();
        request.itemMaps.set(itemId, { actorUuid: entry.uuid, userId: user.id });
        return {
          itemId,
          uuid: entry.uuid,
          targetTokenUuid: entry.targetTokenUuid ?? null,
          combatantId: entry.combatantId ?? null,
          combatUuid: entry.combatUuid ?? null,
          updateTurn: typeof entry.updateTurn === "boolean" ? entry.updateTurn : undefined,
          name: entry.name,
          img: entry.img,
          type: entry.type,
          isNPC: entry.isNPC,
          isPC: entry.isPC,
          privateNPC: entry.privateNPC,
          rollVisibilityLocked: entry.rollVisibilityLocked,
          isPlayerControlled: entry.isPlayerControlled,
          rollMode: entry.rollMode,
          defaultMode: entry.defaultMode,
          originUserId: entry.originUserId ?? null
        };
      });
      const transport = {
        kind: "request",
        requestId: request.id,
        rollType: request.rollType,
        subtype: request.subtype,
        subtypeLabel: request.subtypeLabel,
        typeLabel: request.typeLabel,
        defaultAdvantage: request.defaultAdvantage,
        automatic: !!request.isAutomatic,
        midiWorkflow: !!request.isMidiWorkflow,
        workflowId: request.workflowId ?? null,
        dc: request.dc,
        actors: items,
        startedBy: game.user.id
      };
      await createHiddenTransport([user.id], transport);
    }
  }

  async handleMidiWorkflowChoice(message, transport, senderOverride = null) {
    const request = activeRequests.get(transport.requestId);
    if (!request || request.finalized || !request.isMidiWorkflow || request.workflowId !== transport.workflowId) return;
    const senderId = senderOverride ?? (message?.user?.id ?? message?.user ?? message?.author?.id);
    const sender = game.users.get(senderId);
    const actorUuid = transport.actorUuid;
    const actorEntry = actorRequest(request, actorUuid);
    const actor = actorEntry ? await fromUuid(actorUuid) : null;
    if (request.finalized || activeRequests.get(request.id) !== request) return;
    if (!sender || !actor || !actorEntry || !["advantage", "disadvantage", "normal"].includes(transport.mode)) return;
    if (sender.isGM) {
      if (!isGM()) return;
    } else {
      const mapEntry = request.itemMaps.get(transport.itemId);
      if (!mapEntry || mapEntry.actorUuid !== actorUuid || mapEntry.userId !== senderId || !hasOwner(actor, sender)) return;
    }
    if (request.completed.has(actorUuid) || request.pendingRolls.has(actorUuid)) return;
    request.pendingRolls.add(actorUuid);
    await this.markActorStarted(request.id, actorUuid, senderId);
    if (request.finalized || activeRequests.get(request.id) !== request) return;
    await this.updateActorMode(request.id, actorUuid, transport.mode);
    if (request.finalized || activeRequests.get(request.id) !== request) return;
    if (gmPromptApp?.requestId === request.id) gmPromptApp.render();

    // Hide the actor from every active prompt while Midi is resolving its native target roll.
    for (const [itemId, mapEntry] of request.itemMaps.entries()) {
      if (mapEntry.actorUuid !== actorUuid) continue;
      await createHiddenTransport([mapEntry.userId], {
        kind: "midi-rolling", requestId: request.id, workflowId: request.workflowId, itemId
      });
      if (request.finalized || activeRequests.get(request.id) !== request) return;
    }

    const recipients = game.users.filter(user => user.active && (user.isGM || hasOwner(actor, user))).map(user => user.id);
    const decision = {
      kind: "midi-mode-apply", requestId: request.id, workflowId: request.workflowId,
      actorUuid, mode: transport.mode, rollMode: actorEntry.rollMode,
      defaultMode: actorEntry.defaultMode, rollType: request.rollType, subtype: request.subtype,
      dc: request.dc, isNPC: actorEntry.isNPC, isPC: actorEntry.isPC, privateNPC: actorEntry.privateNPC,
      targetTokenUuid: actorEntry.targetTokenUuid
    };
    // Resolve locally first for GM-owned/fallback rolls, then send the same approved mode
    // to all active actor-owner clients. Only the client Midi actually invokes will roll.
    resolveMidiWorkflowMode({ workflowId: request.workflowId, actorUuid, requestId: request.id, mode: transport.mode });
    await createHiddenTransport(recipients, decision);
  }

  async handleMidiWorkflowResults(message, transport, senderOverride = null) {
    const request = activeRequests.get(transport.requestId);
    if (!request || request.finalized || !request.isMidiWorkflow || request.workflowId !== transport.workflowId) return;
    const senderId = senderOverride ?? (message?.user?.id ?? message?.user ?? message?.author?.id);
    const sender = game.users.get(senderId);
    if (!sender || (senderId !== request.initiatorId && !sender.isGM)) return;

    const supplied = new Set();
    for (const result of transport.results ?? []) {
      const actorUuid = result?.actorUuid;
      const entry = actorRequest(request, actorUuid);
      if (!entry || request.completed.has(actorUuid) || !Number.isFinite(Number(result.total))) continue;
      if (request.finalized || activeRequests.get(request.id) !== request) return;
      supplied.add(actorUuid);
      request.results[actorUuid] = {
        ...result,
        actorUuid,
        name: entry.name,
        img: entry.img,
        isNPC: entry.isNPC,
        isPC: entry.isPC,
        privateNPC: entry.privateNPC,
        rollMode: entry.rollMode,
        mode: ["advantage", "disadvantage", "normal"].includes(result.mode)
          ? result.mode : (request.modeSelections.get(actorUuid) ?? entry.defaultMode ?? "normal"),
        rollerUserId: result.rollerUserId ?? senderId,
        skipped: false
      };
      request.completed.add(actorUuid);
      request.pendingRolls.delete(actorUuid);
      request.startedByUser?.delete(actorUuid);
      await this._broadcastActorDone(request, actorUuid);
      if (request.finalized || activeRequests.get(request.id) !== request) return;
    }

    // Midi can auto-succeed/auto-fail a target without producing a D20Roll. Mark those
    // actors complete without inventing a total, so an otherwise valid request cannot hang.
    for (const entry of request.actors) {
      if (request.finalized || activeRequests.get(request.id) !== request) return;
      if (request.completed.has(entry.uuid) || supplied.has(entry.uuid)) continue;
      request.results[entry.uuid] = {
        actorUuid: entry.uuid, name: entry.name, img: entry.img,
        isNPC: entry.isNPC, isPC: entry.isPC, privateNPC: entry.privateNPC,
        rollMode: entry.rollMode, mode: request.modeSelections.get(entry.uuid) ?? entry.defaultMode ?? "normal",
        rollerUserId: senderId, skipped: true, total: null, passed: null
      };
      request.completed.add(entry.uuid);
      request.pendingRolls.delete(entry.uuid);
      await this._broadcastActorDone(request, entry.uuid);
      if (request.finalized || activeRequests.get(request.id) !== request) return;
    }
    gmPromptApp?.render();
    await this._finalizeIfDone(request);
  }

  async handleAutoCancelTrigger(message, transport) {
    const request = activeRequests.get(transport.requestId);
    if (!request || request.finalized || request.completed.has(transport.actorUuid)) return;
    const senderId = message.user?.id ?? message.user ?? message.author?.id;
    const sender = game.users.get(senderId);
    const actorData = actorRequest(request, transport.actorUuid);
    const mapEntry = transport.itemId ? request.itemMaps.get(transport.itemId) : null;
    if (!sender || !actorData) return;
    const actor = await fromUuid(transport.actorUuid);
    if (request.finalized || activeRequests.get(request.id) !== request) return;
    if (!actor || !hasObserver(actor, sender)) return;
    if (mapEntry ? mapEntry.userId !== sender.id : actorData.originUserId !== sender.id) return;
    await this.skipActor(request.id, actor.uuid);
  }

  async handleObserverRoll(message, transport) {
    const request = activeRequests.get(transport.requestId);
    if (!request || request.finalized || !["advantage", "disadvantage", "normal"].includes(transport.mode)) return;
    const senderId = message.user?.id ?? message.user ?? message.author?.id;
    const mapEntry = request.itemMaps.get(transport.itemId);
    if (!senderId || !mapEntry || mapEntry.userId !== senderId || request.completed.has(mapEntry.actorUuid)) return;
    const actor = await fromUuid(mapEntry.actorUuid);
    const sender = game.users.get(senderId);
    if (request.finalized || activeRequests.get(request.id) !== request) return;
    if (!actor || !sender || !hasOwner(actor, sender)) return;
    if (!gmPromptApp || gmPromptApp.requestId !== request.id) {
      gmPromptApp?.close();
      gmPromptApp = new RollDirectorPrompt({ requestId: request.id, isGMView: true });
      await gmPromptApp.render(true);
    }
    // Legacy transport guard: only the actor's owner may request this player-side roll.
    // The GM still executes the native roll when handling an authorized request.
    await gmPromptApp.rollActor(actor.uuid, transport.mode, senderId);
  }

  async handlePlayerResult(message, transport) {
    const request = activeRequests.get(transport.requestId);
    if (!request || request.finalized) return;
    const senderId = message.user?.id ?? message.user ?? message.author?.id;
    const sender = game.users.get(senderId);
    const mapEntry = request.itemMaps.get(transport.itemId);
    if (!sender || !mapEntry || sender.id !== mapEntry.userId) return;
    if (request.completed.has(mapEntry.actorUuid)) return;
    const actor = await fromUuid(mapEntry.actorUuid);
    if (request.finalized || activeRequests.get(request.id) !== request) return;
    if (!actor || !hasObserver(actor, sender)) return;
    const result = {
      actorUuid: actor.uuid,
      name: actorRequest(request, actor.uuid)?.name ?? actorDisplayName(actor),
      img: documentImage(actor),
      isNPC: isNPC(actor),
      isPC: actorRequest(request, actor.uuid)?.isPC ?? isCharacter(actor),
      privateNPC: actorRequest(request, actor.uuid)?.privateNPC ?? isNPC(actor),
      total: Number(transport.total),
      natural: Number.isFinite(transport.natural) ? Number(transport.natural) : null,
      modifier: Number.isFinite(transport.modifier) ? Number(transport.modifier) : 0,
      mode: ["advantage", "disadvantage", "normal"].includes(transport.mode) ? transport.mode : "normal",
      rollMode: actorRequest(request, actor.uuid)?.rollMode ?? "publicroll",
      rollerUserId: sender.id,
      formula: String(transport.formula ?? "1d20"),
      rollDetail: transport.rollDetail && typeof transport.rollDetail === "object" ? transport.rollDetail : null,
      isCritical: !!transport.isCritical,
      isFumble: !!transport.isFumble,
      skipped: false
    };
    request.results[actor.uuid] = result;
    request.completed.add(actor.uuid);
    request.startedByUser?.delete(actor.uuid);
    await this._broadcastActorDone(request, actor.uuid);
    gmPromptApp?.render();
    await this._finalizeIfDone(request);
  }

  async markActorStarted(requestId, actorUuid, sourceUserId = game.user.id) {
    const request = activeRequests.get(requestId);
    if (!request || request.finalized || request.completed.has(actorUuid) || request.started?.has(actorUuid)) return;
    request.started ??= new Set();
    request.startedByUser ??= new Map();
    request.started.add(actorUuid);
    request.startedByUser.set(actorUuid, sourceUserId ?? game.user.id);
    gmPromptApp?.render();
    for (const [itemId, mapEntry] of request.itemMaps.entries()) {
      if (mapEntry.actorUuid !== actorUuid) continue;
      await createHiddenTransport([mapEntry.userId], { kind: "started", requestId, itemId });
    }
  }

  async handleAutoActorStarted(message, transport) {
    const request = activeRequests.get(transport.requestId);
    if (!request || request.finalized || !actorRequest(request, transport.actorUuid)) return;
    const senderId = message.user?.id ?? message.user ?? message.author?.id;
    const sender = game.users.get(senderId);
    const actor = await fromUuid(transport.actorUuid);
    if (request.finalized || activeRequests.get(request.id) !== request) return;
    if (!sender || !actor) return;
    if (!sender.isGM) {
      const permitted = [...request.itemMaps.values()].some(entry => entry.actorUuid === actor.uuid && entry.userId === sender.id);
      if (!permitted || !hasOwner(actor, sender)) return;
    }
    await this.markActorStarted(request.id, actor.uuid, sender.id);
  }

  async updateActorMode(requestId, actorUuid, mode) {
    const request = activeRequests.get(requestId);
    if (!request || request.finalized || request.completed.has(actorUuid) || !["advantage", "disadvantage", "normal"].includes(mode)) return;
    const actorData = actorRequest(request, actorUuid);
    if (!actorData) return;

    request.modeSelections ??= new Map();
    request.modeSelections.set(actorUuid, mode);
    if (gmPromptApp?.requestId === requestId) {
      gmPromptApp.actorModes.set(actorUuid, mode);
      gmPromptApp.render();
    }

    // Each user has a distinct itemId for this actor in their prompt. Updating by itemId
    // keeps every visible copy in sync without disclosing any NPC state to players.
    for (const [itemId, mapEntry] of request.itemMaps.entries()) {
      if (mapEntry.actorUuid !== actorUuid) continue;
      await createHiddenTransport([mapEntry.userId], {
        kind: "mode-update", requestId, itemId, mode
      });
    }
  }

  async handlePlayerModeChange(message, transport) {
    const request = activeRequests.get(transport.requestId);
    if (!request || request.finalized) return;
    const senderId = message.user?.id ?? message.user ?? message.author?.id;
    const mapEntry = request.itemMaps.get(transport.itemId);
    if (!senderId || !mapEntry || mapEntry.userId !== senderId) return;
    const actor = await fromUuid(mapEntry.actorUuid);
    const sender = game.users.get(senderId);
    if (request.finalized || activeRequests.get(request.id) !== request) return;
    if (!actor || !sender || !hasOwner(actor, sender)) return;
    if (!["advantage", "disadvantage", "normal"].includes(transport.mode)) return;
    await this.updateActorMode(request.id, actor.uuid, transport.mode);
  }

  async _broadcastActorDone(request, actorUuid) {
    const actor = fromUuidSync(actorUuid);
    if (!actor) return;
    const completionIds = [];
    const actorEntry = actorRequest(request, actorUuid);
    if (request.isAutomatic && !request.isMidiWorkflow && !request.results[actorUuid] && actorEntry?.originUserId) {
      await createHiddenTransport([actorEntry.originUserId], {
        kind: "auto-cancel", requestId: request.id, actorUuid
      });
    }
    for (const [itemId, mapEntry] of request.itemMaps.entries()) {
      if (mapEntry.actorUuid !== actorUuid) continue;
      await createHiddenTransport([mapEntry.userId], { kind: "complete", requestId: request.id, itemId });
      completionIds.push(itemId);
    }
  }

  async handleGMResult(requestId, actorUuid, result) {
    const request = activeRequests.get(requestId);
    if (!request || request.finalized || request.completed.has(actorUuid)) return;
    const displayName = actorRequest(request, actorUuid)?.name;
    request.results[actorUuid] = { ...result, actorUuid, ...(displayName ? { name: displayName } : {}), rollerUserId: result.rollerUserId ?? game.user.id };
    request.completed.add(actorUuid);
    request.startedByUser?.delete(actorUuid);
    await this._broadcastActorDone(request, actorUuid);
    gmPromptApp?.render();
    await this._finalizeIfDone(request);
  }

  async skipActor(requestId, actorUuid) {
    const request = activeRequests.get(requestId);
    if (!request || request.finalized || request.completed.has(actorUuid)) return;
    request.completed.add(actorUuid);
    request.startedByUser?.delete(actorUuid);
    await this._broadcastActorDone(request, actorUuid);
    gmPromptApp?.render();
    await this._finalizeIfDone(request);
  }

  async _finalizeIfDone(request) {
    if (request.finalized) return;
    if (request.actors.some(actor => !request.completed.has(actor.uuid))) return;
    request.finalized = true;
    const results = Object.values(request.results).filter(result => !result.skipped && Number.isFinite(Number(result.total)));
    const groupResult = evaluateGroupRoll(request, results);
    const participantIds = new Set([...request.itemMaps.values()].map(entry => entry.userId));
    if (request.isMidiWorkflow) game.users.filter(user => user.isGM && user.active).forEach(user => participantIds.add(user.id));
    for (const userId of participantIds) {
      await createHiddenTransport([userId], { kind: "finished", requestId: request.id, workflowId: request.workflowId });
    }
    await createSummaryMessages(request, results, groupResult);
    activeRequests.delete(request.id);
    clearDisconnectedActorTimers(request.id);
    clearDisconnectedInitiatorTimer(request.id);
    if (request.isMidiWorkflow) clearMidiWorkflowContextsForRequest(request.id, request.workflowId);
    if (gmPromptApp?.requestId === request.id) gmPromptApp.close();
    if (playerPromptApp?.requestId === request.id) playerPromptApp.close();
    currentPromptRequestId = null;
    this._startNextQueuedAutomaticRequest();
  }
}

function subtypeLabelForRequest(rollType, subtype) {
  return subtypeLabel(rollType, subtype);
}

function actorRequest(request, actorUuid) {
  return request.actors.find(actor => actor.uuid === actorUuid);
}

function evaluateGroupRoll(request, results) {
  const characters = results.filter(result => result.isPC);
  if (!request.enableGroupRoll || request.dc === null || request.dc === undefined || request.dc === "" || !Number.isFinite(Number(request.dc))) return null;
  if (characters.length <= 1) return null;
  const dc = Number(request.dc);
  const successes = characters.filter(result => typeof result.passed === "boolean" ? result.passed : result.total >= dc).length;
  const failures = characters.length - successes;
  let total;
  let label;
  let passed;
  if (request.groupMethod === "average") {
    total = Math.ceil(characters.reduce((sum, result) => sum + result.total, 0) / characters.length);
    label = `Average ${total}`;
    passed = total >= dc;
  } else if (request.groupMethod === "leader") {
    const leader = [...characters].sort((a, b) => (Number(b.modifier) || 0) - (Number(a.modifier) || 0))[0];
    total = Number(leader.total) - failures;
    label = `Leader with Help ${total} (${leader.name} − ${failures} failed)`;
    passed = total >= dc;
  } else if (request.groupMethod === "weakest") {
    const weakest = [...characters].sort((a, b) => (Number(a.modifier) || 0) - (Number(b.modifier) || 0))[0];
    total = Number(weakest.total) + successes;
    label = `Weakest Link ${total} (${weakest.name} + ${successes} successes)`;
    passed = total >= dc;
  } else {
    total = successes;
    label = `Standard Rule ${successes}/${characters.length} succeeded`;
    passed = successes >= Math.ceil(characters.length / 2);
  }
  return { method: request.groupMethod, label, total, successes, failures, passed, dc, count: characters.length };
}

async function createSummaryMessages(request, results, groupResult) {
  const gms = game.users.filter(user => user.isGM);
  const gm = gms[0] ?? game.user;
  const gmHTML = makeRequestSummaryHTML(request, results, gm, true, groupResult);
  await ChatMessage.create({
    content: gmHTML,
    style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
    whisper: gms.map(user => user.id),
    blind: false,
    flags: { [MODULE_ID]: { [GM_SUMMARY_FLAG]: true, requestId: request.id } }
  });
  const playerUsers = getPlayerUsers();
  const cohorts = new Map();
  for (const user of playerUsers) {
    const visibleResultIds = results.filter(result => {
      const actor = fromUuidSync(result.actorUuid);
      return actor && canUserSeeResult(result, actor, user);
    }).map(result => result.actorUuid).sort();
    if (!visibleResultIds.length) continue;
    const key = visibleResultIds.join("|");
    if (!cohorts.has(key)) cohorts.set(key, { users: [], results: visibleResultIds.map(uuid => results.find(r => r.actorUuid === uuid)) });
    cohorts.get(key).users.push(user.id);
  }
  for (const cohort of cohorts.values()) {
    const user = game.users.get(cohort.users[0]);
    const saveLike = ["save", "death", "concentration"].includes(request.rollType);
    const showOutcomes = game.settings.get(MODULE_ID, saveLike
      ? "showSaveOutcomesToPlayers" : "showCheckOutcomesToPlayers");
    const html = makeRequestSummaryHTML(request, cohort.results, user, false, null, showOutcomes);
    if (!html.includes("rd-summary-section")) continue;
    await ChatMessage.create({
      content: html,
      style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
      whisper: cohort.users,
      blind: false,
      flags: { [MODULE_ID]: { [SUMMARY_FLAG]: true, requestId: request.id, cohort: cohort.users } }
    });
  }
}

function renderGroupResult(group) {
  if (!group) return "";
  const outcome = group.passed ? "success" : "failure";
  const label = group.passed ? "Passed" : "Failed";
  return `<details class="rd-group-result"><summary class="rd-group-summary"><span class="rd-group-title">Group roll</span><strong class="rd-group-outcome ${outcome}">${label}</strong><i class="rd-group-chevron fa-solid fa-chevron-down" aria-hidden="true"></i></summary><div class="rd-group-details"><p>${escapeHTML(group.label)}</p><small>DC ${Number(group.dc)} · ${Number(group.successes)}/${Number(group.count)} individual successes</small></div></details>`;
}

class RollDirectorPrompt extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor({ requestId, isGMView = false } = {}) {
    const width = Math.min(800, Math.max(260, (globalThis.innerWidth ?? 1280) - 24));
    const height = Math.min(560, Math.max(300, (globalThis.innerHeight ?? 800) - 100));
    super({ position: { width, height, left: Math.max(8, Math.round(((globalThis.innerWidth ?? 1280) - width) / 2)), top: Math.max(30, Math.round(((globalThis.innerHeight ?? 800) - height) / 2)) } });
    this.requestId = requestId;
    this.isGMView = isGMView;
    this.actorModes = new Map();
    this.pending = new Set();
  }

  static DEFAULT_OPTIONS = {
    id: "roll-director-prompt",
    tag: "section",
    classes: ["roll-director", "rd-prompt-app"],
    window: { title: "Roll Request", icon: "fa-solid fa-dice-d20", resizable: true },
    position: { width: 760, height: 360 },
    actions: {}
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/prompt.hbs` }
  };

  get request() {
    return activeRequests.get(this.requestId);
  }

  async _prepareContext() {
    if (this.isGMView) {
      const request = this.request;
      const actors = (request?.actors ?? []).filter(entry => !request.completed.has(entry.uuid) && !request.started?.has(entry.uuid)).map(entry => ({
        ...entry,
        itemId: entry.uuid,
        currentMode: request.modeSelections?.get(entry.uuid) ?? this.actorModes.get(entry.uuid) ?? entry.defaultMode ?? "normal",
        selectedAdvantage: (request.modeSelections?.get(entry.uuid) ?? this.actorModes.get(entry.uuid) ?? entry.defaultMode) === "advantage",
        selectedDisadvantage: (request.modeSelections?.get(entry.uuid) ?? this.actorModes.get(entry.uuid) ?? entry.defaultMode) === "disadvantage",
        canRoll: !request.pendingRolls?.has(entry.uuid)
      }));
      return {
        isGMView: true,
        requestId: this.requestId,
        typeLabel: request?.typeLabel ?? "Roll Request",
        subtypeLabel: request?.subtypeLabel ?? "",
        dc: request?.dc,
        hasDC: request?.dc !== null && request?.dc !== undefined && request?.dc !== "" && Number.isFinite(Number(request?.dc)),
        automatic: !!request?.isAutomatic,
        remaining: actors.length,
        total: request?.actors?.length ?? 0,
        actors,
        rollType: request?.rollType,
        hasActors: actors.length > 0
      };
    }
    return {
      isGMView: false,
      requestId: this.requestId,
      typeLabel: this.playerData?.typeLabel ?? "Roll Request",
      subtypeLabel: this.playerData?.subtypeLabel ?? "",
      automatic: !!this.playerData?.automatic,
      remaining: (this.playerData?.actors ?? []).filter(actor => !this.pending.has(actor.itemId)).length,
      total: this.playerData?.actors?.length ?? 0,
      actors: (this.playerData?.actors ?? []).filter(actor => !this.pending.has(actor.itemId)).map(actor => ({
        ...actor,
        currentMode: this.actorModes.get(actor.itemId) ?? actor.defaultMode ?? "normal",
        selectedAdvantage: (this.actorModes.get(actor.itemId) ?? actor.defaultMode) === "advantage",
        selectedDisadvantage: (this.actorModes.get(actor.itemId) ?? actor.defaultMode) === "disadvantage",
        canRoll: true
      })),
      hasActors: (this.playerData?.actors ?? []).some(actor => !this.pending.has(actor.itemId))
    };
  }

  setPlayerData(transport) {
    this.requestId = transport.requestId;
    this.playerData = transport;
    this.pending.clear();
    this.actorModes.clear();
    for (const actor of transport.actors ?? []) {
      this.actorModes.set(actor.itemId, actor.defaultMode ?? "normal");
      if (transport.midiWorkflow && transport.workflowId) {
        registerMidiWorkflowContext({
          requestId: transport.requestId, workflowId: transport.workflowId, actorUuid: actor.uuid,
          rollType: transport.rollType, subtype: transport.subtype, dc: transport.dc,
          rollMode: actor.rollMode, defaultMode: actor.defaultMode,
          targetTokenUuid: actor.targetTokenUuid, isNPC: actor.isNPC, isPC: actor.isPC,
          privateNPC: actor.privateNPC
        });
      }
      const pending = pendingInterceptRolls.get(actor.uuid);
      if (pending && pending.originUserId === game.user.id) {
        pending.requestId = transport.requestId;
        pending.requestData = actor;
      }
    }
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    if (this._boundRoot !== root) {
      this._boundRoot = root;
      root.addEventListener("click", event => this._handleClick(event));
    }
    if (!this.isGMView) this._fitPlayerPromptToActors();
  }

  _fitPlayerPromptToActors() {
    // Keep the GM prompt's established dimensions/layout untouched. The player prompt
    // should use only the space needed for this player's currently actionable actors.
    const viewportWidth = Math.max(320, (globalThis.innerWidth ?? 1280) - 24);
    const viewportHeight = Math.max(300, (globalThis.innerHeight ?? 800) - 70);
    const count = (this.playerData?.actors ?? []).filter(actor => !this.pending.has(actor.itemId)).length;
    const maxColumns = Math.max(1, Math.min(4, Math.floor((viewportWidth - 40) / 245)));
    const columns = count ? Math.max(1, Math.min(count, maxColumns)) : 1;
    const width = Math.min(viewportWidth, Math.max(320, columns * 245 + 40));
    const rows = Math.max(1, Math.ceil(count / columns));
    const height = Math.min(viewportHeight, count ? 230 + rows * 190 : 300);
    const left = Math.max(8, Math.round(((globalThis.innerWidth ?? 1280) - width) / 2));
    const top = Math.max(24, Math.round(((globalThis.innerHeight ?? 800) - height) / 2));
    this.setPosition({ width, height, left, top });
  }

  async _handleClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const itemId = button.dataset.itemId;
    const mode = button.dataset.mode;
    if (action === "mode") {
      if (!itemId || !["advantage", "disadvantage", "normal"].includes(mode)) return;
      this.actorModes.set(itemId, mode);
      this.render();
      if (this.isGMView) {
        await managerApp?.updateActorMode(this.requestId, itemId, mode);
      } else {
        const gms = game.users.filter(user => user.isGM).map(user => user.id);
        await createHiddenTransport(gms, {
          kind: "mode-change", requestId: this.requestId, itemId, mode
        });
      }
    } else if (action === "roll") {
      await this.rollActor(itemId);
    } else if (action === "roll-all") {
      await this.rollMany(actor => true);
    } else if (action === "roll-npcs") {
      await this.rollMany(actor => actor.isNPC);
    } else if (action === "skip") {
      if (this.isGMView) {
        const request = this.request;
        const actorUuid = itemId;
        await managerApp.skipActor(this.requestId, actorUuid);
      }
    } else if (action === "cancel-request") {
      if (!this.isGMView || !isGM()) return;
      let accepted = false;
      try {
        const DialogV2 = foundry.applications?.api?.DialogV2;
        if (typeof DialogV2?.confirm === "function") {
          accepted = await DialogV2.confirm({
            window: { title: "Cancel Roll Director Request" },
            content: "Cancel the active request? Completed rolls will be retained. For Midi-QoL workflows, pending target rolls return to Midi-QoL's native path."
          });
        } else {
          accepted = globalThis.confirm("Cancel the active Roll Director request? Completed rolls will be retained.");
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | Request cancellation confirmation failed.`, error);
      }
      if (accepted) await managerApp?.cancelRequest(this.requestId, "gm");
    } else if (action === "close") {
      if (this.isGMView) {
        const request = this.request;
        if (request?.isMidiWorkflow) {
          for (const actor of request.actors) {
            if (!request.completed.has(actor.uuid) && !request.pendingRolls.has(actor.uuid)) {
              await managerApp.handleMidiWorkflowChoice(null, {
                requestId: request.id, workflowId: request.workflowId, actorUuid: actor.uuid,
                mode: request.modeSelections.get(actor.uuid) ?? actor.defaultMode ?? "normal"
              }, game.user.id);
            }
          }
        } else if (request) {
          for (const actor of request.actors) {
            if (!request.completed.has(actor.uuid)) await managerApp.skipActor(this.requestId, actor.uuid);
          }
        }
      }
      this.close();
    }
  }

  async rollMany(predicate) {
    const request = this.request;
    const actors = this.isGMView
      ? (request?.actors ?? []).filter(actor => !request.completed.has(actor.uuid) && predicate(actor))
      : (this.playerData?.actors ?? []).filter(actor => !this.pending.has(actor.itemId) && predicate(actor));
    for (const actor of actors) {
      const mode = this.actorModes.get(this.isGMView ? actor.uuid : actor.itemId) ?? actor.defaultMode ?? "normal";
      await this.rollActor(this.isGMView ? actor.uuid : actor.itemId, mode);
    }
  }

  async rollActor(itemId, explicitMode, delegatedRollerId = null) {
    const request = this.request;
    const playerActor = this.isGMView ? null : this.playerData?.actors?.find(actor => actor.itemId === itemId);
    const actorUuid = this.isGMView ? itemId : playerActor?.uuid;
    const actorRequestData = this.isGMView ? actorRequest(request, actorUuid) : playerActor;
    if (!actorRequestData || (!this.isGMView && !actorRequestData.uuid)) return;
    const actor = await fromUuid(actorUuid);
    if (!actor) {
      ui.notifications.warn("Roll Director could not find the requested actor.");
      return;
    }
    if (!this.isGMView && !hasOwner(actor, game.user)) {
      ui.notifications.warn("You no longer have Owner permission for this actor.");
      return;
    }
    const mode = explicitMode ?? this.actorModes.get(itemId) ?? actorRequestData.defaultMode ?? "normal";
    const rollType = request?.rollType ?? this.playerData?.rollType;
    const isMidiWorkflow = !!(request?.isMidiWorkflow ?? this.playerData?.midiWorkflow);
    const midiWorkflowId = request?.workflowId ?? this.playerData?.workflowId;
    const privateNPC = actorRequestData.privateNPC ?? actorRequestData.rollVisibilityLocked ?? isNPC(actor);
    const rollMode = privateNPC ? "selfroll" : normalizeRollMode(actorRequestData.rollMode ?? game.settings.get(MODULE_ID, "defaultRollMode") ?? "publicroll");
    const rollerUserId = delegatedRollerId ?? game.user.id;
    if (isMidiWorkflow) {
      if (request?.pendingRolls?.has(actor.uuid) || request?.completed?.has(actor.uuid)) return;
      if (!this.isGMView) {
        this.pending.add(itemId);
        this.render();
        await createHiddenTransport(game.users.filter(user => user.isGM && user.active).map(user => user.id), {
          kind: "midi-roll-choice", requestId: this.requestId, workflowId: midiWorkflowId,
          actorUuid: actor.uuid, itemId, mode
        });
      } else {
        await managerApp?.handleMidiWorkflowChoice(null, {
          requestId: this.requestId, workflowId: midiWorkflowId, actorUuid: actor.uuid,
          itemId, mode
        }, game.user.id);
      }
      return;
    }

    if (!this.isGMView) this.pending.add(itemId);
    this.render();

    // Automatic interception pauses the native method on its original client. A prompt
    // click only chooses the mode; the original call resumes and returns its real result
    // to D&D 5e/Midi-QoL instead of launching a separate, disconnected roll.
    const pendingNative = pendingInterceptRolls.get(actor.uuid);
    if (pendingNative && (!pendingNative.requestId || pendingNative.requestId === this.requestId)) {
      pendingNative.requestId = this.requestId;
      pendingNative.requestData = actorRequestData;
      if (this.isGMView) {
        await managerApp?.markActorStarted(this.requestId, actor.uuid, rollerUserId);
      } else {
        const gms = game.users.filter(user => user.isGM && user.active).map(user => user.id);
        await createHiddenTransport(gms, { kind: "auto-rolling", requestId: this.requestId, actorUuid: actor.uuid });
      }
      resolvePendingInterceptRoll(actor.uuid, this.requestId, mode);
      return;
    }

    // If this request originated on another client, send the selected mode back to that
    // client so its paused native roll can continue. The GM is not rolling a duplicate.
    const originUserId = actorRequestData.originUserId ?? null;
    const isAutomatic = request?.isAutomatic ?? this.playerData?.automatic;
    if (isAutomatic && originUserId && originUserId !== game.user.id) {
      if (this.isGMView) {
        await managerApp?.markActorStarted(this.requestId, actor.uuid, rollerUserId);
      } else {
        const gms = game.users.filter(user => user.isGM && user.active).map(user => user.id);
        await createHiddenTransport(gms, { kind: "auto-rolling", requestId: this.requestId, actorUuid: actor.uuid });
      }
      await createHiddenTransport([originUserId], {
        kind: "auto-resolve", requestId: this.requestId, actorUuid: actor.uuid, mode
      });
      return;
    }

    const rollOverride = {
      mode, rollType, rollMode, createdAt: Date.now(), requestId: this.requestId,
      actorUuid: actor.uuid, actorId: actor.id, isNPC: isNPC(actor), privateNPC,
      isPC: actorRequestData.isPC ?? isCharacter(actor), rollerUserId
    };
    const securityMarker = { ...rollOverride, expiresAt: Date.now() + 8000 };
    activeRollModeOverrides.set(actor.uuid, rollOverride);
    recentRollSecurityMarkers.set(actor.uuid, securityMarker);
    setTimeout(() => {
      if (recentRollSecurityMarkers.get(actor.uuid) === securityMarker) recentRollSecurityMarkers.delete(actor.uuid);
    }, 8500);
    try {
      // The postRollConfiguration hook applies the selected final mode after D&D 5e and
      // compatible automation modules have prepared the native roll.
      const rollDC = request?.dc ?? this.playerData?.dc;
      const hasRollDC = rollDC !== null && rollDC !== undefined && rollDC !== "" && Number.isFinite(Number(rollDC));
      const target = hasRollDC ? Number(rollDC) : undefined;
      const rollConfig = {
        fastForward: true,
        ...(hasRollDC ? { target, midiOptions: { target }, rolls: [{ options: { target } }] } : {})
      };
      const dialogConfig = { configure: false };
      const messageConfig = { create: false, rollMode };
      let rolls;
      switch (rollType) {
        case "ability":
          rolls = await actor.rollAbilityCheck({ ...rollConfig, ability: request?.subtype ?? this.playerData?.subtype }, dialogConfig, messageConfig);
          break;
        case "save":
          rolls = await actor.rollSavingThrow({ ...rollConfig, ability: request?.subtype ?? this.playerData?.subtype }, dialogConfig, messageConfig);
          break;
        case "skill":
          rolls = await actor.rollSkill({ ...rollConfig, skill: request?.subtype ?? this.playerData?.subtype }, dialogConfig, messageConfig);
          break;
        case "tool":
          rolls = await actor.rollToolCheck({ ...rollConfig, tool: request?.subtype ?? this.playerData?.subtype }, dialogConfig, messageConfig);
          break;
        case "death":
          rolls = await actor.rollDeathSave(rollConfig, dialogConfig, messageConfig);
          break;
        case "concentration":
          rolls = await actor.rollConcentration({ ...rollConfig, ability: request?.subtype ?? this.playerData?.subtype }, dialogConfig, messageConfig);
          break;
        case "initiative": {
          initiativeRollsByActor.delete(actor.uuid);
          const advantageMode = mode === "advantage" ? CONFIG.Dice.D20Roll.ADV_MODE.ADVANTAGE
            : mode === "disadvantage" ? CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE
            : CONFIG.Dice.D20Roll.ADV_MODE.NORMAL;
          {
            const combatResult = await actor.rollInitiative({
              createCombatants: true,
              initiativeOptions: {
                messageMode: "gm",
                ...(typeof actorRequestData.updateTurn === "boolean" ? { updateTurn: actorRequestData.updateTurn } : {})
              }
            }, { advantageMode });
            rolls = resolveInitiativeRollForActor(actor, actorRequestData, combatResult);
          }
          break;
        }
        default:
          ui.notifications.warn("Unsupported roll type in this request.");
          if (!this.isGMView) this.pending.delete(itemId);
          this.render();
          return;
      }
      const result = rollResultPayload(rolls, actor, request ?? this.playerData, mode, rollerUserId);
      if (!result) {
        ui.notifications.warn(`${actor.name}: no roll was produced.`);
        if (!this.isGMView) this.pending.delete(itemId);
        this.render();
        return;
      }
      await ensureDiceAnimation(rolls, actor, {
        requestId: this.requestId,
        actorUuid: actor.uuid,
        actorId: actor.id,
        isNPC: isNPC(actor),
        privateNPC,
        isPC: actorRequestData.isPC ?? isCharacter(actor),
        rollMode,
        rollerUserId
      });
      const req = request ?? this.playerData;
      const fullResult = {
        ...result,
        actorUuid: actor.uuid,
        name: actorRequestData.name ?? actorDisplayName(actor),
        img: documentImage(actor),
        isNPC: isNPC(actor),
        isPC: actorRequestData.isPC ?? isCharacter(actor),
        privateNPC,
        mode,
        rollMode,
        rollerUserId
      };
      if (this.isGMView) {
        await managerApp.handleGMResult(this.requestId, actor.uuid, fullResult);
        this.render();
      } else {
        await createHiddenTransport(game.users.filter(user => user.isGM).map(user => user.id), {
          kind: "result",
          requestId: this.requestId,
          itemId,
          total: result.total,
          natural: result.natural,
          modifier: result.modifier,
          mode,
          formula: result.formula,
          rollDetail: result.rollDetail,
          isCritical: result.isCritical,
          isFumble: result.isFumble
        });
        this.pending.add(itemId);
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Roll failed`, error);
      ui.notifications.error(`${actor.name}: roll failed. See the console for details.`);
      if (!this.isGMView) this.pending.delete(itemId);
      this.render();
    } finally {
      if (rollType === "initiative") initiativeScoresByActor.delete(actor.uuid);
      if (activeRollModeOverrides.get(actor.uuid) === rollOverride) activeRollModeOverrides.delete(actor.uuid);
    }
  }

  applyModeUpdate(itemId, mode) {
    if (!itemId || !["advantage", "disadvantage", "normal"].includes(mode)) return;
    this.actorModes.set(itemId, mode);
    this.render();
  }

  markStarted(itemId) {
    if (!this.isGMView && itemId) {
      this.pending.add(itemId);
      this.render();
    }
  }

  markCompleted(itemId) {
    if (!this.isGMView) {
      this.pending.add(itemId);
      this.render();
    }
  }
}

async function onCreateChatMessage(message) {
  const transport = getTransport(message);
  if (!transport) return;
  if (transport.kind === "auto-start") {
    if (!isGM()) return;
    const senderId = message.user?.id ?? message.user ?? message.author?.id ?? transport.payload?.startedBy;
    managerApp ??= new RollDirectorManager();
    await managerApp.startAutomaticRequest(transport.payload, senderId);
  } else if (transport.kind === "midi-start") {
    if (!isGM()) return;
    const senderId = message.user?.id ?? message.user ?? message.author?.id;
    managerApp ??= new RollDirectorManager();
    const request = await managerApp.startAutomaticRequest(transport.payload, senderId);
    const actorModes = request?.actors?.map(entry => ({
      actorUuid: entry.uuid, targetTokenUuid: entry.targetTokenUuid,
      rollMode: entry.rollMode, defaultMode: entry.defaultMode,
      isNPC: entry.isNPC, isPC: entry.isPC, privateNPC: entry.privateNPC
    })) ?? [];
    await createHiddenTransport(senderId ? [senderId] : [], {
      kind: "midi-started", workflowId: transport.payload?.workflowId,
      accepted: !!request, requestId: request?.id ?? null, actors: actorModes
    });
  } else if (transport.kind === "midi-started") {
    if (!message.whisper?.includes(game.user.id)) return;
    const waiter = midiWorkflowStartWaiters.get(transport.workflowId);
    if (waiter) {
      midiWorkflowStartWaiters.delete(transport.workflowId);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(transport);
    }
  } else if (transport.kind === "midi-prompt-ready") {
    if (!isGM()) return;
    noteMidiPromptReady(message.user?.id ?? message.user ?? message.author?.id, transport.requestId);
  } else if (transport.kind === "midi-roll-choice") {
    if (!isGM()) return;
    await managerApp?.handleMidiWorkflowChoice(message, transport);
  } else if (transport.kind === "midi-mode-apply") {
    const senderId = message.user?.id ?? message.user ?? message.author?.id;
    if (!game.users.get(senderId)?.isGM) return;
    registerMidiWorkflowContext(transport);
    resolveMidiWorkflowMode(transport);
  } else if (transport.kind === "midi-rolling") {
    if (isGM() || !message.whisper?.includes(game.user.id)) return;
    if (playerPromptApp?.requestId === transport.requestId) playerPromptApp.markCompleted(transport.itemId);
  } else if (transport.kind === "midi-workflow-results") {
    if (!isGM()) return;
    await managerApp?.handleMidiWorkflowResults(message, transport);
  } else if (transport.kind === "midi-cancel-actor") {
    const senderId = message.user?.id ?? message.user ?? message.author?.id;
    if (!game.users.get(senderId)?.isGM) return;
    clearMidiWorkflowContextForActor(transport.requestId, transport.workflowId, transport.actorUuid);
  } else if (transport.kind === "midi-adapter-cancel") {
    if (!isGM()) return;
    const request = activeRequests.get(transport.requestId);
    if (request?.isMidiWorkflow && request.workflowId === transport.workflowId) {
      await managerApp?._cancelMidiWorkflowRequest(request);
    }
  } else if (transport.kind === "auto-queued") {
    if (!isGM()) ui.notifications.info("Your automatic roll request is queued until the current Roll Director request finishes.");
  } else if (transport.kind === "request") {
    if (isGM() || !message.whisper?.includes(game.user.id)) return;
    const actors = (transport.actors ?? []).filter(item => {
      const actor = fromUuidSync(item.uuid);
      return actor && hasOwner(actor, game.user);
    });
    // Sanitize on receipt as well as on the GM when sending; a stale or malformed
    // request must never populate the player popup with observer-only actors.
    const playerTransport = { ...transport, actors };
    if (!actors.length) {
      if (playerPromptApp?.requestId === transport.requestId) playerPromptApp.close();
      if (currentPromptRequestId === transport.requestId) currentPromptRequestId = null;
      return;
    }
    if (currentPromptRequestId !== transport.requestId) {
      playerPromptApp?.close();
      playerPromptApp = new RollDirectorPrompt({ requestId: transport.requestId, isGMView: false });
      playerPromptApp.setPlayerData(playerTransport);
      currentPromptRequestId = transport.requestId;
      await playerPromptApp.render(true);
    } else if (playerPromptApp?.requestId === transport.requestId) {
      // A request resent after reconnect refreshes the existing popup instead of leaving
      // stale actor/item IDs in the player's controls.
      playerPromptApp.setPlayerData(playerTransport);
      await playerPromptApp.render();
    }
    if (transport.midiWorkflow) {
      await createHiddenTransport(game.users.filter(user => user.isGM && user.active).map(user => user.id), {
        kind: "midi-prompt-ready", requestId: transport.requestId, workflowId: transport.workflowId
      });
    }
  } else if (transport.kind === "roll-on-behalf") {
    if (!isGM()) return;
    await managerApp?.handleObserverRoll(message, transport);
  } else if (transport.kind === "auto-resolve") {
    const senderId = message.user?.id ?? message.user ?? message.author?.id;
    const sender = game.users.get(senderId);
    const actor = await fromUuid(transport.actorUuid);
    if (!sender || !actor || (!sender.isGM && !hasObserver(actor, sender))) return;
    if (!playerPromptApp?.playerData?.actors?.some(entry => entry.uuid === actor.uuid)
        && !isGM()) return;
    resolvePendingInterceptRoll(transport.actorUuid, transport.requestId, transport.mode);
  } else if (transport.kind === "auto-cancel") {
    const senderId = message.user?.id ?? message.user ?? message.author?.id;
    const sender = game.users.get(senderId);
    if (!sender?.isGM) return;
    resolvePendingInterceptRoll(transport.actorUuid, transport.requestId, null);
  } else if (transport.kind === "auto-cancel-trigger") {
    if (!isGM()) return;
    await managerApp?.handleAutoCancelTrigger(message, transport);
  } else if (transport.kind === "auto-rolling") {
    if (!isGM()) return;
    await managerApp?.handleAutoActorStarted(message, transport);
  } else if (transport.kind === "started") {
    if (isGM() || !message.whisper?.includes(game.user.id)) return;
    if (playerPromptApp?.requestId === transport.requestId) playerPromptApp.markStarted(transport.itemId);
  } else if (transport.kind === "result") {
    if (!isGM()) return;
    await managerApp?.handlePlayerResult(message, transport);
  } else if (transport.kind === "mode-change") {
    if (!isGM()) return;
    await managerApp?.handlePlayerModeChange(message, transport);
  } else if (transport.kind === "mode-update") {
    if (isGM() || !message.whisper?.includes(game.user.id)) return;
    if (playerPromptApp?.requestId === transport.requestId) {
      playerPromptApp.applyModeUpdate(transport.itemId, transport.mode);
    }
  } else if (transport.kind === "complete") {
    if (isGM() || !message.whisper?.includes(game.user.id)) return;
    if (playerPromptApp?.requestId === transport.requestId) playerPromptApp.markCompleted(transport.itemId);
  } else if (transport.kind === "finished") {
    if (!message.whisper?.includes(game.user.id)) return;
    if (!isGM() && playerPromptApp?.requestId === transport.requestId) playerPromptApp.close();
    if (!isGM() && currentPromptRequestId === transport.requestId) currentPromptRequestId = null;
    clearMidiWorkflowContextsForRequest(transport.requestId, transport.workflowId);
  }
}

function inferAutomaticRollType(config, fallback = null) {
  const hooks = (config?.hookNames ?? []).map(name => String(name).toLowerCase());
  if (hooks.includes("deathsave") || config?.saveType === "death") return "death";
  if (hooks.includes("concentration") || config?.saveType === "concentration" || config?.isConcentration) return "concentration";
  if (hooks.includes("initiative") || hooks.includes("initiativedialog") || config?.rolls?.[0]?.data?.roll?.type === "initiative") return "initiative";
  if (config?.skill) return "skill";
  if (config?.tool) return "tool";
  if (hooks.includes("savingthrow") || config?.saveType) return "save";
  // rollSavingThrow passes a fallback of "save" because its config commonly includes
  // an ability ID too; that ability describes the save statistic, not an ability check.
  if (fallback) return fallback;
  if (config?.ability) return "ability";
  return fallback;
}

function initialModeFromRollConfig(config, roll = null) {
  const options = config?.rolls?.[0]?.options ?? roll?.options ?? {};
  if (Number.isFinite(options.advantageMode)) {
    if (options.advantageMode === CONFIG.Dice.D20Roll.ADV_MODE.ADVANTAGE) return "advantage";
    if (options.advantageMode === CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE) return "disadvantage";
    return "normal";
  }
  // Some native/Midi callers pass advantage at the process level instead of inside
  // the individual roll options. Respect those explicit flags for the prompt state.
  const advantage = options.advantage ?? config?.advantage;
  const disadvantage = options.disadvantage ?? config?.disadvantage;
  if (advantage && !disadvantage) return "advantage";
  if (disadvantage && !advantage) return "disadvantage";
  // Unspecified is different from an explicit Normal choice: allow the prompt to
  // preselect native D&D 5e/Active Effect advantage that isn't passed into the API call.
  return null;
}

function targetFromRollConfig(config, roll = null) {
  const candidates = [
    config?.target,
    config?.midiOptions?.target,
    config?.rolls?.[0]?.options?.target,
    config?.rolls?.[0]?.target,
    roll?.options?.target
  ];
  const target = candidates.find(value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)));
  return target === undefined ? null : Number(target);
}

function makeAutomaticRollPayload(actor, rollType, config = {}, roll = null) {
  const subtype = rollType === "skill" ? config?.skill
    : rollType === "tool" ? config?.tool
    : rollType === "initiative" || rollType === "death" ? ""
    : rollType === "concentration"
      ? config?.ability ?? actor.system?.attributes?.concentration?.ability ?? CONFIG.DND5E?.defaultAbilities?.concentration ?? "con"
      : config?.ability ?? "";
  let dc = targetFromRollConfig(config, roll);
  if (dc === null && ["death", "concentration"].includes(rollType)) dc = 10;
  const mode = initialModeFromRollConfig(config, roll);
  const subtypeDisplay = subtypeLabelForRequest(rollType, subtype);
  return {
    triggerActorUuid: actor.uuid,
    rollType,
    subtype: subtype ?? "",
    subtypeLabel: subtypeDisplay,
    typeLabel: rollTypeLabel(rollType),
    dc,
    initialMode: mode,
    startedAt: Date.now()
  };
}

function dispatchAutomaticRoll(actor, payload) {
  if (!actor || !game.settings.get(MODULE_ID, "autoInterceptRolls")) return false;
  const actorTrigger = {
    actorUuid: actor.uuid,
    initialMode: payload.initialMode,
    dc: payload.dc,
    targetTokenUuid: payload.targetTokenUuid ?? null,
    combatantId: payload.combatantId ?? null,
    combatUuid: payload.combatUuid ?? null
  };
  const dcKey = payload.dc === null || payload.dc === undefined ? "none" : String(payload.dc);
  const bucketKey = `${payload.rollType}:${payload.subtype ?? ""}:${dcKey}`;
  let bucket = automaticRequestBuckets.get(bucketKey);
  if (!bucket) {
    bucket = { payload: { ...payload, triggerActors: [actorTrigger] }, initiatorId: game.user.id, timer: null };
    automaticRequestBuckets.set(bucketKey, bucket);
  } else if (!bucket.payload.triggerActors.some(entry => entry.actorUuid === actor.uuid)) {
    bucket.payload.triggerActors.push(actorTrigger);
  }
  if (bucket.timer) clearTimeout(bucket.timer);
  bucket.timer = setTimeout(async () => {
    automaticRequestBuckets.delete(bucketKey);
    const outgoing = bucket.payload;
    outgoing.triggerActorUuid = outgoing.triggerActors[0]?.actorUuid;
    outgoing.initialMode = outgoing.triggerActors[0]?.initialMode ?? outgoing.initialMode;
    try {
      if (isGM()) {
        managerApp ??= new RollDirectorManager();
        await managerApp.startAutomaticRequest(outgoing, bucket.initiatorId);
      } else {
        const gms = game.users.filter(user => user.isGM).map(user => user.id);
        await createHiddenTransport(gms, { kind: "auto-start", payload: outgoing });
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to start automatic roll request`, error);
      ui.notifications.error("Roll Director could not start the automatic roll request.");
    }
  }, 120);
  return true;
}

function midiWorkflowContextKey(workflowId, actorUuid) {
  return workflowId && actorUuid ? `${workflowId}::${actorUuid}` : null;
}

function registerMidiWorkflowContext(context) {
  const key = midiWorkflowContextKey(context?.workflowId, context?.actorUuid);
  if (!key || !context?.requestId) return false;
  const previous = midiWorkflowContexts.get(key);
  if (previous && previous.requestId !== context.requestId) {
    const oldDecision = midiWorkflowModeValues.get(key);
    if (oldDecision?.requestId !== context.requestId) midiWorkflowModeValues.delete(key);
  }
  midiWorkflowContexts.set(key, { ...(previous ?? {}), ...context });
  return true;
}

function resolveMidiWorkflowMode(context) {
  const key = midiWorkflowContextKey(context?.workflowId, context?.actorUuid);
  const registered = key ? midiWorkflowContexts.get(key) : null;
  if (!registered || registered.requestId !== context.requestId) return false;
  if (!["advantage", "disadvantage", "normal"].includes(context.mode)) return false;
  const decision = { requestId: context.requestId, mode: context.mode, at: Date.now() };
  midiWorkflowModeValues.set(key, decision);
  const waiters = midiWorkflowModeWaiters.get(key) ?? [];
  midiWorkflowModeWaiters.delete(key);
  for (const waiter of waiters) {
    if (waiter.requestId !== context.requestId) continue;
    clearTimeout(waiter.timer);
    waiter.resolve({ requestId: context.requestId, mode: context.mode });
  }
  return true;
}

function waitForMidiWorkflowMode(actor, config) {
  const workflowId = config?.midiOptions?.workflowId;
  const key = midiWorkflowContextKey(workflowId, actor?.uuid);
  const context = key ? midiWorkflowContexts.get(key) : null;
  if (!context) return Promise.resolve(null);
  const stored = midiWorkflowModeValues.get(key);
  if (stored?.requestId === context.requestId) return Promise.resolve({ requestId: stored.requestId, mode: stored.mode });
  return new Promise(resolve => {
    const waiter = {
      requestId: context.requestId,
      resolve,
      timer: setTimeout(() => {
        const list = midiWorkflowModeWaiters.get(key) ?? [];
        midiWorkflowModeWaiters.set(key, list.filter(entry => entry !== waiter));
        // Never leave Midi's target-save promise unresolved. If the prompt goes unanswered,
        // continue with the preselected/native mode rather than letting Midi assume a 1.
        const current = midiWorkflowContexts.get(key);
        resolve(current?.requestId === context.requestId
          ? { requestId: context.requestId, mode: current.defaultMode ?? "normal", timedOut: true }
          : null);
      }, midiWorkflowDecisionTimeoutMs)
    };
    const list = midiWorkflowModeWaiters.get(key) ?? [];
    list.push(waiter);
    midiWorkflowModeWaiters.set(key, list);
  });
}

function clearMidiWorkflowContextForActor(requestId, workflowId, actorUuid) {
  const key = midiWorkflowContextKey(workflowId, actorUuid);
  if (!key) return;
  const context = midiWorkflowContexts.get(key);
  if (context && requestId && context.requestId !== requestId) return;
  midiWorkflowContexts.delete(key);
  midiWorkflowModeValues.delete(key);
  const waiters = midiWorkflowModeWaiters.get(key) ?? [];
  midiWorkflowModeWaiters.delete(key);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }
}

function clearMidiWorkflowContextsForRequest(requestId, workflowId = null) {
  for (const [key, context] of midiWorkflowContexts.entries()) {
    if ((requestId && context.requestId === requestId) || (workflowId && context.workflowId === workflowId)) {
      midiWorkflowContexts.delete(key);
      midiWorkflowModeValues.delete(key);
      const waiters = midiWorkflowModeWaiters.get(key) ?? [];
      midiWorkflowModeWaiters.delete(key);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
  }
}

function createMidiPromptReadiness(requestId, expectedUsers) {
  const expected = new Set(expectedUsers ?? []);
  if (!expected.size) return Promise.resolve(true);
  return new Promise(resolve => {
    const state = { expected, ready: new Set(), resolve, timer: null };
    state.timer = setTimeout(() => {
      if (midiPromptReadiness.get(requestId) !== state) return;
      midiPromptReadiness.delete(requestId);
      resolve(false);
    }, midiWorkflowReadyTimeoutMs);
    midiPromptReadiness.set(requestId, state);
  });
}

function noteMidiPromptReady(userId, requestId) {
  const state = midiPromptReadiness.get(requestId);
  if (!state || !state.expected.has(userId)) return;
  state.ready.add(userId);
  if ([...state.expected].every(id => state.ready.has(id))) {
    midiPromptReadiness.delete(requestId);
    clearTimeout(state.timer);
    state.resolve(true);
  }
}

function resolvePendingInterceptRoll(actorUuid, requestId, mode) {
  const pending = pendingInterceptRolls.get(actorUuid);
  if (!pending || pending.resolving) return false;
  if (requestId && pending.requestId && requestId !== pending.requestId) return false;
  if (requestId && !pending.requestId) pending.requestId = requestId;
  pending.resolving = true;
  if (pending.timer) clearTimeout(pending.timer);
  pending.resolve(mode && ["advantage", "disadvantage", "normal"].includes(mode)
    ? { requestId: pending.requestId ?? requestId, mode }
    : null);
  return true;
}

function waitForAutomaticRollDecision(actor, payload) {
  if (pendingInterceptRolls.has(actor.uuid)) {
    ui.notifications.warn(`${actor.name} already has a pending Roll Director request.`);
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    const pending = {
      actorUuid: actor.uuid,
      originUserId: game.user.id,
      payload,
      requestId: null,
      requestData: null,
      resolving: false,
      resolve,
      timer: null
    };
    pending.timer = setTimeout(() => {
      if (pendingInterceptRolls.get(actor.uuid) !== pending) return;
      pendingInterceptRolls.delete(actor.uuid);
      ui.notifications.warn(`Roll Director timed out waiting for a roll decision for ${actor.name}.`);
      resolve(null);
    }, 5 * 60 * 1000);
    pendingInterceptRolls.set(actor.uuid, pending);
    dispatchAutomaticRoll(actor, payload);
  });
}

async function completeAutomaticNativeRoll(actor, rollType, payload, decision, outcome, override) {
  let rolls = outcome;
  if (rollType === "initiative") {
    rolls = initiativeRollsByActor.get(actor.uuid) ?? null;
    initiativeRollsByActor.delete(actor.uuid);
  }
  const requestId = decision.requestId;
  if (!rolls) {
    if (isGM()) await managerApp?.skipActor(requestId, actor.uuid);
    else {
      const itemId = playerPromptApp?.playerData?.actors?.find(entry => entry.uuid === actor.uuid)?.itemId;
      await createHiddenTransport(game.users.filter(user => user.isGM).map(user => user.id), {
        kind: "auto-cancel-trigger", requestId, actorUuid: actor.uuid, itemId
      });
    }
    return;
  }
  const result = rollResultPayload(rolls, actor, { rollType, subtype: payload.subtype }, override.mode, game.user.id);
  if (!result) {
    if (isGM()) await managerApp?.skipActor(requestId, actor.uuid);
    else {
      const itemId = playerPromptApp?.playerData?.actors?.find(entry => entry.uuid === actor.uuid)?.itemId;
      await createHiddenTransport(game.users.filter(user => user.isGM).map(user => user.id), {
        kind: "auto-cancel-trigger", requestId, actorUuid: actor.uuid, itemId
      });
    }
    return;
  }
  const marker = {
    requestId, actorUuid: actor.uuid, actorId: actor.id,
    isNPC: isNPC(actor), privateNPC: override.privateNPC, isPC: override.isPC,
    rollMode: override.rollMode, rollerUserId: game.user.id
  };
  await ensureDiceAnimation(rolls, actor, marker);
  const fullResult = {
    ...result, actorUuid: actor.uuid,
    name: pendingInterceptRolls.get(actor.uuid)?.requestData?.name ?? actorDisplayName(actor), img: documentImage(actor),
    isNPC: isNPC(actor), isPC: override.isPC ?? isCharacter(actor),
    privateNPC: override.privateNPC, mode: override.mode, rollMode: override.rollMode,
    rollerUserId: game.user.id
  };
  if (isGM()) {
    await managerApp?.handleGMResult(requestId, actor.uuid, fullResult);
    return;
  }
  const item = playerPromptApp?.playerData?.actors?.find(entry => entry.uuid === actor.uuid);
  if (!item) {
    console.error(`${MODULE_ID} | Could not map automatic roll for ${actor.name} back to its player request.`, { requestId });
    await createHiddenTransport(game.users.filter(user => user.isGM).map(user => user.id), {
      kind: "auto-cancel-trigger", requestId, actorUuid: actor.uuid
    });
    return;
  }
  await createHiddenTransport(game.users.filter(user => user.isGM).map(user => user.id), {
    kind: "result", requestId, itemId: item.itemId,
    total: result.total, natural: result.natural, modifier: result.modifier,
    mode: override.mode, formula: result.formula, rollDetail: result.rollDetail,
    isCritical: result.isCritical, isFumble: result.isFumble
  });
}

function shouldAutomaticallyIntercept(actor, rollType) {
  return !!actor && !!rollType && isAutomaticallyEligibleActor(actor)
    && !activeRollModeOverrides.has(actor.uuid)
    && !!game.settings.get(MODULE_ID, "autoInterceptRolls")
    && (isGM() || hasOwner(actor, game.user));
}


function midiModeFromFlags(advantage, disadvantage) {
  if (advantage && !disadvantage) return "advantage";
  if (disadvantage && !advantage) return "disadvantage";
  return "normal";
}

function rollModeToMidiMessageMode(mode) {
  switch (normalizeRollMode(mode)) {
    case "blindroll": return "blind";
    case "selfroll": return "self";
    default: return "public";
  }
}

async function buildMidiWorkflowPayload(workflow) {
  if (!workflow?.id || typeof workflow.determineRollTypeAndAction !== "function") return null;
  const manualRequest = foundry.utils.deepClone(workflow.item?.flags?.[MODULE_ID]?.manualRequest ?? null);
  let details;
  try { details = workflow.determineRollTypeAndAction(); }
  catch (error) {
    console.warn(`${MODULE_ID} | Could not inspect Midi-QoL save workflow.`, error);
    return null;
  }
  if (!details?.rollAction || !details.rollType) return null;
  const rawRollType = details.rollType;
  const rollType = rawRollType === "check" ? "ability" : rawRollType;
  if (!["ability", "save", "skill", "tool"].includes(rollType)) return null;
  const rollAbilities = details.rollAbilities ?? [];
  const rollSkills = details.rollSkills ?? [];
  const rollTools = details.rollTools ?? [];
  const subtype = rollType === "skill" ? (rollSkills[0] ?? "")
    : rollType === "tool" ? (rollTools[0] ?? "")
    : (rollAbilities[0] ?? "");
  const rollDCValue = workflow.saveActivity?.save?.dc?.value ?? workflow.saveActivity?.check?.dc?.value ?? workflow.saveDC;
  const dc = rollDCValue !== undefined && rollDCValue !== null && rollDCValue !== "" && Number.isFinite(Number(rollDCValue))
    ? Number(rollDCValue) : null;
  const targetTokens = [...new Set([...(workflow.hitTargets ?? []), ...(workflow.hitTargetsEC ?? [])])];
  const actorDisposition = workflow.token?.document?.disposition !== undefined
    ? workflow.token.document.disposition : (workflow.actor?.type === "npc" ? -1 : 1);
  const triggerActors = [];
  const seenActors = new Set();
  for (const target of targetTokens) {
    const actor = target?.actor;
    if (!actor || (!manualRequest && !isAutomaticallyEligibleActor(actor)) || seenActors.has(actor.uuid)) continue;
    let saveDetails = null;
    if (typeof workflow.buildSaveDetailsForTarget === "function") {
      try {
        saveDetails = await workflow.buildSaveDetailsForTarget(target, {
          rollDC: dc ?? 0,
          rollType: rawRollType,
          rollAbilities,
          rollSkills,
          rollTools,
          flagRollType: details.flagRollType ?? "",
          isMagicSave: workflow.item?.type === "spell" || !!workflow.activity?.midiProperties?.magicEffect,
          actorDisposition
        });
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not precompute the initial mode for ${actor.name}; using the actor's native setting.`, error);
      }
    }
    const initialMode = saveDetails
      ? midiModeFromFlags(saveDetails.advantage, saveDetails.disadvantage)
      : getNativeAdvantageMode(actor, rollType, subtype);
    triggerActors.push({
      actorUuid: actor.uuid,
      targetTokenUuid: target.document?.uuid ?? target.uuid ?? null,
      initialMode,
      dc
    });
    seenActors.add(actor.uuid);
  }
  if (!triggerActors.length) return null;
  return {
    midiWorkflow: true,
    workflowId: workflow.id,
    rollType,
    subtype,
    subtypeLabel: subtypeLabelForRequest(rollType, subtype),
    typeLabel: workflow.item?.flags?.["midi-qol"]?.isConcentrationCheck
      ? "Concentration Check" : rollTypeLabel(rollType),
    dc: manualRequest?.dc ?? dc,
    triggerActors,
    triggerActorUuid: triggerActors[0].actorUuid,
    manualRequest,
    startedAt: Date.now()
  };
}

function installMidiWorkflowQueueAdapter(workflow, actorUuids, includeManualActors = false) {
  if (!workflow || !actorUuids?.size || typeof workflow.queueTargetSaveRoll !== "function"
      || typeof workflow.createStandardSaveRoll !== "function") return false;
  if (workflow.__rollDirectorMidiQueueAdapter) return true;
  const originalQueueTargetSaveRoll = workflow.queueTargetSaveRoll;
  Object.defineProperty(workflow, "__rollDirectorMidiQueueAdapter", { value: true, configurable: true });
  workflow.queueTargetSaveRoll = function(options) {
    const target = options?.target;
    const actor = target?.actor;
    if (!actor || !actorUuids.has(actor.uuid) || (!includeManualActors && !isAutomaticallyEligibleActor(actor))) {
      return originalQueueTargetSaveRoll.call(this, options);
    }
    // Preserve Midi's friendly-target auto success/fail shortcut before replacing its
    // per-target UI dispatch with Roll Director's prompt. Midi still owns the roll,
    // save adjudication, External Reaction pass, damage, and effect workflow.
    try {
      const friendlyRoll = this.getFriendlyTargetRoll?.(options.saveDetails);
      if (friendlyRoll) return { promise: friendlyRoll, requestCard: undefined };
    } catch (_) { /* If the helper changes between Midi versions, continue through the supported standard roll path. */ }
    const display = options.displayOptions ?? {};
    const promise = this.createStandardSaveRoll(
      target,
      options.saveDetails,
      !!display.whisper,
      display.showRoll !== false,
      false,
      !!display.simulate
    );
    return { promise, requestCard: undefined };
  };
  return true;
}

function midiOriginActorMetadata(payload, requestId, actorModes, initiatorId) {
  const modes = new Map((actorModes ?? []).map(entry => [entry.actorUuid ?? entry.uuid, entry]));
  const actors = new Map();
  for (const trigger of payload.triggerActors ?? []) {
    const actor = fromUuidSync(trigger.actorUuid);
    if (!actor) continue;
    const mode = modes.get(actor.uuid) ?? {};
    const targetTokenUuid = trigger.targetTokenUuid ?? mode.targetTokenUuid ?? null;
    actors.set(actor.uuid, {
      actorUuid: actor.uuid,
      targetTokenUuid,
      name: actorDisplayName(actor, findCanvasToken(targetTokenUuid)),
      img: documentImage(actor),
      isNPC: isNPC(actor),
      isPC: isCharacter(actor) || isPlayerControlledActor(actor),
      privateNPC: mode.privateNPC ?? (isNPC(actor) && !isPlayerControlledActor(actor)),
      rollMode: normalizeRollMode(mode.rollMode ?? game.settings.get(MODULE_ID, "defaultRollMode") ?? "publicroll"),
      defaultMode: mode.defaultMode ?? trigger.initialMode ?? "normal"
    });
  }
  return {
    requestId,
    workflowId: payload.workflowId,
    initiatorId,
    rollType: payload.rollType,
    subtype: payload.subtype,
    dc: payload.dc,
    actors
  };
}

async function onMidiPreCheckSaves(workflow) {
  const manualRequest = workflow?.item?.flags?.[MODULE_ID]?.manualRequest;
  if (!workflow || (!manualRequest && !game.settings.get(MODULE_ID, "autoInterceptRolls"))
      || !game.modules.get("midi-qol")?.active) return;
  // Fail open to Midi-QoL's existing UI if this Midi version, or a missing dependency,
  // doesn't expose the methods the adapter depends on. Never take over a workflow that we
  // cannot feed with the real target-roll result promises.
  if (!globalThis.libWrapper?.register
      || typeof workflow.determineRollTypeAndAction !== "function"
      || typeof workflow.buildSaveDetailsForTarget !== "function"
      || typeof workflow.queueTargetSaveRoll !== "function"
      || typeof workflow.createStandardSaveRoll !== "function") {
    console.warn(`${MODULE_ID} | Midi-QoL workflow adapter unavailable; leaving native target-roll UI in place.`, {
      libWrapper: !!globalThis.libWrapper?.register,
      determineRollTypeAndAction: typeof workflow.determineRollTypeAndAction,
      buildSaveDetailsForTarget: typeof workflow.buildSaveDetailsForTarget,
      queueTargetSaveRoll: typeof workflow.queueTargetSaveRoll,
      createStandardSaveRoll: typeof workflow.createStandardSaveRoll
    });
    return;
  }
  if (workflow.__rollDirectorMidiAdapterStarted) return;
  Object.defineProperty(workflow, "__rollDirectorMidiAdapterStarted", { value: true, configurable: true });
  const payload = await buildMidiWorkflowPayload(workflow);
  if (!payload) {
    // No Roll Director participants (for example GM-only NPC targets): retain Midi's
    // native save workflow and do not take over this workflow.
    return;
  }

  let requestId = null;
  let actorModes = [];
  if (isGM()) {
    managerApp ??= new RollDirectorManager();
    const request = await managerApp.startAutomaticRequest(payload, game.user.id);
    if (!request) return;
    requestId = request.id;
    actorModes = request.actors.map(entry => ({
      actorUuid: entry.uuid, targetTokenUuid: entry.targetTokenUuid,
      rollMode: entry.rollMode, defaultMode: entry.defaultMode,
      isNPC: entry.isNPC, isPC: entry.isPC, privateNPC: entry.privateNPC
    }));
  } else {
    const gms = game.users.filter(user => user.isGM && user.active).map(user => user.id);
    if (!gms.length) return;
    let ack;
    const waiter = new Promise(resolve => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          if (midiWorkflowStartWaiters.get(workflow.id) !== entry) return;
          midiWorkflowStartWaiters.delete(workflow.id);
          resolve(null);
        }, midiWorkflowReadyTimeoutMs + 5000)
      };
      midiWorkflowStartWaiters.set(workflow.id, entry);
    });
    await createHiddenTransport(gms, { kind: "midi-start", payload, startedBy: game.user.id });
    ack = await waiter;
    if (!ack?.accepted || !ack.requestId) return;
    requestId = ack.requestId;
    actorModes = ack.actors ?? [];
    // The initiating client can also be the owner of one of the targeted characters.
    // Register the same context locally before Midi starts queueing target rolls, so that
    // this client's actor-method wrapper waits for the Roll Director choice just like every
    // other target owner. The GM has the authoritative request; this is only local routing.
    for (const trigger of payload.triggerActors ?? []) {
      const modeInfo = actorModes.find(entry => (entry.actorUuid ?? entry.uuid) === trigger.actorUuid) ?? {};
      registerMidiWorkflowContext({
        requestId, workflowId: payload.workflowId, actorUuid: trigger.actorUuid,
        rollType: payload.rollType, subtype: payload.subtype, dc: payload.dc,
        rollMode: modeInfo.rollMode, defaultMode: modeInfo.defaultMode ?? trigger.initialMode ?? "normal",
        targetTokenUuid: trigger.targetTokenUuid ?? modeInfo.targetTokenUuid ?? null,
        isNPC: modeInfo.isNPC, isPC: modeInfo.isPC, privateNPC: modeInfo.privateNPC
      });
    }
  }

  const actorSet = new Set(payload.triggerActors.map(entry => entry.actorUuid));
  if (!installMidiWorkflowQueueAdapter(workflow, actorSet, !!payload.manualRequest)) {
    console.warn(`${MODULE_ID} | Could not install the Midi-QoL target queue adapter; preserving Midi's standard save request flow.`);
    if (isGM()) await managerApp?._cancelMidiWorkflowRequest(activeRequests.get(requestId));
    else await createHiddenTransport(game.users.filter(user => user.isGM && user.active).map(user => user.id), {
      kind: "midi-adapter-cancel", requestId, workflowId: payload.workflowId
    });
    return;
  }
  const origin = midiOriginActorMetadata(payload, requestId, actorModes, game.user.id);
  midiWorkflowOriginRequests.set(workflow.id, origin);
  console.info(`${MODULE_ID} | Connected Midi-QoL workflow ${workflow.id} to one Roll Director request for ${actorSet.size} eligible target actor(s).`);
}

function modeFromCompletedRoll(roll, fallback = "normal") {
  const mode = roll?.options?.advantageMode ?? roll?.d20?.options?.advantageMode;
  if (mode === CONFIG.Dice.D20Roll.ADV_MODE.ADVANTAGE || mode === 1) return "advantage";
  if (mode === CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE || mode === -1) return "disadvantage";
  if (mode === CONFIG.Dice.D20Roll.ADV_MODE.NORMAL || mode === 0) return "normal";
  return fallback;
}

async function onMidiPostCheckSaves(workflow) {
  const origin = workflow?.id ? midiWorkflowOriginRequests.get(workflow.id) : null;
  if (!origin) return;
  midiWorkflowOriginRequests.delete(workflow.id);
  const results = [];
  const targets = [...new Set([...(workflow.hitTargets ?? []), ...(workflow.hitTargetsEC ?? [])])];
  for (const actorMeta of origin.actors.values()) {
    const actor = fromUuidSync(actorMeta.actorUuid);
    const saveDetails = actorMeta.targetTokenUuid ? workflow.targetSaveDetails?.[actorMeta.targetTokenUuid] : null;
    const roll = saveDetails?.saveRoll;
    if (!actor || !roll || !Number.isFinite(Number(roll.total))) continue;
    const target = targets.find(token => (token.document?.uuid ?? token.uuid) === actorMeta.targetTokenUuid);
    const passed = target && workflow.saves instanceof Set ? workflow.saves.has(target) : undefined;
    const mode = modeFromCompletedRoll(roll, actorMeta.defaultMode ?? "normal");
    const result = rollResultPayload(roll, actor, { rollType: origin.rollType, subtype: origin.subtype }, mode, game.user.id);
    if (!result) continue;
    results.push({
      ...result,
      actorUuid: actor.uuid,
      name: actorMeta.name,
      img: actorMeta.img,
      isNPC: actorMeta.isNPC,
      isPC: actorMeta.isPC,
      privateNPC: actorMeta.privateNPC,
      rollMode: actorMeta.rollMode,
      mode,
      passed: typeof passed === "boolean" ? passed : undefined,
      rollerUserId: game.users.find(user => user.active && hasOwner(actor, user) && !user.isGM)?.id
        ?? game.users.find(user => user.active && user.isGM)?.id ?? game.user.id,
      skipped: false
    });
  }
  const transport = {
    kind: "midi-workflow-results",
    requestId: origin.requestId,
    workflowId: origin.workflowId,
    results
  };
  try {
    if (isGM()) await managerApp?.handleMidiWorkflowResults(null, transport, game.user.id);
    else await createHiddenTransport(game.users.filter(user => user.isGM && user.active).map(user => user.id), transport);
  } finally {
    clearMidiWorkflowContextsForRequest(origin.requestId, origin.workflowId);
  }
}

/**
 * Identify actor rolls that belong to a Midi-QoL-managed workflow.
 *
 * Midi owns the lifecycle for target saves inside an item workflow: it coordinates
 * the player request, consumes the roll result, evaluates saves, and continues to
 * damage/effects. Pausing the actor method and replacing its chat message at this
 * point prevents Midi from receiving the expected target-save response.
 *
 * Direct/manual D&D rolls remain eligible for Roll Director interception. Registered
 * workflow-owned target rolls are handled by resumeMidiWorkflowTargetRoll; every other
 * Midi workflow call is delegated unchanged so Midi's promises and target-save handshake settle.
 */
function isMidiWorkflowRollCall(args) {
  if (!game.modules.get("midi-qol")?.active) return false;

  const config = args?.[0] ?? {};
  const message = args?.[2] ?? {};
  const workflowCandidates = [
    config?.workflow,
    config?.usage?.config?.workflow,
    config?.usage?.workflow,
    config?.activity?.workflow,
    config?.workflowOptions?.workflow,
    config?.midiOptions?.workflow,
    message?.workflow,
    message?.data?.workflow
  ];
  if (workflowCandidates.some(workflow => workflow && typeof workflow === "object")) return true;

  // Midi-QoL's V14 rollAbility hand-off transmits workflowId rather than a live Workflow
  // object. It is only eligible for the Roll Director workflow adapter when a matching
  // context was registered; otherwise delegate it untouched to Midi-QoL.
  if (config?.midiOptions?.workflowId) return true;

  // D&D 5e v6/Midi-QoL v14 target save messages can identify the originating item card
  // through system.origin. Do not intercept this response roll as a direct roll.
  const origin = message?.data?.system?.origin
    ?? message?.system?.origin
    ?? config?.system?.origin;
  return !!origin;
}

function midiContextOverride(actor, context, mode, config) {
  const privateNPC = context.privateNPC ?? (isNPC(actor) && !isPlayerControlledActor(actor));
  const rollMode = privateNPC ? "selfroll"
    : normalizeRollMode(context.rollMode ?? game.settings.get(MODULE_ID, "defaultRollMode") ?? "publicroll");
  return {
    mode,
    rollType: context.rollType ?? inferAutomaticRollType(config, "save"),
    rollMode,
    createdAt: Date.now(),
    requestId: context.requestId,
    actorUuid: actor.uuid,
    actorId: actor.id,
    isNPC: isNPC(actor),
    privateNPC,
    isPC: context.isPC ?? (isCharacter(actor) || isPlayerControlledActor(actor)),
    rollerUserId: game.user.id
  };
}

function setRecentRollSecurityMarker(actor, override) {
  const marker = { ...override, expiresAt: Date.now() + 30000 };
  recentRollSecurityMarkers.set(actor.uuid, marker);
  setTimeout(() => {
    if (recentRollSecurityMarkers.get(actor.uuid) === marker) recentRollSecurityMarkers.delete(actor.uuid);
  }, 30500);
  return marker;
}

async function resumeMidiWorkflowTargetRoll(wrapped, actor, args, rollType) {
  const originalConfig = args?.[0] ?? {};
  const workflowId = originalConfig?.midiOptions?.workflowId;
  const context = workflowId ? midiWorkflowContexts.get(midiWorkflowContextKey(workflowId, actor.uuid)) : null;
  if (!context) return null;

  const decision = await waitForMidiWorkflowMode(actor, originalConfig);
  // If the GM cancels a request or an adapter fails, release Midi's pending save with its
  // unmodified native call. Never leave the workflow waiting on a promise that cannot settle.
  if (!decision) return wrapped(...args);

  const mode = decision.mode;
  const override = midiContextOverride(actor, { ...context, ...decision }, mode, originalConfig);
  activeRollModeOverrides.set(actor.uuid, override);
  const securityMarker = setRecentRollSecurityMarker(actor, override);

  const advantage = mode === "advantage";
  const disadvantage = mode === "disadvantage";
  args[0] = {
    ...originalConfig,
    advantage,
    disadvantage,
    midiOptions: {
      ...(originalConfig.midiOptions ?? {}),
      advantage,
      disadvantage,
      // The selected Roll Director mode is the explicit mode for this target. Tell Midi
      // to honor it instead of recalculating a competing prompt choice for the same roll.
      recomputeAdvantage: false
    }
  };
  args[1] = { ...(args[1] ?? {}), configure: false };
  args[2] = { ...(args[2] ?? {}), rollMode: rollModeToMidiMessageMode(override.rollMode) };

  try {
    const outcome = await wrapped(...args);
    // Midi creates private internal cards for bookkeeping; if its native Dice So Nice path
    // didn't already animate this roll, show exactly one animation to the authorized audience.
    await ensureDiceAnimation(outcome, actor, securityMarker);
    return outcome;
  } catch (error) {
    console.error(`${MODULE_ID} | Midi-QoL target ${rollType} roll failed for ${actor.name}.`, error);
    throw error;
  } finally {
    if (activeRollModeOverrides.get(actor.uuid) === override) activeRollModeOverrides.delete(actor.uuid);
  }
}

function combatantTokenUuid(combatant) {
  return combatant?.token?.document?.uuid ?? combatant?.token?.uuid
    ?? (combatant?.sceneId && combatant?.tokenId ? `Scene.${combatant.sceneId}.Token.${combatant.tokenId}` : null);
}

function combatantDisplayName(combatant) {
  const token = findCanvasToken(combatantTokenUuid(combatant));
  return actorDisplayName(combatant?.actor, token);
}

function buildCombatTrackerInitiativePayload(combat, combatants, initiativeOptions = {}) {
  const triggerActors = [];
  const seen = new Set();
  for (const combatant of combatants) {
    const actor = combatant?.actor;
    if (!actor || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    triggerActors.push({
      actorUuid: actor.uuid,
      targetTokenUuid: combatantTokenUuid(combatant),
      combatantId: combatant.id,
      combatUuid: combat.uuid,
      updateTurn: typeof initiativeOptions.updateTurn === "boolean" ? initiativeOptions.updateTurn : undefined,
      initialMode: getNativeAdvantageMode(actor, "initiative", ""),
      dc: null
    });
  }
  if (!triggerActors.length) return null;
  return {
    combatTrackerInitiative: true,
    rollType: "initiative",
    subtype: "",
    subtypeLabel: "",
    typeLabel: "Initiative",
    dc: null,
    initialMode: triggerActors[0].initialMode,
    triggerActorUuid: triggerActors[0].actorUuid,
    triggerActors,
    startedAt: Date.now()
  };
}

function installCombatInitiativeInterceptor() {
  runtimeStatus.combatInitiativeInterceptorAttempted = true;
  const prototype = CONFIG.Combat?.documentClass?.prototype;
  if (!prototype || typeof prototype.rollInitiative !== "function") {
    console.warn(`${MODULE_ID} | Could not install Combat Tracker initiative interception: Combat document method unavailable.`);
    return;
  }
  if (!globalThis.libWrapper?.register) {
    console.warn(`${MODULE_ID} | Combat Tracker initiative interception requires libWrapper.`);
    return;
  }
  try {
    libWrapper.register(MODULE_ID, "CONFIG.Combat.documentClass.prototype.rollInitiative", async function(wrapped, ids, options = {}) {
      // Roll Director's own actor.rollInitiative calls pass through this wrapper when the
      // selected actor already carries an approved override. Custom initiative formulas
      // are also left to the native implementation rather than silently discarded.
      if (!game.settings.get(MODULE_ID, "autoInterceptRolls") || options?.formula) return wrapped(ids, options);
      const selectedIds = (Array.isArray(ids) ? ids : [ids]).map(id => String(id ?? "")).filter(Boolean);
      const combatants = selectedIds.map(id => this.combatants?.get?.(id)).filter(combatant => combatant?.actor);
      if (!combatants.length || combatants.length !== selectedIds.length) return wrapped(ids, options);
      if (combatants.some(combatant => activeRollModeOverrides.has(combatant.actor.uuid))) return wrapped(ids, options);

      if (!isGM()) {
        // Never fall back to a native tracker roll for an actor the player does not own:
        // that would bypass Roll Director's Owner-only prompt and summary visibility.
        const ownedCombatants = combatants.filter(combatant => hasOwner(combatant.actor, game.user));
        if (!ownedCombatants.length) {
          ui.notifications.warn("Roll Director can only request initiative for actors you own.");
          return this;
        }
        for (const combatant of ownedCombatants) {
          const actor = combatant.actor;
          const payload = {
            combatTrackerInitiative: true,
            rollType: "initiative",
            subtype: "",
            subtypeLabel: "",
            typeLabel: "Initiative",
            dc: null,
            initialMode: getNativeAdvantageMode(actor, "initiative", ""),
            targetTokenUuid: combatantTokenUuid(combatant),
            combatantId: combatant.id,
            combatUuid: this.uuid,
            startedAt: Date.now()
          };
          dispatchAutomaticRoll(actor, payload);
        }
        if (ownedCombatants.length < combatants.length) {
          ui.notifications.info("Roll Director requested initiative only for actors you own.");
        }
        return this;
      }

      managerApp ??= new RollDirectorManager();
      const payload = buildCombatTrackerInitiativePayload(this, combatants, options);
      if (!payload) return wrapped(ids, options);
      try {
        const request = await managerApp.startAutomaticRequest(payload, game.user.id);
        return request ? this : wrapped(ids, options);
      } catch (error) {
        console.error(`${MODULE_ID} | Could not start Combat Tracker initiative request.`, error);
        return wrapped(ids, options);
      }
    }, "MIXED");
    runtimeStatus.combatInitiativeInterceptorRegistered = true;
  } catch (error) {
    console.error(`${MODULE_ID} | Could not register Combat Tracker initiative interceptor.`, error);
  }
}

function isCombatStartedForInitiative(combat) {
  return !!combat && (combat.started === true || Number(combat.round) > 0);
}

function isPrimaryInitiativeGM() {
  if (!isGM()) return false;
  const activeGMs = game.users?.filter(user => user.isGM && user.active) ?? [];
  return !activeGMs.length || activeGMs[0].id === game.user.id;
}

function actorHasActiveInitiativeRequest(actorUuid) {
  for (const request of activeRequests.values()) {
    if (!request.finalized && request.rollType === "initiative" && request.actors?.some(entry => entry.uuid === actorUuid)) return true;
  }
  return false;
}

function queueCombatantInitiativeAutomation(combatant) {
  if (!isPrimaryInitiativeGM() || !combatant?.id || !combatant?.actor) return;
  const combat = combatant.parent ?? game.combats?.get?.(combatant.combatId) ?? null;
  if (!combat?.uuid || !combat.combatants?.get?.(combatant.id)) return;
  // Roll Director may create missing combatants as part of an already-running initiative
  // roll. Don't recurse into a second automatic request for that same actor.
  if (activeRollModeOverrides.has(combatant.actor.uuid) || actorHasActiveInitiativeRequest(combatant.actor.uuid)) return;

  const started = isCombatStartedForInitiative(combat);
  let batch = pendingCombatantInitiativeBatches.get(combat.uuid);
  if (!batch) {
    batch = { combatUuid: combat.uuid, beforeStartIds: new Set(), duringCombatIds: new Set(), timer: null };
    pendingCombatantInitiativeBatches.set(combat.uuid, batch);
  }
  (started ? batch.duringCombatIds : batch.beforeStartIds).add(combatant.id);
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    void processCombatantInitiativeAutomation(combat.uuid);
  }, combatantInitiativeBatchDelayMs);
}

async function processCombatantInitiativeAutomation(combatUuid) {
  const batch = pendingCombatantInitiativeBatches.get(combatUuid);
  if (!batch) return;
  pendingCombatantInitiativeBatches.delete(combatUuid);
  const combat = fromUuidSync(combatUuid);
  if (!combat || !isPrimaryInitiativeGM()) return;

  const beforeStartIds = [...batch.beforeStartIds];
  const duringCombatIds = [...batch.duringCombatIds];
  let requestIds = [];
  if (beforeStartIds.length && game.settings.get(MODULE_ID, "autoStartInitiativeAfterCombatantsAdded")) {
    // Initial initiative applies to the full unrolled encounter, not just the last token
    // which happened to trigger the createCombatant hook.
    requestIds.push(...[...(combat.combatants ?? [])]
      .filter(entry => entry.initiative === null || entry.initiative === undefined)
      .map(entry => entry.id));
  }
  if (duringCombatIds.length && game.settings.get(MODULE_ID, "autoRequestInitiativeForNewCombatants")) {
    requestIds.push(...duringCombatIds);
  }
  requestIds = [...new Set(requestIds)].filter(id => {
    const entry = combat.combatants?.get?.(id);
    if (!entry?.actor || entry.initiative !== null && entry.initiative !== undefined) return false;
    if (activeRollModeOverrides.has(entry.actor.uuid) || actorHasActiveInitiativeRequest(entry.actor.uuid)) return false;
    return true;
  });
  if (!requestIds.length) return;
  try {
    // Existing combat must keep its current turn while a late arrival receives initiative.
    const onlyLateArrivals = duringCombatIds.length > 0 && beforeStartIds.length === 0;
    await combat.rollInitiative(requestIds, { updateTurn: !onlyLateArrivals });
  } catch (error) {
    console.error(`${MODULE_ID} | Could not automatically start initiative for newly added combatants.`, error);
  }
}

function installNativeRollInterceptors() {
  const prototype = CONFIG.Actor?.documentClass?.prototype;
  if (!prototype) {
    console.warn(`${MODULE_ID} | Could not install automatic roll interception: Actor document class unavailable.`);
    return;
  }
  if (!globalThis.libWrapper?.register) {
    console.warn(`${MODULE_ID} | Automatic roll interception requires libWrapper. Manual roll requests remain available.`);
    return;
  }

  const methods = [
    { name: "rollAbilityCheck", type: "ability" },
    { name: "rollSavingThrow", type: "save" },
    { name: "rollSkill", type: "skill" },
    { name: "rollToolCheck", type: "tool" },
    { name: "rollDeathSave", type: "death" },
    { name: "rollConcentration", type: "concentration" },
    { name: "rollInitiativeDialog", type: "initiative" },
    { name: "rollInitiative", type: "initiative" }
  ];

  for (const { name, type } of methods) {
    if (typeof prototype[name] !== "function") continue;
    const target = `CONFIG.Actor.documentClass.prototype.${name}`;
    runtimeStatus.nativeRollInterceptorAttempts.add(name);
    try {
      // MIXED is required here because a GM-cancelled request intentionally returns
      // without invoking the underlying roll; WRAPPER mode would unregister itself.
      libWrapper.register(MODULE_ID, target, async function (wrapped, ...args) {
        const actor = this;

        // A Roll Director-initiated native roll already has its approved mode. Let
        // the remainder of the system/Midi wrapper chain execute exactly once.
        if (activeRollModeOverrides.has(actor.uuid)) return wrapped(...args);

        const config = args[0] ?? {};
        const workflowId = config?.midiOptions?.workflowId;
        const midiContext = workflowId
          ? midiWorkflowContexts.get(midiWorkflowContextKey(workflowId, actor.uuid))
          : null;
        if (midiContext && game.modules.get("midi-qol")?.active) {
          // The workflow adapter has replaced Midi's per-target UI dispatch, not the roll
          // itself. Wait for the shared Roll Director choice, then resume this same actor
          // call so Midi's Promise receives the real Roll object for save adjudication.
          return resumeMidiWorkflowTargetRoll(wrapped, actor, args, midiContext.rollType ?? type);
        }

        // Any other Midi-managed call is delegated untouched. In particular, don't pause an
        // unregistered workflow target roll: Midi's save promise must always be allowed to settle.
        if (isMidiWorkflowRollCall(args)) {
          if (!midiWorkflowBypassNotices.has(name)) {
            midiWorkflowBypassNotices.add(name);
            console.info(`${MODULE_ID} | Delegating unregistered Midi-QoL workflow ${name} to Midi-QoL unchanged.`);
          }
          return wrapped(...args);
        }

        let rollType = type;
        if (name === "rollSavingThrow") rollType = inferAutomaticRollType(config, "save");
        if (!shouldAutomaticallyIntercept(actor, rollType)) return wrapped(...args);

        let nativeRoll = null;
        if (rollType === "initiative") {
          try {
            nativeRoll = actor.getInitiativeRoll?.(
              name === "rollInitiative" ? (args[1] ?? {}) : (args[0] ?? {})
            );
          } catch (error) {
            console.warn(`${MODULE_ID} | Could not pre-read initiative roll options.`, error);
          }
        }

        const payloadConfig = rollType === "initiative"
          ? {
              subject: actor,
              hookNames: [name === "rollInitiativeDialog" ? "initiativeDialog" : "initiative"],
              rolls: [{ options: nativeRoll?.options ?? {}, data: nativeRoll?.data ?? {} }]
            }
          : { ...config, subject: actor };
        const payload = makeAutomaticRollPayload(actor, rollType, payloadConfig, nativeRoll);
        const decision = await waitForAutomaticRollDecision(actor, payload);
        if (!decision) {
          // GM cancellation resolves the waiter without the timeout callback, so
          // remove the pending entry here; otherwise this actor stays blocked.
          const cancelled = pendingInterceptRolls.get(actor.uuid);
          if (cancelled?.originUserId === game.user.id) {
            if (cancelled.timer) clearTimeout(cancelled.timer);
            pendingInterceptRolls.delete(actor.uuid);
          }
          return null;
        }

        const pending = pendingInterceptRolls.get(actor.uuid);
        const requestData = pending?.requestData ?? {};
        const privateNPC = requestData.privateNPC ?? (isNPC(actor) && !isPlayerControlledActor(actor));
        const rollMode = privateNPC ? "selfroll"
          : normalizeRollMode(requestData.rollMode ?? game.settings.get(MODULE_ID, "defaultRollMode") ?? "publicroll");
        const override = {
          mode: decision.mode,
          rollType,
          rollMode,
          createdAt: Date.now(),
          requestId: decision.requestId,
          actorUuid: actor.uuid,
          actorId: actor.id,
          isNPC: isNPC(actor),
          privateNPC,
          isPC: requestData.isPC ?? (isCharacter(actor) || isPlayerControlledActor(actor)),
          rollerUserId: game.user.id
        };
        const securityMarker = { ...override, expiresAt: Date.now() + 30000 };
        activeRollModeOverrides.set(actor.uuid, override);
        recentRollSecurityMarkers.set(actor.uuid, securityMarker);
        setTimeout(() => {
          if (recentRollSecurityMarkers.get(actor.uuid) === securityMarker) recentRollSecurityMarkers.delete(actor.uuid);
        }, 30500);

        try {
          if (name === "rollInitiativeDialog") {
            args[1] = foundry.utils.mergeObject(
              args[1] ?? {},
              { configure: false },
              { inplace: false }
            );
          }
          const outcome = await wrapped(...args);
          await completeAutomaticNativeRoll(actor, rollType, payload, decision, outcome, override);
          return outcome;
        } catch (error) {
          console.error(`${MODULE_ID} | Automatic native roll failed for ${actor.name}`, error);
          if (isGM()) await managerApp?.skipActor(decision.requestId, actor.uuid);
          else {
            const itemId = playerPromptApp?.playerData?.actors?.find(entry => entry.uuid === actor.uuid)?.itemId;
            await createHiddenTransport(game.users.filter(user => user.isGM).map(user => user.id), {
              kind: "auto-cancel-trigger",
              requestId: decision.requestId,
              actorUuid: actor.uuid,
              itemId
            });
          }
          throw error;
        } finally {
          if (activeRollModeOverrides.get(actor.uuid) === override) activeRollModeOverrides.delete(actor.uuid);
          if (pendingInterceptRolls.get(actor.uuid) === pending) pendingInterceptRolls.delete(actor.uuid);
        }
      }, "MIXED");
      runtimeStatus.nativeRollInterceptors.add(name);
    } catch (error) {
      console.error(`${MODULE_ID} | Could not register libWrapper interceptor for ${name}.`, error);
    }
  }
}

function applyInitiativeOverride(actor, roll, override) {
  if (!actor || !roll || !override) return;
  const mode = override.mode === "advantage" ? CONFIG.Dice.D20Roll.ADV_MODE.ADVANTAGE
    : override.mode === "disadvantage" ? CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE
    : CONFIG.Dice.D20Roll.ADV_MODE.NORMAL;
  roll.options ??= {};
  roll.options.configured = false;
  roll.options.advantage = mode === CONFIG.Dice.D20Roll.ADV_MODE.ADVANTAGE;
  roll.options.disadvantage = mode === CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE;
  roll.options.advantageMode = mode;
  roll.options.rollMode = override.privateNPC ? "selfroll" : normalizeRollMode(override.rollMode);
  roll.options.rollDirector = {
    requestId: override.requestId,
    actorUuid: actor.uuid,
    actorId: actor.id,
    isNPC: isNPC(actor),
    privateNPC: override.privateNPC ?? isNPC(actor),
    isPC: override.isPC ?? isCharacter(actor),
    rollMode: override.privateNPC ? "selfroll" : normalizeRollMode(override.rollMode),
    rollerUserId: override.rollerUserId ?? game.user.id
  };
  roll.configureModifiers?.();
  initiativeRollsByActor.set(actor.uuid, roll);
}

function annotateInitiativeRoll(actor, roll) {
  if (!actor) return;
  const override = activeRollModeOverrides.get(actor.uuid);
  if (override) applyInitiativeOverride(actor, roll, override);
}

function openManager() {
  if (!isGM()) {
    ui.notifications.warn("Roll Director is available to the GM only.");
    return;
  }
  managerApp ??= new RollDirectorManager();
  if (!managerApp.rendered) {
    managerApp.isCollapsed = false;
    managerApp._initialCollapseHandled = false;
  }
  managerApp.render(true);
}

Hooks.on("dnd5e.postRollConfiguration", (rolls, config) => applyRequestedRollMode(rolls, config));

Hooks.once("init", () => {
  registerSettings();
  game.settings.registerMenu(MODULE_ID, "configureFavoriteTools", {
    name: "Favorite tools",
    label: "Configure Favorite Tools",
    hint: "Choose multiple tools to pin in the Favorites column of the Tool Check picker.",
    icon: "fa-solid fa-star",
    type: RollDirectorFavoriteToolsConfig,
    restricted: true
  });
  game.settings.registerMenu(MODULE_ID, "diagnostics", {
    name: "Diagnostics",
    label: "Open Diagnostics",
    hint: "Inspect installed versions, Roll Director integration status, and active request recovery counters. The copied report excludes actor names.",
    icon: "fa-solid fa-stethoscope",
    type: RollDirectorDiagnostics,
    restricted: true
  });
  game.settings.registerMenu(MODULE_ID, "openManager", {
    name: "Open Roll Director",
    label: "Open Manager",
    hint: "Open the GM roll-request interface.",
    icon: "fa-solid fa-dice-d20",
    type: class extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
      static DEFAULT_OPTIONS = { id: "roll-director-open", classes: ["roll-director", "rd-open-manager-app"], window: { title: "Open Roll Director" }, position: { width: 380, height: 120 } };
      static PARTS = { body: { template: `modules/${MODULE_ID}/templates/open-manager.hbs` } };
      async _prepareContext() { return {}; }
      _onRender(context, options) {
        super._onRender(context, options);
        this.element?.querySelector("[data-action='open-manager']")?.addEventListener("click", () => openManager());
      }
    },
    restricted: true
  });
});

Hooks.once("diceSoNiceReady", installDiceSoNicePrivacyWrapper);

Hooks.once("ready", async () => {
  installDiceSoNicePrivacyWrapper();
  Hooks.on("preCreateChatMessage", markManualWorkflowCard);
  Hooks.on("preCreateChatMessage", secureRollDirectorChatMessage);
  if (game.system.id !== "dnd5e") {
    ui.notifications.warn("Roll Director currently requires the D&D 5e system.");
    return;
  }
  game.modules.get(MODULE_ID).api = { open: openManager, manager: () => managerApp };
  // Migrate the retired Private (roller + GM) default to Self so the settings dropdown
  // never retains a value which is no longer offered by this version.
  if (isGM() && game.settings.get(MODULE_ID, "defaultRollMode") === "gmroll") {
    await game.settings.set(MODULE_ID, "defaultRollMode", "selfroll");
  }
  if (isGM() && game.settings.get(MODULE_ID, "autoOpenManager")) openManager();
  Hooks.on("createChatMessage", onCreateChatMessage);
  Hooks.on("renderChatMessageHTML", hideInternalMessages);
  // Integrate at Midi-QoL's awaited workflow boundaries. preCheckSaves creates one
  // Roll Director request for the eligible targets before Midi queues per-target rolls;
  // postCheckSaves receives final rolls after External Reaction and Midi outcome processing.
  // These hooks preserve Midi's own workflow promises, target adjudication, and downstream
  // damage/effects. Actor-level interceptors handle direct/manual rolls and the target roll
  // hand-off registered by this adapter.
  if (game.modules.get("midi-qol")?.active) {
    Hooks.on("midi-qol.preCheckSaves", onMidiPreCheckSaves);
    Hooks.on("midi-qol.postCheckSaves", onMidiPostCheckSaves);
    runtimeStatus.midiHooksRegistered = true;
    console.info(`${MODULE_ID} | Midi-QoL target-save adapter registered.`);
  }
  installNativeRollInterceptors();
  installCombatInitiativeInterceptor();
  Hooks.on("createCombatant", queueCombatantInitiativeAutomation);
  Hooks.on("dnd5e.preRollInitiative", annotateInitiativeRoll);
  Hooks.on("dnd5e.rollInitiative", recordInitiativeScores);
  Hooks.on("renderChatLog", (_app, html) => {
    if (!isGM()) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.querySelector("[data-roll-director-button='true']")) return;
    const host = root.querySelector(".chat-controls") ?? root.querySelector(".chat-form") ?? root.querySelector(".chat-input");
    if (!host) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "roll-director-open-button";
    button.dataset.rollDirectorButton = "true";
    button.title = "Open Roll Director";
    button.innerHTML = `<i class="fa-solid fa-dice-d20"></i><span>Roll Director</span>`;
    button.addEventListener("click", openManager);
    host.prepend(button);
  });
  if (isGM()) {
    Hooks.on("canvasReady", () => managerApp?.render());
    Hooks.on("createToken", () => managerApp?.render());
    Hooks.on("deleteToken", () => managerApp?.render());
    Hooks.on("userDisconnected", user => void managerApp?.handleUserDisconnected(user));
    Hooks.on("userConnected", user => void managerApp?.handleUserConnected(user));
  }
});
