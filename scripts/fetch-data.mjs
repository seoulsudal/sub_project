#!/usr/bin/env node
/**
 * 수도권(서울·경기·인천) 아이 동반 장소/행사 데이터를 공공 API에서 모아 data/items.json 으로 만든다.
 *
 * 사용법
 *   node --env-file=.env scripts/fetch-data.mjs           # 수집 후 data/items.json 갱신
 *   node --env-file=.env scripts/fetch-data.mjs --probe   # 각 API를 1건씩 호출해 원본 응답 구조만 확인
 *   node --env-file=.env scripts/fetch-data.mjs --count   # 목록만 조회해 후보 수와 필요한 호출 수를 예측 (상세 조회 안 함)
 *   node --env-file=.env scripts/fetch-data.mjs --dry     # 수집 결과를 파일에 쓰지 않고 요약만 출력
 *
 * 필요한 환경변수 (.env 또는 GitHub Secrets)
 *   TOUR_API_KEY   공공데이터포털 - 한국관광공사 국문 관광정보 서비스 인증키
 *   SEOUL_API_KEY  서울 열린데이터광장 인증키
 *   둘 중 하나만 있어도 해당 소스만 수집한다.
 *
 * 주의: 이 스크립트는 API 명세를 문서로만 확인하고 작성했다. 처음 키를 넣고 --probe 로
 *       응답 구조가 아래 상수/필드명과 맞는지 반드시 확인할 것.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = resolve(ROOT, "data/items.json");
const CACHE_FILE = resolve(ROOT, "data/cache.json");
const OVERRIDES_FILE = resolve(ROOT, "data/overrides.json");

const args = new Set(process.argv.slice(2));
const PROBE = args.has("--probe");
const DRY = args.has("--dry");
const COUNT = args.has("--count"); // 목록 조회만 하고 상세 조회에 필요한 호출 수를 예측한다

/* ---------------- 설정 (API 명세가 다르면 여기만 고친다) ---------------- */

const TOUR_BASE = process.env.TOUR_API_BASE || "https://apis.data.go.kr/B551011/KorService2";
// 서울 API의 8088 포트는 http 전용이다. 브라우저에서는 호출 불가하므로 반드시 이 스크립트(서버 측)에서만 호출한다.
const SEOUL_BASE = process.env.SEOUL_API_BASE || "http://openapi.seoul.go.kr:8088";

// 법정동 시도코드 (lDongRegnCd)
const TOUR_REGIONS = [
  { name: "서울", code: "11" },
  { name: "인천", code: "28" },
  { name: "경기", code: "41" },
];
// 장소는 목록 전체를 받지 않고 키워드로 서버에서 먼저 좁혀 받는다 (searchKeyword2).
// 여기에 없는 유명 장소(예: 서울숲)는 data/overrides.json 의 add 로 직접 등록한다.
const TOUR_PLACE_KEYWORDS = [
  "어린이", "키즈", "유아", "아이와", "가족", "동물원", "수족관", "아쿠아리움",
  "과학관", "테마파크", "놀이", "체험", "목장", "휴양림", "생태", "자연학습",
];
// 관광지 12, 문화시설 14, 레포츠 28 만 장소로 채택 (행사 15 는 searchFestival2 로 따로, 숙박·음식·쇼핑 제외)
const TOUR_PLACE_TYPES = new Set(["12", "14", "28"]);

// 개발계정 일 1,000회 제한 → 여유를 두고 상한을 둔다
const MAX_TOUR_CALLS = Number(process.env.MAX_TOUR_CALLS || 850);
const EVENT_WINDOW_DAYS = 90; // 오늘부터 이 기간 안에 열리는 행사만 수집

// 제목에 이 단어가 있으면 아이 동반 장소일 가능성이 높아 상세 조회를 먼저 한다
const STRONG_KID_RE = /어린이|키즈|유아|아이|동물원|수족관|아쿠아|과학관|테마파크|놀이|체험|목장|농장/;
// 행사는 이 단어가 제목/이용대상/개요에 실제로 있어야 채택한다 ("누구나 관람"만으로는 채택하지 않음)
const KID_EVENT_STRICT_RE = /어린이|영유아|유아|아기|아가|아이(?!돌|스|유|디|템|폰|콘)|키즈|가족|패밀리|동화|그림책|인형극|초등|유치원|꼬마|놀이|만들기/;
const ONLINE_RE = /온라인|비대면/;
const KID_EVENT_RE = /어린이|아이|유아|키즈|가족|체험|동화|놀이|그림책|인형극|동물|곤충|과학|만들기|캐릭터|축제|페스티벌/;
const ADULT_ONLY_RE = /맥주|와인|막걸리|주류|위스키|클럽|EDM|19세/;
// 이용대상이 "성인"으로 시작하면 성인 전용으로 본다 ("어린이·성인 누구나" 같은 값은 제외하지 않는다)
const ADULT_TARGET_RE = /^\s*(성인|만?\s*19세)/;

/* ---------------- 유틸 ---------------- */

const today = new Date();
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const compact = (s) => s.replaceAll("-", "");
const dashed = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
const TODAY = ymd(today);
const UNTIL = ymd(new Date(today.getTime() + EVENT_WINDOW_DAYS * 86400000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function stripHtml(v) {
  return String(v ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// homepage 필드는 <a href="..."> 형태의 HTML 로 오는 경우가 많다
function extractUrl(v) {
  const s = String(v ?? "");
  const m = s.match(/href=["']([^"']+)["']/i) || s.match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return null;
  const url = (m[1] || m[0]).trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

const upgradeHttps = (u) => (u ? u.replace(/^http:\/\//i, "https://") : null);

function shortHash(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 10);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

// 서울 API는 LAT/LOT 가 뒤바뀌어 오는 경우가 있어 값의 범위로 위도·경도를 판별한다
function pickLatLng(a, b) {
  const x = num(a), y = num(b);
  if (x == null || y == null) return { lat: null, lng: null };
  const isLat = (v) => v >= 33 && v <= 39;
  const isLng = (v) => v >= 124 && v <= 132;
  if (isLat(x) && isLng(y)) return { lat: x, lng: y };
  if (isLat(y) && isLng(x)) return { lat: y, lng: x };
  return { lat: null, lng: null };
}

function inferFree(text) {
  const t = stripHtml(text);
  if (!t) return null;
  const hasPrice = /\d[\d,]*\s*원/.test(t);
  if (/무료/.test(t) && !hasPrice) return true;
  if (hasPrice || /유료/.test(t)) return false;
  return null;
}

// 연령 구간: 0~7 미취학(영유아·유치원) / 8~12 초등학생 (중학생 이상은 다루지 않음)
const AGE_BUCKETS = [["preschool", 0, 7], ["elementary", 8, 12]];

// 텍스트에서 대상 연령 태그를 추정한다 (휴리스틱이므로 overrides 로 보정)
function inferAges(text) {
  const t = stripHtml(text);
  const ages = new Set();
  const addRange = (lo, hi) => AGE_BUCKETS.forEach(([key, a, b]) => { if (a <= hi && b >= lo) ages.add(key); });

  if (/전\s*연령|모든\s*연령|전체\s*관람|누구나|가족/.test(t)) ages.add("all");

  // 숫자 나이 표기: "5세", "3~5세", "만 7세 이상" ("이상/부터"는 초등 고학년까지 포함)
  for (const m of t.matchAll(/(\d{1,2})\s*(?:[~\-–]\s*(\d{1,2}))?\s*세\s*(이상|부터)?/g)) {
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : m[3] ? 12 : lo;
    if (lo <= 12 && lo <= hi) addRange(lo, Math.min(hi, 12));
  }
  if (/\d+\s*개월/.test(t)) addRange(0, 2);

  // 단어로 표기된 경우
  if (/영아|신생아|영유아|아기|유아|유치원|미취학|예비\s*초등|초등\s*입학/.test(t)) ages.add("preschool");
  if (/초등|저학년|고학년/.test(t)) ages.add("elementary");

  // 아이 관련 단어만 있고 나이 정보가 없으면 미취학·초등 모두로 본다
  if (!ages.size && /어린이|키즈|아이/.test(t)) { ages.add("preschool"); ages.add("elementary"); }
  return [...ages];
}

const INDOOR_RE = /박물관|미술관|전시관|과학관|아쿠아|수족관|도서관|체험관|키즈카페|문화센터|공연장|극장|홀\b/;
const OUTDOOR_RE = /공원|숲|수목원|해변|계곡|농장|목장|둘레길|정원|호수|생태|캠핑|동물원|광장|잔디|야외|축구장/;

function inferIndoor(typeId, text) {
  if (typeId === "14") return true;
  if (typeId === "28") return false;
  const i = INDOOR_RE.test(text), o = OUTDOOR_RE.test(text);
  if (i && !o) return true;
  if (o && !i) return false;
  return null;
}

/* ---------------- 한국관광공사 TourAPI ---------------- */

let tourCalls = 0;

function toArray(items) {
  if (!items || items === "") return [];
  const item = items.item ?? items;
  return Array.isArray(item) ? item : [item];
}

async function tour(op, params = {}) {
  if (tourCalls >= MAX_TOUR_CALLS) throw new Error("TOUR_BUDGET");
  tourCalls++;

  // 이미 URL 인코딩된 키(Encoding 키)를 넣어도 이중 인코딩되지 않게 디코딩한다
  const rawKey = process.env.TOUR_API_KEY;
  const key = rawKey.includes("%") ? decodeURIComponent(rawKey) : rawKey;

  const url = new URL(`${TOUR_BASE}/${op}`);
  url.search = new URLSearchParams({
    serviceKey: key, MobileOS: "ETC", MobileApp: "kids-outing", _type: "json", ...params,
  }).toString();

  const res = await fetch(url);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    if (/LIMITED_NUMBER|EXCEEDS/i.test(text)) throw new Error("TOUR_BUDGET");
    throw new Error(`TourAPI ${op}: JSON 아님 (${res.status}) ${text.slice(0, 200)}`);
  }
  if (PROBE) log(`\n[probe] ${op}`, JSON.stringify(json).slice(0, 900));

  const header = json?.response?.header;
  if (header && header.resultCode !== "0000") {
    // 22: 일일 호출 한도 초과
    if (header.resultCode === "22") throw new Error("TOUR_BUDGET");
    throw new Error(`TourAPI ${op}: ${header.resultCode} ${header.resultMsg}`);
  }
  const body = json?.response?.body ?? {};
  return { items: toArray(body.items), total: Number(body.totalCount || 0) };
}

// 페이지를 끝까지 넘기며 모두 가져온다
async function tourAll(op, params, { maxPages = 10, rows = 500 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { items, total } = await tour(op, { ...params, numOfRows: rows, pageNo: page });
    all.push(...items);
    if (PROBE || all.length >= total || items.length === 0) break;
    await sleep(120); // 초당 호출 제한 회피
  }
  return all;
}

async function collectTour(cache) {
  const out = [];
  const detailTargets = [];

  /* 1) 행사 */
  for (const region of TOUR_REGIONS) {
    const rows = await tourAll("searchFestival2", {
      eventStartDate: compact(TODAY), lDongRegnCd: region.code, arrange: "A",
    });
    for (const r of rows) {
      const start = dashed(r.eventstartdate), end = dashed(r.eventenddate) || start;
      if (!start || end < TODAY || start > UNTIL) continue;
      const text = `${r.title}`;
      if (ADULT_ONLY_RE.test(text) || !KID_EVENT_RE.test(text)) continue;
      detailTargets.push({ id: `tour-${r.contentid}`, typeId: r.contenttypeid || "15" });
      out.push({ raw: r, kind: "event", region: region.name, start, end });
    }
  }

  /* 2) 장소: 키워드 검색 결과만 후보로 삼는다 */
  const seenPlace = new Set();
  for (const region of TOUR_REGIONS) {
    for (const keyword of TOUR_PLACE_KEYWORDS) {
      const rows = await tourAll("searchKeyword2", { keyword, lDongRegnCd: region.code, arrange: "A" }, { rows: 100, maxPages: 3 });
      for (const r of rows) {
        if (!TOUR_PLACE_TYPES.has(r.contenttypeid) || seenPlace.has(r.contentid) || ADULT_ONLY_RE.test(r.title)) continue;
        seenPlace.add(r.contentid);
        detailTargets.push({ id: `tour-${r.contentid}`, typeId: r.contenttypeid, strong: STRONG_KID_RE.test(r.title) });
        out.push({ raw: r, kind: "place", region: region.name, typeId: r.contenttypeid });
      }
    }
  }
  log(`[tour] 후보 ${out.length}건 (목록 조회 호출 ${tourCalls}회)`);

  if (COUNT) {
    const need = new Set(detailTargets.map((t) => t.id.replace("tour-", "")).filter((c) => !cache.tour[c]));
    const events = out.filter((o) => o.kind === "event").length;
    const calls = need.size * 2;
    log(`[count] 후보: 장소 ${out.length - events}건 + 행사 ${events}건`);
    log(`[count] 상세 조회 필요 ${need.size}건 → 약 ${calls}회 (상세 1건당 2회)`);
    log(`[count] 목록 ${tourCalls}회 + 상세 ${calls}회 = ${tourCalls + calls}회 → 하루 상한 ${MAX_TOUR_CALLS}회 기준 약 ${Math.ceil((tourCalls + calls) / MAX_TOUR_CALLS)}일`);
    return [];
  }

  /* 3) 상세(개요·홈페이지·요금·연령): 캐시에 없는 것만 조회해서 호출 수를 아낀다 */
  // --probe 는 구조 확인용이라 상세는 장소 1건·행사 1건만 조회한다 (호출 한도 보호)
  const ordered = [...detailTargets].sort((a, b) => (b.typeId === "15") - (a.typeId === "15") || Number(!!b.strong) - Number(!!a.strong));
  const targets = PROBE
    ? [ordered.find((t) => t.typeId === "15"), ordered.find((t) => t.typeId !== "15")].filter(Boolean)
    : ordered;
  for (const t of targets) {
    const cid = t.id.replace("tour-", "");
    if (cache.tour[cid]) continue;
    try {
      const [common, intro] = await Promise.all([
        tour("detailCommon2", { contentId: cid }),
        tour("detailIntro2", { contentId: cid, contentTypeId: t.typeId }),
      ]);
      const c = common.items[0] || {}, i = intro.items[0] || {};
      cache.tour[cid] = {
        overview: stripHtml(c.overview).slice(0, 400),
        homepage: extractUrl(c.homepage) || extractUrl(i.eventhomepage),
        fee: stripHtml(i.usefee || i.usetimefestival || i.usefeeleports || ""),
        ageText: stripHtml(i.agelimit || i.expagerange || i.expagerangeleports || ""),
        cachedAt: TODAY,
      };
      await sleep(120);
    } catch (e) {
      if (e.message === "TOUR_BUDGET") { log("[tour] 일일 호출 상한 도달 → 남은 상세는 다음 실행에서 채움"); break; }
      log(`[tour] 상세 실패 ${cid}: ${e.message}`);
    }
  }

  if (!PROBE) await saveCache(cache);

  /* 4) 정규화 */
  const ready = out.filter((o) => {
    const d = cache.tour[o.raw.contentid];
    if (!d) return false;
    if (o.kind !== "event") return true;
    return KID_EVENT_STRICT_RE.test(`${o.raw.title} ${d.overview}`) && !ONLINE_RE.test(o.raw.title);
  });
  if (!PROBE) log(`[tour] 상세 확보 ${ready.length}건 / 후보 ${out.length}건 (나머지는 다음 실행에서 채움)`);
  return ready.map(({ raw, kind, region, typeId, start, end }) => {
    const cid = raw.contentid;
    const d = cache.tour[cid];
    const text = `${raw.title} ${d.overview || ""} ${d.ageText || ""}`;
    const { lat, lng } = pickLatLng(raw.mapy, raw.mapx);
    return {
      id: `tour-${cid}`,
      type: kind,
      title: stripHtml(raw.title),
      region,
      district: null, // 시군구명은 주소에서 추출
      address: stripHtml(`${raw.addr1 || ""} ${raw.addr2 || ""}`),
      lat, lng,
      image: upgradeHttps(raw.firstimage || raw.firstimage2 || null),
      ...(kind === "event" ? { startDate: start, endDate: end } : {}),
      isFree: inferFree(d.fee),
      indoor: inferIndoor(typeId, text),
      ages: inferAges(text),
      officialUrl: d.homepage || null,
      tel: stripHtml(raw.tel) || null,
      source: "tour",
      summary: d.overview || "",
    };
  });
}

/* ---------------- 서울 열린데이터광장 ---------------- */

async function collectSeoul() {
  const key = process.env.SEOUL_API_KEY;
  const rows = [];
  const step = 1000;
  for (let start = 1; start <= 50000; start += step) {
    const url = `${SEOUL_BASE}/${key}/json/culturalEventInfo/${start}/${start + step - 1}/`;
    const res = await fetch(url);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`서울 API: JSON 아님 (${res.status}) ${text.slice(0, 200)}`); }
    if (PROBE) log("\n[probe] culturalEventInfo", JSON.stringify(json).slice(0, 1200));
    const data = json.culturalEventInfo;
    if (!data) throw new Error(`서울 API 오류: ${JSON.stringify(json).slice(0, 200)}`);
    const code = data.RESULT?.CODE;
    if (code && code !== "INFO-000") { if (code === "INFO-200") break; throw new Error(`서울 API ${code}: ${data.RESULT?.MESSAGE}`); }
    rows.push(...(data.row || []));
    if (PROBE || rows.length >= Number(data.list_total_count || 0)) break;
    await sleep(120);
  }

  const items = [];
  for (const r of rows) {
    const start = String(r.STRTDATE || "").slice(0, 10), end = String(r.END_DATE || "").slice(0, 10) || start;
    if (!start || end < TODAY || start > UNTIL) continue;
    const text = `${r.TITLE} ${r.USE_TRGT} ${r.CODENAME} ${r.PROGRAM || ""} ${r.ETC_DESC || ""}`;
    const kidText = `${r.TITLE} ${r.USE_TRGT} ${r.CODENAME}`;
    if (ADULT_ONLY_RE.test(`${r.TITLE} ${r.CODENAME}`) || ADULT_TARGET_RE.test(r.USE_TRGT || "")) continue;
    if (ONLINE_RE.test(r.TITLE) || !KID_EVENT_STRICT_RE.test(kidText)) continue;
    const { lat, lng } = pickLatLng(r.LAT, r.LOT);
    items.push({
      id: `seoul-${shortHash(`${r.TITLE}|${start}|${r.PLACE}`)}`,
      type: "event",
      title: stripHtml(r.TITLE),
      region: "서울",
      district: r.GUNAME || null,
      address: stripHtml(r.PLACE),
      lat, lng,
      image: upgradeHttps(r.MAIN_IMG || null),
      startDate: start, endDate: end,
      // IS_FREE 값이 있으면 가장 신뢰할 수 있는 정보로 쓴다
      isFree: r.IS_FREE === "무료" ? true : r.IS_FREE === "유료" ? false : inferFree(r.USE_FEE),
      indoor: inferIndoor("15", text),
      ages: inferAges(`${r.USE_TRGT} ${r.TITLE}`),
      officialUrl: extractUrl(r.ORG_LINK) || extractUrl(r.HMPG_ADDR),
      tel: null,
      source: "seoul",
      summary: stripHtml(r.PROGRAM || r.ETC_DESC || "").slice(0, 300),
    });
  }
  log(`[seoul] 전체 ${rows.length}건 중 ${items.length}건 채택`);
  return items;
}

/* ---------------- 병합 / 저장 ---------------- */

// 상세 조회 결과는 비싸게 얻은 것이므로 --dry 든 실패든 조회 직후 바로 저장해 재사용한다
async function saveCache(cache) {
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache) + "\n");
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

// 시군구명이 비어 있으면 주소 앞부분에서 뽑는다 (예: "경기 과천시 ..." → 과천시)
function fillDistrict(item) {
  if (item.district) return item;
  const m = item.address.match(/([가-힣]+[시군구])(?:\s|$)/g);
  const first = (item.address.split(/\s+/)[1] || "").match(/^[가-힣]+[시군구]$/);
  return { ...item, district: first ? first[0] : (m ? m[m.length - 1].trim() : null) };
}

function dedupe(list) {
  const seen = new Map();
  for (const it of list) {
    const key = `${it.title.replace(/\s+/g, "")}|${it.startDate || ""}`;
    // 서울 API 쪽이 요금·연령 정보가 정확하므로 충돌 시 서울 데이터를 우선한다
    if (!seen.has(key) || it.source === "seoul") seen.set(key, it);
  }
  return [...seen.values()];
}

function applyOverrides(items, ov) {
  const exclude = new Set(ov.exclude || []);
  let out = items.filter((i) => !exclude.has(i.id)).map((i) => ({ ...i, ...(ov.patch?.[i.id] || {}) }));
  for (const add of ov.add || []) out.push({ source: "manual", ages: [], isFree: null, indoor: null, ...add });
  return out;
}

async function main() {
  const hasTour = Boolean(process.env.TOUR_API_KEY), hasSeoul = Boolean(process.env.SEOUL_API_KEY);
  if (!hasTour && !hasSeoul) {
    console.error("TOUR_API_KEY 또는 SEOUL_API_KEY 가 필요합니다. .env.example 을 참고해 .env 를 만드세요.");
    process.exit(1);
  }

  const cache = await readJson(CACHE_FILE, { tour: {} });
  cache.tour ||= {};
  const all = [];

  // 한 소스가 실패해도 다른 소스 결과는 살린다
  if (hasTour) {
    try { all.push(...(await collectTour(cache))); } catch (e) { console.error("[tour] 실패:", e.message); }
  }
  if (hasSeoul) {
    try { all.push(...(await collectSeoul())); } catch (e) { console.error("[seoul] 실패:", e.message); }
  }
  if (PROBE || COUNT) return;

  const overrides = await readJson(OVERRIDES_FILE, {});
  const items = applyOverrides(dedupe(all).map(fillDistrict), overrides)
    .filter((i) => i.title && i.region)
    .sort((a, b) => (a.type === b.type ? a.title.localeCompare(b.title, "ko") : a.type === "event" ? -1 : 1));

  const stat = (f) => items.filter(f).length;
  log(`\n총 ${items.length}건 (장소 ${stat((i) => i.type === "place")}, 행사 ${stat((i) => i.type === "event")})`);
  log(`좌표 없음 ${stat((i) => i.lat == null)}, 공식링크 없음 ${stat((i) => !i.officialUrl)}, 무료 확인 ${stat((i) => i.isFree === true)}, 연령 미확인 ${stat((i) => !i.ages.length)}`);
  log(`TourAPI 호출 ${tourCalls}회`);

  // 수집이 통째로 실패했을 때 기존 데이터를 빈 파일로 덮어쓰지 않는다
  if (items.length === 0) { console.error("수집 결과가 0건이라 파일을 갱신하지 않습니다."); process.exit(1); }
  if (DRY) {
    const label = (i) => `- (${i.type}/${i.region}/${i.isFree === true ? "무료" : i.isFree === false ? "유료" : "?"}/${i.ages.join(",") || "?"}) ${i.title}`;
    log(["", "[제목 미리보기]", ...items.slice(0, 40).map(label)].join("\n"));
    return;
  }

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 1) + "\n");
  log("data/items.json 저장 완료");
}

main().catch((e) => { console.error(e); process.exit(1); });
