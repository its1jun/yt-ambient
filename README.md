# Ambient Light for YouTube

YouTube 시청 페이지의 극장/전체화면에서 영상 뒤에 흐린 앰비언트 라이트를 깔아 주는 Chrome 확장(MV3).

## 개발

```text
npm install
npm run build   # scripts/ → dist/content.js
```

구조와 계약은 `docs/ARCHITECTURE.md`를 본다.

## 크롬에 불러오기

1. `npm run build`
2. `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드" → 이 폴더 선택

## 배포용 zip

`npm run build` 후 **`manifest.json`**, **`dist/`**, **`styles/`** 만 담는다.

```text
zip -r ambient-light.zip manifest.json dist styles
```
