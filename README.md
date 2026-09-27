# 아이랑 어디가 · 수도권 나들이

서울·경기·인천에서 아이와 갈 만한 **장소와 행사**를 공공 API에서 모아 보여주는 정적 웹페이지입니다.
필터: 연령 · 실내/야외 · 무료 · 지역 · 장소/행사 · 검색. 카드를 누르면 상세(공식 사이트 이동, 지도, 길찾기)가 열립니다.

```
GitHub Actions (매일 06:00 KST, 인증키는 Secrets)
  └─ scripts/fetch-data.mjs → data/items.json 생성
        └─ GitHub Pages 배포  ← 브라우저는 index.html + app.js + data/items.json 만 읽음 (키 노출 없음)
```

## 로컬에서 화면 보기

`fetch`를 쓰므로 `index.html`을 더블클릭(file://)하면 안 되고 로컬 서버가 필요합니다.

```bash
python -m http.server 8000
```

http://127.0.0.1:8000 접속. 저장소의 `data/items.json`은 화면 확인용 **샘플**입니다.

## 실제 데이터 수집

1. 인증키 발급 (직접 발급해야 합니다)
   - [공공데이터포털](https://www.data.go.kr) → **한국관광공사_국문 관광정보 서비스** 활용신청 → 인증키
   - [서울 열린데이터광장](https://data.seoul.go.kr) → 인증키 (서울시 문화행사 정보)
2. `.env.example`을 `.env`로 복사해 키 입력 (`.env`는 git에서 제외됩니다)
3. **처음에는 반드시 `--probe`로 응답 구조를 확인**하세요. 스크립트는 API 문서만 보고 작성돼 필드명이 다르면 상단 설정/정규화 부분을 고쳐야 합니다.

```bash
node --env-file=.env scripts/fetch-data.mjs --probe   # 각 API 1건씩 원본 응답 출력
node --env-file=.env scripts/fetch-data.mjs --count   # 목록만 조회해 필요한 호출 수 예측 (상세 조회 안 함)
node --env-file=.env scripts/fetch-data.mjs --dry     # 저장 없이 결과 요약 + 샘플 3건 출력
node --env-file=.env scripts/fetch-data.mjs           # data/items.json 갱신
```

장소는 목록 전체를 받지 않고 **키워드 검색**(`TOUR_PLACE_KEYWORDS`: 어린이, 키즈, 동물원, 과학관 …)으로 서버에서 먼저 좁혀 받습니다. 키워드에 걸리지 않는 유명 장소(예: 서울숲)는 아래 `overrides.json`의 `add`로 직접 등록하세요.

TourAPI 개발계정은 하루 1,000회 제한입니다. 상세 조회 결과는 `data/cache.json`에 저장해 재사용하고, 호출이 `MAX_TOUR_CALLS`(기본 850)에 닿으면 멈추고 다음 실행에서 이어서 채웁니다.

## 배포 (GitHub Pages)

1. GitHub 저장소를 만들고 코드를 push (`main` 브랜치)
2. Settings → Pages → **Source: GitHub Actions**
3. Settings → Secrets and variables → Actions → `TOUR_API_KEY`, `SEOUL_API_KEY` 등록
4. Actions 탭 → "데이터 수집 및 배포" → Run workflow (이후 매일 자동 실행)

## 데이터 보정 (`data/overrides.json`)

연령·실내외·무료 여부는 텍스트 기반 **추정**이라 틀릴 수 있습니다. 수집 때마다 아래 내용이 덮어써집니다.

```json
{
  "add": [
    { "id": "manual-1", "type": "place", "title": "우리동네 놀이터", "region": "경기", "district": "수원시",
      "address": "경기 수원시 …", "lat": 37.28, "lng": 127.0, "image": null,
      "isFree": true, "indoor": false, "ages": ["preschool"], "officialUrl": null, "tel": null, "summary": "" }
  ],
  "patch": { "tour-126508": { "ages": ["preschool"], "isFree": true } },
  "exclude": ["tour-999999"]
}
```

- `add`: 직접 등록 (수집 결과에 없는 곳)
- `patch`: id별로 필드 덮어쓰기
- `exclude`: 화면에서 뺄 id

## 데이터 스키마 (`data/items.json`)

`id, type(place|event), title, region(서울|경기|인천), district, address, lat, lng, image, startDate, endDate(행사만), isFree(true|false|null), indoor(true|false|null), ages(["preschool","elementary","all"]), officialUrl, tel, source, summary`

`null`/빈 배열은 "미확인"이며, 필터를 켜면 정보가 확인된 항목만 남습니다.

## 출처 표기

한국관광공사(TourAPI), 서울 열린데이터광장(서울문화포털, 공공누리 1유형), 지도 © OpenStreetMap contributors.
