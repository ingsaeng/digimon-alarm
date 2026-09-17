// 메가박스 [아트그라피] 디지몬 어드벤처 취소표 알리미 (GitHub Actions용)
// 외부 라이브러리 없음. Node 20 이상의 내장 fetch만 사용
// 저장 경로: 저장소 최상단 check.js

const fs = require("fs");

// ─────────────────────────────────────────────
// 설정 영역 (여기만 고치면 됨)
// ─────────────────────────────────────────────

// 날짜별 대상 지점. 이벤트 진행극장 기준
const TARGETS = {
  "20260919": ["강남", "구의"],
  "20260920": ["코엑스", "하남스타필드"],
};

const TITLE_KEYWORD = "디지몬";
const ARTGRAPHY_TAG = "아트그라피";
const REQUIRE_ARTGRAPHY = false; // probe에서 ★ 확인 후 true 전환 권장
const MIN_SEATS = 1;             // 2인 관람이면 2

const LOOP_COUNT = 4;            // 실행 1회당 확인 횟수
const LOOP_GAP_MS = 70000;       // 확인 사이 간격

const BASE = "https://www.megabox.co.kr";
const BOKD_URL = `${BASE}/on/oh/ohb/SimpleBooking/selectBokdList.do`;
const BOOKING_PAGE = `${BASE}/booking`;
const STATE_FILE = "state.json";

const MODE = process.env.MODE || "watch";
const TG_TOKEN = process.env.TG_TOKEN || "";
const TG_CHAT = process.env.TG_CHAT || "";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Content-Type": "application/json;charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
  "Accept-Language": "ko-KR,ko;q=0.9",
  Origin: BASE,
  Referer: BOOKING_PAGE,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────
// 통신부
// ─────────────────────────────────────────────

let COOKIE = "";

async function warmup() {
  try {
    const r = await fetch(BOOKING_PAGE, { headers: { "User-Agent": HEADERS["User-Agent"] } });
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    COOKIE = set.map((c) => c.split(";")[0]).join("; ");
  } catch (e) {
    console.log("  warmup 실패(무시 가능):", e.message);
  }
}

function payloadVariants(playDe, brchNo = "") {
  const full = {
    areaCd1: "", areaCd2: "", areaCd3: "",
    arrMovieNo: "",
    brchAll: "N",
    brchNo1: brchNo, brchNo2: "", brchNo3: "",
    brchNoListCnt: brchNo ? 1 : 0,
    brchSpcl: "",
    movieNo1: "", movieNo2: "", movieNo3: "",
    playDe,
    sellChnlCd: "MEGABOX",
    spclbYn1: "N", spclbYn2: "", spclbYn3: "",
    theabKindCd1: "", theabKindCd2: "", theabKindCd3: "",
  };
  return [
    full,
    { ...full, sellChnlCd: "" },
    { ...full, brchAll: "", spclbYn1: "" },
    { playDe, brchNo1: brchNo, brchNoListCnt: brchNo ? 1 : 0 },
  ];
}

async function fetchBokd(playDe, brchNo = "", verbose = false) {
  let lastErr = "";
  const variants = payloadVariants(playDe, brchNo);
  for (let i = 0; i < variants.length; i++) {
    try {
      const res = await fetch(BOKD_URL, {
        method: "POST",
        headers: COOKIE ? { ...HEADERS, Cookie: COOKIE } : HEADERS,
        body: JSON.stringify(variants[i]),
      });
      if (!res.ok) { lastErr = `variant${i} HTTP ${res.status}`; continue; }
      const data = await res.json();
      if (data && data.statCd === -1) { lastErr = `variant${i} statCd=-1 (${data.msg})`; continue; }
      if (verbose) console.log(`  [ok] payload variant${i} 사용`);
      return data;
    } catch (e) {
      lastErr = `variant${i} 예외: ${e.message}`;
    }
  }
  if (verbose) console.log(`  [fail] ${lastErr}`);
  return null;
}

// ─────────────────────────────────────────────
// 파싱부
// ─────────────────────────────────────────────

function* walkDicts(obj) {
  if (Array.isArray(obj)) {
    for (const v of obj) yield* walkDicts(v);
  } else if (obj && typeof obj === "object") {
    yield obj;
    for (const v of Object.values(obj)) yield* walkDicts(v);
  }
}

function pick(d, ...cands) {
  for (const c of cands) if (d[c] !== undefined && d[c] !== null && d[c] !== "") return d[c];
  for (const c of cands) {
    for (const [k, v] of Object.entries(d)) {
      if (k.toLowerCase().includes(c.toLowerCase()) && v !== null && v !== "") return v;
    }
  }
  return null;
}

function extractBranches(data) {
  const out = {};
  for (const d of walkDicts(data)) {
    if (d.brchNm && d.brchNo) out[String(d.brchNm)] = String(d.brchNo);
  }
  return out;
}

function extractShowtimes(data) {
  const rows = [], seen = new Set();
  for (const d of walkDicts(data)) {
    const keys = Object.keys(d);
    const hasTime = ["playStartTime", "playSchdlNo", "playStartTm"].some((k) => k in d);
    const hasSeat = keys.some((k) => k.toLowerCase().includes("seat"));
    if (!hasTime || !hasSeat) continue;
    const raw = JSON.stringify(d);
    const row = {
      movie: String(pick(d, "movieNm", "rpstMovieNm") ?? "?"),
      branch: String(pick(d, "brchNm") ?? "?"),
      date: String(pick(d, "playDe") ?? "?"),
      start: String(pick(d, "playStartTime", "playStartTm") ?? "?"),
      screen: String(pick(d, "theabNm", "theabExpoNm") ?? "?"),
      rest: parseInt(pick(d, "restSeatCnt", "restSeat", "seatRest") ?? "", 10),
      total: parseInt(pick(d, "totSeatCnt", "totSeat") ?? "", 10),
      art: raw.includes(ARTGRAPHY_TAG),
      raw,
    };
    const key = [row.branch, row.date, row.start, row.screen].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    row.key = key;
    rows.push(row);
  }
  return rows;
}

const isTarget = (r) =>
  r.raw.includes(TITLE_KEYWORD) && (!REQUIRE_ARTGRAPHY || r.art);

const fmtTime = (t) => (/^\d{4,}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : t);
const fmtDate = (d) => (/^\d{8}$/.test(d) ? `${d.slice(4, 6)}/${d.slice(6, 8)}` : d);

// ─────────────────────────────────────────────
// 알림부
// ─────────────────────────────────────────────

async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log("  텔레그램 미설정. 메시지 생략:\n" + text);
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: false }),
    });
    const body = await res.json();
    if (!body.ok) console.log("  텔레그램 실패:", body.description);
    return !!body.ok;
  } catch (e) {
    console.log("  텔레그램 예외:", e.message);
    return false;
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

// ─────────────────────────────────────────────
// 실행 모드
// ─────────────────────────────────────────────

async function buildPlan() {
  const firstDate = Object.keys(TARGETS)[0];
  const data = await fetchBokd(firstDate, "", true);
  if (!data) return null;
  const table = extractBranches(data);
  const plan = {};
  for (const [date, keywords] of Object.entries(TARGETS)) {
    plan[date] = {};
    for (const kw of keywords) {
      const names = Object.keys(table);
      const exact = names.filter((n) => n === kw);
      const partial = names.filter((n) => n.includes(kw));
      for (const n of (exact.length ? exact : partial)) plan[date][n] = table[n];
    }
  }
  return { table, plan };
}

async function scan(plan, state) {
  const hits = [];
  for (const [date, branches] of Object.entries(plan)) {
    for (const [nm, no] of Object.entries(branches)) {
      const data = await fetchBokd(date, no);
      if (!data) { console.log(`  ${fmtDate(date)} ${nm}: 응답 실패`); continue; }
      const rows = extractShowtimes(data).filter(isTarget);
      if (!rows.length) console.log(`  ${fmtDate(date)} ${nm}: 대상 회차 없음`);
      for (const r of rows) {
        const rest = Number.isNaN(r.rest) ? 0 : r.rest;
        const prev = state[r.key];
        console.log(
          `  ${r.art ? "★" : " "} ${fmtDate(r.date)} ${r.branch} ${fmtTime(r.start)} ` +
          `${r.screen} 잔여 ${rest}/${r.total}`
        );
        if (rest >= MIN_SEATS && (prev === undefined || prev < MIN_SEATS)) hits.push({ ...r, rest });
        state[r.key] = rest;
      }
      await sleep(1200);
    }
  }
  return hits;
}

async function main() {
  console.log(`=== megabox-alarm / mode=${MODE} / ${new Date().toISOString()} ===`);

  if (MODE === "test") {
    const ok = await telegram("✅ 메가박스 알리미 연결 테스트 성공");
    console.log("텔레그램 테스트:", ok ? "성공" : "실패");
    return;
  }

  await warmup();
  const built = await buildPlan();
  if (!built) {
    console.log("엔드포인트 응답 실패. 러너 IP 차단 가능성 있음");
    process.exit(1);
  }
  const { table, plan } = built;
  console.log(`전체 지점 ${Object.keys(table).length}개 수신`);
  for (const [date, br] of Object.entries(plan)) {
    console.log(`  ${fmtDate(date)} → ${Object.entries(br).map(([n, v]) => `${n}(${v})`).join(", ") || "매칭 없음"}`);
  }

  if (MODE === "probe") {
    const state = {};
    await scan(plan, state);
    console.log("\nprobe 완료. 위 목록에 회차와 잔여좌석이 보이면 정상");
    return;
  }

  const state = loadState();
  for (let i = 0; i < LOOP_COUNT; i++) {
    console.log(`\n[확인 ${i + 1}/${LOOP_COUNT}] ${new Date().toISOString()}`);
    const hits = await scan(plan, state);
    for (const h of hits) {
      const line =
        `${h.art ? "★아트그라피 " : ""}${h.branch} / ${fmtDate(h.date)} ${fmtTime(h.start)} / ` +
        `${h.screen} / 잔여 ${h.rest}석`;
      console.log("🎟 취소표 발견 →", line);
      await telegram(`🎟 취소표 발견\n${h.movie}\n${line}\n${BOOKING_PAGE}`);
    }
    saveState(state);
    if (i < LOOP_COUNT - 1) await sleep(LOOP_GAP_MS);
  }
  console.log("\n실행 종료");
}

main().catch((e) => {
  console.error("치명적 오류:", e);
  process.exit(1);
});
