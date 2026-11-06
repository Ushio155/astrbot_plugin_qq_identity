const bridge = window.AstrBotPluginView || window.AstrBotPluginPage;
const $ = (id) => document.getElementById(id);

let state = {};
let masters = [];
// 「恢复默认」= 把模板清空保存，后端会把空模板当成"用内置默认"
let tplReset = { owner: false, known: false, stranger: false };
// 当前显示的是哪一档。三段 textarea 一直留在 DOM 里，切档只是隐藏面板，
// 所以「改了一半切走再切回来」不会丢内容。
let activeTier = "owner";
// 分段控件尺寸变了就重算高亮块（见 syncThumb），留着引用防止被 GC
let segObserver = null;
// 熟人登记表单当前在编辑谁（空 = 新增模式）
let editingQq = "";
// 删除的二次确认：**不能用 window.confirm** —— 插件页 iframe 的 sandbox 是
// "allow-scripts allow-forms allow-downloads"（dashboard/src/views/PluginViewPage.vue:651），
// 没有 allow-modals，confirm() 会被静默忽略并返回 false，点「移除」等于没反应。
// 所以改成页内两步：第一次点把按钮变成「确认移除？」，4 秒不点第二次就复原。
let confirmQq = "";
let confirmTimer = null;
// 「清空候选表」同样要二次确认（这一步不可撤销），但不和上面的行内按钮共用状态
let clearArmed = false;
let clearTimer = null;

const TIERS = ["owner", "known", "stranger"];
const TIER_LABEL = { owner: "开发者", known: "熟人", stranger: "陌生人" };
// people.json 里的 source：三条写入路径各一个值，界面上显示成人话
const SOURCE_LABEL = {
  command: "聊天指令",
  tool: "开发者工具",
  webui: "页面表单",
  candidate: "候选转正",
};
const TPL_VARS = new Set([
  "name", "qq", "group", "label", "address", "masters", "tier",
  "aliases", "relation", "note", "profile",
]);

function unwrap(res) {
  if (res === null || res === undefined) throw new Error("空响应");
  if (typeof res === "object" && res.status === "error") throw new Error(res.message || "请求失败");
  if (typeof res === "object" && res.status === "ok" && "data" in res) return res.data;
  return res;
}

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add("hidden"), isError ? 4200 : 2200);
}

async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err?.message || String(err), true);
    return null;
  }
}

const splitList = (value) =>
  String(value || "")
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

// 别名按后端同一套分隔符切（不切空格：中文名里不该有空格，但也不该吃掉它）
const splitAliases = (value) =>
  String(value || "")
    .split(/[|/，,、]+/)
    .map((item) => item.trim())
    .filter(Boolean);

/* ------------------------------------------------------------------ 渲染 */

function renderChips() {
  const box = $("master-chips");
  box.innerHTML = "";
  if (!masters.length) {
    const span = document.createElement("span");
    span.className = "hint";
    span.textContent = "（空，将回退到管理员列表）";
    box.appendChild(span);
    return;
  }
  masters.forEach((qq, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<span></span><button type="button" title="移除">×</button>`;
    chip.querySelector("span").textContent = qq;
    chip.querySelector("button").addEventListener("click", () => {
      masters.splice(index, 1);
      renderChips();
    });
    box.appendChild(chip);
  });
}

function render() {
  $("c-enable").checked = Boolean(state.enable);
  $("c-inject").checked = Boolean(state.inject_identity);
  $("c-log").checked = Boolean(state.log);
  $("c-mask").checked = state.mask_enable !== false;
  $("mask-words").value = (state.mask_words || ["开发者"]).join("，");
  $("mask-char").value = state.mask_char || "＊";
  $("c-owner-tools").checked = state.owner_tools_enable !== false;
  $("c-candidates").checked = state.auto_candidates_enable !== false;
  $("owner-tools-list").textContent = (state.owner_tools || []).join(" / ") || "（未加载）";
  $("people-audit").textContent = state.audit_path ? `审计日志：${state.audit_path}` : "";
  $("master-label").value = state.master_label || "开发者";
  $("inject-target").value = state.inject_target || "system";
  $("isolate-mode").value = state.isolate_mode || "all";
  $("isolate-groups").value = (state.isolate_groups || []).join("，");
  $("isolate-qq").value = (state.isolate_qq || []).join("，");
  renderTemplates();
  applyPersonLimits();
  renderPeople();
  renderCandidates();
  masters = [...(state.master_qq || [])];
  renderChips();
  const admins = state.admins_id || [];
  $("admins-hint").textContent = admins.length
    ? `AstrBot 管理员：${admins.join("、")}｜当前生效的开发者名单：${(state.masters_effective || []).join("、") || "（空）"}`
    : "没有读到 AstrBot 的 admins_id。";
}

function tplBox(tier) {
  return $(`tpl-${tier}`);
}

function renderBadge(tier) {
  const custom = Boolean(state[`tpl_${tier}_custom`]);
  const badge = $(`tpl-${tier}-badge`);
  badge.textContent = custom ? "自定义" : "内置默认";
  badge.classList.toggle("custom", custom);
}

function renderTemplates() {
  const defaults = state.tpl_defaults || {};
  for (const tier of TIERS) {
    tplReset[tier] = false;
    tplBox(tier).value = state[`tpl_${tier}`] || defaults[tier] || "";
    renderBadge(tier);
    checkTemplate(tier);
  }
  syncMaskWordsHint();
  applyTplTierView();
}

/* --------------------------------------------- 身份块模板：分档切换（0.8.3） */

const tabBtn = (tier) => $("tpl-tabs")?.querySelector(`.seg-item[data-tier="${tier}"]`);

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

const mirrorOf = (tier) => $(`tpl-${tier}-mirror`);

// 编辑区背后的"变量高亮层"：只画 {name} 这类变量的背景块，文字由上面的 textarea
// 自己画（那一层 color: transparent），所以不会出现重影，也不用接管光标/选区/输入法。
function mirrorHtml(text) {
  let out = "";
  let last = 0;
  for (const m of String(text).matchAll(/\{[^{}\n]*\}/g)) {
    out += escapeHtml(text.slice(last, m.index));
    const known = TPL_VARS.has(m[0].slice(1, -1).trim());
    out += `<span class="tpl-var${known ? "" : " bad"}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  // 末尾换行时补一个零宽字符，否则最后那行空行不占高度，滚动同步会差一行
  if (String(text).endsWith("\n")) out += "\u200b";
  return out;
}

function syncMirror(tier) {
  const mirror = mirrorOf(tier);
  const box = tplBox(tier);
  if (!mirror || !box) return;
  mirror.innerHTML = mirrorHtml(box.value);
  mirror.scrollTop = box.scrollTop;
}

// 高亮块的落点用 rect 差值算：.seg 的描边是 inset 阴影而不是真 border，
// 它的 padding box 原点就是控件左上角，所以 translateX 不会差 1px。
function syncThumb() {
  const seg = $("tpl-tabs");
  const thumb = seg && seg.querySelector(".seg-thumb");
  const active = tabBtn(activeTier);
  if (!thumb || !active) return;
  const segRect = seg.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  // 页面还没布局（iframe 隐藏/后台标签页）时宽度是 0，等 ResizeObserver 再来一次
  if (!rect.width) return;
  thumb.style.width = `${rect.width}px`;
  thumb.style.transform = `translateX(${rect.left - segRect.left}px)`;
}

// 只切显示，一个字都不动：三个 textarea 的内容各自留着
function applyTplTierView() {
  for (const tier of TIERS) {
    const btn = tabBtn(tier);
    const panel = $(`panel-${tier}`);
    if (!btn || !panel) continue;
    const on = tier === activeTier;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    btn.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  }
  syncThumb();
}

function setActiveTier(tier, focusTab = false) {
  if (!TIERS.includes(tier)) return;
  activeTier = tier;
  applyTplTierView();
  checkTemplate(tier);
  // 「恢复默认」在编辑框左下角，用 title/提示说明它只作用于当前这一档
  const label = TIER_LABEL[tier];
  const reset = $("btn-reset-tpl");
  if (reset) reset.title = `只把「${label}」这一档恢复成内置默认（其它两档不动）`;
  const hint = $("tpl-reset-hint");
  if (hint) hint.textContent = `只影响「${label}」这一档`;
  if (focusTab) tabBtn(tier)?.focus();
}

function markTplDefault(tier) {
  const badge = $(`tpl-${tier}-badge`);
  badge.textContent = "内置默认";
  badge.classList.remove("custom");
}

function applyPersonLimits() {
  const lim = state.people_limits || {};
  if (lim.relation) $("np-relation").maxLength = lim.relation;
  if (lim.note) $("np-note").maxLength = lim.note;
  if (lim.alias) $("np-aliases").title = `每个别名最多 ${lim.alias} 字（超出会被截断）`;
}

function renderPeople() {
  const people = state.people || [];
  $("people-count").textContent = `${people.length} 人`;
  $("people-path").textContent = state.store_path ? `数据文件：${state.store_path}` : "";
  const box = $("people-list");
  box.innerHTML = "";
  if (!people.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "还没有登记任何人 —— 上面填 QQ 和称呼点「登记」，或让开发者发一句 /know QQ 称呼 关系 备注。";
    box.appendChild(empty);
    return;
  }
  people.forEach((record) => {
    const row = document.createElement("div");
    row.className = "person";
    if (record.qq && record.qq === editingQq) row.classList.add("editing");

    const qq = document.createElement("span");
    qq.className = "qq";
    qq.textContent = `QQ ${record.qq || "?"}`;

    const alias = document.createElement("span");
    alias.className = "alias";
    alias.textContent = (record.aliases || []).join("、") || "（无称呼）";

    const meta = document.createElement("span");
    meta.className = "meta grow";
    const bits = [];
    if (record.relation) bits.push(`关系：${record.relation}`);
    if (record.note) bits.push(`备注：${record.note}`);
    if (record.source) bits.push(`来源：${SOURCE_LABEL[record.source] || record.source}`);
    if (record.added_by) bits.push(`登记人：${record.added_by}`);
    if (record.updated_at) bits.push(record.updated_at);
    meta.textContent = bits.join("｜");

    const edit = document.createElement("button");
    edit.className = "btn ghost";
    edit.type = "button";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => fillPersonForm(record));

    const del = document.createElement("button");
    del.className = "btn ghost";
    del.type = "button";
    if (confirmQq === record.qq) {
      del.textContent = "确认移除？";
      del.classList.add("danger");
      del.title = "再点一次就移除；4 秒内不点第二次会自动取消";
    } else {
      del.textContent = "移除";
    }
    del.addEventListener("click", () => removePerson(record.qq));

    row.append(qq, alias, meta, edit, del);
    box.appendChild(row);
  });
}

/* --------------------------------------------------------- 熟人登记表单 */

function fillPersonForm(record) {
  editingQq = record.qq || "";
  $("np-qq").value = editingQq;
  // 编辑时锁住 QQ：改号 = 另一条记录，容易误把旧记录留成孤儿
  $("np-qq").readOnly = true;
  $("np-aliases").value = (record.aliases || []).join(" | ");
  $("np-relation").value = record.relation || "";
  $("np-note").value = record.note || "";
  $("btn-person-save").textContent = "保存修改";
  $("btn-person-cancel").classList.remove("hidden");
  $("np-mode").textContent = `正在编辑 QQ ${editingQq}（要换号先取消，再登记一条新的）`;
  $("people-form").classList.add("editing");
  renderPeople();
  $("np-aliases").focus();
}

function resetPersonForm() {
  editingQq = "";
  for (const id of ["np-qq", "np-aliases", "np-relation", "np-note"]) $(id).value = "";
  $("np-qq").readOnly = false;
  $("btn-person-save").textContent = "登记";
  $("btn-person-cancel").classList.add("hidden");
  $("np-mode").textContent = "";
  $("people-form").classList.remove("editing");
}

async function submitPerson() {
  const qq = $("np-qq").value.trim();
  if (!/^\d{5,12}$/.test(qq)) {
    toast("QQ 号应为 5-12 位数字", true);
    $("np-qq").focus();
    return;
  }
  const aliases = splitAliases($("np-aliases").value);
  if (!aliases.length) {
    toast("至少要给一个称呼（比如「小七」）", true);
    $("np-aliases").focus();
    return;
  }
  const res = await guard(async () =>
    unwrap(
      await bridge.apiPost("identity/people/save", {
        qq,
        aliases,
        relation: $("np-relation").value.trim(),
        note: $("np-note").value.trim(),
      }),
    ),
  );
  if (!res) return;
  toast(res.updated ? `已更新 ${qq}` : `已登记 ${qq}`);
  resetPersonForm();
  await loadState();
}

/* ---------------------------------------------------------------- 熟人候选 */

// "2026-11-06 19:40:11" -> "11-06 19:40"：这一栏只是给开发者认人用的，年份没意义
const shortTime = (value) =>
  String(value || "")
    .replace(/^\d{4}-/, "")
    .replace(/:\d{2}$/, "");

function renderCandidates() {
  const list = state.candidates || [];
  $("cand-count").textContent = `${list.length} 人`;
  $("cand-max").textContent = state.candidates_max || 200;
  $("cand-path").textContent = state.candidates_path ? `数据文件：${state.candidates_path}` : "";
  const box = $("cand-list");
  box.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent =
      state.auto_candidates_enable === false
        ? "自动记录已关闭 —— 不会记下任何陌生人。打开上面的开关并点「保存」即可开始。"
        : "还没有记录到陌生人。开关是开着的，等有人给机器人发消息就会出现在这里（他们仍然是陌生人档）。";
    box.appendChild(empty);
    return;
  }
  list.forEach((record) => {
    const row = document.createElement("div");
    row.className = "person";

    const qq = document.createElement("span");
    qq.className = "qq";
    qq.textContent = `QQ ${record.qq || "?"}`;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = (record.names || []).join(" / ") || "（没记到昵称）";

    const meta = document.createElement("span");
    meta.className = "meta grow";
    const bits = [record.group ? `群 ${record.group}` : "私聊"];
    if (record.first_seen) bits.push(`首次 ${shortTime(record.first_seen)}`);
    if (record.last_seen) bits.push(`最近 ${shortTime(record.last_seen)}`);
    meta.textContent = bits.join("｜");

    const seen = document.createElement("span");
    seen.className = "cand-tag";
    seen.textContent = `见 ${record.seen || 0} 次`;

    const promote = document.createElement("button");
    promote.type = "button";
    promote.className = "btn ghost promote";
    promote.textContent = "转为熟人";
    promote.title = "写进熟人登记表（称呼沿用昵称，之后可在上面编辑）";
    promote.addEventListener("click", () => promoteCandidate(record.qq));

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn ghost";
    dismiss.textContent = "忽略";
    dismiss.title = "只从候选表删掉，不影响档位；他再发消息会被重新记一次";
    dismiss.addEventListener("click", () => dismissCandidate(record.qq));

    row.append(qq, name, meta, seen, promote, dismiss);
    box.appendChild(row);
  });
}

async function promoteCandidate(qq) {
  if (!qq) return;
  const res = await guard(async () =>
    unwrap(await bridge.apiPost("identity/candidates/promote", { qq })),
  );
  if (!res) return;
  toast(res.updated ? `已更新 ${qq} 为熟人` : `已把 ${qq} 转为熟人`);
  await loadState();
}

async function dismissCandidate(qq) {
  if (!qq) return;
  const res = await guard(async () =>
    unwrap(await bridge.apiPost("identity/candidates/dismiss", { qq })),
  );
  if (!res) return;
  toast(`已忽略 ${qq}`);
  await loadState();
}

function syncClearButton() {
  const btn = $("btn-cand-clear");
  btn.textContent = clearArmed ? "确认清空？" : "清空候选表";
  btn.classList.toggle("danger", clearArmed);
  btn.title = clearArmed ? "4 秒内再点一次就清空，之后自动取消" : "清空候选表（不动熟人登记表）";
}

async function clearCandidates() {
  if (!clearArmed) {
    clearArmed = true;
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      clearArmed = false;
      syncClearButton();
    }, 4000);
    syncClearButton();
    return;
  }
  clearTimeout(clearTimer);
  clearArmed = false;
  syncClearButton();
  const res = await guard(async () =>
    unwrap(await bridge.apiPost("identity/candidates/clear", {})),
  );
  if (!res) return;
  toast(`已清空候选表（${res.cleared ?? 0} 个）`);
  await loadState();
}

async function removePerson(qq) {
  if (!qq) return;
  // 第一次点击只"上膛"，第二次才真删（见文件顶部 confirmQq 的注释）
  if (confirmQq !== qq) {
    confirmQq = qq;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      confirmQq = "";
      renderPeople();
    }, 4000);
    renderPeople();
    return;
  }
  clearTimeout(confirmTimer);
  confirmQq = "";
  const res = await guard(async () =>
    unwrap(await bridge.apiPost("identity/people/delete", { qq })),
  );
  if (!res) {
    renderPeople();
    return;
  }
  toast(`已移除 ${qq}，之后按陌生人对待`);
  if (editingQq === qq) resetPersonForm();
  await loadState();
}

function checkTemplate(tier) {
  const text = tplBox(tier).value;
  const warnEl = $(`tpl-${tier}-warn`);
  const problems = [];  if (text.trim()) {
    if (!text.includes("{qq}")) {
      problems.push("没有 {qq}：模型看不到 QQ 号，「只看 QQ 号」这条就落空了");
    }
    for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
      if (!TPL_VARS.has(match[1])) problems.push(`未知变量 {${match[1]}}，保存会被拒绝`);
    }
    const stripped = text.replace(/\{[^{}]*\}/g, "");
    if (stripped.includes("{") || stripped.includes("}")) problems.push("有落单的花括号，保存会被拒绝");
    if (tier !== "owner" && text.includes("{masters}")) {
      problems.push("这个模板里用了 {masters}：会把开发者 QQ 号发给模型，可能被问出来");
    }
  }
  warnEl.textContent = problems.join("；");
  const lenEl = $(`tpl-${tier}-len`);
  if (lenEl) lenEl.textContent = `${text.length} 字`;
  // 内容变了就让背后的变量高亮层跟上（输入、恢复默认、回读配置都会走到这里）
  syncMirror(tier);
}

function syncMaskWordsHint() {
  const effective = state.mask_words_effective || [];
  const extra = effective.filter((w) => !(state.mask_words || []).includes(w));
  $("mask-words").title = extra.length ? `实际生效还会包含：${extra.join("、")}` : "";
}

/* ------------------------------------------------------------------ 动作 */

async function loadState() {
  state = unwrap(await bridge.apiGet("identity/state"));
  render();
}

const sameAsDefault = (value, tier) => {
  const text = String(value || "").trim();
  const fallback = String((state.tpl_defaults || {})[tier] || "").trim();
  return !text || text === fallback;
};

// 空串 = 用内置默认；和默认文案一致也存空串，免得"顺手点保存"就把默认文案固化住
const tplPayload = (tier) =>
  tplReset[tier] || sameAsDefault(tplBox(tier).value, tier) ? "" : tplBox(tier).value;

async function save() {
  const config = {
    enable: $("c-enable").checked,
    inject_identity: $("c-inject").checked,
    log: $("c-log").checked,
    master_qq: masters,
    master_label: $("master-label").value.trim() || "开发者",
    inject_target: $("inject-target").value,
    isolate_mode: $("isolate-mode").value,
    isolate_groups: splitList($("isolate-groups").value),
    isolate_qq: splitList($("isolate-qq").value),
    mask_enable: $("c-mask").checked,
    mask_words: splitList($("mask-words").value),
    mask_char: $("mask-char").value.trim() || "＊",
    tpl_owner: tplPayload("owner"),
    tpl_known: tplPayload("known"),
    tpl_stranger: tplPayload("stranger"),
    owner_tools_enable: $("c-owner-tools").checked,
    auto_candidates_enable: $("c-candidates").checked,
  };
  const res = await guard(async () => unwrap(await bridge.apiPost("identity/save", { config })));
  if (!res) return;
  toast("已保存");
  await loadState();
}

async function preview() {
  const sender = $("p-sender").value.trim();
  if (!sender) {
    toast("先填一个 QQ 号", true);
    return;
  }
  const res = await guard(async () =>
    unwrap(
      await bridge.apiPost("identity/preview", {
        sender_id: sender,
        sender_name: $("p-name").value.trim(),
        group_id: $("p-group").value.trim(),
      }),
    ),
  );
  if (!res) return;
  const meta = [
    `判定：${res.tier ? TIER_LABEL[res.tier] || res.tier : res.is_master ? "开发者" : "陌生人"}`,
    `注入位置：${res.inject_target}`,
    `长度：${res.chars} 字符`,
    res.isolated_umo ? `隔离后会话：${res.isolated_umo}` : "隔离后会话：不隔离",
  ];
  if (Array.isArray(res.aliases) && res.aliases.length) meta.push(`称呼：${res.aliases.join("、")}`);
  if (res.relation) meta.push(`关系：${res.relation}`);
  if (res.mask_applied) meta.push(`昵称打码：${res.masked_name}`);
  $("p-meta").textContent = meta.join("｜");
  $("p-out").textContent = res.block;
}

/* ------------------------------------------------------------------ 绑定 */

function bind() {
  $("btn-save").addEventListener("click", save);
  $("btn-add-master").addEventListener("click", () => {
    const qq = $("master-input").value.trim();
    if (!/^\d{5,12}$/.test(qq)) {
      toast("QQ 号应为 5-12 位数字", true);
      return;
    }
    if (!masters.includes(qq)) masters.push(qq);
    $("master-input").value = "";
    renderChips();
  });
  $("master-input").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      $("btn-add-master").click();
    }
  });
  $("btn-use-admins").addEventListener("click", () => {
    const admins = state.admins_id || [];
    if (!admins.length) {
      toast("没有可用的管理员列表", true);
      return;
    }
    masters = [...admins];
    renderChips();
    toast("已填入管理员列表，记得点保存");
  });
  $("btn-preview").addEventListener("click", preview);

  // 熟人登记表单：录入 / 回车提交 / 取消编辑
  $("btn-person-save").addEventListener("click", submitPerson);
  $("btn-cand-clear").addEventListener("click", clearCandidates);
  syncClearButton();
  $("btn-person-cancel").addEventListener("click", () => {
    resetPersonForm();
    renderPeople();
  });
  for (const id of ["np-qq", "np-aliases", "np-relation", "np-note"]) {
    $(id).addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitPerson();
      }
      if (ev.key === "Escape" && editingQq) {
        resetPersonForm();
        renderPeople();
      }
    });
  }

  // 身份块模板：分档切换 + 单一「恢复默认」（只作用于当前这一档）
  const tabs = $("tpl-tabs");
  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".seg-item");
    if (btn?.dataset.tier) setActiveTier(btn.dataset.tier);
  });
  // 键盘左右也能切（WAI-ARIA tabs 的常规做法），和点击共用同一套状态
  tabs.addEventListener("keydown", (ev) => {
    const i = TIERS.indexOf(activeTier);
    let next = null;
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = TIERS[(i + 1) % TIERS.length];
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = TIERS[(i - 1 + TIERS.length) % TIERS.length];
    else if (ev.key === "Home") next = TIERS[0];
    else if (ev.key === "End") next = TIERS[TIERS.length - 1];
    if (!next) return;
    ev.preventDefault();
    setActiveTier(next, true);
  });
  $("btn-reset-tpl").addEventListener("click", () => {
    const tier = activeTier;
    tplReset[tier] = true;
    tplBox(tier).value = (state.tpl_defaults || {})[tier] || "";
    markTplDefault(tier);
    checkTemplate(tier);
    toast(`「${TIER_LABEL[tier]}」已恢复默认，记得点保存`);
  });
  for (const tier of TIERS) {
    // 恢复默认后再动一下输入框 = 又要自己写了，得把 reset 标记撤掉，
    // 否则保存时会被当成"仍用默认"而把刚打的字丢掉
    tplBox(tier).addEventListener("input", () => {
      tplReset[tier] = false;
      checkTemplate(tier);
    });
    // 高亮层不跟着滚就会错位
    tplBox(tier).addEventListener("scroll", () => {
      const mirror = mirrorOf(tier);
      if (mirror) mirror.scrollTop = tplBox(tier).scrollTop;
    });
  }

  // 说明区可折叠：grid-template-rows 0fr↔1fr 的过渡在 CSS 里，这里只切状态
  const helpBtn = $("btn-tpl-help");
  const helpBox = $("tpl-help");
  const setHelpOpen = (open) => {
    helpBox.dataset.open = open ? "true" : "false";
    helpBtn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  helpBtn.addEventListener("click", () => setHelpOpen(helpBox.dataset.open !== "true"));
  setHelpOpen(false);

  // 高亮块依赖布局：窗口缩放、iframe 从隐藏变可见、字体加载完成都要重算
  window.addEventListener("resize", syncThumb);
  document.addEventListener("visibilitychange", syncThumb);
  if (typeof ResizeObserver === "function") {
    // 留住引用：观察器被 GC 掉就不会再回调了
    segObserver = new ResizeObserver(syncThumb);
    segObserver.observe(tabs);
  }
  if (document.fonts?.ready) document.fonts.ready.then(syncThumb).catch(() => {});
  setActiveTier(activeTier);
}

(async function boot() {
  if (!bridge) {
    document.body.innerHTML = "<p style='padding:24px'>没有找到 AstrBot 插件 bridge，请从 AstrBot WebUI 打开此页面。</p>";
    return;
  }
  await bridge.ready();
  bind();
  await guard(loadState);
})();
