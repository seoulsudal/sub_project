(() => {
  "use strict";

  const DATA_URL = "data/items.json";

  const AGE_OPTIONS = [
    { value: "0-2", label: "영아 0~2세" },
    { value: "3-5", label: "유아 3~5세" },
    { value: "6-7", label: "6~7세" },
    { value: "8-9", label: "초등 저학년" },
    { value: "10-12", label: "초등 고학년" },
  ];
  const AGE_LABEL = Object.fromEntries(AGE_OPTIONS.map((o) => [o.value, o.label]));
  const SOURCE_LABEL = {
    tour: "한국관광공사",
    seoul: "서울 열린데이터광장",
    manual: "직접 등록",
    sample: "샘플 데이터",
  };

  const $ = (id) => document.getElementById(id);
  const grid = $("grid");

  // 필터 상태. 알 수 없는 값(null)은 조건이 켜지면 제외한다.
  const state = { age: new Set(), io: "", free: false, region: "", type: "", q: "" };
  let items = [];

  /* ---------- 공통 유틸 ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // 외부 데이터의 URL은 http(s)만 허용한다 (javascript: 등 차단)
  function safeUrl(value) {
    if (!value) return null;
    try {
      const u = new URL(value);
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
    } catch {
      return null;
    }
  }

  function ymd(date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  // id 문자열로 카드 색상(hue)을 고정한다
  function hueOf(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  function formatPeriod(item) {
    if (item.type !== "event" || !item.startDate) return "";
    const fmt = (s) => s.slice(5).replace("-", ".");
    return item.startDate === item.endDate ? fmt(item.startDate) : `${fmt(item.startDate)} ~ ${fmt(item.endDate)}`;
  }

  function ageText(item) {
    if (!item.ages || !item.ages.length) return "";
    if (item.ages.includes("all")) return "전 연령";
    return item.ages.map((a) => AGE_LABEL[a] || a).join(", ");
  }

  /* ---------- 필터 ---------- */

  function matches(item) {
    if (state.region && item.region !== state.region) return false;
    if (state.type && item.type !== state.type) return false;
    if (state.free && item.isFree !== true) return false;
    if (state.io === "indoor" && item.indoor !== true) return false;
    if (state.io === "outdoor" && item.indoor !== false) return false;
    if (state.age.size) {
      const ages = item.ages || [];
      const ok = ages.includes("all") || [...state.age].some((a) => ages.includes(a));
      if (!ok) return false;
    }
    if (state.q) {
      const hay = `${item.title} ${item.district || ""} ${item.address || ""} ${item.region}`.toLowerCase();
      if (!hay.includes(state.q.toLowerCase())) return false;
    }
    return true;
  }

  function hasActiveFilter() {
    return state.age.size > 0 || state.io || state.free || state.region || state.type || state.q;
  }

  /* ---------- 카드 ---------- */

  function buildBadges(item, withAge) {
    const box = el("span", "badges");
    if (item.source === "sample") box.append(el("span", "badge sample", "샘플"));
    if (item.isFree === true) box.append(el("span", "badge free", "무료"));
    else if (item.isFree === false) box.append(el("span", "badge paid", "유료"));
    if (item.indoor === true) box.append(el("span", "badge", "실내"));
    else if (item.indoor === false) box.append(el("span", "badge", "야외"));
    if (withAge) {
      const t = ageText(item);
      if (t) box.append(el("span", "badge", t));
    }
    return box;
  }

  // 이미지가 없거나 로딩에 실패하면 첫 글자 플레이스홀더를 보여준다
  function fillImage(box, item) {
    box.style.setProperty("--hue", hueOf(item.id));
    const ph = el("span", "ph", item.title.replace(/^\[.*?\]\s*/, "").charAt(0));
    box.append(ph);
    const src = safeUrl(item.image);
    if (!src) return;
    const img = new Image();
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("load", () => box.prepend(img));
    img.src = src;
  }

  function makeCard(item, index) {
    const card = el("button", "card");
    card.type = "button";
    card.style.setProperty("--hue", hueOf(item.id));
    card.style.setProperty("--i", index);

    const thumb = el("span", "thumb");
    fillImage(thumb, item);
    thumb.append(el("span", "kind" + (item.type === "event" ? " event" : ""), item.type === "event" ? "행사" : "장소"));

    const body = el("span", "c-body");
    body.append(el("span", "c-title", item.title));
    const meta = [item.region + (item.district ? ` ${item.district}` : ""), formatPeriod(item)].filter(Boolean).join(" · ");
    body.append(el("span", "c-meta", meta));
    const foot = el("span", "c-foot");
    foot.append(buildBadges(item, false), el("span", "more", "자세히 보기"));
    body.append(foot);

    card.append(thumb, body);
    card.addEventListener("click", () => openDetail(item));
    // 마우스 위치를 CSS 변수로 넘겨 스포트라이트 효과를 준다
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
    return card;
  }

  function render() {
    const list = items.filter(matches);
    grid.replaceChildren(...list.map(makeCard));
    $("empty").hidden = list.length > 0;
    $("result-count").textContent = `${list.length}곳 / 전체 ${items.length}곳`;
    $("filter-hint").hidden = !(state.age.size || state.io || state.free);
    $("reset").hidden = !hasActiveFilter();
    syncChips();
    writeHash();
  }

  /* ---------- 칩(필터 버튼) ---------- */

  const groups = {};

  function buildGroup(containerId, key, options, mode) {
    const box = $(containerId);
    groups[key] = { box, mode, buttons: [] };
    options.forEach((opt) => {
      const b = el("button", "chip", opt.label);
      b.type = "button";
      b.dataset.value = opt.value;
      b.addEventListener("click", () => {
        if (mode === "multi") {
          state[key].has(opt.value) ? state[key].delete(opt.value) : state[key].add(opt.value);
        } else if (mode === "toggle") {
          state[key] = !state[key];
        } else {
          state[key] = opt.value;
        }
        render();
      });
      box.append(b);
      groups[key].buttons.push(b);
    });
  }

  function syncChips() {
    for (const [key, g] of Object.entries(groups)) {
      g.buttons.forEach((b) => {
        const v = b.dataset.value;
        const on = g.mode === "multi" ? state[key].has(v) : g.mode === "toggle" ? state[key] : state[key] === v;
        b.setAttribute("aria-pressed", String(on));
      });
    }
  }

  function initFilters() {
    buildGroup("f-age", "age", AGE_OPTIONS, "multi");
    buildGroup("f-indoor", "io", [
      { value: "", label: "실내·야외 전체" },
      { value: "indoor", label: "실내" },
      { value: "outdoor", label: "야외" },
    ], "single");
    buildGroup("f-free", "free", [{ value: "1", label: "무료만" }], "toggle");
    buildGroup("f-region", "region", [
      { value: "", label: "수도권 전체" },
      { value: "서울", label: "서울" },
      { value: "경기", label: "경기" },
      { value: "인천", label: "인천" },
    ], "single");
    buildGroup("f-type", "type", [
      { value: "", label: "장소+행사" },
      { value: "place", label: "장소" },
      { value: "event", label: "행사" },
    ], "single");

    $("q").addEventListener("input", (e) => { state.q = e.target.value.trim(); render(); });
    $("q").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.target.value = ""; state.q = ""; e.target.blur(); render(); }
    });
    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (e.key === "/" && !typing && !$("detail").open) { e.preventDefault(); $("q").focus(); }
    });
    $("reset").addEventListener("click", () => {
      state.age.clear(); state.io = ""; state.free = false; state.region = ""; state.type = ""; state.q = "";
      $("q").value = "";
      render();
    });
  }

  /* ---------- URL 해시 (필터 공유용) ---------- */

  function writeHash() {
    const p = new URLSearchParams();
    if (state.age.size) p.set("age", [...state.age].join(","));
    if (state.io) p.set("io", state.io);
    if (state.free) p.set("free", "1");
    if (state.region) p.set("region", state.region);
    if (state.type) p.set("type", state.type);
    if (state.q) p.set("q", state.q);
    const s = p.toString();
    history.replaceState(null, "", s ? `#${s}` : location.pathname + location.search);
  }

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const valid = (v, list) => (list.includes(v) ? v : "");
    (p.get("age") || "").split(",").filter((a) => AGE_LABEL[a]).forEach((a) => state.age.add(a));
    state.io = valid(p.get("io"), ["indoor", "outdoor"]);
    state.free = p.get("free") === "1";
    state.region = valid(p.get("region"), ["서울", "경기", "인천"]);
    state.type = valid(p.get("type"), ["place", "event"]);
    state.q = (p.get("q") || "").slice(0, 60);
    $("q").value = state.q;
  }

  /* ---------- 이번 주말 행사 ---------- */

  function weekendRange(now) {
    const dow = now.getDay(); // 0 일 ~ 6 토
    const sat = dow === 0 ? addDays(now, -1) : addDays(now, 6 - dow);
    const sun = addDays(sat, 1);
    const today = ymd(now);
    return { from: ymd(sat) < today ? today : ymd(sat), to: ymd(sun), sat: ymd(sat), sun: ymd(sun) };
  }

  function renderWeekend() {
    const w = weekendRange(new Date());
    const list = items
      .filter((i) => i.type === "event" && i.startDate <= w.to && i.endDate >= w.from)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    $("weekend").hidden = list.length === 0;
    if (!list.length) return;
    $("weekend-range").textContent = `${w.sat.slice(5).replace("-", ".")} ~ ${w.sun.slice(5).replace("-", ".")}`;
    $("strip").replaceChildren(
      ...list.map((item) => {
        const b = el("button", "mini");
        b.type = "button";
        b.append(
          el("span", "when", formatPeriod(item)),
          el("span", "t", item.title),
          el("span", "w", `${item.region}${item.district ? " " + item.district : ""}${item.isFree ? " · 무료" : ""}`)
        );
        b.addEventListener("click", () => openDetail(item));
        return b;
      })
    );
  }

  /* ---------- 상세 모달 ---------- */

  const dialog = $("detail");
  let map = null;
  let marker = null;

  function infoRow(dl, label, value) {
    if (!value) return;
    dl.append(el("dt", null, label), el("dd", null, value));
  }

  function actionLink(text, href, primary) {
    const a = el("a", "btn" + (primary ? " primary" : ""), text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function showMap(item) {
    const hasPos = Number.isFinite(item.lat) && Number.isFinite(item.lng);
    $("d-map").hidden = !hasPos || typeof L === "undefined";
    $("d-map-note").hidden = hasPos && typeof L !== "undefined";
    if ($("d-map").hidden) return;

    const pos = [item.lat, item.lng];
    if (!map) {
      map = L.map("d-map", { scrollWheelZoom: false }).setView(pos, 15);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors",
      }).addTo(map);
    }
    if (marker) marker.remove();
    marker = L.marker(pos).addTo(map);
    map.setView(pos, 15);
    // 모달이 열린 뒤에야 크기가 확정되므로 다시 계산시킨다
    requestAnimationFrame(() => map.invalidateSize());
  }

  function openDetail(item) {
    const image = $("d-image");
    image.replaceChildren();
    fillImage(image, item);

    $("d-badges").replaceChildren(el("span", "badge", item.type === "event" ? "행사" : "장소"), ...buildBadges(item, true).children);
    $("d-title").textContent = item.title;
    $("d-summary").textContent = item.summary || "";
    $("d-summary").hidden = !item.summary;

    const dl = $("d-info");
    dl.replaceChildren();
    infoRow(dl, "기간", item.type === "event" ? formatPeriod(item) : "");
    infoRow(dl, "주소", item.address);
    infoRow(dl, "요금", item.isFree === true ? "무료" : item.isFree === false ? "유료 (자세한 요금은 공식 사이트 확인)" : "");
    infoRow(dl, "구분", item.indoor === true ? "실내" : item.indoor === false ? "야외" : "");
    infoRow(dl, "연령", ageText(item));
    infoRow(dl, "문의", item.tel);
    infoRow(dl, "출처", SOURCE_LABEL[item.source] || item.source);

    const actions = $("d-actions");
    actions.replaceChildren();
    const official = safeUrl(item.officialUrl);
    if (official) actions.append(actionLink("공식 사이트로 이동 ↗", official, true));
    else actions.append(Object.assign(el("span", "btn primary disabled", "공식 사이트 정보 없음"), {}));
    if (Number.isFinite(item.lat) && Number.isFinite(item.lng)) {
      const name = encodeURIComponent(item.title.replace(/[,]/g, " "));
      actions.append(actionLink("길찾기 (카카오맵) ↗", `https://map.kakao.com/link/to/${name},${item.lat},${item.lng}`, false));
    }

    dialog.showModal();
    dialog.querySelector(".d-inner").scrollTop = 0;
    showMap(item);
  }

  function initDialog() {
    $("d-close").addEventListener("click", () => dialog.close());
    // 배경(backdrop) 클릭 시 닫기
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  }

  /* ---------- 시계 / 인사말 ---------- */

  function tick() {
    const d = new Date();
    $("time").textContent = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
    $("date").textContent = d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
    const h = d.getHours();
    $("greeting").textContent = h < 6 ? "늦은 밤이에요" : h < 12 ? "좋은 아침" : h < 18 ? "좋은 오후" : "좋은 저녁";
  }

  /* ---------- 시작 ---------- */

  async function load() {
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const json = await res.json();
      const today = ymd(new Date());
      // 이미 끝난 행사는 화면에서 제외한다
      items = (json.items || []).filter((i) => i.type !== "event" || (i.endDate || "") >= today);
      if (json.updatedAt) {
        $("updated").textContent = `데이터 갱신: ${new Date(json.updatedAt).toLocaleDateString("ko-KR")}${json.note ? " · " + json.note : ""}`;
      }
    } catch (err) {
      console.error("데이터 로딩 실패", err);
      $("load-error").hidden = false;
      return;
    }
    renderWeekend();
    render();
  }

  tick();
  setInterval(tick, 20000);
  readHash();
  initFilters();
  initDialog();
  load();
})();
